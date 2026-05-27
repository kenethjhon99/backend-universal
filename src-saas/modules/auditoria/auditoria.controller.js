import { asyncHandler } from "../../shared/http/async-handler.js";
import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import * as service from "./auditoria.service.js";
import { computeDiff, summarizeDiff } from "./diff.js";

export const listAuditoriaEventos = asyncHandler(async (req, res) => {
  const data = await service.listAuditoriaEventos({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

/**
 * Devuelve el diff completo entre `datos_antes` y `datos_despues` de un
 * evento de auditoria. Si el evento no tiene datos_antes (ej. CREATE),
 * devuelve los datos_despues marcados todos como "added".
 */
export const getEventoDiff = asyncHandler(async (req, res) => {
  const idAuditoria = Number(req.params.id);
  if (!Number.isInteger(idAuditoria) || idAuditoria <= 0) {
    throw HttpError.badRequest("id invalido");
  }

  const result = await pool.query(
    `
      select id_auditoria, modulo, entidad, entidad_id, accion,
             datos_antes, datos_despues, created_at, id_usuario
      from auditoria_eventos
      where id_empresa = $1 and id_auditoria = $2
      limit 1
    `,
    [req.auth.id_empresa, idAuditoria]
  );

  if (result.rowCount === 0) {
    throw HttpError.notFound("Evento de auditoria no encontrado");
  }

  const ev = result.rows[0];
  const antes = ev.datos_antes || {};
  const despues = ev.datos_despues || {};

  const diff = summarizeDiff(antes, despues, 100);

  res.json({
    ok: true,
    data: {
      ...ev,
      diff,
    },
  });
});

/**
 * Devuelve TODO el historial de cambios de una entidad concreta, con diff
 * computado por evento. Util para "ver el linaje" de una venta, producto, etc.
 */
export const getEntityHistory = asyncHandler(async (req, res) => {
  const { entidad, entidadId } = req.params;
  if (!entidad || !entidadId) {
    throw HttpError.badRequest("entidad y entidadId son requeridos");
  }

  const result = await pool.query(
    `
      select ae.id_auditoria, ae.accion, ae.modulo,
             ae.datos_antes, ae.datos_despues,
             ae.created_at, ae.id_usuario,
             u.username as usuario_username,
             concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from auditoria_eventos ae
      left join usuarios u
        on u.id_empresa = ae.id_empresa and u.id_usuario = ae.id_usuario
      where ae.id_empresa = $1
        and upper(ae.entidad) = upper($2)
        and ae.entidad_id = $3
      order by ae.created_at asc
      limit 200
    `,
    [req.auth.id_empresa, entidad, Number(entidadId)]
  );

  const eventos = result.rows.map((ev) => {
    const antes = ev.datos_antes || {};
    const despues = ev.datos_despues || {};
    return {
      id_auditoria: Number(ev.id_auditoria),
      accion: ev.accion,
      modulo: ev.modulo,
      usuario: ev.usuario_nombre || ev.usuario_username || "Sistema",
      created_at: ev.created_at,
      diff: summarizeDiff(antes, despues, 50),
    };
  });

  res.json({ ok: true, data: { entidad, entidadId: Number(entidadId), eventos } });
});
