import bcrypt from "bcrypt";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { pool } from "../../config/db.js";
import { env } from "../../config/env.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { DEFAULT_MODULE_CODES } from "../../shared/saas/company-modules.js";
import {
  computeEffectivePermissions,
  getPermissionsForRole,
} from "../../shared/security/permissions.js";
import { createCompanyWithAdmin } from "../../shared/saas/company-bootstrap.js";
import { signAccessToken } from "../../shared/security/jwt.js";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  listActiveRefreshTokens,
  revokeRefreshTokenById,
} from "../../shared/security/refresh-tokens.js";
import {
  assertLoginNotLocked,
  clearLoginFailures,
  recordLoginFailure,
} from "../../shared/security/login-attempts.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { invalidateAuthCache } from "../../middlewares/authenticate.js";
import {
  issueMfaChallenge,
  verifyMfaChallenge,
  isLocked,
  recordFailedAttempt,
  clearFailedAttempts,
} from "../../shared/security/mfa.js";
import {
  loginAttempts,
  refreshTokenEvents,
} from "../../shared/metrics/registry.js";
import {
  DEFAULT_BRANDING,
  getCompanyBranding,
  normalizeBranding,
} from "../../shared/branding/branding.js";
import { getCompanyWhiteLabel } from "../../shared/saas/white-label.js";

const SESSION_ROLE_PRIORITY = [
  "SUPER_ADMIN_SAAS",
  "SUPER_ADMIN",
  "ADMIN_EMPRESA",
  "ENCARGADO_SUCURSAL",
  "CAJERO",
];

const COMPANY_SELECTION_EXP = process.env.COMPANY_SELECTION_EXPIRES || "5m";
const GENERIC_LOGIN_ERROR = "Correo o contrasena invalidos";
const PASSWORD_RESET_BYTES = 32;
const PASSWORD_RESET_TTL_MINUTES = Number(
  process.env.PASSWORD_RESET_TTL_MINUTES || 30
);

const getCompanySelectionSecret = () =>
  crypto
    .createHmac("sha256", process.env.COMPANY_SELECTION_SECRET || env.jwtSecret)
    .update("company-selection")
    .digest("hex");

const issueCompanySelectionChallenge = ({ email, candidates }) =>
  jwt.sign(
    {
      purpose: "company-selection",
      email,
      candidates: candidates.map((candidate) => ({
        id_empresa: Number(candidate.id_empresa),
        id_usuario: Number(candidate.id_usuario),
      })),
    },
    getCompanySelectionSecret(),
    { expiresIn: COMPANY_SELECTION_EXP }
  );

const verifyCompanySelectionChallenge = (token) => {
  try {
    const payload = jwt.verify(token, getCompanySelectionSecret());
    if (payload.purpose !== "company-selection") return null;
    return {
      email: String(payload.email || "").toLowerCase(),
      candidates: Array.isArray(payload.candidates)
        ? payload.candidates.map((candidate) => ({
            id_empresa: Number(candidate.id_empresa),
            id_usuario: Number(candidate.id_usuario),
          }))
        : [],
    };
  } catch {
    return null;
  }
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const hashOpaqueToken = (raw) =>
  crypto.createHash("sha256").update(String(raw || "")).digest("hex");

const generatePasswordResetToken = () =>
  crypto.randomBytes(PASSWORD_RESET_BYTES).toString("hex");

const buildPasswordResetExpiresAt = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() + PASSWORD_RESET_TTL_MINUTES);
  return date;
};

const auditAuthEvent = async ({
  auth,
  requestMeta = null,
  accion,
  entidadId = null,
  despues = null,
}) => {
  try {
    await writeAuditEvent(pool, {
      auth,
      requestMeta,
      modulo: "AUTH",
      entidad: "SESION",
      entidadId: entidadId || auth?.id_usuario || 0,
      accion,
      despues,
    });
  } catch {
    // La auditoria no debe bloquear el flujo de autenticacion.
  }
};

const normalizeRole = (value) => String(value || "").trim().toUpperCase();

const pickPrimaryRole = (roles) => {
  const normalized = roles.map((role) => normalizeRole(role.codigo));

  for (const roleCode of SESSION_ROLE_PRIORITY) {
    if (normalized.includes(roleCode)) {
      return roleCode;
    }
  }

  return normalized[0] || null;
};

