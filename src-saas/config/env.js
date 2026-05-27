import dotenv from "dotenv";

dotenv.config();

const getEnv = (name, fallback = undefined) => {
  const value = process.env[name];

  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
};

const splitCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const isRemoteHost = (host) => {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized && !["localhost", "127.0.0.1"].includes(normalized);
};

const resolveSsl = () => {
  const mode = String(process.env.PGSSLMODE || "").trim().toLowerCase();

  if (["disable", "false", "0"].includes(mode)) return false;
  if (["require", "prefer", "true", "1"].includes(mode)) {
    return { rejectUnauthorized: false };
  }

  return isRemoteHost(process.env.PGHOST)
    ? { rejectUnauthorized: false }
    : false;
};

// =========================================================================
// Validación temprana de JWT_SECRET.
// - Mínimo 32 caracteres (ataques de fuerza bruta sobre HMAC-SHA256).
// - Bloquea valores placeholder conocidos en producción.
// - En desarrollo, solo emite warning para no romper DX.
// =========================================================================
const FORBIDDEN_JWT_SECRETS = new Set([
  "change-this-secret",
  "secret",
  "changeme",
  "supersecret",
  "your-secret-here",
  "__cambiar__minimo_32_caracteres_aleatorios__",
]);

const validateJwtSecret = (secret, nodeEnv) => {
  const value = String(secret || "");
  const isProd = String(nodeEnv).toLowerCase() === "production";

  if (FORBIDDEN_JWT_SECRETS.has(value)) {
    const msg =
      "JWT_SECRET tiene un valor placeholder inseguro. Rotalo: openssl rand -hex 32";
    if (isProd) throw new Error(msg);
    console.warn(`[env] WARN: ${msg}`);
  }

  if (value.length < 32) {
    const msg = `JWT_SECRET debe tener al menos 32 caracteres (actual: ${value.length}).`;
    if (isProd) throw new Error(msg);
    console.warn(`[env] WARN: ${msg}`);
  }

  return value;
};

const nodeEnv = getEnv("NODE_ENV", "development");
const jwtSecret = validateJwtSecret(getEnv("JWT_SECRET"), nodeEnv);
const pgUser = getEnv("PGUSER");
const isProduction = String(nodeEnv).toLowerCase() === "production";
const isVitest = String(process.env.VITEST || "").toLowerCase() === "true";
const allowSuperuserDbInProduction =
  String(process.env.ALLOW_SUPERUSER_DB_IN_PRODUCTION || "")
    .trim()
    .toLowerCase() === "true";

if (
  isProduction &&
  !isVitest &&
  ["postgres", "root", "superuser"].includes(
    String(pgUser).trim().toLowerCase()
  ) &&
  !allowSuperuserDbInProduction
) {
  throw new Error(
    "PGUSER no debe ser un superuser en produccion. Usa el rol saas_app sin BYPASSRLS o define ALLOW_SUPERUSER_DB_IN_PRODUCTION=true solo para una emergencia controlada."
  );
}

export const env = {
  nodeEnv,
  port: Number(getEnv("PORT", 4000)),
  jwtSecret,
  jwtExpires: getEnv("JWT_EXPIRES", "8h"),
  corsOrigins: splitCsv(
    process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "http://localhost:5173"
  ),
  pg: {
    host: getEnv("PGHOST", "localhost"),
    port: Number(getEnv("PGPORT", 5432)),
    database: getEnv("PGDATABASE"),
    user: pgUser,
    password: getEnv("PGPASSWORD"),
    ssl: resolveSsl(),
  },
  security: {
    allowSuperuserDbInProduction,
  },
};
