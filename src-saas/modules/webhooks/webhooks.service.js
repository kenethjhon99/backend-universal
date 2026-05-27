import crypto from "node:crypto";
import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { logger } from "../../shared/logging/logger.js";
import { enqueue, queueAvailable } from "../../shared/queue/queues.js";

const MAX_BODY_SIZE = 10_000; // recortamos el response_body para no inflar la tabla

const generateSecret = () =>
  crypto.randomBytes(32).toString("hex"); // 64 chars hex

const signPayload = (secret, payload) =>
  crypto
    .createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : JSON.stringify(payload))
    .digest("hex");

// ============================================================
// CRUD endpoints
// ============================================================

export const listEndpoints = async ({ auth }) => {
  const result = await pool.query(
    `
      select id_endpoint, url, descripcion, eventos, headers_extra,
             activo, reintentos_max, created_at, updated_at
      from webhooks_endpoints
      where id_empresa = $1
      order by activo desc, created_at desc
    `,
    [auth.id_empresa]
  );
  // Nota: NO devolvemos el secret en listings; solo se ve al crearlo.
  return result.rows;
};

export const createEndpoint = async ({ auth, scope, body, requestMeta }) => {
  const url = String(body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw HttpError.badRequest("url debe ser HTTP o HTTPS");
  }
  const eventos = Array.isArray(body?.eventos) ? body.eventos : [];

  const secret = generateSecret();

  const result = await pool.query(
    `
      insert into webhooks_endpoints (
        id_empresa, url, descripcion, secret, eventos,
        headers_extra, activo, reintentos_max, created_by, updated_by
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $9)
      returning *
    `,
    [
      auth.id_empresa,
      url,
      body?.descripcion || null,
      secret,
      JSON.stringify(eventos),
      body?.headers_extra ? JSON.stringify(body.headers_extra) : null,
      body?.activo !== false,
      Math.min(20, Math.max(1, Number(body?.reintentos_max) || 5)),
      auth.id_usuario,
    ]
  );

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "WEBHOOKS",
    entidad: "ENDPOINT",
    entidadId: result.rows[0].id_endpoint,
    accion: "CREATE",
    despues: { ...result.rows[0], secret: "[REDACTED]" },
  });

  // SI devolvemos el secret una sola vez (igual que Stripe / GitHub)
  return result.rows[0];
};