const getUserWithCompany = async (db, { empresaSlug, username }) => {
  const result = await db.query(
    `
      select
        u.id_usuario,
        u.id_empresa,
        u.username,
        u.email,
        u.password_hash,
        u.nombre,
        u.apellido,
        u.id_sucursal_default,
        u.activo,
        e.slug as empresa_slug,
        e.nombre_legal,
        e.estado as empresa_estado
      from usuarios u
      inner join empresas e
        on e.id_empresa = u.id_empresa
      where e.slug = $1
        and u.username = $2
      limit 1
    `,
    [empresaSlug, username]
  );

  return result.rows[0] || null;
};

const getUsersByEmail = async (db, { email, idEmpresa = null }) => {
  const params = [email];
  const tenantFilter = idEmpresa ? "and u.id_empresa = $2" : "";
  if (idEmpresa) params.push(idEmpresa);

  const result = await db.query(
    `
      select
        u.id_usuario,
        u.id_empresa,
        u.username,
        u.email,
        u.password_hash,
        u.nombre,
        u.apellido,
        u.id_sucursal_default,
        u.activo,
        e.slug as empresa_slug,
        e.nombre_legal,
        e.estado as empresa_estado
      from usuarios u
      inner join empresas e
        on e.id_empresa = u.id_empresa
      where lower(u.email) = $1
        ${tenantFilter}
      order by e.nombre_legal asc, u.id_usuario asc
    `,
    params
  );

  return result.rows;
};

const getUserRoles = async (db, { idEmpresa, idUsuario }) => {
  const result = await db.query(
    `
      select r.id_rol, r.codigo, r.nombre, r.es_sistema, r.permisos
      from usuarios_roles ur
      inner join roles r
        on r.id_rol = ur.id_rol
      where ur.id_empresa = $1
        and ur.id_usuario = $2
        and (r.id_empresa is null or r.id_empresa = $1)
      order by r.es_sistema desc, r.codigo asc
    `,
    [idEmpresa, idUsuario]
  );

  return result.rows.map((row) => ({
    ...row,
    permisos: Array.isArray(row.permisos) ? row.permisos : [],
  }));
};

const getAssignedBranches = async (db, { idEmpresa, idUsuario }) => {
  const result = await db.query(
    `
      select
        s.id_sucursal,
        s.codigo,
        s.nombre,
        us.es_predeterminada
      from usuarios_sucursales us
      inner join sucursales s
        on s.id_empresa = us.id_empresa
       and s.id_sucursal = us.id_sucursal
      where us.id_empresa = $1
        and us.id_usuario = $2
        and s.activa = true
      order by us.es_predeterminada desc, s.nombre asc
    `,
    [idEmpresa, idUsuario]
  );

  return result.rows;
};

const getCompanyModules = async (db, idEmpresa) => {
  // Fuente unica de verdad: union de saas_planes.modulos_incluidos +
  // empresas_modulos.activo overrides. Definida en migracion 035.
  const result = await db.query(
    `select unnest(app.modulos_efectivos($1)) as codigo`,
    [idEmpresa]
  );
  return result.rows.map((row) => row.codigo).filter(Boolean).sort();
};

