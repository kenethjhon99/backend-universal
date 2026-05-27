import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { notify } from "../notificaciones/notificaciones.service.js";
import { HttpError } from "../../shared/http/http-error.js";

const TICKET_STATES = ["ABIERTO", "EN_PROGRESO", "RESUELTO", "CERRADO"];
const PRIORIDADES = ["BAJA", "MEDIA", "ALTA", "CRITICA"];

const generateTicketNumber = async (client, idEmpresa) => {
  const r = await client.query(
    `select coalesce(max(cast(substring(numero from 'TKT-(\\d+)') as integer)), 0) + 1 as next
     from tickets where id_empresa = $1`,
    [idEmpresa]
  );
  const next = Number(r.rows[0].next || 1);
  return `TKT-${String(next).padStart(8, "0")}`;
};

// ============================================================
// CRUD basico
// ============================================================

export const list = async ({ auth, query }) => {
  const filters = ["t.id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.estado) {
    filters.push(`t.estado = $${i}`);
    params.push(String(query.estado).toUpperCase());
    i += 1;
  }
  if (query?.prioridad) {
    filters.push(`t.prioridad = $${i}`);
    params.push(String(query.prioridad).toUpperCase());
    i += 1;
  }
  if (query?.id_asignado) {
    filters.push(`t.id_asignado = $${i}`);
    params.push(Number(query.id_asignado));
    i += 1;
  }
  if (query?.mios === "true") {
    filters.push(`t.id_creador = $${i}`);
    params.push(auth.id_usuario);
    i += 1;
  }

  const result = await pool.query(
    `
      select
        t.*,
        uc.username as creador_username,
        concat(uc.nombre, ' ', uc.apellido) as creador_nombre,
        ua.username as asignado_username,
        concat(ua.nombre, ' ', ua.apellido) as asignado_nombre
      from tickets t
      inner join usuarios uc on uc.id_empresa = t.id_empresa and uc.id_usuario = t.id_creador
      left join usuarios ua on ua.id_empresa = t.id_empresa and ua.id_usuario = t.id_asignado
      where ${filters.join(" and ")}
      order by
        case t.estado when 'ABIERTO' then 0 when 'EN_PROGRESO' then 1 when 'RESUELTO' then 2 else 3 end,
        case t.prioridad when 'CRITICA' then 0 when 'ALTA' then 1 when 'MEDIA' then 2 else 3 end,
        t.created_at desc
      limit 200
    `,
    params
  );
  return result.rows;
};

export const getById = async ({ auth, idTicket }) => {
  const tResult = await pool.query(
    `
      select t.*,
             uc.username as creador_username,
             concat(uc.nombre, ' ', uc.apellido) as creador_nombre,
             ua.username as asignado_username,
             concat(ua.nombre, ' ', ua.apellido) as asignado_nombre
      from tickets t
      inner join usuarios uc on uc.id_empresa = t.id_empresa and uc.id_usuario = t.id_creador
      left join usuarios ua on ua.id_empresa = t.id_empresa and ua.id_usuario = t.id_asignado
      where t.id_empresa = $1 and t.id_ticket = $2
    `,
    [auth.id_empresa, idTicket]
  );
  if (tResult.rowCount === 0) throw HttpError.notFound("Ticket no encontrado");

  const mResult = await pool.query(
    `
      select m.*,
             u.username, concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from tickets_mensajes m
      inner join usuarios u on u.id_empresa = m.id_empresa and u.id_usuario = m.id_usuario
      where m.id_empresa = $1 and m.id_ticket = $2
      order by m.created_at asc
    `,
    [auth.id_empresa, idTicket]
  );

  return { ticket: tResult.rows[0], mensajes: mResult.rows };
};

