import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";

export const listBySucursal = async ({ auth, idSucursal }) => {
  const r = await pool.query(
    `select * from bodegas
     where id_empresa = $1 and id_sucursal = $2
     order by es_principal desc, nombre asc`,
    [auth.id_empresa, idSucursal]
  );
  return r.rows;
};

export const listEmpresa = async ({ auth }) => {
  const r = await pool.query(
    `select b.*, s.nombre as sucursal_nombre
     from bodegas b
     inner join sucursales s on s.id_empresa = b.id_empresa and s.id_sucursal = b.id_sucursal
     where b.id_empresa = $1
     order by s.nombre asc, b.es_principal desc, b.nombre asc`,
    [auth.id_empresa]
  );
  return r.rows;
};

export const create = async ({ auth, scope, body, requestMeta }) => {
  const idSucursal = Number(body?.id_sucursal);
  const codigo = String(body?.codigo || "").trim().toUpperCase();
  const nombre = String(body?.nombre || "").trim();

  if (!Number.isInteger(idSucursal) || !codigo || !nombre) {
    throw HttpError.badRequest("id_sucursal, codigo y nombre son requeridos");
  }

  const r = await pool.query(
    `
      insert into bodegas (
        id_empresa, id_sucursal, codigo, nombre, descripcion, ubicacion,
        es_principal, activa, created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      returning *
    `,
    [
      auth.id_empresa,
      idSucursal,
      codigo,
      nombre,
      body?.descripcion || null,
      body?.ubicacion || null,
      body?.es_principal === true,
      body?.activa !== false,
      auth.id_usuario,
    ]
  ).catch((e) => {
    if (String(e.message).includes("uq_bodegas_principal_por_sucursal")) {
      throw HttpError.conflict("Ya existe una bodega principal en esta sucursal");
    }
    throw e;
  });

  await writeAuditEvent(pool, {
    auth, scope, requestMeta,
    modulo: "BODEGAS", entidad: "BODEGA",
    entidadId: r.rows[0].id_bodega, accion: "CREATE",
    despues: r.rows[0],
  });
  return r.rows[0];
};

export const update = async ({ auth, idBodega, body }) => {
  const updates = [];
  const params = [];
  let i = 1;

  for (const [key, col] of Object.entries({
    nombre: "nombre",
    descripcion: "descripcion",
    ubicacion: "ubicacion",
    activa: "activa",
  })) {
    if (body?.[key] !== undefined) {
      updates.push(`${col} = $${i}`);
      params.push(body[key]);
      i += 1;
    }
  }

  if (updates.length === 0) {
    throw HttpError.badRequest("nada que actualizar");
  }

  updates.push(`updated_by = $${i}`);
  params.push(auth.id_usuario);
  params.push(auth.id_empresa, idBodega);

  const r = await pool.query(
    `update bodegas set ${updates.join(", ")}
     where id_empresa = $${i + 1} and id_bodega = $${i + 2}
     returning *`,
    params
  );
  if (r.rowCount === 0) throw HttpError.notFound("Bodega no encontrada");
  return r.rows[0];
};

/**
 * Resuelve la bodega "principal" de una sucursal (la que se usa por defecto
 * en operaciones que no especifican bodega).
 */
export const getPrincipalSucursal = async (client, { idEmpresa, idSucursal }) => {
  const r = await client.query(
    `select id_bodega from bodegas
     where id_empresa = $1 and id_sucursal = $2 and es_principal = true and activa = true
     limit 1`,
    [idEmpresa, idSucursal]
  );
  return r.rows[0]?.id_bodega || null;
};
