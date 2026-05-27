#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "database", "migrations");
const dryRun = process.argv.includes("--dry-run");
const baseline = process.argv.includes("--baseline");
const baselineThroughArg = process.argv.find((arg) =>
  arg.startsWith("--baseline-through=")
);
const baselineThrough = baselineThroughArg
  ? baselineThroughArg.split("=").slice(1).join("=").trim()
  : null;

const required = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[migrate] Falta ${key}`);
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: ["require", "true", "1"].includes(
    String(process.env.PGSSLMODE || "").toLowerCase()
  )
    ? { rejectUnauthorized: false }
    : false,
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const ensureTable = async (client) => {
  await client.query(`
    create table if not exists app_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
};

const main = async () => {
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await ensureTable(client);
    const appliedResult = await client.query(
      `select filename, checksum from app_migrations`
    );
    const applied = new Map(
      appliedResult.rows.map((row) => [row.filename, row.checksum])
    );

    let pending = 0;
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      const checksum = sha256(sql);
      const known = applied.get(file);

      if (known) {
        if (known !== checksum) {
          throw new Error(
            `Checksum cambio para ${file}. No edites migraciones ya aplicadas.`
          );
        }
        continue;
      }

      pending += 1;
      console.log(`[migrate] pendiente ${file}`);
      const shouldBaselineFile =
        baseline || (baselineThrough && file <= baselineThrough);
      if (shouldBaselineFile) {
        await client.query(
          `insert into app_migrations (filename, checksum) values ($1, $2)`,
          [file, checksum]
        );
        console.log(`[migrate] baseline ${file}`);
        continue;
      }
      if (dryRun) continue;

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into app_migrations (filename, checksum) values ($1, $2)`,
          [file, checksum]
        );
        await client.query("commit");
        console.log(`[migrate] aplicado ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    console.log(
      baseline || baselineThrough
        ? `[migrate] baseline OK. Registradas: ${pending}`
        : dryRun
        ? `[migrate] dry-run OK. Pendientes: ${pending}`
        : `[migrate] OK. Aplicadas nuevas: ${pending}`
    );
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch(async (error) => {
  console.error(`[migrate] ERROR: ${error.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