export const create = async ({ auth, scope, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const titulo = String(body?.titulo || "").trim();
      if (!titulo) throw HttpError.badRequest("titulo es requerido");

      const prioridad = String(body?.prioridad || "MEDIA").toUpperCase();
      if (!PRIORIDADES.includes(prioridad)) {
        throw HttpError.badRequest(`prioridad invalida. Validas: ${PRIORIDADES.join(", ")}`);
      }

      const numero = await generateTicketNumber(client, auth.id_empresa);

      const insert = await client.query(
        `
          insert into tickets (
            id_empresa, numero, titulo, descripcion, categoria, prioridad,
            estado, id_creador, id_asignado, referencia_tipo, referencia_id,
            created_by, updated_by
          )
          values ($1, $2, $3, $4, $5, $6, 'ABIERTO', $7, $8, $9, $10, $7, $7)
          returning *
        `,
        [
          auth.id_empresa,
          numero,
          titulo,
          body?.descripcion || null,
          body?.categoria ? String(body.categoria).toUpperCase() : null,
          prioridad,
          auth.id_usuario,
          body?.id_asignado ? Number(body.id_asignado) : null,
          body?.referencia_tipo || null,
          body?.referencia_id ? Number(body.referencia_id) : null,
        ]
      );
      const ticket = insert.rows[0];

      // Si el creador escribió un mensaje inicial, lo registramos
      const mensajeInicial = String(body?.mensaje || "").trim();
      if (mensajeInicial) {
        await client.query(
          `
            insert into tickets_mensajes (id_empresa, id_ticket, id_usuario, contenido)
            values ($1, $2, $3, $4)
          `,
          [auth.id_empresa, ticket.id_ticket, auth.id_usuario, mensajeInicial]
        );
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "TICKETS",
        entidad: "TICKET",
        entidadId: ticket.id_ticket,
        accion: "CREATE",
        despues: ticket,
      });

      // Notificar a asignado y a admins (best-effort)
      notify({
        idEmpresa: auth.id_empresa,
        tipoEvento: "TICKET_CREADO",
        payload: {
          numero,
          titulo,
          prioridad,
          creador: auth.id_usuario,
          asignado: body?.id_asignado || null,
        },
      }).catch(() => {});

      return ticket;
    },
    { auth }
  );

export const addMessage = async ({ auth, idTicket, body }) => {
  const contenido = String(body?.contenido || "").trim();
  if (!contenido) throw HttpError.badRequest("contenido es requerido");

  return runInTransaction(
    async (client) => {
      const tResult = await client.query(
        `select estado from tickets where id_empresa = $1 and id_ticket = $2 for update`,
        [auth.id_empresa, idTicket]
      );
      if (tResult.rowCount === 0) throw HttpError.notFound("Ticket no encontrado");

      // Cambio de estado opcional en el mismo mensaje
      let cambioEstado = null;
      if (body?.cambio_estado) {
        const nuevo = String(body.cambio_estado).toUpperCase();
        if (!TICKET_STATES.includes(nuevo)) {
          throw HttpError.badRequest("cambio_estado invalido");
        }
        cambioEstado = nuevo;

        const updates = [`estado = $1`];
        const params = [nuevo, auth.id_usuario, auth.id_empresa, idTicket];
        let i = 2;
        if (nuevo === "RESUELTO") {
          updates.push(`id_resuelto_por = $${i}, resuelto_en = now()`);
          i += 1;
        }
        if (nuevo === "CERRADO") {
          updates.push(`cerrado_en = now()`);
        }
        updates.push(`updated_by = $${i}`);

        await client.query(
          `update tickets set ${updates.join(", ")} where id_empresa = $${i + 1} and id_ticket = $${i + 2}`,
          params
        );
      }

      const m = await client.query(
        `
          insert into tickets_mensajes (id_empresa, id_ticket, id_usuario, contenido, cambio_estado)
          values ($1, $2, $3, $4, $5)
          returning *
        `,
        [auth.id_empresa, idTicket, auth.id_usuario, contenido, cambioEstado]
      );

      return m.rows[0];
    },
    { auth }
  );
};

export const assign = async ({ auth, idTicket, idUsuarioAsignado }) => {
  const r = await pool.query(
    `update tickets
       set id_asignado = $1, updated_by = $2,
           estado = case when estado = 'ABIERTO' then 'EN_PROGRESO' else estado end
     where id_empresa = $3 and id_ticket = $4
     returning *`,
    [idUsuarioAsignado || null, auth.id_usuario, auth.id_empresa, idTicket]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Ticket no encontrado");
  return r.rows[0];
};

export const getStats = async ({ auth }) => {
  const r = await pool.query(
    `
      select
        count(*) filter (where estado = 'ABIERTO')::int as abiertos,
        count(*) filter (where estado = 'EN_PROGRESO')::int as en_progreso,
        count(*) filter (where estado = 'RESUELTO')::int as resueltos,
        count(*) filter (where estado = 'CERRADO')::int as cerrados,
        count(*) filter (where prioridad = 'CRITICA' and estado in ('ABIERTO','EN_PROGRESO'))::int as criticos_pendientes
      from tickets
      where id_empresa = $1
    `,
    [auth.id_empresa]
  );
  return r.rows[0];
};
