/**
 * Proteccion CSRF para endpoints que dependen del cookie httpOnly de refresh
 * (`/auth/refresh`, `/auth/logout`).
 *
 * Defensa en capas:
 *
 *   1) SameSite=Strict en el cookie de refresh (ya configurado en
 *      refresh-tokens.js). Bloquea el 99% de CSRF en navegadores modernos.
 *
 *   2) Validacion de Origin/Referer header: si el browser envia un Origin
 *      (siempre lo hace en POST cross-site moderno), debe estar en la lista
 *      de CORS permitidos. Si no envia Origin ni Referer, rechazamos en
 *      produccion (legitimo browser SIEMPRE envia uno).
 *
 *   3) Double-submit cookie pattern: cookie no-HttpOnly `XSRF-TOKEN` que JS
 *      puede leer. Axios (con withCredentials=true) lo replica automatico
 *      al header `X-XSRF-TOKEN`. Validamos que cookie == header. Un atacante
 *      no puede leer el cookie de otra origin → no puede replicar el header.
 *
 * El middleware es estricto: si CUALQUIERA de las verificaciones aplicables
 * falla, rechaza 403.
 */
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../shared/logging/logger.js";

// Funcion (no constante) para que cambios de NODE_ENV en runtime/tests funcionen.
const isProd = () =>
  String(process.env.NODE_ENV || "").toLowerCase() === "production";

const CSRF_COOKIE_NAME = "XSRF-TOKEN"; // axios default
const CSRF_HEADER_NAME = "x-xsrf-token"; // axios default

// ============================================================
// Helpers
// ============================================================

const constantTimeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

const matchesAllowedOrigin = (originOrReferer) => {
  if (!originOrReferer) return false;
  return env.corsOrigins.some((allowed) => {
    if (!allowed) return false;
    // Origin: comparacion exacta. Referer: empieza con el origin.
    return (
      originOrReferer === allowed ||
      originOrReferer.startsWith(allowed + "/")
    );
  });
};

// ============================================================
// Genera y devuelve un token CSRF nuevo
// ============================================================
export const generateCsrfToken = () => crypto.randomBytes(32).toString("hex");

export const getCsrfCookieOptions = () => {
  const configuredSameSite = String(
    process.env.COOKIE_SAMESITE || (isProd() ? "strict" : "lax")
  )
    .trim()
    .toLowerCase();
  const sameSite = ["strict", "lax", "none"].includes(configuredSameSite)
    ? configuredSameSite
    : isProd()
      ? "strict"
      : "lax";
  const domain = String(process.env.COOKIE_DOMAIN || "").trim();

  return {
  // NO httpOnly: el frontend necesita leerlo desde JS
  httpOnly: false,
  secure: isProd() || sameSite === "none",
  sameSite,
  ...(domain ? { domain } : {}),
  // Path raiz: para que el navegador lo envie en cualquier request a /api/saas/*
  path: "/",
  // No seteamos maxAge: cookie de sesion (vive lo que vive la pestania).
  // Si querés que persista, agregalo aca alineado con refresh-tokens.
  };
};

export const CSRF_COOKIE = CSRF_COOKIE_NAME;
export const CSRF_HEADER = CSRF_HEADER_NAME;

// ============================================================
// Middleware
// ============================================================
/**
 * Aplicar a endpoints que usan el cookie de refresh:
 *   router.post("/refresh", csrfGuard, controller.refresh);
 *   router.post("/logout",  csrfGuard, controller.logout);
 *
 * No aplicar a /login ni /bootstrap (no usan cookie, validan password).
 */
export const csrfGuard = (req, res, next) => {
  const method = String(req.method || "").toUpperCase();

  // Safe methods: nunca CSRF
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }

  // ----- (a) Validacion Origin/Referer -----
  const origin = req.headers.origin || null;
  const referer = req.headers.referer || null;

  if (origin) {
    if (!matchesAllowedOrigin(origin)) {
      logger.warn(
        { origin, path: req.originalUrl },
        "csrf: Origin no permitido"
      );
      return res.status(403).json({ error: "csrf_origin_invalid" });
    }
  } else if (referer) {
    if (!matchesAllowedOrigin(referer)) {
      logger.warn(
        { referer, path: req.originalUrl },
        "csrf: Referer no permitido"
      );
      return res.status(403).json({ error: "csrf_referer_invalid" });
    }
  } else if (isProd()) {
    // En prod, browser legitimo SIEMPRE envia Origin o Referer en POST.
    // Server-to-server / CLI tools / mobile apps deben usar Bearer auth, no cookie.
    logger.warn(
      { path: req.originalUrl, ua: req.headers["user-agent"] },
      "csrf: request sin Origin ni Referer en produccion"
    );
    return res.status(403).json({ error: "csrf_origin_required" });
  }

  // ----- (b) Double-submit cookie -----
  // Si no hay cookie CSRF aun (primer login), el cliente no puede tener el
  // header. Lo permitimos solo si el method es login/bootstrap. Como ESTE
  // middleware NO se monta en login/bootstrap, aca exigimos cookie+header.
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken =
    req.headers[CSRF_HEADER_NAME] || req.headers[CSRF_HEADER_NAME.toLowerCase()];

  if (!cookieToken || !headerToken) {
    // Permitir bypass en dev para curl/postman manuales si no hay cookie:
    // este escenario es POST a refresh sin haber pasado por login.
    if (!isProd() && !cookieToken && !headerToken) {
      logger.debug(
        { path: req.originalUrl },
        "csrf: bypass en dev (sin cookie ni header)"
      );
      return next();
    }
    logger.warn(
      {
        hasCookie: Boolean(cookieToken),
        hasHeader: Boolean(headerToken),
        path: req.originalUrl,
      },
      "csrf: cookie o header CSRF faltante"
    );
    return res.status(403).json({ error: "csrf_token_missing" });
  }

  if (!constantTimeEqual(cookieToken, headerToken)) {
    logger.warn({ path: req.originalUrl }, "csrf: cookie/header mismatch");
    return res.status(403).json({ error: "csrf_token_mismatch" });
  }

  next();
};
