/**
 * Job recurrente: detecta empresas cuyo trial vence pronto y dispara
 * BILLING_TRIAL_EXPIRING. Tambien notifica empresas que llegaron a 80% de
 * algun limite (PLAN_LIMIT_WARNING).
 *
 * Idempotencia: usa saas_subscription_events para evitar notificar dos veces
 * el mismo aviso dentro del mismo umbral (busca eventos en las ultimas 24h).
 *
 * Se ejecuta desde worker.js via BullMQ repeatable job (cada 6h).
 */
import { pool } from "../config/db.js";
import { logger } from "../shared/logging/logger.js";
import { notify } from "../modules/notificaciones/notificaciones.service.js";

const TRIAL_DAYS_THRESHOLDS = [7, 3, 1]; // notificar a 7, 3, 1 dias
const PLAN_LIMIT_WARNING_RATIO = 0.8; // 80% del max

/**
 * Devuelve true si ya hubo un evento del mismo tipo+empresa en las ultimas
 * "hours" horas (deduplicacion).
 */
const wasNotifiedRecently = async (idEmpresa, tipoEvento, hours = 20) => {
  const r = await pool.query(
    `select 1
     from saas_subscription_events
     where id_empresa = $1
       and tipo_evento = $2
       and created_at > now() - ($3 || ' hours')::interval
     limit 1`,
    [idEmpresa, tipoEvento, hours]
  );
  return r.rowCount > 0;
};

const markNotified = async (idEmpresa, tipoEvento, metadata = {}) => {
  await pool.query(
    `insert into saas_subscription_events (id_empresa, tipo_evento, metadata)
     values ($1, $2, $3::jsonb)`,
    [idEmpresa, tipoEvento, JSON.stringify(metadata)]
  );
};

/**
 * Trials por vencer: busca empresas en estado TRIAL con trial_hasta dentro
 * de los umbrales.
 */
const processTrialExpiring = async () => {
  let count = 0;
  for (const threshold of TRIAL_DAYS_THRESHOLDS) {
    const r = await pool.query(
      `select id_empresa, slug, nombre_legal, saas_trial_hasta,
              (saas_trial_hasta - current_date) as dias_restantes
       from empresas
       where saas_estado = 'TRIAL'
         and saas_trial_hasta is not null
         and saas_trial_hasta - current_date = $1`,
      [threshold]
    );

    for (const row of r.rows) {
      const tipoEvento = `TRIAL_REMINDER_${threshold}D`;
      if (await wasNotifiedRecently(row.id_empresa, tipoEvento, 20)) {
        continue;
      }

      try {
        await notify({
          idEmpresa: row.id_empresa,
          tipoEvento: "BILLING_TRIAL_EXPIRING",
          payload: {
            empresa: row.nombre_legal || row.slug,
            dias_restantes: row.dias_restantes,
            trial_hasta: row.saas_trial_hasta,
          },
        });
        await markNotified(row.id_empresa, tipoEvento, {
          dias_restantes: row.dias_restantes,
          trial_hasta: row.saas_trial_hasta,
        });
        count += 1;
      } catch (err) {
        logger.warn(
          { err: err.message, idEmpresa: row.id_empresa, threshold },
          "fallo enviando trial reminder"
        );
      }
    }
  }
  return count;
};

/**
 * Plan limit warning: detecta empresas que llegaron a >=80% de algun limite.
 * Solo notifica una vez cada 24h para no spamear.
 */
const processPlanLimitWarning = async () => {
  let count = 0;
  // Solo planes con limites finitos (max_* not null)
  const r = await pool.query(
    `select
       e.id_empresa,
       e.slug,
       e.nombre_legal,
       p.codigo as plan_codigo,
       p.max_sucursales,
       p.max_usuarios,
       p.max_ventas_mes,
       u.sucursales_count,
       u.usuarios_count,
       u.ventas_mes_count,
       u.ventas_mes_periodo
     from empresas e
     inner join saas_planes p on p.codigo = e.saas_plan_codigo
     inner join empresa_uso_actual u using (id_empresa)
     where e.saas_estado in ('ACTIVA', 'TRIAL')`
  );

  for (const row of r.rows) {
    const checks = [
      { resource: "sucursal", current: row.sucursales_count, max: row.max_sucursales },
      { resource: "usuario", current: row.usuarios_count, max: row.max_usuarios },
      { resource: "venta", current: row.ventas_mes_count, max: row.max_ventas_mes },
    ];

    for (const check of checks) {
      if (
        check.max == null ||
        check.max === 0 ||
        check.current / check.max < PLAN_LIMIT_WARNING_RATIO
      ) {
        continue;
      }
      // Si ya esta 100% bloqueado, no enviamos warning (ya recibio el 402).
      if (check.current >= check.max) continue;

      const tipoEvento = `LIMIT_WARNING_${check.resource.toUpperCase()}`;
      if (await wasNotifiedRecently(row.id_empresa, tipoEvento, 20)) continue;

      try {
        await notify({
          idEmpresa: row.id_empresa,
          tipoEvento: "PLAN_LIMIT_WARNING",
          payload: {
            empresa: row.nombre_legal || row.slug,
            recurso: check.resource,
            current: check.current,
            max: check.max,
            plan: row.plan_codigo,
          },
        });
        await markNotified(row.id_empresa, tipoEvento, {
          recurso: check.resource,
          current: check.current,
          max: check.max,
        });
        count += 1;
      } catch (err) {
        logger.warn(
          { err: err.message, idEmpresa: row.id_empresa, recurso: check.resource },
          "fallo enviando plan-limit warning"
        );
      }
    }
  }
  return count;
};

/**
 * Auto-suspender trials que ya expiraron (saas_estado=TRIAL pero trial_hasta < hoy).
 * Esto es backup del enforcement en authenticate.js (que ya devuelve 402),
 * pero ademas dispara la notificacion BILLING_SUSPENDED.
 */
const processExpiredTrials = async () => {
  const r = await pool.query(
    `select id_empresa, slug, nombre_legal
     from empresas
     where saas_estado = 'TRIAL'
       and saas_trial_hasta is not null
       and saas_trial_hasta < current_date`
  );

  let count = 0;
  for (const row of r.rows) {
    await pool.query(
      `update empresas set saas_estado = 'SUSPENDIDA' where id_empresa = $1`,
      [row.id_empresa]
    );
    await pool.query(
      `insert into saas_subscription_events (id_empresa, tipo_evento, metadata)
       values ($1, 'TRIAL_EXPIRED', $2::jsonb)`,
      [row.id_empresa, JSON.stringify({ auto: true })]
    );
    try {
      await notify({
        idEmpresa: row.id_empresa,
        tipoEvento: "BILLING_SUSPENDED",
        payload: {
          empresa: row.nombre_legal || row.slug,
          motivo: "periodo de prueba vencido",
        },
      });
    } catch (err) {
      logger.warn(
        { err: err.message, idEmpresa: row.id_empresa },
        "fallo notify trial-expired"
      );
    }
    count += 1;
  }
  return count;
};

/**
 * Entry point que llama el worker.
 */
export const runBillingReminders = async () => {
  const started = Date.now();
  const trialNotified = await processTrialExpiring();
  const limitWarnings = await processPlanLimitWarning();
  const trialsExpired = await processExpiredTrials();
  const elapsed = Date.now() - started;
  logger.info(
    { trialNotified, limitWarnings, trialsExpired, ms: elapsed },
    "billing-reminders ejecutado"
  );
  return { trialNotified, limitWarnings, trialsExpired };
};
