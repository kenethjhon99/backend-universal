/**
 * Entry point del API SaaS.
 *
 * Estrategia de arranque:
 *  1. Levantar HTTP listener inmediato (para que healthchecks/orquestadores
 *     vean el puerto abierto).
 *  2. Pingear Postgres en background con backoff exponencial. El estado se
 *     refleja en /api/saas/health (devuelve 503 hasta que la BD responda).
 *  3. Graceful shutdown: en SIGTERM/SIGINT cerramos el listener, esperamos
 *     in-flight requests, cerramos pool de Postgres y queues.
 */

// Sentry debe importarse e inicializarse LO MAS TEMPRANO POSIBLE para que
// auto-instrumente las libs que importamos abajo (express, http, pg).
import { closeSentry, initSentry } from "./shared/observability/sentry.js";
await initSentry();

import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { pingDatabase, pool } from "./config/db.js";
import { logger } from "./shared/logging/logger.js";
import { closeQueues } from "./shared/queue/queues.js";
import { closeRedisClient } from "./shared/redis/connection.js";

// ---------------------------------------------------------------------------
// Estado de salud compartido (lo lee app.js en /health)
// ---------------------------------------------------------------------------
export const health = {
  db: { ok: false, lastError: null, lastCheckAt: null, attempts: 0 },
  startedAt: new Date().toISOString(),
  shuttingDown: false,
};

// ---------------------------------------------------------------------------
// Ping de Postgres con backoff exponencial: 500ms, 1s, 2s, 4s, 8s, 16s (tope)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startDatabasePingLoop = async () => {
  let attempt = 0;

  while (!health.shuttingDown) {
    attempt += 1;
    health.db.attempts = attempt;
    health.db.lastCheckAt = new Date().toISOString();

    try {
      const result = await pingDatabase();
      if (!health.db.ok) {
        logger.info(
          { dbTime: result.now, attempts: attempt },
          "Postgres SaaS conectado"
        );
      }
      health.db.ok = true;
      health.db.lastError = null;
      // Una vez conectado, revisamos cada 30s para detectar caídas
      await sleep(30_000);
      attempt = 0;
      continue;
    } catch (error) {
      health.db.ok = false;
      health.db.lastError = error.message;
      const wait = Math.min(16_000, 500 * 2 ** Math.min(attempt - 1, 5));
      logger.warn(
        { err: error.message, attempt, retryInMs: wait },
        "Postgres ping fallo; reintentando"
      );
      await sleep(wait);
    }
  }
};

// ---------------------------------------------------------------------------
// Listener HTTP
// ---------------------------------------------------------------------------
// buildApp() es async porque inicializa rate-limiters con store Redis.
// Esto NO bloquea por mucho: si REDIS_URL no esta, retorna inmediato.
const app = await buildApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port }, "SaaS API escuchando");
});

// Lanzar el loop de ping sin bloquear el listener
startDatabasePingLoop().catch((err) => {
  logger.fatal({ err }, "ping loop crash");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const SHUTDOWN_TIMEOUT_MS = 15_000;

const shutdown = async (signal) => {
  if (health.shuttingDown) return;
  health.shuttingDown = true;

  logger.info({ signal }, "Shutdown iniciado");

  // Forzar exit si tardamos demasiado
  const killTimer = setTimeout(() => {
    logger.fatal("Shutdown excedio timeout, forzando exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  killTimer.unref();

  try {
    // 1) Dejar de aceptar nuevas conexiones HTTP y esperar in-flight
    await new Promise((resolve) => server.close(() => resolve()));
    logger.info("HTTP listener cerrado");

    // 2) Cerrar queues (BullMQ + su conexion Redis dedicada)
    await closeQueues();
    logger.info("Queues cerradas");

    // 3) Cerrar cliente Redis compartido (rate-limit, cache)
    await closeRedisClient();
    logger.info("Redis cliente cerrado");

    // 4) Cerrar pool de Postgres
    await pool.end();
    logger.info("Pool Postgres cerrado");

    // 5) Flush + close Sentry (envia eventos pendientes antes de exit)
    await closeSentry(3000);

    clearTimeout(killTimer);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error durante shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Captura de errores no manejados
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  // Drenar logs y salir; el orquestador reinicia
  setTimeout(() => process.exit(1), 100).unref();
});
