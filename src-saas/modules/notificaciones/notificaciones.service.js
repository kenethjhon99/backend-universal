import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { logger } from "../../shared/logging/logger.js";
import { dispatch } from "./dispatcher.js";

/**
 * Tipos de evento estandar que la app dispara.
 * Cada uno tiene un asunto y plantilla por defecto. La empresa puede sobrescribir
 * via canal.config.templates[tipo_evento].
 */
const EVENT_TEMPLATES = {
  STOCK_BAJO: {
    asunto: "Alerta de stock bajo",
    cuerpo: ({ producto, stock, minimo }) =>
      `El producto "${producto}" tiene stock ${stock} (minimo configurado ${minimo}).`,
  },
  CAJA_SIN_CERRAR: {
    asunto: "Caja con turno sin cerrar",
    cuerpo: ({ usuario, fecha_apertura }) =>
      `La caja de ${usuario} abierta el ${fecha_apertura} sigue sin cerrarse.`,
  },
  VENTA_GRANDE: {
    asunto: "Venta grande registrada",
    cuerpo: ({ numero, total, cajero }) =>
      `Venta ${numero} por ${total} registrada por ${cajero}.`,
  },
  NO_COBRADO: {
    asunto: "Venta NO_COBRADO registrada",
    cuerpo: ({ numero, total, motivo, cajero }) =>
      `Venta ${numero} por ${total} marcada como NO_COBRADO. Motivo: ${motivo}. Cajero: ${cajero}.`,
  },
  RECORDATORIO_SERVICIO: {
    asunto: "Recordatorio de servicio",
    cuerpo: ({ cliente, ultima_visita, servicio }) =>
      `Hola ${cliente}, han pasado mas de 90 dias desde tu ultimo ${servicio} (${ultima_visita}). Te esperamos!`,
  },
  // ----- Billing / Subscription -----
  WELCOME_USER: {
    asunto: "Bienvenido a TradeNova",
    cuerpo: ({ nombre, empresa, trial_dias }) =>
      `Hola ${nombre}, tu cuenta para "${empresa}" esta lista. ` +
      (trial_dias
        ? `Tienes ${trial_dias} dias de prueba gratis. Aprovecha para configurar productos, sucursales y empezar a operar.`
        : "Empieza a configurar tu sistema."),
  },
  BILLING_TRIAL_EXPIRING: {
    asunto: "Tu prueba gratuita vence pronto",
    cuerpo: ({ empresa, dias_restantes, trial_hasta }) =>
      `Tu periodo de prueba de "${empresa}" vence en ${dias_restantes} dia(s) (${trial_hasta}). ` +
      `Activa un plan para no interrumpir tu operacion. Si no actuas, la cuenta se suspendera automaticamente.`,
  },
  BILLING_PAYMENT_FAILED: {
    asunto: "No pudimos cobrar tu suscripcion",
    cuerpo: ({ empresa, plan }) =>
      `El cobro del plan ${plan || ""} para "${empresa}" no pudo procesarse. ` +
      `Verifica tu metodo de pago en la seccion de billing antes de que la cuenta se suspenda.`,
  },
  BILLING_SUSPENDED: {
    asunto: "Tu cuenta fue suspendida",
    cuerpo: ({ empresa, motivo }) =>
      `Lamentamos informarte que la cuenta de "${empresa}" fue suspendida. ` +
      `Motivo: ${motivo || "falta de pago"}. ` +
      `Para reactivarla, ingresa al sistema y completa el pago desde la pantalla de facturacion.`,
  },
  BILLING_CANCELLED: {
    asunto: "Tu suscripcion fue cancelada",
    cuerpo: ({ empresa }) =>
      `La suscripcion de "${empresa}" fue cancelada. Si fue un error o quieres reactivarla, ` +
      `contacta a soporte o activa un plan nuevo desde el sistema.`,
  },
  BILLING_REACTIVATED: {
    asunto: "Tu suscripcion esta activa",
    cuerpo: ({ empresa, plan }) =>
      `Listo! La cuenta de "${empresa}" se reactivo correctamente con el plan ${plan || ""}. ` +
      `Ya puedes operar normalmente.`,
  },
  PLAN_LIMIT_WARNING: {
    asunto: "Estas cerca del limite de tu plan",
    cuerpo: ({ empresa, recurso, current, max, plan }) =>
      `La cuenta de "${empresa}" lleva ${current} de ${max} ${recurso}(s) permitidos en el plan ${plan}. ` +
      `Cuando alcances el limite, no podras crear mas ${recurso}(s) hasta hacer upgrade.`,
  },
};

const getCanalesForEvent = async ({ idEmpresa, tipoEvento }) => {
  const result = await pool.query(
    `
      select * from notificaciones_canales
      where id_empresa = $1
        and activo = true
        and eventos @> to_jsonb($2::text[])
    `,
    [idEmpresa, [tipoEvento]]
  );
  return result.rows;
};

