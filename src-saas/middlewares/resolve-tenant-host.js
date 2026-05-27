import { pool } from "../config/db.js";
import { logger } from "../shared/logging/logger.js";

/**
 * Middleware que resuelve el tenant por el Host header (marca blanca).
 * Pone en req.tenantContext = { id_empresa, hostname, branding } si el host
 * está registrado y verificado.
 *
 * Se monta ANTES de authenticate para que las pantallas públicas
 * (login, registro, pantalla pública de orden) puedan tomar el branding
 * sin estar autenticadas.
 *
 * Si el host es localhost o el dominio principal del SaaS, no se aplica
 * (request normal, sin contexto especial).
 */

const APP_DOMAIN = process.env.APP_DOMAIN || ""; // ej. "pos-saas.com"
const SKIP_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

// Cache en memoria con TTL corto para evitar pegarle a Postgres en cada request
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const getFromCache = (host) => {
  const entry = cache.get(host);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  return null;
};

const setCache = (host, value) => {
  cache.set(host, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

export const invalidateTenantHostCache = (host) => {
  if (host) cache.delete(host.toLowerCase());
  else cache.clear();
};

export const resolveTenantByHost = async (req, _res, next) => {
  try {
    const rawHost = String(req.headers.host || "")
      .split(":")[0]
      .toLowerCase();

    if (!rawHost || SKIP_HOSTS.has(rawHost)) {
      return next();
    }

    // Si el host es el dominio principal del SaaS, no es tenant marca blanca
    if (APP_DOMAIN && rawHost === APP_DOMAIN.toLowerCase()) {
      return next();
    }

    // Cache hit
    const cached = getFromCache(rawHost);
    if (cached !== null) {
      if (cached === false) return next(); // host no registrado
      req.tenantContext = cached;
      return next();
    }

    const r = await pool.query(
      `select * from app.resolve_tenant_by_host($1)`,
      [rawHost]
    );

    if (r.rowCount === 0) {
      setCache(rawHost, false);
      return next();
    }

    const tenant = {
      id_empresa: Number(r.rows[0].id_empresa),
      hostname: r.rows[0].hostname,
      branding: r.rows[0].branding || {},
    };
    setCache(rawHost, tenant);
    req.tenantContext = tenant;
    next();
  } catch (err) {
    logger.warn({ err: err.message }, "resolve-tenant-host fallo");
    next(); // no bloquear la request si esto falla
  }
};