const buildSession = async (db, { idEmpresa, idUsuario, requestedSucursalId }) => {
  const result = await db.query(
    `
      select
        u.id_usuario,
        u.id_empresa,
        u.username,
        u.email,
        u.nombre,
        u.apellido,
        u.id_sucursal_default,
        e.slug as empresa_slug,
        e.nombre_legal
      from usuarios u
      inner join empresas e
        on e.id_empresa = u.id_empresa
      where u.id_empresa = $1
        and u.id_usuario = $2
        and u.activo = true
      limit 1
    `,
    [idEmpresa, idUsuario]
  );

  const user = result.rows[0];

  if (!user) {
    throw HttpError.unauthorized("Usuario no encontrado o inactivo");
  }

  const roles = await getUserRoles(db, {
    idEmpresa,
    idUsuario,
  });

  if (roles.length === 0) {
    throw HttpError.forbidden("El usuario no tiene roles asignados");
  }

  const sucursales = await getAssignedBranches(db, {
    idEmpresa,
    idUsuario,
  });

  if (sucursales.length === 0) {
    throw HttpError.forbidden("El usuario no tiene sucursales asignadas");
  }

  const activeSucursal =
    sucursales.find(
      (branch) => Number(branch.id_sucursal) === Number(requestedSucursalId)
    ) ||
    sucursales.find((branch) => branch.es_predeterminada) ||
    sucursales.find(
      (branch) => Number(branch.id_sucursal) === Number(user.id_sucursal_default)
    ) ||
    sucursales[0];

  if (!activeSucursal) {
    throw HttpError.forbidden("No se pudo resolver la sucursal activa");
  }

  const modulos = await getCompanyModules(db, idEmpresa);
  const branding = await getCompanyBranding(db, idEmpresa);
  const whiteLabel = await getCompanyWhiteLabel(db, idEmpresa);
  const rol = pickPrimaryRole(roles);
  // Permisos efectivos: union de roles globales + roles custom del usuario
  const permisos = computeEffectivePermissions({ rol, roles });

  const tokenPayload = {
    id_usuario: Number(user.id_usuario),
    id_empresa: Number(user.id_empresa),
    id_sucursal: Number(activeSucursal.id_sucursal),
    rol,
    sucursales: sucursales.map((branch) => Number(branch.id_sucursal)),
    modulos,
    permisos,
    empresa: {
      slug: user.empresa_slug,
      nombre_legal: user.nombre_legal,
    },
  };

  return {
    token: signAccessToken(tokenPayload),
    user: {
      id_usuario: Number(user.id_usuario),
      id_empresa: Number(user.id_empresa),
      username: user.username,
      email: user.email,
      nombre: user.nombre,
      apellido: user.apellido,
      rol,
      roles,
    },
    empresa: {
      id_empresa: Number(user.id_empresa),
      slug: user.empresa_slug,
      nombre_legal: user.nombre_legal,
    },
    branding,
    white_label: whiteLabel,
    sucursal_activa: {
      id_sucursal: Number(activeSucursal.id_sucursal),
      codigo: activeSucursal.codigo,
      nombre: activeSucursal.nombre,
    },
    sucursales,
    modulos,
    permisos,
  };
};

export const bootstrap = async ({
  empresa,
  sucursalPrincipal,
  adminUsuario,
  modulos = DEFAULT_MODULE_CODES,
}) => {
  const result = await pool.query("select count(*)::int as total from usuarios");

  if (Number(result.rows[0]?.total || 0) > 0) {
    throw HttpError.conflict(
      "El bootstrap inicial ya fue ejecutado. Usa login normal."
    );
  }

  let bootstrapInfo = null;
  const session = await runInTransaction(async (client) => {
    const bootstrapResult = await createCompanyWithAdmin(client, {
      empresa,
      sucursalPrincipal,
      adminUsuario,
      adminRoleCodes: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
      moduleCodes: modulos,
    });

    bootstrapInfo = {
      idEmpresa: bootstrapResult.empresa.id_empresa,
      nombre_legal: bootstrapResult.empresa.nombre_legal,
      slug: bootstrapResult.empresa.slug,
      admin: {
        nombre: bootstrapResult.adminUsuario?.nombre,
        email: bootstrapResult.adminUsuario?.email,
      },
    };

    return buildSession(client, {
      idEmpresa: bootstrapResult.empresa.id_empresa,
      idUsuario: bootstrapResult.adminUsuario.id_usuario,
      requestedSucursalId: bootstrapResult.sucursalPrincipal.id_sucursal,
    });
  });

  // Fire-and-forget welcome email (post-commit; no rompe el response si falla)
  if (bootstrapInfo?.admin?.email) {
    import("../notificaciones/notificaciones.service.js")
      .then(({ notify }) =>
        notify({
          idEmpresa: bootstrapInfo.idEmpresa,
          tipoEvento: "WELCOME_USER",
          payload: {
            nombre: bootstrapInfo.admin.nombre,
            empresa: bootstrapInfo.nombre_legal || bootstrapInfo.slug,
            trial_dias: 14,
          },
        })
      )
      .catch(() => {
        /* fallar silencioso, ya logueado por safeNotify-equivalente */
      });
  }

  return session;
};

export const getPublicAuthContext = async ({ tenantContext = null } = {}) => {
  if (!tenantContext?.id_empresa) {
    return {
      mode: "platform",
      tenant: null,
      branding: normalizeBranding(DEFAULT_BRANDING),
      capabilities: {
        email_login: true,
        company_selection: true,
        password_reset: true,
        mfa: true,
        white_label: false,
        private_api: false,
      },
    };
  }

  const result = await pool.query(
    `
      select id_empresa, slug, nombre_legal, estado
      from empresas
      where id_empresa = $1
      limit 1
    `,
    [tenantContext.id_empresa]
  );
  const company = result.rows[0] || null;
  const whiteLabel = await getCompanyWhiteLabel(pool, tenantContext.id_empresa);

  return {
    mode: "tenant",
    tenant: company
      ? {
          id_empresa: Number(company.id_empresa),
          slug: company.slug,
          nombre_legal: company.nombre_legal,
          estado: company.estado,
          hostname: tenantContext.hostname || null,
        }
      : {
          id_empresa: Number(tenantContext.id_empresa),
          hostname: tenantContext.hostname || null,
        },
    branding: normalizeBranding(
      tenantContext.branding || (await getCompanyBranding(pool, tenantContext.id_empresa))
    ),
    capabilities: {
      email_login: true,
      company_selection: false,
      password_reset: true,
      mfa: true,
      white_label: true,
      private_api: whiteLabel.api_privada_activa === true,
    },
    white_label: whiteLabel,
  };
};

