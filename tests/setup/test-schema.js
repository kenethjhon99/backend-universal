// Schema minimo para los tests de comprobantes.
// Crea las tablas y funciones necesarias en un schema temporal por test run,
// asi cada `npm test` arranca limpio sin tocar tablas reales.
import pg from "pg";

const { Pool } = pg;

let testPool = null;
let testSchema = null;

const createPool = () =>
  new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 20,
    ...(testSchema
      ? { options: `-c search_path=${testSchema},public` }
      : {}),
  });

const buildSchemaName = () => {
  const suffix =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `test_comprobantes_${suffix}`;
};

export const getTestPool = () => {
  if (!testPool) {
    testPool = createPool();
  }
  return testPool;
};

export const getTestSchema = () => testSchema;

export const setupTestSchema = async () => {
  const pool = getTestPool();
  testSchema = buildSchemaName();

  await pool.query(`create schema ${testSchema}`);
  await pool.end();
  testPool = createPool();
  const schemaPool = getTestPool();

  // Tabla minima de comprobante_series con la unicidad real.
  await schemaPool.query(`
    create table ${testSchema}.comprobante_series (
      id_comprobante_serie bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      modulo varchar(30) not null,
      tipo_comprobante varchar(30) not null,
      nombre varchar(80) not null,
      serie varchar(20) not null,
      ultimo_correlativo bigint not null default 0,
      activo boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_sucursal, modulo, tipo_comprobante, serie)
    )
  `);

  return testSchema;
};

export const teardownTestSchema = async () => {
  if (!testPool) return;

  if (testSchema) {
    try {
      await testPool.query(`drop schema if exists ${testSchema} cascade`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[tests] No se pudo dropear schema de test:", error.message);
    }
  }

  await testPool.end();
  testPool = null;
  testSchema = null;
};

/**
 * Establece el search_path en el client/pool a nuestro schema temporal.
 * Util porque el helper `emitirComprobante` hace `insert into comprobante_series`
 * sin schema, asi que necesitamos que la tabla este resoluble por nombre simple.
 */
export const setSchemaSearchPath = async (clientOrPool) => {
  if (!testSchema) {
    throw new Error("Schema de test aun no inicializado");
  }
  await clientOrPool.query(`set search_path to ${testSchema}, public`);
};
