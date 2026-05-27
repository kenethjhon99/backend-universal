import { pool } from "../config/db.js";
import { HttpError } from "../shared/http/http-error.js";
import { getSentry } from "../shared/observability/sentry.js";
import { getPermissionsForRole } from "../shared/security/permissions.js";
import { verifyAccessToken } from "../shared/security/jwt.js";

// Cache en memoria del token_valid_from por usuario para reducir queries.
// TTL corto (30s) para que la revocacion surta efecto rapido sin pegar a BD
// en cada request.
const TOKEN_VALID_TTL_MS = 30 * 1000;
const tokenValidCache = new Map();

const getTokenValidFromCached = async (idUsuario) => {
  const cached = tokenValidCache.get(idUsuario);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = await pool.query(
    `select token_valid_from, activo from usuarios where id_usuario = $1 limit 1`,
    [idUsuario]
  );
  const row = result.rows[0];
  if (!row) {
    return { tokenValidFrom: null, activo: false };
  }

  const value = {
    tokenValidFrom: row.token_valid_from
      ? new Date(row.token_valid_from).getTime()
      : 0,
    activo: row.activo === true,
  };
  tokenValidCache.set(idUsuario, {
    value,
    expiresAt: Date.now() + TOKEN_VALID_TTL_MS,
  });
  return value;
};

/**
 * Invalida la cache para un usuario despues de operaciones que cambian su
 * token_valid_from (logout, change password, role updates, deactivation).
 */
export const invalidateAuthCache = (idUsuario) => {
  tokenValidCache.delete(Number(idUsuario));
};

// ============================================================
// Cache de estado de empresa (activa / suspendida / cancelada / trial).
// 30s para que un cambio (Stripe webhook) se refleje rapido sin pegar a BD
// en cada request.
// ============================================================
const COMPANY_STATUS_TTL_MS = 30 * 1000;
const companyStatusCache = new Map();

const getCompanyStatusCached = async (idEmpresa) => {
  const cached = companyStatusCache.get(idEmpresa);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const r = await pool.query(
    `select estado, saas_estado, saas_trial_hasta
     from empresas
     where id_empresa = $1
     limit 1`,
    [idEmpresa]
  );
  const value = r.rows[0] || null;
  companyStatusCache.set(idEmpresa, {
    value,
    expiresAt: Date.now() + COMPANY_STATUS_TTL_MS,
  });
  return value;
};

/**
 * Invalida la cache de estado de empresa. Llamar tras webhook Stripe,
 * suspension manual desde SuperAdmin, etc.
 */
export const invalidateCompanyStatusCache = (idEmpresa) => {
  companyStatusCache.delete(Number(idEmpresa));
};

/**
 * Aplica el chequeo de empresa activa contra req.auth.
 * Lanza HttpError 402/403 si corresponde. SUPER_ADMIN bypassa.
 */
const enforceActiveCompany = async (req) => {
  if (["SUPER_ADMIN", "SUPER_ADMIN_SAAS"].includes(String(req.auth?.rol).toUpperCase())) {
    return;
  }

  const idEmpresa = Number(req.auth?.id_empresa);
  if (!idEmpresa) return;

  const row = await getCompanyStatusCached(idEmpresa);
  if (!row) {
    throw HttpError.unauthorized("Empresa no encontrada");
  }

  if (String(row.estado).toUpperCase() !== "ACTIVA") {
    throw HttpError.forbidden("Tu empresa esta inactiva", {
      reason: "company_inactive",
      estado: row.estado,
    });
  }

  const saasEstado = String(row.saas_estado || "").toUpperCase();

  if (saasEstado === "SUSPENDIDA") {
    throw HttpError.paymentRequired(
      "Tu suscripcion esta suspendida por falta de pago",
      { reason: "subscription_suspended", saas_estado: saasEstado }
    );
  }
  if (saasEstado === "CANCELADA") {
    throw HttpError.paymentRequired("Tu suscripcion fue cancelada", {
      reason: "subscription_cancelled",
      saas_estado: saasEstado,
    });
  }

  if (saasEstado === "TRIAL") {
    const trialHasta = row.saas_trial_hasta
      ? new Date(row.saas_trial_hasta)
      : null;
    if (trialHasta && trialHasta.getTime() < Date.now()) {
      throw HttpError.paymentRequired(
        "Tu periodo de prueba expiro. Activa un plan para continuar.",
        { reason: "trial_expired", trial_hasta: row.saas_trial_hasta }
      );
    }
  }
};

