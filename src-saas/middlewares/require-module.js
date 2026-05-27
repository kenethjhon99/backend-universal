import { HttpError } from "../shared/http/http-error.js";

const PLATFORM_ROLES = new Set(["SUPER_ADMIN", "SUPER_ADMIN_SAAS"]);

export const requireModule = (...modules) => {
  const normalizedModules = modules
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);

  return (req, _res, next) => {
    const currentRole = String(req.auth?.rol || "").trim().toUpperCase();

    if (PLATFORM_ROLES.has(currentRole) && req.auth?.impersonation !== true) {
      return next(
        HttpError.forbidden(
          "El administrador SaaS no puede operar modulos de clientes",
          {
            rol_actual: currentRole,
            modulos_requeridos: normalizedModules,
          }
        )
      );
    }

    const activeModules = Array.isArray(req.auth?.modulos)
      ? req.auth.modulos.map((item) => String(item).trim().toUpperCase())
      : [];

    const enabled = normalizedModules.some((item) => activeModules.includes(item));

    if (!enabled) {
      return next(
        HttpError.forbidden("El modulo no esta habilitado para esta empresa", {
          modulos_requeridos: normalizedModules,
          modulos_activos: activeModules,
        })
      );
    }

    next();
  };
};
