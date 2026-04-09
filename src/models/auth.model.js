import { pool } from "../config/db.js";

export const getUsuarioByUsername = async (username) => {
  const r = await pool.query(
    `SELECT id_usuario, username, password_hash, nombre, activo
     FROM "Usuario"
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

export const updateUsuarioPasswordHash = async (id_usuario, password_hash, actorId = null) => {
  const r = await pool.query(
    `UPDATE "Usuario"
     SET password_hash = $1,
         updated_by = $3
     WHERE id_usuario = $2
     RETURNING id_usuario, username, nombre, activo`,
    [password_hash, id_usuario, actorId]
  );
  return r.rows[0];
};