/**
 * Factory del middleware authenticate.
 *
 * @param {object} opts
 * @param {boolean} [opts.requireActiveCompany=true] - si true (default), tras
 *   validar el JWT tambien valida que la empresa este ACTIVA y la suscripcion
 *   no este suspendida/cancelada/trial-expirado. Setear false en rutas que
 *   el cliente suspendido necesita usar (billing).
 */
const makeAuthenticate = ({ requireActiveCompany = true } = {}) =>
  async (req, _res, next) => {
    try {
      const header = String(req.headers.authorization || "");

      if (!header.startsWith("Bearer ")) {
        throw HttpError.unauthorized("Token requerido");
      }

      const payload = verifyAccessToken(header.slice(7));

      // Revocacion: si token.iat < usuarios.token_valid_from, el token ya
      // fue invalidado por un cambio de password / desactivacion / rotacion
      // de roles desde la admin.
      if (payload.id_usuario) {
        const { tokenValidFrom, activo } = await getTokenValidFromCached(
          Number(payload.id_usuario)
        );

        if (!activo) {
          throw HttpError.unauthorized("Usuario inactivo");
        }

        if (tokenValidFrom && payload.iat) {
          const iatMs = Number(payload.iat) * 1000;
          if (iatMs < tokenValidFrom) {
            throw HttpError.unauthorized(
              "Sesion revocada. Inicia sesion nuevamente."
            );
          }
        }
      }

      req.auth = {
        id_usuario: payload.id_usuario,
        id_empresa: payload.id_empresa,
        id_sucursal: payload.id_sucursal,
        rol: payload.rol,
        sucursales: payload.sucursales || [],
        modulos: payload.modulos || [],
        permisos:
          Array.isArray(payload.permisos) && payload.permisos.length > 0
            ? payload.permisos
            : getPermissionsForRole(payload.rol),
        empresa: payload.empresa || null,
      };

      // Chequeo de estado de empresa (suspension, trial, etc).
      // Las variantes "permissive" lo saltean (ej. billing).
      if (requireActiveCompany) {
        await enforceActiveCompany(req);
      }

      // Propagar contexto al scope Sentry actual.
      const Sentry = getSentry();
      if (Sentry) {
        const scope = Sentry.getCurrentScope();
        scope.setUser({ id: String(req.auth.id_usuario || "") });
        scope.setTag("id_empresa", String(req.auth.id_empresa || ""));
        scope.setTag("rol", String(req.auth.rol || ""));
        if (req.auth.empresa?.slug) {
          scope.setTag("empresa_slug", req.auth.empresa.slug);
        }
      }

      next();
    } catch (error) {
      next(
        error instanceof HttpError
          ? error
          : HttpError.unauthorized("Token invalido o expirado")
      );
    }
  };

/**
 * Middleware estandar: autentica JWT + verifica empresa activa.
 * Es lo que deben usar la mayoria de rutas.
 */
export const authenticate = makeAuthenticate({ requireActiveCompany: true });

/**
 * Variante "permissive": solo autentica JWT sin chequear estado de empresa.
 * Usar en endpoints que el usuario suspendido necesita acceder, como
 * billing (para pagar y reactivar) o consultar su sesion (/auth/me).
 */
export const authenticatePermissive = makeAuthenticate({
  requireActiveCompany: false,
});