const getRoleCodesForUser = async (db, idEmpresa, idUsuario) => {
  const rolesResult = await db.query(
    `select r.codigo
     from usuarios_roles ur
     inner join roles r on r.id_rol = ur.id_rol
     where ur.id_empresa = $1 and ur.id_usuario = $2`,
    [idEmpresa, idUsuario]
  );

  return rolesResult.rows.map((row) => String(row.codigo).toUpperCase());
};

const completePasswordLogin = async ({ user, id_sucursal }) =>
  runInTransaction(
    async (client) => {
      // Login es pre-auth: tras validar password abrimos contexto tenant para
      // que RLS permita resolver roles, sucursales, MFA, branding y modulos.
      const mfaResult = await client.query(
        `select habilitado from usuarios_mfa where id_usuario = $1 limit 1`,
        [user.id_usuario]
      );
      const mfaEnabled = mfaResult.rows[0]?.habilitado === true;

      const roleCodes = await getRoleCodesForUser(
        client,
        user.id_empresa,
        user.id_usuario
      );
      const requiresMfa = roleCodes.some((code) =>
        ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"].includes(code)
      );
      const mfaEnforced =
        String(process.env.MFA_REQUIRED_FOR_ADMINS || "true").toLowerCase() !==
        "false";

      if (mfaEnabled) {
        loginAttempts.inc({ result: "mfa_required" });
        return {
          mfa_required: true,
          challenge_token: issueMfaChallenge({
            idUsuario: user.id_usuario,
            idEmpresa: user.id_empresa,
          }),
          requested_sucursal_id: id_sucursal || null,
        };
      }

      let mfaEnrollmentRequired = false;
      if (requiresMfa && mfaEnforced && !mfaEnabled) {
        mfaEnrollmentRequired = true;
        loginAttempts.inc({ result: "mfa_enrollment_required" });
      }

      loginAttempts.inc({ result: "success" });

      await client.query(
        `
          update usuarios
          set ultimo_login_at = now()
          where id_usuario = $1
        `,
        [user.id_usuario]
      );

      const session = await buildSession(client, {
        idEmpresa: user.id_empresa,
        idUsuario: user.id_usuario,
        requestedSucursalId: id_sucursal,
      });

      return {
        ...session,
        ...(mfaEnrollmentRequired ? { mfa_enrollment_required: true } : {}),
      };
    },
    {
      auth: {
        id_empresa: user.id_empresa,
        id_usuario: user.id_usuario,
        id_sucursal: id_sucursal || user.id_sucursal_default || null,
      },
    }
  );

const loginLegacy = async ({
  empresa_slug,
  username,
  password,
  id_sucursal,
  requestMeta = {},
}) => {
  const empresaSlug = String(empresa_slug || "").trim().toLowerCase();
  const normalizedUsername = String(username || "").trim().toLowerCase();

  if (!empresaSlug || !normalizedUsername || !password) {
    throw HttpError.badRequest(
      "empresa_slug, username y password son requeridos"
    );
  }

  await assertLoginNotLocked(pool, {
    email: `${normalizedUsername}@${empresaSlug}`,
  });

  const user = await getUserWithCompany(pool, {
    empresaSlug,
    username: normalizedUsername,
  });

  if (!user) {
    await recordLoginFailure(pool, {
      email: `${normalizedUsername}@${empresaSlug}`,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      motivo: "invalid_credentials",
    });
    loginAttempts.inc({ result: "invalid_credentials" });
    throw HttpError.unauthorized("Credenciales invalidas");
  }

  await assertLoginNotLocked(pool, {
    email: `${normalizedUsername}@${empresaSlug}`,
    idEmpresa: user.id_empresa,
    idUsuario: user.id_usuario,
  });

  if (!user.activo || String(user.empresa_estado).toUpperCase() !== "ACTIVA") {
    loginAttempts.inc({ result: "inactive" });
    throw HttpError.forbidden("La cuenta o la empresa estan inactivas");
  }

  const passwordOk = await bcrypt.compare(password, user.password_hash);

  if (!passwordOk) {
    await recordLoginFailure(pool, {
      email: `${normalizedUsername}@${empresaSlug}`,
      idEmpresa: user.id_empresa,
      idUsuario: user.id_usuario,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      motivo: "invalid_credentials",
    });
    loginAttempts.inc({ result: "invalid_credentials" });
    throw HttpError.unauthorized("Credenciales invalidas");
  }

  await clearLoginFailures(pool, {
    email: `${normalizedUsername}@${empresaSlug}`,
    idEmpresa: user.id_empresa,
    idUsuario: user.id_usuario,
  });

  const session = await completePasswordLogin({ user, id_sucursal });
  if (!session.mfa_required) {
    await auditAuthEvent({
      auth: {
        id_empresa: user.id_empresa,
        id_usuario: user.id_usuario,
      },
      requestMeta,
      accion: "LOGIN_LEGACY",
      despues: { method: "password" },
    });
  }
  return session;
};