export const rotateSecret = async ({ auth, idEndpoint }) => {
  const secret = generateSecret();
  const r = await pool.query(
    `
      update webhooks_endpoints
        set secret = $1, updated_by = $2
      where id_empresa = $3 and id_endpoint = $4
      returning id_endpoint, url, secret
    `,
    [secret, auth.id_usuario, auth.id_empresa, idEndpoint]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Endpoint no encontrado");
  return r.rows[0];
};

export const deactivateEndpoint = async ({ auth, idEndpoint }) => {
  const r = await pool.query(
    `update webhooks_endpoints set activo = false, updated_by = $1
     where id_empresa = $2 and id_endpoint = $3 returning id_endpoint`,
    [auth.id_usuario, auth.id_empresa, idEndpoint]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Endpoint no encontrado");
  return { ok: true };
};

// ============================================================
// Disparo (best-effort, no bloquea operacion principal)
// ============================================================

/**
 * Encola un evento para todos los endpoints suscritos.
 * Returns: { encolados: number }
 */
export const triggerEvent = async ({ idEmpresa, tipoEvento, payload }) => {
  const result = await pool.query(
    `
      select id_endpoint
      from webhooks_endpoints
      where id_empresa = $1
        and activo = true
        and eventos @> to_jsonb($2::text[])
    `,
    [idEmpresa, [tipoEvento]]
  );

  if (result.rowCount === 0) return { encolados: 0 };

  for (const row of result.rows) {
    await pool.query(
      `
        insert into webhooks_eventos (
          id_empresa, id_endpoint, tipo_evento, payload, proximo_intento_en
        )
        values ($1, $2, $3, $4::jsonb, now())
      `,
      [idEmpresa, row.id_endpoint, tipoEvento, JSON.stringify(payload || {})]
    );
  }

  // Dispara la entrega: si hay Redis, encola; si no, ejecuta in-process.
  if (queueAvailable()) {
    enqueue(
      "webhooks",
      "process",
      { idEmpresa, tipoEvento, count: result.rowCount },
      () => processPendingDeliveries(20)
    ).catch(() => {});
  } else {
    setImmediate(() => processPendingDeliveries(20).catch(() => {}));
  }

  return { encolados: result.rowCount };
};

/**
 * Procesa el siguiente lote de eventos PENDIENTE cuyos proximo_intento_en
 * ya pasó. Diseñado para llamarse desde cron + setImmediate al disparar.
 */
export const processPendingDeliveries = async (limit = 20) => {
  const result = await pool.query(
    `
      select e.*, ep.url, ep.secret, ep.headers_extra, ep.reintentos_max
      from webhooks_eventos e
      inner join webhooks_endpoints ep
        on ep.id_empresa = e.id_empresa and ep.id_endpoint = e.id_endpoint
      where e.estado = 'PENDIENTE'
        and (e.proximo_intento_en is null or e.proximo_intento_en <= now())
        and ep.activo = true
      order by e.created_at asc
      limit $1
      for update skip locked
    `,
    [limit]
  );

  let dispatched = 0;
  let failed = 0;

  for (const ev of result.rows) {
    const payloadStr = JSON.stringify({
      id: ev.id_evento,
      tipo: ev.tipo_evento,
      empresa: ev.id_empresa,
      timestamp: new Date().toISOString(),
      data: ev.payload,
    });
    const signature = signPayload(ev.secret, payloadStr);

    try {
      const headers = {
        "Content-Type": "application/json",
        "X-Pos-Event": ev.tipo_evento,
        "X-Pos-Signature": signature,
        "X-Pos-Event-Id": String(ev.id_evento),
        ...(ev.headers_extra || {}),
      };

      const response = await fetch(ev.url, {
        method: "POST",
        headers,
        body: payloadStr,
        // timeout manual con AbortController
        signal: AbortSignal.timeout(15_000),
      });

      const bodyText = await response.text().catch(() => "");

      if (response.ok) {
        await pool.query(
          `
            update webhooks_eventos
              set estado = 'ENVIADO',
                  ultimo_status = $1,
                  ultimo_response_body = $2,
                  intentos = intentos + 1,
                  ultimo_intento_en = now(),
                  ultimo_error = null
            where id_evento = $3
          `,
          [response.status, bodyText.slice(0, MAX_BODY_SIZE), ev.id_evento]
        );
        dispatched += 1;
      } else {
        await scheduleRetryOrFail(ev, {
          status: response.status,
          body: bodyText,
          error: `HTTP ${response.status}`,
        });
        failed += 1;
      }
    } catch (error) {
      logger.warn(
        { url: ev.url, err: error.message },
        "webhook delivery error"
      );
      await scheduleRetryOrFail(ev, {
        status: null,
        body: null,
        error: error.message,
      });
      failed += 1;
    }
  }

  return { dispatched, failed, total: result.rowCount };
};

/**
 * Decide si reintentar (con backoff) o marcar FALLIDO definitivo.
 * Backoff: 1, 5, 15, 60, 240 minutos.
 */
const scheduleRetryOrFail = async (ev, { status, body, error }) => {
  const nextIntento = (ev.intentos || 0) + 1;
  const reintentosMax = Number(ev.reintentos_max || 5);

  if (nextIntento >= reintentosMax) {
    await pool.query(
      `
        update webhooks_eventos
          set estado = 'FALLIDO',
              ultimo_status = $1,
              ultimo_response_body = $2,
              ultimo_error = $3,
              intentos = $4,
              ultimo_intento_en = now()
        where id_evento = $5
      `,
      [status, (body || "").slice(0, MAX_BODY_SIZE), error, nextIntento, ev.id_evento]
    );
    return;
  }

  const backoffMin = [1, 5, 15, 60, 240][Math.min(nextIntento - 1, 4)];
  await pool.query(
    `
      update webhooks_eventos
        set ultimo_status = $1,
            ultimo_response_body = $2,
            ultimo_error = $3,
            intentos = $4,
            ultimo_intento_en = now(),
            proximo_intento_en = now() + ($5 || ' minutes')::interval
      where id_evento = $6
    `,
    [
      status,
      (body || "").slice(0, MAX_BODY_SIZE),
      error,
      nextIntento,
      backoffMin,
      ev.id_evento,
    ]
  );
};

// ============================================================
// Listing de eventos para debug en UI
// ============================================================

export const listEventos = async ({ auth, query }) => {
  const filters = ["id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.tipo_evento) {
    filters.push(`tipo_evento = $${i}`);
    params.push(String(query.tipo_evento));
    i += 1;
  }
  if (query?.estado) {
    filters.push(`estado = $${i}`);
    params.push(String(query.estado).toUpperCase());
    i += 1;
  }
  if (query?.id_endpoint) {
    filters.push(`id_endpoint = $${i}`);
    params.push(Number(query.id_endpoint));
    i += 1;
  }

  const r = await pool.query(
    `
      select id_evento, id_endpoint, tipo_evento, estado, intentos,
             ultimo_status, ultimo_error, ultimo_intento_en,
             proximo_intento_en, created_at
      from webhooks_eventos
      where ${filters.join(" and ")}
      order by created_at desc
      limit 100
    `,
    params
  );
  return r.rows;
};
