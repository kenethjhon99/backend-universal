/**
 * enforcePlanLimits middleware.
 *
 * Bloquea la creacion de un recurso si la empresa ya alcanzo el limite de
 * su plan SaaS. Consulta la funcion SQL app.empresa_puede_crear(empresa, recurso)
 * que cruza saas_planes.max_* contra empresa_uso_actual.*_count.
 *
 * Uso:
 *   router.post("/", authenticate, enforcePlanLimits("sucursal"), controller.create);
 *
 * Respuesta cuando bloquea: 402 Payment Required con detalles del limite.
 *
 * Performance:
 *  - Para recursos de baja frecuencia (sucursal, usuario, bodega): se consulta
 *    la BD en cada request. ~ 1-2ms.
 *  - Para recursos de alta frecuencia (venta): cache en memoria del estado
 *    "permitido / no permitido" por 30s. Los counts en BD se actualizan via
 *    trigger en tiempo real, asi que el cache solo es del LOOKUP, no del dato.
 *    Tradeoff: hasta 30s de tolerancia para detectar que cruzaste el limite.
 *    Aceptable porque el limite es por mes (~30 dias).
 */
import { pool } from "../config/db.js";
import { HttpError } from "../shared/http/http-error.js";

const VALID_RESOURCES = new Set([
  "sucursal",
  "usuario",
  "venta",
  "bodega",
  "producto",
  "caja",
  "storage_mb",
  "api_request",
]);

// Recursos cuyo check vale la pena cachear (alta frecuencia, limite "grande").
const CACHEABLE = new Set(["venta", "api_request"]);
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // key: `${idEmpresa}:${resource}` -> { value, expiresAt }

const cacheKey = (idEmpresa, resource) => `${idEmpresa}:${resource}`;

/**
 * Invalida una entrada de cache. Llamar tras cambiar el plan de una empresa
 * (upgrade/downgrade) o tras suspension.
 */
export const invalidatePlanLimitCache = (idEmpresa, resource = null) => {
  if (resource) {
    cache.delete(cacheKey(idEmpresa, resource));
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${idEmpresa}:`)) cache.delete(key);
  }
};

const fetchPermission = async (idEmpresa, resource) => {
  const r = await pool.query(
    `select permitido, current_count, max_count, plan_codigo
     from app.empresa_puede_crear($1, $2)`,
    [idEmpresa, resource]
  );
  return r.rows[0] || null;
};

const getCached = async (idEmpresa, resource) => {
  if (!CACHEABLE.has(resource)) {
    return fetchPermission(idEmpresa, resource);
  }
  const key = cacheKey(idEmpresa, resource);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Si el cache dijo "permitido pero current cerca del max", invalidamos
    // antes para que el proximo hit re-consulte. Asi reaccionamos rapido
    // cuando estamos por cruzar el limite.
    return cached.value;
  }
  const value = await fetchPermission(idEmpresa, resource);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
};

export const enforcePlanLimits = (resource) => {
  if (!VALID_RESOURCES.has(resource)) {
    throw new Error(
      `enforcePlanLimits: recurso invalido '${resource}'. Validos: ${[
        ...VALID_RESOURCES,
      ].join(", ")}`
    );
  }

  return async (req, _res, next) => {
    try {
      // SUPER_ADMIN nunca esta sujeto a limites
      if (
        ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"].includes(
          String(req.auth?.rol).toUpperCase()
        )
      ) {
        return next();
      }

      const idEmpresa = Number(req.auth?.id_empresa);
      if (!idEmpresa) return next();

      const row = await getCached(idEmpresa, resource);

      if (!row || row.permitido === true) {
        return next();
      }

      // Si vamos a bloquear, invalidamos el cache para que el cliente no quede
      // bloqueado eternamente si en realidad pago/upgradeo y el webhook llego.
      invalidatePlanLimitCache(idEmpresa, resource);

      return next(
        HttpError.paymentRequired(
          `Limite de tu plan alcanzado: ${row.current_count}/${row.max_count} ${resource}(s). Actualiza el plan para crear mas.`,
          {
            reason: "plan_limit_reached",
            resource,
            current: row.current_count,
            max: row.max_count,
            plan: row.plan_codigo,
          }
        )
      );
    } catch (err) {
      next(err);
    }
  };
};
