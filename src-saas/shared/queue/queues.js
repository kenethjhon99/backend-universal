/**
 * Setup central de queues BullMQ.
 *
 * Si REDIS_URL no esta configurado, exporta versiones in-process (fallback)
 * que ejecutan el job sincrónicamente. Esto permite que el dev local funcione
 * sin Redis y producción use el worker dedicado.
 */
import { logger } from "../logging/logger.js";

const REDIS_URL = process.env.REDIS_URL || null;

let Queue, Worker, IORedis, connection;
let isAvailable = false;

if (REDIS_URL) {
  try {
    const bull = await import("bullmq");
    const Redis = (await import("ioredis")).default;
    Queue = bull.Queue;
    Worker = bull.Worker;
    IORedis = Redis;
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    isAvailable = true;
    logger.info({ redisUrl: REDIS_URL.replace(/:[^@/]+@/, ":***@") }, "BullMQ queue habilitado");
  } catch (err) {
    logger.warn(
      { err: err.message },
      "BullMQ no se pudo cargar; fallback in-process activo"
    );
    isAvailable = false;
  }
}

export const queueAvailable = () => isAvailable;

// ============================================================
// Definicion de queues
// ============================================================

const queues = {};

const QUEUE_DEFS = [
  { name: "webhooks", defaultJobOpts: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } },
  { name: "notifications", defaultJobOpts: { attempts: 3, removeOnComplete: 500, removeOnFail: 1000 } },
  { name: "marketplace-sync", defaultJobOpts: { attempts: 3, removeOnComplete: 200, removeOnFail: 500 } },
  { name: "scheduled", defaultJobOpts: { attempts: 2, removeOnComplete: 50, removeOnFail: 200 } },
];

if (isAvailable) {
  for (const def of QUEUE_DEFS) {
    queues[def.name] = new Queue(def.name, {
      connection,
      defaultJobOptions: def.defaultJobOpts,
    });
  }
}

/**
 * Encola un job. Si Redis no esta disponible, ejecuta el fallback en-proceso.
 *
 * @param {string} queueName - "webhooks" | "notifications" | "marketplace-sync"
 * @param {string} jobName - identificador del tipo de job
 * @param {object} data - payload
 * @param {Function} [fallbackHandler] - handler in-process si no hay queue
 */
export const enqueue = async (queueName, jobName, data, fallbackHandler = null) => {
  if (isAvailable && queues[queueName]) {
    await queues[queueName].add(jobName, data);
    return { mode: "queued" };
  }

  // Fallback: ejecuta async pero in-process. No bloquea al caller.
  if (fallbackHandler) {
    setImmediate(() => {
      Promise.resolve(fallbackHandler(data)).catch((err) => {
        logger.warn(
          { err: err.message, queue: queueName, job: jobName },
          "fallback handler fallo"
        );
      });
    });
    return { mode: "in-process" };
  }

  return { mode: "discarded" };
};

/**
 * Encola un job repeatable (cron). Idempotente: si ya esta encolado el mismo
 * jobId con la misma cron expression, BullMQ no lo duplica.
 *
 * @param {string} queueName
 * @param {string} jobName  - identificador legible (ej "billing-reminders")
 * @param {object} data
 * @param {object} repeatOpts - ej { cron: "0 * /6 * * *" } o { every: 60_000 }
 * @returns {Promise<{mode: string}>}
 */
export const scheduleRepeatable = async (queueName, jobName, data, repeatOpts) => {
  if (!isAvailable || !queues[queueName]) {
    logger.warn(
      { queueName, jobName },
      "scheduleRepeatable: Redis no disponible, job no se programa"
    );
    return { mode: "skipped" };
  }
  await queues[queueName].add(jobName, data, {
    repeat: repeatOpts,
    jobId: `repeat:${jobName}`, // idempotencia
  });
  return { mode: "scheduled" };
};

/**
 * Helper para que el worker.js cree consumidores. Solo funciona si Redis está.
 */
export const registerWorker = (queueName, processor, opts = {}) => {
  if (!isAvailable) {
    throw new Error(
      "No hay Redis configurado; no se pueden registrar workers BullMQ"
    );
  }
  return new Worker(queueName, processor, {
    connection,
    concurrency: opts.concurrency || 5,
    ...opts,
  });
};

export const closeQueues = async () => {
  for (const q of Object.values(queues)) {
    try {
      await q.close();
    } catch {
      /* noop */
    }
  }
  try {
    await connection?.quit();
  } catch {
    /* noop */
  }
};
