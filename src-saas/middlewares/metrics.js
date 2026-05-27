import {
  httpRequestsTotal,
  httpRequestDurationMs,
} from "../shared/metrics/registry.js";

/**
 * Normaliza el path para que las metricas no exploten en cardinalidad.
 * Convierte /api/saas/ventas/12345 -> /api/saas/ventas/:id
 *
 * Postgres-LIKE pattern intentionally simple: cualquier segmento puramente
 * numerico se reemplaza por :id. Asi todos los GET por id agrupan.
 */
const normalizeRoute = (req) => {
  // express deja req.route.path solo si matcheo; si fue 404 / next() temprano
  // tomamos req.originalUrl como fallback.
  const raw =
    req.route?.path && req.baseUrl
      ? `${req.baseUrl}${req.route.path}`
      : req.originalUrl?.split("?")[0] || "unknown";

  return raw
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? ":id" : seg))
    .join("/");
};

/**
 * Middleware que mide cada request HTTP y reporta a prom-client.
 * Lo correcto es montarlo despues del logger pero antes de los routers.
 */
export const metricsMiddleware = (req, res, next) => {
  // /metrics y /health no se cuentan para no contaminar las metricas
  // con el propio scrape de Prometheus.
  if (req.path === "/metrics" || req.path === "/api/saas/health") {
    return next();
  }

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = normalizeRoute(req);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationMs.observe(labels, durationMs);
  });

  next();
};
