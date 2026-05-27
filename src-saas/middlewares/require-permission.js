import { HttpError } from "../shared/http/http-error.js";
import {
  getPermissionsForRole,
  hasPermission,
} from "../shared/security/permissions.js";

export const requirePermission =
  (...permissions) =>
  (req, _res, next) => {
    const normalizedPermissions = permissions
      .map((permission) => String(permission || "").trim().toLowerCase())
      .filter(Boolean);

    const currentPermissions = [
      ...new Set([
        ...(Array.isArray(req.auth?.permisos) ? req.auth.permisos : []),
        ...getPermissionsForRole(req.auth?.rol),
      ]),
    ];

    const allowed =
      normalizedPermissions.length === 0 ||
      normalizedPermissions.some((permission) =>
        hasPermission(currentPermissions, permission)
      );

    if (!allowed) {
      return next(
        HttpError.forbidden("No tienes permiso para ejecutar esta accion", {
          permisos_requeridos: normalizedPermissions,
          permisos_actuales: currentPermissions,
        })
      );
    }

    next();
  };
