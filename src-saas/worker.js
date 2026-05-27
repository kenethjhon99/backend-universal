/**
 * Worker dedicado para procesar jobs en background.
 *
 * Arranque:
 *   node src-saas/worker.js
 *   # o con dev:
 *   npm run worker:dev
 *
 * Requiere REDIS_URL configurado. Si no, fallar loud.
 */
import { logger } from "./shared/logging/logger.js";
import {
  closeQueues,
  queueAvailable,
  registerWorker,
  scheduleRepeatable,
} from "./shared/queue/queues.js";
import { processPendingDeliveries as procesarWebhooks } from "./modules/webhooks/webhooks.service.js";
import { notify } from "./modules/notificaciones/notificaciones.service.js";
import { syncStockProducto } from "./modules/marketplace/marketplace.service.js";
import { runBillingReminders } from "./jobs/billing-reminders.js";

if (!queueAvailable()) {
  logger.fatal(
    "REDIS_URL no configurado. Worker dedicado requiere Redis. Exiting."
  );
  process.exit(1);
}

logger.info("Worker BullMQ iniciado");

// ============================================================
// Consumidor: webhooks
// ============================================================
const webhookWorker = registerWorker(
  "webhooks",
  async (job) => {
    const { id_empresa, tipo_evento, payload } = job.data || {};
    logger.debug({ id_empresa, tipo_evento }, "procesando webhook");
    // El triggerEvent del service ya escribe a la tabla. Aquí solo procesamos
    // la cola de PENDIENTES (que el service va dejando) en lotes.
    return await procesarWebhooks(20);
  },
  { concurrency: 5 }
);

webhookWorker.on("failed", (job, err) => {
  logger.warn(
    { jobId: job?.id, err: err.message },
    "webhook job failed"
  );
});

// ============================================================
// Consumidor: notificaciones
// ============================================================
const notifWorker = registerWorker(
  "notifications",
  async (job) => {
    const { idEmpresa, tipoEvento, payload } = job.data || {};
    return await notify({ idEmpresa, tipoEvento, payload });
  },
  { concurrency: 10 }
);

notifWorker.on("failed", (job, err) => {
  logger.warn(
    { jobId: job?.id, err: err.message },
    "notification job failed"
  );
});

// ============================================================
// Consumidor: marketplace sync
// ============================================================
const marketWorker = registerWorker(
  "marketplace-sync",
  async (job) => {
    const { idEmpresa, idProducto } = job.data || {};
    return await syncStockProducto({ idEmpresa, idProducto });
  },
  { concurrency: 3 }
);

marketWorker.on("failed", (job, err) => {
  logger.warn(
    { jobId: job?.id, err: err.message },
    "marketplace sync job failed"
  );
});

// ============================================================
// Consumidor: scheduled jobs (cron)
// ============================================================
const scheduledWorker = registerWorker(
  "scheduled",
  async (job) => {
    switch (job.name) {
      case "billing-reminders":
        return await runBillingReminders();
      default:
        logger.warn({ jobName: job.name }, "scheduled job desconocido");
        return null;
    }
  },
  { concurrency: 1 }
);

scheduledWorker.on("failed", (job, err) => {
  logger.warn(
    { jobName: job?.name, err: err.message },
    "scheduled job failed"
  );
});

// Programar el job de billing-reminders cada 6 horas.
// Idempotente: si ya esta encolado, BullMQ no duplica.
await scheduleRepeatable(
  "scheduled",
  "billing-reminders",
  {},
  { every: 6 * 60 * 60 * 1000 } // 6 horas
);
logger.info("billing-reminders programado cada 6h");

// ============================================================
// Shutdown limpio
// ============================================================
const shutdown = async (signal) => {
  logger.info({ signal }, "Worker recibió señal, cerrando...");
  await Promise.all([
    webhookWorker.close(),
    notifWorker.close(),
    marketWorker.close(),
    scheduledWorker.close(),
  ]);
  await closeQueues();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "worker unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "worker uncaught exception");
  setTimeout(() => process.exit(1), 100);
});