export const login = async ({
  email,
  password,
  id_sucursal,
  tenantContext = null,
  empresa_slug,
  username,
  requestMeta = {},
}) => {
  // Compatibilidad interna durante la migracion: la UI nueva ya no envia estos
  // campos, pero scripts o clientes antiguos pueden seguir usandolos.
  if (!email && empresa_slug && username) {
    return loginLegacy({
      empresa_slug,
      username,
      password,
      id_sucursal,
      requestMeta,
    });
  }

  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    throw HttpError.badRequest("email y password son requeridos");
  }

  await assertLoginNotLocked(pool, {
    email: normalizedEmail,
    idEmpresa: tenantContext?.id_empresa || null,
  });

  const candidates = await getUsersByEmail(pool, {
    email: normalizedEmail,
    idEmpresa: tenantContext?.id_empresa || null,
  });

  if (candidates.length === 0) {
    await recordLoginFailure(pool, {
      email: normalizedEmail,
      idEmpresa: tenantContext?.id_empresa || null,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      motivo: "invalid_credentials",
    });
    loginAttempts.inc({ result: "invalid_credentials" });
    throw HttpError.unauthorized(GENERIC_LOGIN_ERROR);
  }

  const passwordMatches = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const passwordOk = await bcrypt.compare(password, candidate.password_hash);
    if (passwordOk) passwordMatches.push(candidate);
  }

  if (passwordMatches.length === 0) {
    await recordLoginFailure(pool, {
      email: normalizedEmail,
      idEmpresa: candidates[0]?.id_empresa || tenantContext?.id_empresa || null,
      idUsuario: candidates[0]?.id_usuario || null,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      motivo: "invalid_credentials",
    });
    loginAttempts.inc({ result: "invalid_credentials" });
    throw HttpError.unauthorized(GENERIC_LOGIN_ERROR);
  }

  const activeMatches = passwordMatches.filter(
    (candidate) =>
      candidate.activo && String(candidate.empresa_estado).toUpperCase() === "ACTIVA"
  );

  if (activeMatches.length === 0) {
    await recordLoginFailure(pool, {
      email: normalizedEmail,
      idEmpresa: passwordMatches[0]?.id_empresa || tenantContext?.id_empresa || null,
      idUsuario: passwordMatches[0]?.id_usuario || null,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      motivo: "inactive",
    });
    loginAttempts.inc({ result: "inactive" });
    throw HttpError.forbidden("La cuenta o la empresa estan inactivas");
  }

  await clearLoginFailures(pool, {
    email: normalizedEmail,
    idEmpresa: activeMatches[0]?.id_empresa || tenantContext?.id_empresa || null,
    idUsuario: activeMatches[0]?.id_usuario || null,
  });

  if (activeMatches.length > 1 && !tenantContext?.id_empresa) {
    loginAttempts.inc({ result: "company_selection_required" });
    return {
      company_selection_required: true,
      challenge_token: issueCompanySelectionChallenge({
        email: normalizedEmail,
        candidates: activeMatches,
      }),
      companies: activeMatches.map((candidate) => ({
        id_empresa: Number(candidate.id_empresa),
        slug: candidate.empresa_slug,
        nombre_legal: candidate.nombre_legal,
      })),
    };
  }

  const session = await completePasswordLogin({
    user: activeMatches[0],
    id_sucursal,
  });

  if (!session.mfa_required) {
    await auditAuthEvent({
      auth: {
        id_empresa: activeMatches[0].id_empresa,
        id_usuario: activeMatches[0].id_usuario,
      },
      requestMeta,
      accion: "LOGIN",
      despues: { method: "password" },
    });
  }

  return session;
};

