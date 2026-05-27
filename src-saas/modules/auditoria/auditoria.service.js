import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

export const listAuditoriaEventos = async ({ auth, query }) => {
  if (!Array.isArray(auth?.permisos) || !auth.permisos.includes("audit.read")) {
    throw HttpError.forbidden("No tienes permiso para consultar auditoria");
  }

  const filters = ["ae.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (query?.modulo) {
    filters.push(`ae.modulo = $${index}`);
    params.push(String(query.modulo).trim().toUpperCase());
    index += 1;
  }

  if (query?.entidad) {
    filters.push(`ae.entidad = $${index}`);
    params.push(String(query.entidad).trim().toUpperCase());
    index += 1;
  }

  if (query?.accion) {
    filters.push(`ae.accion = $${index}`);
    params.push(String(query.accion).trim().toUpperCase());
    index += 1;
  }

  if (query?.id_usuario) {
    const userId = Number(query.id_usuario);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw HttpError.badRequest("id_usuario invalido");
    }
    filters.push(`ae.id_usuario = $${index}`);
    params.push(userId);
    index += 1;
  }

  if (query?.desde) {
    filters.push(`ae.created_at::date >= $${index}::date`);
    params.push(String(query.desde).trim());
    index += 1;
  }

  if (query?.hasta) {
    filters.push(`ae.created_at::date <= $${index}::date`);
    params.push(String(query.hasta).trim());
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(u.username, '') ilike $${index} or coalesce(ae.entidad, '') ilike $${index} or cast(ae.entidad_id as text) = $${index + 1} or coalesce(ae.modulo, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    params.push(String(query.search).trim());
    index += 2;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 50, 100));
  params.push(limit);

  const result = await pool.query(
    `
      select
        ae.*,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        s.codigo as sucursal_codigo,
        s.nombre as sucursal_nombre
      from auditoria_eventos ae
      left join usuarios u
        on u.id_empresa = ae.id_empresa
       and u.id_usuario = ae.id_usuario
      left join sucursales s
        on s.id_empresa = ae.id_empresa
       and s.id_sucursal = ae.id_sucursal
      where ${filters.join(" and ")}
      order by ae.created_at desc, ae.id_auditoria desc
      limit $${index}
    `,
    params
  );

  return result.rows;
};
