import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getNextTenantCode } from "../../shared/saas/tenant-code.js";

const normalizeUpper = (value) =>
  String(value || "").trim().toUpperCase() || null;

const normalizeText = (value) => String(value || "").trim() || null;
const normalizeEmail = (value) => String(value || "").trim().toLowerCase() || null;

const normalizeBoolean = (value, fallback = true) => {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() !== "false";
};

const normalizeProveedorPayload = (body = {}, current = null) => ({
  codigo:
    body?.codigo !== undefined
      ? normalizeUpper(body.codigo)
      : current?.codigo || null,
  nombre:
    body?.nombre !== undefined
      ? String(body.nombre || "").trim()
      : current?.nombre || "",
  nit:
    body?.nit !== undefined ? normalizeUpper(body.nit) : current?.nit || null,
  telefono:
    body?.telefono !== undefined
      ? normalizeText(body.telefono)
      : current?.telefono || null,
  email:
    body?.email !== undefined
      ? normalizeEmail(body.email)
      : current?.email || null,
  direccion:
    body?.direccion !== undefined
      ? normalizeText(body.direccion)
      : current?.direccion || null,
  activo:
    body?.activo !== undefined
      ? normalizeBoolean(body.activo)
      : current?.activo ?? true,
});

const getProveedorByField = async (
  db,
  { idEmpresa, fieldName, value, excludeId = null }
) => {
  if (!value) {
    return null;
  }

  const result = await db.query(
    `
      select id_proveedor
      from proveedores
      where id_empresa = $1
        and ${fieldName} = $2
        and ($3::bigint is null or id_proveedor <> $3)
      limit 1
    `,
    [idEmpresa, value, excludeId]
  );

  return result.rows[0] || null;
};

const ensureProveedorUniqueness = async (
  db,
  { idEmpresa, codigo, nit, email, excludeId = null }
) => {
  if (codigo) {
    const duplicateCode = await getProveedorByField(db, {
      idEmpresa,
      fieldName: "codigo",
      value: codigo,
      excludeId,
    });

    if (duplicateCode) {
      throw HttpError.conflict("Ya existe un proveedor con ese codigo");
    }
  }

  if (nit) {
    const duplicateNit = await getProveedorByField(db, {
      idEmpresa,
      fieldName: "nit",
      value: nit,
      excludeId,
    });

    if (duplicateNit) {
      throw HttpError.conflict("Ya existe un proveedor con ese NIT");
    }
  }

  if (email) {
    const duplicateEmail = await getProveedorByField(db, {
      idEmpresa,
      fieldName: "email",
      value: email,
      excludeId,
    });

    if (duplicateEmail) {
      throw HttpError.conflict("Ya existe un proveedor con ese email");
    }
  }
};

const getProveedorBaseQuery = () => `
  select
    p.id_proveedor,
    p.id_empresa,
    p.codigo,
    p.nombre,
    p.nit,
    p.telefono,
    p.email,
    p.direccion,
    p.activo,
    p.created_at,
    p.updated_at
  from proveedores p
`;

export const listProveedores = async ({ auth, query }) => {
  const filters = ["p.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (!normalizeBoolean(query?.incluir_inactivos, false)) {
    filters.push("p.activo = true");
  }

  if (query?.search) {
    filters.push(
      `(p.nombre ilike $${index} or coalesce(p.codigo, '') ilike $${index} or coalesce(p.nit, '') ilike $${index} or coalesce(p.email, '') ilike $${index} or coalesce(p.telefono, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const result = await pool.query(
    `
      ${getProveedorBaseQuery()}
      where ${filters.join(" and ")}
      order by p.activo desc, p.nombre asc, p.codigo asc nulls last
    `,
    params
  );

  return result.rows;
};

export const getProveedorById = async ({ auth, idProveedor }) => {
  const result = await pool.query(
    `
      ${getProveedorBaseQuery()}
      where p.id_empresa = $1
        and p.id_proveedor = $2
      limit 1
    `,
    [auth.id_empresa, idProveedor]
  );

  const proveedor = result.rows[0];

  if (!proveedor) {
    throw HttpError.notFound("Proveedor no encontrado");
  }

  return proveedor;
};

export const createProveedor = async ({ auth, body }) =>
  runInTransaction(
    async (client) => {
      const payload = normalizeProveedorPayload(body);

      if (!payload.nombre) {
        throw HttpError.badRequest("nombre es requerido");
      }

      if (!payload.codigo) {
        payload.codigo = await getNextTenantCode(client, {
          entityKey: "PROVEEDORES",
          idEmpresa: auth.id_empresa,
        });
      }

      await ensureProveedorUniqueness(client, {
        idEmpresa: auth.id_empresa,
        codigo: payload.codigo,
        nit: payload.nit,
        email: payload.email,
      });

      const result = await client.query(
        `
          insert into proveedores (
            id_empresa,
            codigo,
            nombre,
            nit,
            telefono,
            email,
            direccion,
            activo,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
          returning id_proveedor
        `,
        [
          auth.id_empresa,
          payload.codigo,
          payload.nombre,
          payload.nit,
          payload.telefono,
          payload.email,
          payload.direccion,
          payload.activo,
          auth.id_usuario,
        ]
      );

      return getProveedorById({
        auth,
        idProveedor: result.rows[0].id_proveedor,
      });
    },
    { auth }
  );

export const updateProveedor = async ({ auth, idProveedor, body }) =>
  runInTransaction(
    async (client) => {
      const existing = await getProveedorById({ auth, idProveedor });
      const payload = normalizeProveedorPayload(body, existing);

      if (!payload.nombre) {
        throw HttpError.badRequest("nombre es requerido");
      }

      await ensureProveedorUniqueness(client, {
        idEmpresa: auth.id_empresa,
        codigo: payload.codigo,
        nit: payload.nit,
        email: payload.email,
        excludeId: idProveedor,
      });

      await client.query(
        `
          update proveedores
          set
            codigo = $1,
            nombre = $2,
            nit = $3,
            telefono = $4,
            email = $5,
            direccion = $6,
            activo = $7,
            updated_by = $8
          where id_empresa = $9
            and id_proveedor = $10
        `,
        [
          payload.codigo,
          payload.nombre,
          payload.nit,
          payload.telefono,
          payload.email,
          payload.direccion,
          payload.activo,
          auth.id_usuario,
          auth.id_empresa,
          idProveedor,
        ]
      );

      return getProveedorById({ auth, idProveedor });
    },
    { auth }
  );

export const deactivateProveedor = async ({ auth, idProveedor }) =>
  setProveedorEstado({ auth, idProveedor, activo: false });

// G8 - setProveedorEstado: permite activar / desactivar coherentemente.
export const setProveedorEstado = async ({ auth, idProveedor, activo }) => {
  if (typeof activo !== "boolean") {
    throw HttpError.badRequest("activo debe ser boolean (true|false)");
  }

  const result = await pool.query(
    `
      update proveedores
      set activo = $1,
          updated_by = $2
      where id_empresa = $3
        and id_proveedor = $4
      returning id_proveedor
    `,
    [activo, auth.id_usuario, auth.id_empresa, idProveedor]
  );

  if (result.rowCount === 0) {
    throw HttpError.notFound("Proveedor no encontrado");
  }

  return getProveedorById({ auth, idProveedor });
};
