import { pool } from "../config/db.js";

export const getProveedoresActivos = async () => {
  const result = await pool.query(`
    SELECT id_proveedor, nombre, nit, telefono, correo, direccion, estado, created_at, updated_at, created_by, updated_by, inactivado_en, inactivado_por
    FROM "Proveedor"
    WHERE estado = true
    ORDER BY nombre ASC
  `);

  return result.rows;
};

export const getProveedores = async ({ incluirInactivos = false } = {}) => {
  const result = await pool.query(
    `
      SELECT id_proveedor, nombre, nit, telefono, correo, direccion, estado, created_at
           , updated_at, created_by, updated_by, inactivado_en, inactivado_por
      FROM "Proveedor"
      WHERE $1::boolean = true OR estado = true
      ORDER BY estado DESC, nombre ASC
    `,
    [incluirInactivos]
  );

  return result.rows;
};

export const existsProveedorByNit = async (nit, excludeId = null) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM "Proveedor"
      WHERE UPPER(TRIM(nit)) = UPPER(TRIM($1))
        AND ($2::int IS NULL OR id_proveedor <> $2)
      LIMIT 1
    `,
    [nit, excludeId]
  );

  return result.rowCount > 0;
};

export const createProveedor = async ({
  nombre,
  nit,
  telefono = null,
  correo = null,
  direccion = null,
  actorId = null,
}) => {
  const result = await pool.query(
    `
      INSERT INTO "Proveedor" (nombre, nit, telefono, correo, direccion, estado, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, true, $6, $6)
      RETURNING id_proveedor, nombre, nit, telefono, correo, direccion, estado, created_at, updated_at, created_by, updated_by, inactivado_en, inactivado_por
    `,
    [nombre, nit, telefono, correo, direccion, actorId]
  );

  return result.rows[0];
};

export const updateProveedor = async (
  id_proveedor,
  { nombre, nit, telefono = null, correo = null, direccion = null },
  actorId = null
) => {
  const result = await pool.query(
    `
      UPDATE "Proveedor"
      SET nombre = $1,
          nit = $2,
          telefono = $3,
          correo = $4,
          direccion = $5,
          updated_by = $6
      WHERE id_proveedor = $7
      RETURNING id_proveedor, nombre, nit, telefono, correo, direccion, estado, created_at, updated_at, created_by, updated_by, inactivado_en, inactivado_por
    `,
    [nombre, nit, telefono, correo, direccion, actorId, id_proveedor]
  );

  return result.rows[0];
};

export const desactivarProveedor = async (id_proveedor, actorId = null) => {
  const result = await pool.query(
    `
      UPDATE "Proveedor"
      SET estado = false,
          inactivado_en = now(),
          inactivado_por = $2,
          updated_by = $2
      WHERE id_proveedor = $1
        AND estado = true
      RETURNING id_proveedor, nombre, nit, telefono, correo, direccion, estado, created_at, updated_at, created_by, updated_by, inactivado_en, inactivado_por
    `,
    [id_proveedor, actorId]
  );

  return result.rows[0];
};
