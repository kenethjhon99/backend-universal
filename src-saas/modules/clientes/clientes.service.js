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

const normalizeClientePayload = (body = {}, current = null) => ({
  codigo:
    body?.codigo !== undefined
      ? normalizeUpper(body.codigo)
      : current?.codigo || null,
  nit:
    body?.nit !== undefined ? normalizeUpper(body.nit) : current?.nit || null,
  dui:
    body?.dui !== undefined ? normalizeUpper(body.dui) : current?.dui || null,
  nombre:
    body?.nombre !== undefined
      ? String(body.nombre || "").trim()
      : current?.nombre || "",
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

const getClienteByField = async (
  db,
  { idEmpresa, fieldName, value, excludeId = null }
) => {
  if (!value) {
    return null;
  }

  const result = await db.query(
    `
      select id_cliente
      from clientes
      where id_empresa = $1
        and ${fieldName} = $2
        and ($3::bigint is null or id_cliente <> $3)
      limit 1
    `,
    [idEmpresa, value, excludeId]
  );

  return result.rows[0] || null;
};

const ensureClienteUniqueness = async (
  db,
  { idEmpresa, codigo, nit, email, excludeId = null }
) => {
  if (codigo) {
    const duplicateCode = await getClienteByField(db, {
      idEmpresa,
      fieldName: "codigo",
      value: codigo,
      excludeId,
    });

    if (duplicateCode) {
      throw HttpError.conflict("Ya existe un cliente con ese codigo");
    }
  }

  if (nit) {
    const duplicateNit = await getClienteByField(db, {
      idEmpresa,
      fieldName: "nit",
      value: nit,
      excludeId,
    });

    if (duplicateNit) {
      throw HttpError.conflict("Ya existe un cliente con ese NIT");
    }
  }

  if (email) {
    const duplicateEmail = await getClienteByField(db, {
      idEmpresa,
      fieldName: "email",
      value: email,
      excludeId,
    });

    if (duplicateEmail) {
      throw HttpError.conflict("Ya existe un cliente con ese email");
    }
  }
};

const getClienteBaseQuery = () => `
  select
    c.id_cliente,
    c.id_empresa,
    c.codigo,
    c.nombre,
    c.nit,
    c.dui,
    c.telefono,
    c.email,
    c.direccion,
    c.activo,
    c.created_at,
    c.updated_at
  from clientes c
`;

export const listClientes = async ({ auth, query }) => {
  const filters = ["c.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (!normalizeBoolean(query?.incluir_inactivos, false)) {
    filters.push("c.activo = true");
  }

  if (query?.search) {
    filters.push(
      `(c.nombre ilike $${index} or coalesce(c.codigo, '') ilike $${index} or coalesce(c.nit, '') ilike $${index} or coalesce(c.email, '') ilike $${index} or coalesce(c.telefono, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const result = await pool.query(
    `
      ${getClienteBaseQuery()}
      where ${filters.join(" and ")}
      order by c.activo desc, c.nombre asc, c.codigo asc nulls last
    `,
    params
  );

  return result.rows;
};

export const getClienteById = async ({ auth, idCliente }) => {
  const result = await pool.query(
    `
      ${getClienteBaseQuery()}
      where c.id_empresa = $1
        and c.id_cliente = $2
      limit 1
    `,
    [auth.id_empresa, idCliente]
  );

  const cliente = result.rows[0];

  if (!cliente) {
    throw HttpError.notFound("Cliente no encontrado");
  }

  return cliente;
};

export const createCliente = async ({ auth, body }) =>
  runInTransaction(
    async (client) => {
      const payload = normalizeClientePayload(body);

      if (!payload.nombre) {
        throw HttpError.badRequest("nombre es requerido");
      }

      if (!payload.codigo) {
        payload.codigo = await getNextTenantCode(client, {
          entityKey: "CLIENTES",
          idEmpresa: auth.id_empresa,
        });
      }

      await ensureClienteUniqueness(client, {
        idEmpresa: auth.id_empresa,
        codigo: payload.codigo,
        nit: payload.nit,
        email: payload.email,
      });

      const result = await client.query(
        `
          insert into clientes (
            id_empresa,
            codigo,
            nombre,
            nit,
            dui,
            telefono,
            email,
            direccion,
            activo,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
          returning id_cliente
        `,
        [
          auth.id_empresa,
          payload.codigo,
          payload.nombre,
          payload.nit,
          payload.dui,
          payload.telefono,
          payload.email,
          payload.direccion,
          payload.activo,
          auth.id_usuario,
        ]
      );

      return getClienteById({
        auth,
        idCliente: result.rows[0].id_cliente,
      });
    },
    { auth }
  );

export const updateCliente = async ({ auth, idCliente, body }) =>
  runInTransaction(
    async (client) => {
      const existing = await getClienteById({ auth, idCliente });
      const payload = normalizeClientePayload(body, existing);

      if (!payload.nombre) {
        throw HttpError.badRequest("nombre es requerido");
      }

      await ensureClienteUniqueness(client, {
        idEmpresa: auth.id_empresa,
        codigo: payload.codigo,
        nit: payload.nit,
        email: payload.email,
        excludeId: idCliente,
      });

      await client.query(
        `
          update clientes
          set
            codigo = $1,
            nombre = $2,
            nit = $3,
            dui = $4,
            telefono = $5,
            email = $6,
            direccion = $7,
            activo = $8,
            updated_by = $9
          where id_empresa = $10
            and id_cliente = $11
        `,
        [
          payload.codigo,
          payload.nombre,
          payload.nit,
          payload.dui,
          payload.telefono,
          payload.email,
          payload.direccion,
          payload.activo,
          auth.id_usuario,
          auth.id_empresa,
          idCliente,
        ]
      );

      return getClienteById({ auth, idCliente });
    },
    { auth }
  );

export const deactivateCliente = async ({ auth, idCliente }) =>
  setClienteEstado({ auth, idCliente, activo: false });

// G8 - setClienteEstado: permite activar / desactivar coherentemente.
export const setClienteEstado = async ({ auth, idCliente, activo }) => {
  if (typeof activo !== "boolean") {
    throw HttpError.badRequest("activo debe ser boolean (true|false)");
  }

  const result = await pool.query(
    `
      update clientes
      set activo = $1,
          updated_by = $2
      where id_empresa = $3
        and id_cliente = $4
      returning id_cliente
    `,
    [activo, auth.id_usuario, auth.id_empresa, idCliente]
  );

  if (result.rowCount === 0) {
    throw HttpError.notFound("Cliente no encontrado");
  }

  return getClienteById({ auth, idCliente });
};
