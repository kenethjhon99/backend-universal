/**
 * Cliente Redis compartido (singleton).
 *
 * Si REDIS_URL no esta definido, exporta null y el resto del sistema cae a
 * comportamiento in-process (queues fallback, rate-limit en memoria, etc.).
 *
 * Nota: BullMQ ya crea su propia conexion ioredis con opciones especificas
 * (maxRetriesPerRequest: null, enableReadyCheck: false). Esta conexion es
 * para cache y rate-limit, donde podemos usar defaults.
 */
import { logger } from "../logging/logger.js";

const REDIS_URL = process.env.REDIS_URL || null;

let cachedClient = null;
let initFailed = false;

/**
 * Devuelve un cliente ioredis listo, o null si no hay REDIS_URL.
 * Lazy: solo carga el modulo `ioredis` si REDIS_URL esta definido.
 */
export const getRedisClient = async () => {
  if (!REDIS_URL || initFailed) return null;
  if (cachedClient) return cachedClient;

  try {
    const IORedis = (await import("ioredis")).default;
    cachedClient = new IORedis(REDIS_URL, {
      // Defaults razonables para uso general (rate-limit, cache)
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    cachedClient.on("error", (err) => {
      logger.warn({ err: err.message }, "redis client error");
    });

    cachedClient.on("ready", () => {
      logger.info(
        { url: REDIS_URL.replace(/:[^@/]+@/, ":***@") },
        "redis client ready"
      );
    });

    return cachedClient;
  } catch (err) {
    initFailed = true;
    logger.warn(
      { err: err.message },
      "no se pudo inicializar cliente Redis; fallback in-memory"
    );
    return null;
  }
};

/**
 * Cierra el cliente Redis si esta abierto.
 * Llamar desde el shutdown handler del server.
 */
export const closeRedisClient = async () => {
  if (cachedClient) {
    try {
      await cachedClient.quit();
    } catch {
      /* noop */
    }
    cachedClient = null;
  }
};

export const redisAvailable = () => Boolean(REDIS_URL) && !initFailed;
