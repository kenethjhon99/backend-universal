import pg from "pg";
import { env } from "./env.js";
import { logger } from "../shared/logging/logger.js";

const { Pool } = pg;

export const pool = new Pool({
  host: env.pg.host,
  port: env.pg.port,
  database: env.pg.database,
  user: env.pg.user,
  password: env.pg.password,
  ssl: env.pg.ssl,
});

pool.on("error", (error) => {
  logger.error({ err: error }, "unexpected postgres pool error");
});

export const applyRequestSettings = async (client, auth = {}) => {
  const settings = [
    ["app.current_empresa_id", auth.id_empresa],
    ["app.current_sucursal_id", auth.id_sucursal],
    ["app.current_usuario_id", auth.id_usuario],
    ["app.current_rol", auth.rol],
  ];

  for (const [key, value] of settings) {
    if (value === undefined || value === null || value === "") continue;
    await client.query("select set_config($1, $2, true)", [
      key,
      String(value),
    ]);
  }
};

export const pingDatabase = async () => {
  const result = await pool.query(`
    select
      now() as now,
      current_user as current_user,
      coalesce(
        (select rolbypassrls from pg_roles where rolname = current_user),
        false
      ) as bypassa_rls
  `);
  const row = result.rows[0];

  if (
    String(env.nodeEnv).toLowerCase() === "production" &&
    row?.bypassa_rls === true &&
    env.security.allowSuperuserDbInProduction !== true
  ) {
    throw new Error(
      `El rol DB '${row.current_user}' tiene BYPASSRLS. Usa saas_app sin BYPASSRLS en produccion.`
    );
  }

  return row;
};
