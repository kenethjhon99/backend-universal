import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { invalidateAuthCache } from "../../middlewares/authenticate.js";
import {
  getPermissionCatalog,
  isValidPermission,
} from "../../shared/security/permissions.js";

const sanitizeCodigo = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .slice(0, 40);

const normalizePermisos = (arr) => {
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (const p of arr) {
    const code = String(p || "").trim().toLowerCase();
    if (isValidPermission(code)) out.add(code);
  }
  return [...out];
};

const PLATFORM_ROLE_CODES = new Set(["SUPER_ADMIN", "SUPER_ADMIN_SAAS"]);

// `db` puede ser un client transaccional (req.db, via withTenantDb) o el pool
// global. Si el caller no provee `db`, caemos al pool (compat hacia atras).
const resolveDb = (db) => db || pool;

export const getCatalogoPermisos = async ({ db } = {}) => {
  const conn = resolveDb(db);
  const r = await conn.query(
    `select codigo, nombre, descripcion, modulo, riesgo
     from permisos_catalogo
     order by modulo asc, riesgo asc, codigo asc`
  );
  const validCodes = new Set(getPermissionCatalog());
  return r.rows.filter((row) => validCodes.has(row.codigo));
};

/**
 * Lista los roles disponibles para la empresa actual.
 *   - Roles globales del SaaS (id_empresa null, es_sistema true) — solo lectura
 *   - Roles custom de la empresa (id_empresa = empresa actual, es_sistema false) — editables
 */
export const listRolesDisponibles = async ({ db, auth }) => {
  const conn = resolveDb(db);
  const r = await conn.query(
    `
      select id_rol, codigo, nombre, descripcion, es_sistema, id_empresa, permisos
      from roles
      where id_empresa is null or id_empresa = $1
      order by es_sistema desc, codigo asc
    `,
    [auth.id_empresa]
  );
  return r.rows
    .filter((row) => !PLATFORM_ROLE_CODES.has(String(row.codigo || "").toUpperCase()))
    .map((row) => ({
      ...row,
      es_global: row.es_sistema && row.id_empresa === null,
      permisos: Array.isArray(row.permisos) ? row.permisos : [],
    }));
};

export const createRolCustom = async ({
  db,
  auth,
  scope,
  body,
  requestMeta,
}) => {
  const conn = resolveDb(db);
  const codigo = sanitizeCodigo(body?.codigo || body?.nombre || "");
  const nombre = String(body?.nombre || "").trim();
  if (!codigo || !nombre) {
    throw HttpError.badRequest("codigo y nombre son requeridos");
  }
  const permisos = normalizePermisos(body?.permisos);

  const r = await conn
    .query(
      `
      insert into roles (codigo, nombre, descripcion, id_empresa, permisos, es_sistema)
      values ($1, $2, $3, $4, $5::jsonb, false)
      returning *
    `,
      [
        codigo,
        nombre,
        body?.descripcion || null,
        auth.id_empresa,
        JSON.stringify(permisos),
      ]
    )
    .catch((e) => {
      if (String(e.message).includes("uq_roles_custom_empresa_codigo")) {
        throw HttpError.conflict(`Ya existe un rol con codigo "${codigo}"`);
      }
      if (String(e.message).includes("uq_roles_globales_codigo")) {
        throw HttpError.conflict(
          `El codigo "${codigo}" esta reservado para el SaaS`
        );
      }
      throw e;
    });

  await writeAuditEvent(conn, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "ROL_CUSTOM",
    entidadId: r.rows[0].id_rol,
    accion: "CREATE",
    despues: r.rows[0],
  });

  return { ...r.rows[0], permisos };
};

export const updateRolCustom = async ({
  db,
  auth,
  scope,
  idRol,
  body,
  requestMeta,
}) => {
  const conn = resolveDb(db);
  // Solo se puede editar un rol custom propio de la empresa, NO los globales
  const cur = await conn.query(
    `select * from roles where id_rol = $1 and id_empresa = $2 and es_sistema = false`,
    [idRol, auth.id_empresa]
  );
  if (cur.rowCount === 0) {
    throw HttpError.notFound("Rol custom no encontrado o no editable");
  }
  const before = cur.rows[0];

  const updates = [];
  const params = [];
  let i = 1;

  if (body?.nombre !== undefined) {
    updates.push(`nombre = $${i}`);
    params.push(String(body.nombre).trim());
    i += 1;
  }
  if (body?.descripcion !== undefined) {
    updates.push(`descripcion = $${i}`);
    params.push(body.descripcion);
    i += 1;
  }
  if (body?.permisos !== undefined) {
    const permisos = normalizePermisos(body.permisos);
    updates.push(`permisos = $${i}::jsonb`);
    params.push(JSON.stringify(permisos));
    i += 1;
  }

  if (updates.length === 0) {
    throw HttpError.badRequest("nada que actualizar");
  }

  params.push(idRol, auth.id_empresa);

  const r = await conn.query(
    `update roles set ${updates.join(", ")}
     where id_rol = $${i} and id_empresa = $${i + 1}
     returning *`,
    params
  );

  // Si cambiaron los permisos del rol, invalidamos los JWT existentes de los
  // usuarios que tienen este rol (bumpeamos token_valid_from). En el proximo
  // request, su token sera rechazado y deberan re-loguearse (donde recibiran
  // los permisos nuevos).
  if (body?.permisos !== undefined) {
    const affected = await conn.query(
      `update usuarios u
        set token_valid_from = now()
        from usuarios_roles ur
        where ur.id_empresa = $1
          and ur.id_rol = $2
          and ur.id_usuario = u.id_usuario
        returning u.id_usuario`,
      [auth.id_empresa, idRol]
    );
    // Limpiar cache local de authenticate para cada usuario afectado
    for (const row of affected.rows) {
      invalidateAuthCache(row.id_usuario);
    }
  }

  await writeAuditEvent(conn, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "ROL_CUSTOM",
    entidadId: idRol,
    accion: "UPDATE",
    antes: before,
    despues: r.rows[0],
  });

  return r.rows[0];
};

export const deleteRolCustom = async ({
  db,
  auth,
  scope,
  idRol,
  requestMeta,
}) => {
  const conn = resolveDb(db);
  // No se pueden borrar globales
  const cur = await conn.query(
    `select * from roles where id_rol = $1 and id_empresa = $2 and es_sistema = false`,
    [idRol, auth.id_empresa]
  );
  if (cur.rowCount === 0) {
    throw HttpError.notFound("Rol custom no encontrado o no eliminable");
  }

  // Verificar que ningún usuario lo tenga asignado
  const enUso = await conn.query(
    `select count(*)::int as n from usuarios_roles where id_empresa = $1 and id_rol = $2`,
    [auth.id_empresa, idRol]
  );
  if (Number(enUso.rows[0].n) > 0) {
    throw HttpError.conflict(
      `No se puede eliminar: ${enUso.rows[0].n} usuario(s) tienen este rol asignado`
    );
  }

  await conn.query(`delete from roles where id_rol = $1 and id_empresa = $2`, [
    idRol,
    auth.id_empresa,
  ]);

  await writeAuditEvent(conn, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "ROL_CUSTOM",
    entidadId: idRol,
    accion: "DELETE",
    antes: cur.rows[0],
  });

  return { ok: true };
};
