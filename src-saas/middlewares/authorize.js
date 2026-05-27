import { HttpError } from "../shared/http/http-error.js";

const PLATFORM_ROLES = new Set(["SUPER_ADMIN", "SUPER_ADMIN_SAAS"]);
const PRIVILEGED_ROLES = new Set(["ADMIN_EMPRESA"]);

const normalizeRole = (value) => String(value || "").trim().toUpperCase();

export const authorize =
  ({ roles = [], allowAnyAssignedSucursal = false } = {}) =>
  (req, _res, next) => {
    if (!req.auth) {
      return next(HttpError.unauthorized("Sesion no disponible"));
    }

    const currentRole = normalizeRole(req.auth.rol);
    const allowedRoles = roles.map(normalizeRole);
    const mixedControlAndTenantRoles =
      allowedRoles.length > 0 &&
      allowedRoles.some((role) => PLATFORM_ROLES.has(role)) &&
      allowedRoles.some((role) => !PLATFORM_ROLES.has(role));

    if (
      PLATFORM_ROLES.has(currentRole) &&
      req.auth?.impersonation !== true &&
      (req.tenantDbContext === true || mixedControlAndTenantRoles)
    ) {
      return next(
        HttpError.forbidden(
          "El administrador SaaS no puede operar datos de clientes",
          { rol_actual: currentRole }
        )
      );
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(currentRole)) {
      return next(
        HttpError.forbidden("Tu rol no puede ejecutar esta accion", {
          rol_actual: currentRole,
          roles_permitidos: allowedRoles,
        })
      );
    }

    const providedSucursal =
      req.headers?.["x-sucursal-id"] ??
      req.body?.id_sucursal ??
      req.query?.id_sucursal ??
      req.auth.id_sucursal;

    const requestedSucursal = Number(providedSucursal);

    if (!Number.isInteger(requestedSucursal) || requestedSucursal <= 0) {
      return next(HttpError.badRequest("id_sucursal invalido"));
    }

    const assignedSucursales = Array.isArray(req.auth.sucursales)
      ? req.auth.sucursales.map(Number)
      : [];

    const canUseRequestedSucursal =
      PRIVILEGED_ROLES.has(currentRole) ||
      (allowAnyAssignedSucursal
        ? assignedSucursales.includes(requestedSucursal)
        : Number(req.auth.id_sucursal) === requestedSucursal);

    if (!canUseRequestedSucursal) {
      return next(
        HttpError.forbidden("No tienes acceso a la sucursal solicitada", {
          id_sucursal_solicitada: requestedSucursal,
        })
      );
    }

    req.scope = {
      id_empresa: Number(req.auth.id_empresa),
      id_sucursal: requestedSucursal,
    };

    next();
  };
