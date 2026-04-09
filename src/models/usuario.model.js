import { pool } from "../config/db.js";

export const getUsuarioByUsername = async (username) => {
  const r = await pool.query(
    `SELECT id_usuario, username, password_hash, nombre, activo
     FROM usuario
     WHERE username = $1
     LIMIT 1`,
    [username]
  );
  return r.rows[0];
};

export const getRolesByUsuario = async (id_usuario) => {
  const r = await pool.query(
    `SELECT r.id_rol, r.nombre_rol
     FROM "Detalle_usuario" du
     JOIN "Rol" r ON r.id_rol = du.id_rol
     WHERE du.id_usuario = $1
       AND COALESCE(du.activo, true) = true
     ORDER BY r.nombre_rol`,
    [id_usuario]
  );
  return r.rows; // [{id_rol, nombre_rol}, ...]
};

export const createUsuario = async ({
  username,
  password_hash,
  nombre,
  activo = true,
  created_by = null,
}) => {
  const r = await pool.query(
    `INSERT INTO "Usuario" (username, password_hash, nombre, activo, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$5)
     RETURNING id_usuario, username, nombre, activo`,
    [username, password_hash, nombre, activo, created_by]
  );
  return r.rows[0];
};

export const addRolToUsuario = async (id_usuario, id_rol, actorId = null) => {
  const existing = await pool.query(
    `SELECT id_usuario, id_rol, COALESCE(activo, true) AS activo
     FROM "Detalle_usuario"
     WHERE id_usuario = $1 AND id_rol = $2
     LIMIT 1`,
    [id_usuario, id_rol]
  );

  if (existing.rowCount > 0) {
    if (existing.rows[0].activo) {
      return existing.rows[0];
    }

    const reactivated = await pool.query(
      `UPDATE "Detalle_usuario"
       SET activo = true,
           inactivado_en = null,
           inactivado_por = null,
           updated_by = $3
       WHERE id_usuario = $1 AND id_rol = $2
       RETURNING id_usuario, id_rol`,
      [id_usuario, id_rol, actorId]
    );

    return reactivated.rows[0];
  }

  const r = await pool.query(
    `INSERT INTO "Detalle_usuario" (id_usuario, id_rol, activo, created_by, updated_by)
     VALUES ($1,$2,true,$3,$3)
     RETURNING id_usuario, id_rol`,
    [id_usuario, id_rol, actorId]
  );
  return r.rows[0];
};
