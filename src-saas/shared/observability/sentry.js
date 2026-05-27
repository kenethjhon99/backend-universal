/**
 * Integracion Sentry para el backend (Node + Express).
 *
 * Comportamiento:
 *  - Si `SENTRY_DSN` no esta definido, todas las funciones son no-op.
 *  - Si esta definido, captura excepciones no manejadas, errores 5xx y
 *    breadcrumbs del logger.
 *
 * IMPORTANTE: `initSentry()` debe llamarse al inicio del entry point
 * (server.js), antes de importar otros modulos para que la
 * auto-instrumentacion de Sentry pueda parchearlos.
 */
import { logger } from "../logging/logger.js";

const DSN = process.env.SENTRY_DSN || null;
const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development";
const RELEASE = process.env.SENTRY_RELEASE || null;
const TRACES_RATE = Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1);
const PROFILES_RATE = Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0);

let SentryRef = null;
let initialized = false;

/**
 * Inicializa el SDK. Debe llamarse antes de cualquier require/import de
 * librerias que Sentry instrumenta (express, pg, http).
 *
 * Retorna { Sentry } para que el caller pueda usarlo directo si quiere;
 * tambien queda accesible via getSentry().
 */
export const initSentry = async () => {
  if (initialized) return SentryRef;
  initialized = true;

  if (!DSN) {
    logger.info("Sentry: SENTRY_DSN no definido, captura desactivada");
    return null;
  }

  try {
    const Sentry = await import("@sentry/node");

    // Profiling opcional (solo si la dep esta y profiles_rate > 0).
    let profilingIntegration = null;
    if (PROFILES_RATE > 0) {
      try {
        const { nodeProfilingIntegration } = await import(
          "@sentry/profiling-node"
        );
        profilingIntegration = nodeProfilingIntegration();
      } catch (err) {
        logger.warn(
          { err: err.message },
          "Sentry profiling no disponible (dep @sentry/profiling-node)"
        );
      }
    }

    Sentry.init({
      dsn: DSN,
      environment: ENVIRONMENT,
      release: RELEASE || undefined,
      // Auto-instrumenta express, http, pg, ioredis, etc.
      tracesSampleRate: TRACES_RATE,
      profilesSampleRate: PROFILES_RATE,
      integrations: profilingIntegration ? [profilingIntegration] : undefined,
      // No capturamos requests con bodies que pueden contener passwords
      sendDefaultPii: false,
      beforeSend(event) {
        // Sanitizacion extra: eliminar headers sensibles si por algun motivo
        // llegaron pese a la config.
        const headers = event.request?.headers;
        if (headers) {
          delete headers.authorization;
          delete headers.cookie;
          delete headers["x-xsrf-token"];
          delete headers["x-metrics-token"];
          delete headers["x-docs-token"];
        }
        // Tambien limpiar cualquier body con password
        if (event.request?.data && typeof event.request.data === "object") {
          if ("password" in event.request.data)
            event.request.data.password = "[REDACTED]";
          if ("password_hash" in event.request.data)
            event.request.data.password_hash = "[REDACTED]";
        }
        return event;
      },
    });

    SentryRef = Sentry;
    logger.info(
      { environment: ENVIRONMENT, tracesSampleRate: TRACES_RATE, release: RELEASE },
      "Sentry inicializado"
    );
    return Sentry;
  } catch (err) {
    logger.warn(
      { err: err.message },
      "Sentry init fallo; se desactiva captura"
    );
    return null;
  }
};

/**
 * Devuelve el SDK Sentry inicializado, o null si no esta listo.
 */
export const getSentry = () => SentryRef;

/**
 * Middleware: setea el user/tenant scope desde req.auth.
 * Aplicar DESPUES de `authenticate` para que la info este disponible.
 */
export const sentryUserContext = (req, _res, next) => {
  if (SentryRef && req.auth) {
    SentryRef.getCurrentScope().setUser({
      id: String(req.auth.id_usuario || ""),
      username: req.auth.empresa?.slug
        ? `${req.auth.empresa.slug}/${req.auth.id_usuario}`
        : String(req.auth.id_usuario || ""),
    });
    SentryRef.getCurrentScope().setTag(
      "id_empresa",
      String(req.auth.id_empresa || "")
    );
    SentryRef.getCurrentScope().setTag("rol", String(req.auth.rol || ""));
  }
  next();
};

/**
 * Engancha el error handler de Sentry en una app Express.
 * Llamar DESPUES de todas las rutas y ANTES del errorHandler propio.
 */
export const setupSentryErrorHandler = (app) => {
  if (!SentryRef) return;
  // En Sentry v8+ la signatura es setupExpressErrorHandler(app)
  SentryRef.setupExpressErrorHandler(app);
};

/**
 * Flush + cierre. Llamar en el graceful shutdown del proceso.
 */
export const closeSentry = async (timeoutMs = 2000) => {
  if (!SentryRef) return;
  try {
    await SentryRef.flush(timeoutMs);
    await SentryRef.close(timeoutMs);
  } catch (err) {
    logger.warn({ err: err.message }, "Sentry close warning");
  }
};
