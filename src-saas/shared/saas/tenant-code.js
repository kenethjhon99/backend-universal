import { HttpError } from "../http/http-error.js";

const SERIES_CONFIG = {
  CLIENTES: {
    lockKey: 8201,
    tableName: "clientes",
    prefix: "CL",
  },
  PROVEEDORES: {
    lockKey: 8202,
    tableName: "proveedores",
    prefix: "PR",
  },
};

export const getNextTenantCode = async (db, { entityKey, idEmpresa }) => {
  const config = SERIES_CONFIG[String(entityKey || "").trim().toUpperCase()];

  if (!config) {
    throw HttpError.badRequest("Serie de codigo no configurada");
  }

  await db.query("select pg_advisory_xact_lock($1, $2)", [
    Number(idEmpresa),
    config.lockKey,
  ]);

  const result = await db.query(
    `
      select
        coalesce(max(substring(codigo from '[0-9]+$')::int), 0) + 1 as next_number
      from ${config.tableName}
      where id_empresa = $1
        and codigo ~ $2
    `,
    [idEmpresa, `^${config.prefix}-[0-9]+$`]
  );

  const nextNumber = Number(result.rows[0]?.next_number || 1);
  return `${config.prefix}-${String(nextNumber).padStart(4, "0")}`;
};