export const selectCompany = async ({
  challenge_token,
  id_empresa,
  id_sucursal,
  tenantContext = null,
  requestMeta = {},
}) => {
  const decoded = verifyCompanySelectionChallenge(challenge_token);
  if (!decoded || decoded.candidates.length === 0) {
    throw HttpError.unauthorized(
      "Seleccion expirada. Vuelve a iniciar sesion."
    );
  }

  const selectedCompanyId = Number(id_empresa);
  const candidate = decoded.candidates.find(
    (item) => Number(item.id_empresa) === selectedCompanyId
  );

  if (!candidate) {
    throw HttpError.forbidden("La empresa seleccionada no esta disponible");
  }

  if (
    tenantContext?.id_empresa &&
    Number(tenantContext.id_empresa) !== selectedCompanyId
  ) {
    throw HttpError.forbidden("El dominio no corresponde a la empresa seleccionada");
  }

  const users = await getUsersByEmail(pool, {
    email: decoded.email,
    idEmpresa: selectedCompanyId,
  });
  const user = users.find(
    (item) => Number(item.id_usuario) === Number(candidate.id_usuario)
  );

  if (
    !user ||
    !user.activo ||
    String(user.empresa_estado).toUpperCase() !== "ACTIVA"
  ) {
    throw HttpError.forbidden("La cuenta o la empresa estan inactivas");
  }

  const session = await completePasswordLogin({
    user,
    id_sucursal,
  });

  await auditAuthEvent({
    auth: {
      id_empresa: user.id_empresa,
      id_usuario: user.id_usuario,
    },
    requestMeta,
    accion: session.mfa_required ? "SELECT_COMPANY_MFA_REQUIRED" : "SELECT_COMPANY",
    despues: { id_empresa: Number(user.id_empresa) },
  });

  return session;
};

/**
 * Paso 2 del login en 2 pasos: canjea challenge + codigo TOTP/backup por
 * session completa.
 */
export const verifyMfaLogin = async ({
  challenge_token,
  code,
  id_sucursal,
  requestMeta = {},
}) => {
  const decoded = verifyMfaChallenge(challenge_token);
  if (!decoded) {
    throw HttpError.unauthorized(
      "Challenge invalido o expirado. Volve a hacer login."
    );
  }

  const { idUsuario, idEmpresa } = decoded;

  // Anti-bruteforce: chequear si esta bloqueado
  const lock = await isLocked(pool, idUsuario);
  if (lock.locked) {
    throw HttpError.tooManyRequests(
      "Demasiados intentos fallidos. Espera 15 minutos antes de reintentar.",
      { locked_until: lock.lockedUntil }
    );
  }

  const { verifyCodeForLogin } = await import("../mfa/mfa.service.js");
  const result = await verifyCodeForLogin(idUsuario, code);

  if (!result?.ok) {
    await recordFailedAttempt(pool, idUsuario, "invalid_code", requestMeta);
    loginAttempts.inc({ result: "mfa_invalid" });
    throw HttpError.unauthorized("Codigo MFA invalido");
  }

  // Limpiar contador de fallidos al exito
  await clearFailedAttempts(pool, idUsuario);
  loginAttempts.inc({ result: "mfa_success" });

  await pool.query(
    `update usuarios set ultimo_login_at = now() where id_usuario = $1`,
    [idUsuario]
  );

  const session = await buildSession(pool, {
    idEmpresa,
    idUsuario,
    requestedSucursalId: id_sucursal,
  });

  await auditAuthEvent({
    auth: { id_empresa: idEmpresa, id_usuario: idUsuario },
    requestMeta,
    accion: "LOGIN_MFA",
    despues: { method: result.method },
  });

  return {
    ...session,
    mfa_method: result.method, // "TOTP" o "BACKUP_CODE"
    ...(result.backup_codes_restantes !== undefined
      ? { backup_codes_restantes: result.backup_codes_restantes }
      : {}),
  };
};

export const switchSucursal = async ({ auth, id_sucursal }) => {
  if (!Number.isInteger(Number(id_sucursal)) || Number(id_sucursal) <= 0) {
    throw HttpError.badRequest("id_sucursal invalido");
  }

  return buildSession(pool, {
    idEmpresa: auth.id_empresa,
    idUsuario: auth.id_usuario,
    requestedSucursalId: Number(id_sucursal),
  });
};