/**
 * Punto de entrada principal: dispara una notificacion por evento.
 * Encola un registro en notificaciones_eventos por cada canal suscrito,
 * intenta despachar inmediatamente y actualiza estado.
 */
export const notify = async ({ idEmpresa, tipoEvento, payload = {} }) => {
  const canales = await getCanalesForEvent({ idEmpresa, tipoEvento });

  if (canales.length === 0) {
    return { dispatched: 0, channels: 0 };
  }

  const template = EVENT_TEMPLATES[tipoEvento];
  if (!template) {
    logger.warn({ tipoEvento }, "evento de notificacion sin template");
  }

  const asunto = template?.asunto || tipoEvento;
  const cuerpo = template ? template.cuerpo(payload) : JSON.stringify(payload);

  let dispatched = 0;
  for (const canal of canales) {
    const ev = await pool.query(
      `
        insert into notificaciones_eventos (
          id_empresa, id_canal, tipo_evento, asunto, cuerpo,
          destinatarios, payload, estado
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'PENDIENTE')
        returning id_evento
      `,
      [
        idEmpresa,
        canal.id_canal,
        tipoEvento,
        asunto,
        cuerpo,
        JSON.stringify(canal.destinatarios || []),
        JSON.stringify(payload),
      ]
    );
    const idEvento = ev.rows[0].id_evento;

    try {
      await dispatch(canal, {
        asunto,
        cuerpo,
        destinatarios: canal.destinatarios || [],
        tipo_evento: tipoEvento,
        payload,
      });
      await pool.query(
        `update notificaciones_eventos
           set estado = 'ENVIADO',
               enviado_en = now(),
               intentos = intentos + 1
         where id_evento = $1`,
        [idEvento]
      );
      dispatched += 1;
    } catch (error) {
      logger.warn(
        { canal: canal.nombre, tipoEvento, err: error.message },
        "fallo al despachar notificacion"
      );
      await pool.query(
        `update notificaciones_eventos
           set estado = 'FALLIDO',
               intentos = intentos + 1,
               ultimo_error = $1
         where id_evento = $2`,
        [String(error.message || error).slice(0, 1000), idEvento]
      );
    }
  }

  return { dispatched, channels: canales.length };
};

// ============================================================
// CRUD de canales
// ============================================================

export const listCanales = async ({ auth }) => {
  const result = await pool.query(
    `select * from notificaciones_canales where id_empresa = $1 order by tipo asc, nombre asc`,
    [auth.id_empresa]
  );
  return result.rows;
};

export const createCanal = async ({ auth, scope, body, requestMeta }) => {
  const tipo = String(body?.tipo || "").toUpperCase();
  if (!["EMAIL", "WHATSAPP", "TELEGRAM", "WEBHOOK", "SMS"].includes(tipo)) {
    throw HttpError.badRequest("tipo invalido");
  }

  const insert = await pool.query(
    `
      insert into notificaciones_canales (
        id_empresa, tipo, nombre, config, activo, eventos, destinatarios,
        created_by, updated_by
      )
      values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $8)
      returning *
    `,
    [
      auth.id_empresa,
      tipo,
      String(body?.nombre || tipo).trim(),
      JSON.stringify(body?.config || {}),
      body?.activo !== false,
      JSON.stringify(Array.isArray(body?.eventos) ? body.eventos : []),
      JSON.stringify(Array.isArray(body?.destinatarios) ? body.destinatarios : []),
      auth.id_usuario,
    ]
  );

  const created = insert.rows[0];

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "NOTIFICACIONES",
    entidad: "CANAL",
    entidadId: created.id_canal,
    accion: "CREATE",
    despues: { ...created, config: undefined }, // no logear credenciales
  });

  return created;
};

export const listEventos = async ({ auth, query }) => {
  const filters = ["e.id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.tipo_evento) {
    filters.push(`e.tipo_evento = $${i}`);
    params.push(String(query.tipo_evento).toUpperCase());
    i += 1;
  }
  if (query?.estado) {
    filters.push(`e.estado = $${i}`);
    params.push(String(query.estado).toUpperCase());
    i += 1;
  }

  const result = await pool.query(
    `
      select e.*, c.nombre as canal_nombre, c.tipo as canal_tipo
      from notificaciones_eventos e
      left join notificaciones_canales c on c.id_canal = e.id_canal
      where ${filters.join(" and ")}
      order by e.created_at desc
      limit 100
    `,
    params
  );
  return result.rows;
};

export const sendTest = async ({ auth, idCanal }) => {
  const result = await pool.query(
    `select * from notificaciones_canales where id_empresa = $1 and id_canal = $2`,
    [auth.id_empresa, idCanal]
  );
  const canal = result.rows[0];
  if (!canal) throw HttpError.notFound("Canal no encontrado");

  await dispatch(canal, {
    asunto: "Notificacion de prueba",
    cuerpo: `Test desde TradeNova - ${new Date().toISOString()}`,
    destinatarios: canal.destinatarios || [],
    tipo_evento: "TEST",
    payload: { test: true },
  });

  return { ok: true };
};
