import pino from "pino";
import { env } from "../../config/env.js";

const isDev = String(env.nodeEnv).toLowerCase() !== "production";
const level = process.env.LOG_LEVEL || (isDev ? "debug" : "info");

/**
 * Logger pino global. En desarrollo usa pino-pretty para legibilidad humana.
 * En produccion emite JSON puro listo para ingestion (Datadog, ELK, Loki).
 */
export const logger = pino({
  level,
  base: {
    service: "pos-saas-api",
    env: env.nodeEnv,
  },
  // Redactar campos sensibles que podrian llegar a logs por accidente.
  // Cubre: credenciales, tokens, cookies, secrets MFA/CSRF/webhooks, PII
  // (emails/telefonos/nits/direcciones) que jamas debe quedar en logs.
  redact: {
    paths: [
      // Passwords / hashes
      "password",
      "password_hash",
      "admin_password",
      "new_password",
      "current_password",
      "*.password",
      "*.password_hash",
      "*.admin_password",
      "*.new_password",
      "*.current_password",
      // Tokens
      "token",
      "access_token",
      "refresh_token",
      "challenge_token",
      "*.token",
      "*.access_token",
      "*.refresh_token",
      "*.challenge_token",
      // Secrets (TOTP, webhooks, encryption)
      "secret",
      "secret_encrypted",
      "secret_iv",
      "secret_auth_tag",
      "backup_codes",
      "backup_codes_hash",
      "api_key",
      "auth_token",
      "bot_token",
      "stripe_signature",
      "*.secret",
      "*.api_key",
      // Headers HTTP
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-xsrf-token']",
      "req.headers['x-metrics-token']",
      "req.headers['x-docs-token']",
      "req.headers['stripe-signature']",
      "res.headers['set-cookie']",
      // Identificadores fiscales/PII (pueden viajar en payloads de billing)
      "nit",
      "rfc",
      "tax_id",
      "card",
      "card_number",
      "*.nit",
      "*.card_number",
    ],
    censor: "[REDACTED]",
    remove: false,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service",
          singleLine: false,
        },
      }
    : undefined,
});

/**
 * Devuelve un child logger con contexto adicional. Util en services para
 * agregar entityId, jobId, etc:
 *
 *   const log = childLogger({ module: "ventas", venta_id: 42 });
 *   log.info("creada");
 */
export const childLogger = (bindings) => logger.child(bindings || {});

export default logger;