export const me = async (auth) =>
  buildSession(pool, {
    idEmpresa: auth.id_empresa,
    idUsuario: auth.id_usuario,
    requestedSucursalId: auth.id_sucursal,
  });

export const requestPasswordReset = async ({
  email,
  tenantContext = null,
  requestMeta = {},
}) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw HttpError.badRequest("email es requerido");
  }

  const users = await getUsersByEmail(pool, {
    email: normalizedEmail,
    idEmpresa: tenantContext?.id_empresa || null,
  });

  const activeUsers = users.filter(
    (user) =>
      user.activo === true && String(user.empresa_estado).toUpperCase() === "ACTIVA"
  );

  const issuedTokens = [];
  for (const user of activeUsers) {
    const rawToken = generatePasswordResetToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAt = buildPasswordResetExpiresAt();

    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `
        insert into password_reset_tokens (
          id_empresa, id_usuario, token_hash, expires_at, ip, user_agent
        )
        values ($1, $2, $3, $4, $5, $6)
      `,
      [
        user.id_empresa,
        user.id_usuario,
        tokenHash,
        expiresAt,
        requestMeta.ip || null,
        requestMeta.userAgent || null,
      ]
    );

    // eslint-disable-next-line no-await-in-loop
    await auditAuthEvent({
      auth: {
        id_empresa: user.id_empresa,
        id_usuario: user.id_usuario,
      },
      requestMeta,
      accion: "PASSWORD_RESET_REQUESTED",
      despues: { expires_at: expiresAt.toISOString() },
    });

    issuedTokens.push({
      id_empresa: Number(user.id_empresa),
      email: normalizedEmail,
      token: rawToken,
      expires_at: expiresAt.toISOString(),
    });
  }

  const response = { requested: true };
  if (String(process.env.NODE_ENV).toLowerCase() !== "production") {
    response.debug_tokens = issuedTokens;
  }
  return response;
};

export const confirmPasswordReset = async ({
  token,
  new_password,
  requestMeta = {},
}) => {
  const rawToken = String(token || "").trim();
  if (!rawToken || !new_password) {
    throw HttpError.badRequest("token y new_password son requeridos");
  }

  if (String(new_password).length < 8) {
    throw HttpError.unprocessable("La contrasena debe tener al menos 8 caracteres");
  }

  const tokenHash = hashOpaqueToken(rawToken);
  const tokenResult = await pool.query(
    `
      select
        prt.id_password_reset,
        prt.id_empresa,
        prt.id_usuario,
        u.activo,
        e.estado as empresa_estado
      from password_reset_tokens prt
      inner join usuarios u
        on u.id_empresa = prt.id_empresa
       and u.id_usuario = prt.id_usuario
      inner join empresas e
        on e.id_empresa = prt.id_empresa
      where prt.token_hash = $1
        and prt.used_at is null
        and prt.expires_at > now()
      limit 1
    `,
    [tokenHash]
  );

  const reset = tokenResult.rows[0];
  if (
    !reset ||
    reset.activo !== true ||
    String(reset.empresa_estado).toUpperCase() !== "ACTIVA"
  ) {
    throw HttpError.unauthorized("Token invalido o expirado");
  }

  const passwordHash = await bcrypt.hash(String(new_password), 10);

  await runInTransaction(async (client) => {
    await client.query(
      `
        update usuarios
        set password_hash = $3,
            token_valid_from = now(),
            updated_at = now()
        where id_empresa = $1
          and id_usuario = $2
      `,
      [reset.id_empresa, reset.id_usuario, passwordHash]
    );

    await client.query(
      `
        update password_reset_tokens
        set used_at = now()
        where id_password_reset = $1
      `,
      [reset.id_password_reset]
    );

    await client.query(
      `
        update refresh_tokens
        set revoked_at = coalesce(revoked_at, now()),
            revoked_reason = coalesce(revoked_reason, 'password_reset')
        where id_empresa = $1
          and id_usuario = $2
          and revoked_at is null
      `,
      [reset.id_empresa, reset.id_usuario]
    );
  });

  invalidateAuthCache(reset.id_usuario);

  await auditAuthEvent({
    auth: {
      id_empresa: reset.id_empresa,
      id_usuario: reset.id_usuario,
    },
    requestMeta,
    accion: "PASSWORD_RESET_CONFIRMED",
  });

  return { reset: true };
};

