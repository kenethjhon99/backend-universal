/**
 * Proteccion de endpoints "ops" expuestos por el API:
 *   - /metrics          (Prometheus scraping)
 *   - /api/saas/docs    (Swagger UI)
 *   - /api/saas/openapi.json
 *
 * En dev: comportamiento permisivo (DX).
 * En produccion: requieren credenciales explicitas y, si faltan, los
 * endpoints responden 401/404 — no se exponen "por error".
 *
 * Comparacion de tokens usa comparacion en tiempo constante para evitar
 * ataques de timing.
 */
import { timingSafeEqual } from "node:crypto";
import { verifyAccessToken } from "../shared/security/jwt.js";
import { logger } from "../shared/logging/logger.js";

// Evaluado por request (no por module load) para que cambios de env en tests
// y reconfiguraciones runtime funcionen correctamente.
const isProd = () =>
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

// ============================================================
// Helpers
// ============================================================

const constantTimeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

const extractBearerOrHeader = (req, headerName) => {
  const headerVal = req.headers[headerName.toLowerCase()];
  if (headerVal) return String(headerVal);
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return null;
};

// ============================================================
// /metrics
// ============================================================
// Reglas:
//  - METRICS_TOKEN definido: requiere coincidencia exacta (X-Metrics-Token
//    header o Authorization: Bearer).
//  - METRICS_TOKEN sin definir + production: rechaza 401 (no abrir por
//    accidente). Loguea warning al boot.
//  - METRICS_TOKEN sin definir + dev: abierto (DX).
export const protectMetrics = (req, res, next) => {
  const expected = process.env.METRICS_TOKEN;

  if (!expected) {
    if (isProd()) {
      logger.warn(
        "METRICS_TOKEN no configurado en produccion. /metrics respondera 401."
      );
      res.status(401).send("metrics_token_not_configured");
      return;
    }
    return next(); // dev: abierto
  }

  const provided = extractBearerOrHeader(req, "x-metrics-token");
  if (!provided || !constantTimeEqual(provided, expected)) {
    res.status(401).send("unauthorized");
    return;
  }
  next();
};

// ============================================================
// /api/saas/docs y /api/saas/openapi.json
// ============================================================
// Modos via env API_DOCS_MODE:
//   - "public"  (default en dev): abierto a cualquiera.
//   - "off"     (default en prod): responde 404. No se expone.
//   - "token"   : requiere API_DOCS_TOKEN via X-Docs-Token o Bearer.
//   - "admin"   : requiere JWT valido con rol SUPER_ADMIN o ADMIN_EMPRESA.
//
// Recomendaciones:
//   - Dev local: dejar default (public).
//   - Staging: "token" con un token compartido con QA.
//   - Production publica (API publica documentada): "public".
//   - Production interna: "off" o "admin".
const resolveDocsMode = () => {
  const raw = String(process.env.API_DOCS_MODE || "").trim().toLowerCase();
  if (raw) return raw;
  return isProd() ? "off" : "public";
};

// Log informativo solo en prod, una vez al boot. No afecta funcionamiento.
if (isProd()) {
  logger.info({ docsMode: resolveDocsMode() }, "API docs mode activo");
}

export const protectDocs = (req, res, next) => {
  // Evaluamos por request para que cambios de env (tests, hot-reload) funcionen.
  const docsMode = resolveDocsMode();
  switch (docsMode) {
    case "public":
      return next();

    case "off":
      res.status(404).send("not_found");
      return;

    case "token": {
      const expected = process.env.API_DOCS_TOKEN;
      if (!expected) {
        logger.warn("API_DOCS_MODE=token pero API_DOCS_TOKEN no configurado");
        res.status(503).send("docs_token_not_configured");
        return;
      }
      const provided = extractBearerOrHeader(req, "x-docs-token");
      if (!provided || !constantTimeEqual(provided, expected)) {
        res.status(401).send("unauthorized");
        return;
      }
      return next();
    }

    case "admin": {
      try {
        const auth = String(req.headers.authorization || "");
        if (!auth.toLowerCase().startsWith("bearer ")) {
          res.status(401).send("authentication_required");
          return;
        }
        const payload = verifyAccessToken(auth.slice(7));
        const rol = String(payload.rol || "").toUpperCase();
        if (!["SUPER_ADMIN", "ADMIN_EMPRESA"].includes(rol)) {
          res.status(403).send("forbidden");
          return;
        }
        return next();
      } catch (err) {
        res.status(401).send("invalid_token");
        return;
      }
    }

    default:
      logger.warn(
        { docsMode },
        "API_DOCS_MODE invalido. Valores validos: public|off|token|admin"
      );
      res.status(500).send("misconfigured");
      return;
  }
};
