/**
 * Factory de rate-limit con backend Redis si esta disponible, in-memory si no.
 *
 * - Con Redis: limite efectivo es global a todas las instancias del API.
 *   Necesario en cualquier deploy con N>1 replicas o autoscaling.
 * - Sin Redis (dev local): limite por proceso (default de express-rate-limit).
 *
 * Uso:
 *   const limiter = await createRateLimiter({
 *     prefix: "rl:login:",
 *     windowMs: 15 * 60 * 1000,
 *     max: 5,
 *     skipSuccessfulRequests: true,
 *     message: { error: "Demasiados intentos" },
 *   });
 *   app.use("/api/saas/auth/login", limiter);
 */
import rateLimit from "express-rate-limit";
import { getRedisClient } from "../redis/connection.js";
import { logger } from "../logging/logger.js";

/**
 * Crea un limiter. Async porque la inicializacion del store de Redis es async.
 *
 * @param {object} opts
 * @param {string} opts.prefix - prefijo de keys en Redis (ej "rl:login:")
 * @param {number} opts.windowMs - ventana en milisegundos
 * @param {number} opts.max - max requests en la ventana
 * @param {boolean} [opts.skipSuccessfulRequests]
 * @param {boolean} [opts.standardHeaders]
 * @param {boolean} [opts.legacyHeaders]
 * @param {object|Function} [opts.message]
 * @param {Function} [opts.keyGenerator] - default: req.ip
 * @returns {Promise<Function>} middleware express
 */
export const createRateLimiter = async ({
  prefix,
  windowMs,
  max,
  skipSuccessfulRequests = false,
  standardHeaders = true,
  legacyHeaders = false,
  message,
  keyGenerator,
}) => {
  const client = await getRedisClient();
  let store;

  if (client) {
    try {
      // Lazy import para no obligar a tener rate-limit-redis instalado si
      // no hay Redis configurado.
      const { RedisStore } = await import("rate-limit-redis");
      store = new RedisStore({
        sendCommand: (...args) => client.call(...args),
        prefix,
      });
    } catch (err) {
      logger.warn(
        { err: err.message, prefix },
        "no se pudo cargar rate-limit-redis; fallback in-memory"
      );
    }
  }

  return rateLimit({
    windowMs,
    max,
    skipSuccessfulRequests,
    standardHeaders,
    legacyHeaders,
    message,
    keyGenerator,
    ...(store ? { store } : {}),
  });
};
