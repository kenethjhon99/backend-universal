import { env } from "../config/env.js";
import { logger as fallbackLogger } from "../shared/logging/logger.js";

const isDev = String(env.nodeEnv).toLowerCase() !== "production";

/**
 * Manejador global de errores.
 *  - 4xx (HttpError): se devuelve mensaje + details al cliente (intencionales).
 *  - 5xx (errores de runtime, fallas de BD, etc.): se loguea TODO server-side
 *    via pino con reqId y context, pero al cliente solo se le devuelve un
 *    mensaje generico para evitar leak de detalles internos.
 *  - En desarrollo se mantiene el mensaje real para facilitar debug.
 */
export const errorHandler = (error, req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const log = req?.log || fallbackLogger;

  if (statusCode >= 500) {
    log.error(
      {
        err: error,
        method: req?.method,
        path: req?.originalUrl || req?.url,
        userId: req?.auth?.id_usuario || null,
        empresaId: req?.auth?.id_empresa || null,
      },
      "request failed with 5xx"
    );

    res.status(500).json({
      error: isDev ? error.message : "Error interno del servidor",
      details: isDev ? error.details || null : null,
      reqId: req?.id || null,
    });
    return;
  }

  // 4xx: log a nivel warn pero sin stack ruidoso, y mensaje real al cliente
  log.warn(
    {
      statusCode,
      message: error.message,
      path: req?.originalUrl || req?.url,
    },
    "request rejected"
  );

  res.status(statusCode).json({
    error: error.message || "Error",
    details: error.details || null,
  });
};
