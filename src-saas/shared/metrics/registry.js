import client from "prom-client";

/**
 * Registry global de Prometheus.
 * Recolecta default metrics (memoria, GC, event loop, fd, CPU) + las
 * custom que definimos abajo.
 *
 * El endpoint /metrics emite todo en formato text/plain de prometheus.
 */
export const registry = new client.Registry();

registry.setDefaultLabels({
  service: "pos-saas-api",
});

client.collectDefaultMetrics({ register: registry });

// ============================================================
// HTTP metrics
// ============================================================

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Numero total de requests HTTP procesadas",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

export const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "Latencia de requests HTTP en milisegundos",
  labelNames: ["method", "route", "status_code"],
  // Buckets en ms apropiados para una API normal
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

// ============================================================
// Business metrics
// ============================================================

export const ventasCreated = new client.Counter({
  name: "saas_ventas_creadas_total",
  help: "Numero de ventas creadas",
  labelNames: ["empresa", "tipo_venta", "metodo_pago", "estado"],
  registers: [registry],
});

export const ventasReversiones = new client.Counter({
  name: "saas_ventas_reversiones_total",
  help: "Numero de reversiones de venta (devoluciones / notas de credito)",
  labelNames: ["empresa", "tipo_reversion", "metodo_resolucion"],
  registers: [registry],
});

export const ordenesServicioCreadas = new client.Counter({
  name: "saas_ordenes_servicio_total",
  help: "Numero de ordenes de servicio creadas",
  labelNames: ["empresa", "modulo"],
  registers: [registry],
});

export const cajaSesionesAbiertas = new client.Gauge({
  name: "saas_caja_sesiones_abiertas",
  help: "Cajas actualmente abiertas (snapshot)",
  labelNames: ["empresa"],
  registers: [registry],
});

export const loginAttempts = new client.Counter({
  name: "saas_login_attempts_total",
  help: "Intentos de login agrupados por resultado",
  labelNames: ["result"], // success | invalid_credentials | inactive | error
  registers: [registry],
});

export const refreshTokenEvents = new client.Counter({
  name: "saas_refresh_token_events_total",
  help: "Eventos de refresh token",
  labelNames: ["event"], // issued | rotated | reused_revoked | revoked_logout
  registers: [registry],
});

export const dbQueryDurationMs = new client.Histogram({
  name: "saas_db_query_duration_ms",
  help: "Duracion de queries de Postgres por modulo",
  labelNames: ["module", "operation"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});

export const readinessChecks = new client.Gauge({
  name: "saas_readiness_check",
  help: "Estado de checks de readiness (1 ok, 0 fail/degraded)",
  labelNames: ["check", "severity"],
  registers: [registry],
});

/**
 * Helper para wrappear un async fn y reportar duracion automaticamente.
 *
 *   const venta = await measureDb("ventas", "create", () => createVenta(...));
 */
export const measureDb = async (module, operation, fn) => {
  const stop = dbQueryDurationMs.startTimer({ module, operation });
  try {
    return await fn();
  } finally {
    stop();
  }
};
