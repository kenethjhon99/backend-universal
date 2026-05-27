const ALL_PERMISSIONS = [
  "company.create",
  "company.read",
  "company.branding.read",
  "company.branding.update",
  "company.white_label.read",
  "company.white_label.update",
  "company.api_keys.manage",
  "company.modules.catalog.read",
  "company.modules.read",
  "company.modules.update",
  "branches.read",
  "branches.create",
  "users.read",
  "users.create",
  "users.update",
  "users.status",
  "users.roles",
  "audit.read",
  "catalogs.read",
  "catalogs.manage",
  "inventory.read",
  "inventory.manage",
  "purchases.read",
  "purchases.manage",
  "purchases.adjust",
  "finance.read",
  "finance.manage",
  "finance.close",
  "reports.read",
  "services.read",
  "services.manage",
  "services.refund",
  "services.reports.read",
  "sales.read",
  "sales.manage",
  "sales.refund",
  "cash.read",
  "cash.manage",
  "comprobantes.read",
  "comprobantes.manage",
  "roles.manage",
];

const PLATFORM_PERMISSIONS = [
  "company.create",
  "company.read",
  "company.branding.read",
  "company.branding.update",
  "company.white_label.read",
  "company.white_label.update",
  "company.api_keys.manage",
  "company.modules.catalog.read",
  "company.modules.read",
  "company.modules.update",
  "audit.read",
];

const ROLE_PERMISSIONS = {
  SUPER_ADMIN: PLATFORM_PERMISSIONS,
  SUPER_ADMIN_SAAS: PLATFORM_PERMISSIONS,
  ADMIN_EMPRESA: [
    "company.read",
    "company.branding.read",
    "company.branding.update",
    "company.white_label.read",
    "company.white_label.update",
    "company.api_keys.manage",
    "company.modules.read",
    "branches.read",
    "branches.create",
    "users.read",
    "users.create",
    "users.update",
    "users.status",
    "users.roles",
    "audit.read",
    "catalogs.read",
    "catalogs.manage",
    "inventory.read",
    "inventory.manage",
    "purchases.read",
    "purchases.manage",
    "purchases.adjust",
    "finance.read",
    "finance.manage",
    "finance.close",
    "reports.read",
    "services.read",
    "services.manage",
    "services.refund",
    "services.reports.read",
    "sales.read",
    "sales.manage",
    "sales.refund",
    "cash.read",
    "cash.manage",
    "comprobantes.read",
    "comprobantes.manage",
    "roles.manage",
  ],
  ENCARGADO_SUCURSAL: [
    "branches.read",
    "users.read",
    "users.create",
    "users.update",
    "users.status",
    "catalogs.read",
    "catalogs.manage",
    "inventory.read",
    "inventory.manage",
    "purchases.read",
    "purchases.manage",
    "purchases.adjust",
    "finance.read",
    "finance.manage",
    "reports.read",
    "services.read",
    "services.manage",
    "services.refund",
    "services.reports.read",
    "sales.read",
    "sales.manage",
    "sales.refund",
    "cash.read",
    "cash.manage",
    "comprobantes.read",
    "comprobantes.manage",
  ],
  CAJERO: [
    "catalogs.read",
    "services.read",
    "services.manage",
    "sales.read",
    "sales.manage",
    "cash.read",
    "cash.manage",
    "comprobantes.read",
  ],
  GERENTE: [
    "branches.read",
    "users.read",
    "catalogs.read",
    "inventory.read",
    "purchases.read",
    "finance.read",
    "reports.read",
    "services.read",
    "services.reports.read",
    "sales.read",
    "cash.read",
    "comprobantes.read",
  ],
  BODEGUERO: [
    "catalogs.read",
    "inventory.read",
    "inventory.manage",
    "purchases.read",
    "comprobantes.read",
  ],
  COMPRAS: [
    "catalogs.read",
    "inventory.read",
    "purchases.read",
    "purchases.manage",
    "purchases.adjust",
    "comprobantes.read",
  ],
  OPERADOR_CARWASH: [
    "catalogs.read",
    "inventory.read",
    "services.read",
    "services.manage",
    "cash.read",
    "comprobantes.read",
  ],
  SUPERVISOR_CARWASH: [
    "catalogs.read",
    "inventory.read",
    "services.read",
    "services.manage",
    "services.refund",
    "services.reports.read",
    "reports.read",
    "cash.read",
    "comprobantes.read",
  ],
};

const normalizePermission = (value) => String(value || "").trim().toLowerCase();
const normalizeRole = (value) => String(value || "").trim().toUpperCase();

/**
 * Permisos efectivos de un usuario dado:
 *   - Sus roles globales (codigo en ROLE_PERMISSIONS) → permisos fijos
 *   - Sus roles custom (con array `permisos` en la fila de roles) → ese array literal
 *   - Union de todos, deduplicado.
 *
 * @param {object} params
 * @param {string} params.rol  - codigo del rol PRIMARIO (compat con JWT viejo)
 * @param {Array<{ codigo: string, es_sistema: boolean, permisos?: string[] }>} [params.roles]
 *        Array completo de roles del usuario (custom y globales). Si se
 *        provee, gana sobre `rol`.
 * @returns {string[]}
 */
export const computeEffectivePermissions = ({ rol, roles }) => {
  const set = new Set();

  if (Array.isArray(roles) && roles.length > 0) {
    for (const r of roles) {
      const code = normalizeRole(r?.codigo);
      // Rol global del SaaS
      if (ROLE_PERMISSIONS[code]) {
        for (const p of ROLE_PERMISSIONS[code]) set.add(normalizePermission(p));
      }
      // Rol custom (es_sistema = false) usa su array literal de permisos
      if (r?.es_sistema === false && Array.isArray(r?.permisos)) {
        for (const p of r.permisos) {
          if (ALL_PERMISSIONS.includes(normalizePermission(p))) {
            set.add(normalizePermission(p));
          }
        }
      }
    }
    return [...set];
  }

  // Fallback: solo el rol primario (compatibilidad)
  const code = normalizeRole(rol);
  for (const p of ROLE_PERMISSIONS[code] || []) {
    set.add(normalizePermission(p));
  }
  return [...set];
};

/** Compat: alias usado en imports antiguos */
export const getPermissionsForRole = (role) =>
  computeEffectivePermissions({ rol: role });

export const hasPermission = (permissions, permission) =>
  (Array.isArray(permissions) ? permissions : [])
    .map(normalizePermission)
    .includes(normalizePermission(permission));

export const getPermissionCatalog = () => [...ALL_PERMISSIONS];

export const isValidPermission = (code) =>
  ALL_PERMISSIONS.includes(normalizePermission(code));