// ============================================================
// Refresh tokens
// ============================================================

/**
 * Emite un refresh token nuevo para una sesion (post-login o post-bootstrap).
 * Devuelve el token en CLARO para que el caller lo coloque en una cookie httpOnly.
 */
export const issueSessionRefresh = async ({
  idEmpresa,
  idUsuario,
  userAgent,
  ip,
}) => {
  const result = await issueRefreshToken({
    idEmpresa,
    idUsuario,
    userAgent,
    ip,
  });
  refreshTokenEvents.inc({ event: "issued" });
  return result;
};

/**
 * Refresca una sesion: rota el refresh token (invalida el viejo + emite nuevo)
 * y emite un nuevo access token con el estado actual del usuario.
 *
 * Si el refresh token fue revocado y se intenta reutilizar, se revocan TODOS
 * los del usuario (proteccion contra robo).
 */
export const refreshSession = async ({ rawRefreshToken, userAgent, ip }) => {
  let rotated;
  try {
    rotated = await rotateRefreshToken({
      rawToken: rawRefreshToken,
      userAgent,
      ip,
    });
  } catch (error) {
    if (/revocado|reuso|reuse/i.test(error.message || "")) {
      refreshTokenEvents.inc({ event: "reused_revoked" });
    }
    throw error;
  }

  refreshTokenEvents.inc({ event: "rotated" });

  const { idEmpresa, idUsuario, refreshToken } = rotated;
  const session = await buildSession(pool, {
    idEmpresa,
    idUsuario,
    requestedSucursalId: null,
  });

  await auditAuthEvent({
    auth: { id_empresa: idEmpresa, id_usuario: idUsuario },
    requestMeta: { userAgent, ip },
    accion: "REFRESH_TOKEN_ROTATED",
  });

  return {
    ...session,
    refreshToken,
  };
};

/**
 * Logout: revoca el refresh token actual.
 */
export const logoutSession = async ({ rawRefreshToken, auth = null, requestMeta = {} }) => {
  await revokeRefreshToken(rawRefreshToken, "logout");
  refreshTokenEvents.inc({ event: "revoked_logout" });
  if (auth?.id_usuario) {
    await auditAuthEvent({
      auth,
      requestMeta,
      accion: "LOGOUT",
    });
  }
};

/**
 * Revoca todos los refresh tokens del usuario (al cambiar password,
 * desactivar usuario, o sospechar intrusion).
 */
export const revokeAllSessionsForUser = async ({
  idEmpresa,
  idUsuario,
  reason = "global_logout",
}) => revokeAllForUser({ idEmpresa, idUsuario, reason });

export const listSessions = async ({ auth }) =>
  listActiveRefreshTokens({
    idEmpresa: auth.id_empresa,
    idUsuario: auth.id_usuario,
  });

export const revokeSession = async ({ auth, idRefreshToken, requestMeta = {} }) => {
  const id = Number(idRefreshToken);
  if (!Number.isInteger(id) || id <= 0) {
    throw HttpError.badRequest("id_refresh_token invalido");
  }

  const revoked = await revokeRefreshTokenById({
    idEmpresa: auth.id_empresa,
    idUsuario: auth.id_usuario,
    idRefreshToken: id,
    reason: "session_revoked",
  });

  if (!revoked) {
    throw HttpError.notFound("Sesion no encontrada");
  }

  await auditAuthEvent({
    auth,
    requestMeta,
    accion: "SESSION_REVOKED",
    despues: { id_refresh_token: id },
  });

  return { revoked: true };
};

export const logoutAllSessions = async ({ auth, requestMeta = {} }) => {
  await runInTransaction(async (client) => {
    await client.query(
      `
        update refresh_tokens
        set revoked_at = coalesce(revoked_at, now()),
            revoked_reason = coalesce(revoked_reason, 'global_logout')
        where id_empresa = $1
          and id_usuario = $2
          and revoked_at is null
      `,
      [auth.id_empresa, auth.id_usuario]
    );

    await client.query(
      `
        update usuarios
        set token_valid_from = now()
        where id_empresa = $1
          and id_usuario = $2
      `,
      [auth.id_empresa, auth.id_usuario]
    );
  });

  invalidateAuthCache(auth.id_usuario);
  refreshTokenEvents.inc({ event: "revoked_global" });

  await auditAuthEvent({
    auth,
    requestMeta,
    accion: "LOGOUT_ALL",
  });

  return { revoked: true };
};
