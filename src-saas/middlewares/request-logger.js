import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { logger } from "../shared/logging/logger.js";

/**
 * Middleware de logging por request.
 *  - Genera un reqId unico si el cliente no lo manda en X-Request-Id.
 *  - Loguea inicio y fin de cada request con metadata (path, status, durMs).
 *  - Cuando authenticate ya corrio, agrega userId y empresaId al log.
 *  - Skipea /health para no llenar el log con healthchecks de Kubernetes.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req) =>
    req.headers["x-request-id"] || req.headers["x-correlation-id"] || randomUUID(),
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) =>
    `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} -> ${res.statusCode} ${err?.message || ""}`,
  customProps: (req) => ({
    userId: req.auth?.id_usuario || null,
    empresaId: req.auth?.id_empresa || null,
    sucursalId: req.auth?.id_sucursal || req.scope?.id_sucursal || null,
  }),
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
  autoLogging: {
    ignore: (req) =>
      req.url === "/api/saas/health" || req.url === "/favicon.ico",
  },
});
