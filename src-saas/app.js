import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { metricsMiddleware } from "./middlewares/metrics.js";
import {
  protectDocs,
  protectMetrics,
} from "./middlewares/protect-ops-endpoints.js";
import { requestLogger } from "./middlewares/request-logger.js";
import { resolveTenantByHost } from "./middlewares/resolve-tenant-host.js";
import { registry as metricsRegistry } from "./shared/metrics/registry.js";
import {
  buildOpenApiDocument,
  buildSwaggerUiHtml,
} from "./shared/openapi/registry.js";
// Side effect import: registra todos los endpoints en el registry
import "./shared/openapi/specs.js";
import apiRouter from "./routes/index.js";
import { createRateLimiter } from "./shared/security/rate-limit-store.js";
import { logger } from "./shared/logging/logger.js";
import { setupSentryErrorHandler } from "./shared/observability/sentry.js";
import { buildReadinessReport } from "./shared/ops/readiness.js";

const isDev = String(env.nodeEnv).toLowerCase() !== "production";

/**
 * Construye la app Express. Es async porque los rate limiters pueden usar
 * un store Redis (carga lazy de `rate-limit-redis` + connect a Redis).
 *
 * Llamar desde server.js:
 *   const app = await buildApp();
 *   app.listen(...);
 */
export const buildApp = async () => {
  const app = express();

  // Trust proxy: necesario cuando hay Nginx/Cloud LB delante para que
  // rate limiter use req.ip real y no el del proxy.
  app.set("trust proxy", 1);

  // ----- Logger por request -----
  app.use(requestLogger);

  // ----- Metricas Prometheus por request -----
  app.use(metricsMiddleware);

  // ----- Helmet (security headers) -----
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // ----- CORS -----
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          if (isDev) {
            callback(null, true);
          } else {
            callback(new Error("Origin requerido"));
          }
          return;
        }
        if (env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Resuelve el tenant por Host header (marca blanca). NO requiere auth.
  app.use(resolveTenantByHost);

  // ----- Construccion de rate limiters (store Redis si disponible) -----
  const [generalLimiter, loginLimiter, refreshLimiter] = await Promise.all([
    // 300 req/min/IP — uso normal.
    createRateLimiter({
      prefix: "rl:gen:",
      windowMs: 60 * 1000,
      max: 300,
      message: {
        error: "Demasiadas peticiones. Intenta de nuevo en un momento.",
      },
    }),
    // 5 intentos/15min/IP — fuerza bruta a passwords.
    createRateLimiter({
      prefix: "rl:login:",
      windowMs: 15 * 60 * 1000,
      max: 5,
      skipSuccessfulRequests: true,
      message: {
        error:
          "Demasiados intentos de inicio de sesion. Espera 15 minutos antes de intentar de nuevo.",
      },
    }),
    // 60/15min/IP — refresh ya esta protegido por cookie httpOnly + CSRF.
    createRateLimiter({
      prefix: "rl:refresh:",
      windowMs: 15 * 60 * 1000,
      max: 60,
    }),
  ]);

  logger.info(
    {
      backend: process.env.REDIS_URL ? "redis" : "memory",
    },
    "rate limiters listos"
  );

  // ----- Health -----
  app.get("/api/saas/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // ----- Readiness -----
  app.get("/api/saas/ready", async (_req, res) => {
    const report = await buildReadinessReport();
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.get("/api/saas/live", (_req, res) => {
    res.json({
      ok: true,
      service: "pos-saas-api",
      ts: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
    });
  });

  // ----- Metricas Prometheus -----
  app.get("/metrics", protectMetrics, async (_req, res, next) => {
    try {
      res.set("Content-Type", metricsRegistry.contentType);
      res.send(await metricsRegistry.metrics());
    } catch (error) {
      next(error);
    }
  });

  // ----- OpenAPI spec + Swagger UI -----
  let cachedOpenApiDoc = null;
  const getOpenApiDoc = () => {
    if (!cachedOpenApiDoc) {
      cachedOpenApiDoc = buildOpenApiDocument({
        title: "TradeNova API",
        version: "1.0.0",
        description: "API multi-tenant para POS + CarWash",
        serverUrl: "/api/saas",
      });
    }
    return cachedOpenApiDoc;
  };

  app.get("/api/saas/openapi.json", protectDocs, (_req, res) => {
    res.json(getOpenApiDoc());
  });

  app.get("/api/saas/docs", protectDocs, (_req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(buildSwaggerUiHtml("/api/saas/openapi.json"));
  });

  // ----- Login / bootstrap con rate limit estricto -----
  app.use("/api/saas/auth/login", loginLimiter);
  app.use("/api/saas/auth/select-company", loginLimiter);
  app.use("/api/saas/auth/bootstrap", loginLimiter);
  app.use("/api/saas/auth/password-reset", loginLimiter);

  // ----- Refresh con rate limit dedicado -----
  app.use("/api/saas/auth/refresh", refreshLimiter);

  // ----- API general con rate limit relajado -----
  app.use("/api/saas", generalLimiter, apiRouter);

  // Sentry error handler debe ir DESPUES de las rutas y ANTES del errorHandler
  // propio. Captura cualquier excepcion no manejada antes de que la transforme
  // el handler local.
  setupSentryErrorHandler(app);

  app.use(errorHandler);

  return app;
};

export default buildApp;
