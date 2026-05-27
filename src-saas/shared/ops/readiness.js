import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, pingDatabase } from "../../config/db.js";
import { env } from "../../config/env.js";
import { queueAvailable } from "../queue/queues.js";
import { readinessChecks } from "../metrics/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../database/migrations");

const isProduction = () => String(env.nodeEnv).toLowerCase() === "production";

const check = ({ name, status, severity = "critical", message = null, meta = {} }) => ({
  name,
  status,
  severity,
  ok: status === "ok",
  message,
  meta,
});

const listMigrationFiles = async () => {
  try {
    const files = await fs.readdir(MIGRATIONS_DIR);
    return files.filter((file) => file.endsWith(".sql")).sort();
  } catch {
    return [];
  }
};

const getAppliedMigrations = async () => {
  const exists = await pool.query(
    `
      select to_regclass('public.app_migrations') as table_name
    `
  );
  if (!exists.rows[0]?.table_name) {
    return null;
  }

  const result = await pool.query(
    `
      select filename
      from app_migrations
      order by filename asc
    `
  );
  return result.rows.map((row) => row.filename);
};

const checkDatabase = async () => {
  try {
    const db = await pingDatabase();
    return check({
      name: "database",
      status: "ok",
      meta: {
        now: db.now,
        current_user: db.current_user,
        bypassa_rls: db.bypassa_rls === true,
      },
    });
  } catch (error) {
    return check({
      name: "database",
      status: "fail",
      severity: "critical",
      message: error.message,
    });
  }
};

const checkMigrations = async () => {
  try {
    const files = await listMigrationFiles();
    const applied = await getAppliedMigrations();

    if (applied === null) {
      return check({
        name: "migrations",
        status: isProduction() ? "fail" : "warn",
        severity: isProduction() ? "critical" : "warning",
        message: "app_migrations no existe; ejecuta npm run db:migrate",
        meta: { files: files.length, applied: null },
      });
    }

    const missing = files.filter((file) => !applied.includes(file));
    return check({
      name: "migrations",
      status: missing.length === 0 ? "ok" : "fail",
      severity: "critical",
      message:
        missing.length === 0
          ? null
          : `Migraciones pendientes: ${missing.slice(0, 5).join(", ")}`,
      meta: {
        files: files.length,
        applied: applied.length,
        pending: missing.length,
      },
    });
  } catch (error) {
    return check({
      name: "migrations",
      status: "fail",
      severity: "critical",
      message: error.message,
    });
  }
};

const checkRuntime = () => {
  const warnings = [];
  const failures = [];

  if (isProduction() && !process.env.REDIS_URL) {
    failures.push("REDIS_URL requerido para workers/rate limit distribuido");
  }
  if (isProduction() && !process.env.METRICS_TOKEN) {
    warnings.push("METRICS_TOKEN no configurado");
  }
  if (isProduction() && !process.env.SENTRY_DSN) {
    warnings.push("SENTRY_DSN no configurado");
  }
  if (isProduction() && !process.env.S3_BUCKET) {
    warnings.push("S3_BUCKET no configurado para archivos/backups externos");
  }

  return check({
    name: "runtime_config",
    status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "ok",
    severity: failures.length > 0 ? "critical" : "warning",
    message: [...failures, ...warnings].join("; ") || null,
    meta: {
      node_env: env.nodeEnv,
      redis_configured: Boolean(process.env.REDIS_URL),
      sentry_configured: Boolean(process.env.SENTRY_DSN),
      metrics_token_configured: Boolean(process.env.METRICS_TOKEN),
      s3_configured: Boolean(process.env.S3_BUCKET),
    },
  });
};

const checkQueue = () =>
  check({
    name: "queue",
    status: queueAvailable() ? "ok" : isProduction() ? "fail" : "warn",
    severity: isProduction() ? "critical" : "warning",
    message: queueAvailable()
      ? null
      : "BullMQ/Redis no disponible; jobs quedan limitados al fallback",
    meta: {
      mode: queueAvailable() ? "redis" : "in-process",
    },
  });

export const buildReadinessReport = async () => {
  const checks = [
    await checkDatabase(),
    await checkMigrations(),
    checkRuntime(),
    checkQueue(),
  ];

  for (const item of checks) {
    readinessChecks.set(
      { check: item.name, severity: item.severity },
      item.ok ? 1 : 0
    );
  }

  const criticalFailed = checks.some(
    (item) => item.status === "fail" && item.severity === "critical"
  );
  const degraded = checks.some((item) => item.status !== "ok");

  return {
    ok: !criticalFailed,
    status: criticalFailed ? "not_ready" : degraded ? "degraded" : "ready",
    service: "pos-saas-api",
    env: env.nodeEnv,
    ts: new Date().toISOString(),
    checks,
  };
};
