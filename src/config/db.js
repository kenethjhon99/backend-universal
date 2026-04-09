import dotenv from "dotenv";
import pg from "pg";
import { hashPassword } from "../utils/password.js";

dotenv.config();

const { Pool } = pg;

const isRemotePostgresHost = (host) => {
  const normalizedHost = String(host || "").trim().toLowerCase();

  if (!normalizedHost) return false;

  return !["localhost", "127.0.0.1"].includes(normalizedHost);
};

const shouldUseSSL = () => {
  const sslMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();

  if (["disable", "false", "0"].includes(sslMode)) return false;
  if (["require", "prefer", "true", "1"].includes(sslMode)) return true;

  return isRemotePostgresHost(process.env.PGHOST);
};

export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: shouldUseSSL() ? { rejectUnauthorized: false } : false,
});

pool.on("connect", (client) => {
  client.query("SET search_path TO public").catch((error) => {
    console.error("No se pudo fijar search_path en public:", error.message);
  });
});

const AUDIT_TABLES = [
  "Producto",
  "Proveedor",
  "Clientes",
  "Usuario",
  "Persona",
  "Compra",
  "Detalle_compra",
  "Venta",
  "Detalle_venta",
  "Stock_producto",
  "Movimiento_stock",
  "Rol",
  "Detalle_usuario",
];

const SOFT_DELETE_TABLES = [
  { tableName: "Producto", activeColumn: "activo" },
  { tableName: "Proveedor", activeColumn: "estado" },
  { tableName: "Clientes", activeColumn: "estado" },
  { tableName: "Usuario", activeColumn: "activo" },
  { tableName: "Persona", activeColumn: "estado" },
  { tableName: "Detalle_usuario", activeColumn: "activo" },
];

const sanitizeTriggerName = (tableName) =>
  `trg_${String(tableName).toLowerCase().replace(/[^a-z0-9]+/g, "_")}_updated_at`;

const getBootstrapRoles = () => {
  return String(process.env.BOOTSTRAP_ROLES || "SUPER_ADMIN")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
};

const ensureBootstrapUser = async () => {
  const username = String(process.env.BOOTSTRAP_USERNAME || "").trim();
  const password = String(process.env.BOOTSTRAP_PASSWORD || "");

  if (!username || !password) return;

  const nombre = String(process.env.BOOTSTRAP_NOMBRE || "Super").trim() || "Super";
  const apellido = String(process.env.BOOTSTRAP_APELLIDO || "Admin").trim() || "Admin";
  const roles = getBootstrapRoles();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const passwordHash = await hashPassword(password);

    let userResult = await client.query(
      `SELECT id_usuario
       FROM "Usuario"
       WHERE username = $1
       LIMIT 1`,
      [username]
    );

    let idUsuario = userResult.rows[0]?.id_usuario ?? null;

    if (!idUsuario) {
      userResult = await client.query(
        `INSERT INTO "Usuario" (username, password_hash, nombre, activo)
         VALUES ($1, $2, $3, true)
         RETURNING id_usuario`,
        [username, passwordHash, `${nombre} ${apellido}`.trim()]
      );

      idUsuario = userResult.rows[0].id_usuario;

      await client.query(
        `INSERT INTO "Persona"
         (nombre, apellido, fecha_inicio, estado, id_usuario)
         VALUES ($1, $2, CURRENT_DATE, true, $3)`,
        [nombre, apellido, idUsuario]
      );
    } else {
      await client.query(
        `UPDATE "Usuario"
         SET password_hash = $1,
             nombre = $2,
             activo = true
         WHERE id_usuario = $3`,
        [passwordHash, `${nombre} ${apellido}`.trim(), idUsuario]
      );

      await client.query(
        `UPDATE "Persona"
         SET nombre = $1,
             apellido = $2,
             estado = true,
             fecha_inicio = COALESCE(fecha_inicio, CURRENT_DATE)
         WHERE id_usuario = $3`,
        [nombre, apellido, idUsuario]
      );
    }

    if (roles.length > 0) {
      const roleRows = await client.query(
        `SELECT id_rol, UPPER(TRIM(nombre_rol)) AS nombre_rol
         FROM "Rol"
         WHERE UPPER(TRIM(nombre_rol)) = ANY($1::text[])`,
        [roles]
      );

      for (const role of roleRows.rows) {
        await client.query(
          `INSERT INTO "Detalle_usuario" (id_usuario, id_rol, activo)
           VALUES ($1, $2, true)
           ON CONFLICT DO NOTHING`,
          [idUsuario, role.id_rol]
        );

        await client.query(
          `UPDATE "Detalle_usuario"
           SET activo = true
           WHERE id_usuario = $1
             AND id_rol = $2`,
          [idUsuario, role.id_rol]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const ensureAuditColumnsForTable = async (tableName) => {
  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now()
  `);

  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now()
  `);

  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS created_by integer
  `);

  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS updated_by integer
  `);

  await pool.query(`
    UPDATE "${tableName}"
    SET created_at = COALESCE(created_at, now()),
        updated_at = COALESCE(updated_at, now())
    WHERE created_at IS NULL OR updated_at IS NULL
  `);
};

const ensureSoftDeleteColumnsForTable = async (tableName, activeColumn) => {
  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS "${activeColumn}" boolean NOT NULL DEFAULT true
  `);

  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS inactivado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "${tableName}"
    ADD COLUMN IF NOT EXISTS inactivado_por integer
  `);
};

const ensureUpdatedAtTriggerForTable = async (tableName) => {
  const triggerName = sanitizeTriggerName(tableName);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = '${triggerName}'
      ) THEN
        EXECUTE 'CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON "${tableName}"
        FOR EACH ROW
        EXECUTE FUNCTION public.set_updated_at_column()';
      END IF;
    END $$;
  `);
};

export async function ensureSchema() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS public
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION public.set_updated_at_column()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  for (const tableName of AUDIT_TABLES) {
    await ensureAuditColumnsForTable(tableName);
  }

  for (const table of SOFT_DELETE_TABLES) {
    await ensureSoftDeleteColumnsForTable(table.tableName, table.activeColumn);
  }

  for (const tableName of AUDIT_TABLES) {
    await ensureUpdatedAtTriggerForTable(tableName);
  }

  await pool.query(`
    ALTER TABLE "Clientes"
    ADD COLUMN IF NOT EXISTS nombre character varying(150)
  `);

  await pool.query(`
    ALTER TABLE "Clientes"
    ADD COLUMN IF NOT EXISTS telefono character varying(30)
  `);

  await pool.query(`
    ALTER TABLE "Clientes"
    ADD COLUMN IF NOT EXISTS correo character varying(150)
  `);

  await pool.query(`
    ALTER TABLE "Clientes"
    ADD COLUMN IF NOT EXISTS direccion character varying(250)
  `);

  await pool.query(`
    ALTER TABLE "Producto"
    ADD COLUMN IF NOT EXISTS modulo_origen character varying(20) NOT NULL DEFAULT 'GENERAL'
  `);

  await pool.query(`
    UPDATE "Producto"
    SET modulo_origen = 'GENERAL'
    WHERE modulo_origen IS NULL
       OR BTRIM(modulo_origen) = ''
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "clientes_nit_unique"
    ON "Clientes" (nit)
    WHERE nit IS NOT NULL
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS id_cliente integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS id_caja_sesion integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS id_comprobante_serie integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS tipo_comprobante character varying(30)
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS serie_comprobante character varying(20)
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS correlativo_comprobante integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS numero_comprobante character varying(50)
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS monto_recibido numeric(12,2)
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS cambio_entregado numeric(12,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_motivo text
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_por integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_por integer
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Venta"
    ADD COLUMN IF NOT EXISTS no_cobrado_validacion_nota text
  `);

  await pool.query(`
    ALTER TABLE "Compra"
    ADD COLUMN IF NOT EXISTS anulada_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Compra"
    ADD COLUMN IF NOT EXISTS anulada_por integer
  `);

  await pool.query(`
    ALTER TABLE "Compra"
    ADD COLUMN IF NOT EXISTS motivo_anulacion text
  `);

  await pool.query(`
    ALTER TABLE "Detalle_compra"
    ADD COLUMN IF NOT EXISTS cantidad_anulada integer NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE "Detalle_compra"
    ADD COLUMN IF NOT EXISTS anulada_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Detalle_compra"
    ADD COLUMN IF NOT EXISTS anulada_por integer
  `);

  await pool.query(`
    ALTER TABLE "Detalle_compra"
    ADD COLUMN IF NOT EXISTS motivo_anulacion text
  `);

  await pool.query(`
    ALTER TABLE "Detalle_compra"
    ADD COLUMN IF NOT EXISTS estado character varying(20) NOT NULL DEFAULT 'ACTIVO'
  `);

  await pool.query(`
    ALTER TABLE "Detalle_venta"
    ADD COLUMN IF NOT EXISTS cantidad_anulada integer NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE "Detalle_venta"
    ADD COLUMN IF NOT EXISTS anulada_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Detalle_venta"
    ADD COLUMN IF NOT EXISTS anulada_por integer
  `);

  await pool.query(`
    ALTER TABLE "Detalle_venta"
    ADD COLUMN IF NOT EXISTS motivo_anulacion text
  `);

  await pool.query(`
    ALTER TABLE "Detalle_venta"
    ADD COLUMN IF NOT EXISTS estado character varying(20) NOT NULL DEFAULT 'ACTIVO'
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'Venta'
          AND constraint_name = 'fk_venta_cliente'
      ) THEN
        ALTER TABLE "Venta"
        ADD CONSTRAINT fk_venta_cliente
        FOREIGN KEY (id_cliente) REFERENCES "Clientes"("Id_clientes");
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_venta_cliente"
    ON "Venta" (id_cliente)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Detalle_venta_anulacion" (
      id_anulacion serial PRIMARY KEY,
      id_venta integer NOT NULL REFERENCES "Venta"(id_venta),
      id_detalle integer NOT NULL REFERENCES "Detalle_venta"(id_detalle),
      id_producto integer REFERENCES "Producto"(id_producto),
      cantidad integer NOT NULL,
      motivo text,
      fecha timestamp with time zone NOT NULL DEFAULT now(),
      id_usuario integer REFERENCES "Usuario"(id_usuario)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_detalle_venta_anulacion_venta"
    ON "Detalle_venta_anulacion" (id_venta)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_detalle_venta_anulacion_detalle"
    ON "Detalle_venta_anulacion" (id_detalle)
  `);

  await ensureAuditColumnsForTable("Detalle_venta_anulacion");
  await ensureUpdatedAtTriggerForTable("Detalle_venta_anulacion");

  await pool.query(`
    UPDATE "Detalle_venta_anulacion"
    SET created_at = COALESCE(created_at, fecha),
        updated_at = COALESCE(updated_at, fecha),
        created_by = COALESCE(created_by, id_usuario),
        updated_by = COALESCE(updated_by, id_usuario)
    WHERE created_at IS NULL
       OR updated_at IS NULL
       OR created_by IS NULL
       OR updated_by IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Detalle_compra_anulacion" (
      id_anulacion serial PRIMARY KEY,
      id_compra integer NOT NULL REFERENCES "Compra"(id_compra),
      id_detalle_compra integer NOT NULL REFERENCES "Detalle_compra"(id_detalle_compra),
      id_producto integer REFERENCES "Producto"(id_producto),
      cantidad integer NOT NULL,
      motivo text,
      fecha timestamp with time zone NOT NULL DEFAULT now(),
      id_usuario integer REFERENCES "Usuario"(id_usuario)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_detalle_compra_anulacion_compra"
    ON "Detalle_compra_anulacion" (id_compra)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_detalle_compra_anulacion_detalle"
    ON "Detalle_compra_anulacion" (id_detalle_compra)
  `);

  await ensureAuditColumnsForTable("Detalle_compra_anulacion");
  await ensureUpdatedAtTriggerForTable("Detalle_compra_anulacion");

  await pool.query(`
    UPDATE "Detalle_compra_anulacion"
    SET created_at = COALESCE(created_at, fecha),
        updated_at = COALESCE(updated_at, fecha),
        created_by = COALESCE(created_by, id_usuario),
        updated_by = COALESCE(updated_by, id_usuario)
    WHERE created_at IS NULL
       OR updated_at IS NULL
       OR created_by IS NULL
       OR updated_by IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Caja_sesion" (
      id_caja_sesion serial PRIMARY KEY,
      id_usuario integer NOT NULL REFERENCES "Usuario"(id_usuario),
      id_sucursal integer NOT NULL DEFAULT 1,
      estado character varying(20) NOT NULL DEFAULT 'ABIERTA',
      monto_apertura numeric(12,2) NOT NULL DEFAULT 0,
      monto_cierre_reportado numeric(12,2),
      monto_cierre_calculado numeric(12,2),
      diferencia numeric(12,2),
      observaciones_apertura text,
      observaciones_cierre text,
      fecha_apertura timestamp with time zone NOT NULL DEFAULT now(),
      fecha_cierre timestamp with time zone
    )
  `);

  await ensureAuditColumnsForTable("Caja_sesion");
  await ensureUpdatedAtTriggerForTable("Caja_sesion");

  await pool.query(`
    ALTER TABLE "Caja_sesion"
    ADD COLUMN IF NOT EXISTS diferencia_validada_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Caja_sesion"
    ADD COLUMN IF NOT EXISTS diferencia_validada_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Caja_sesion"
    ADD COLUMN IF NOT EXISTS diferencia_validacion_nota text
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_caja_sesion_abierta_usuario"
    ON "Caja_sesion" (id_usuario)
    WHERE estado = 'ABIERTA'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_caja_sesion_usuario_fecha"
    ON "Caja_sesion" (id_usuario, fecha_apertura DESC)
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'Venta'
          AND constraint_name = 'fk_venta_caja_sesion'
      ) THEN
        ALTER TABLE "Venta"
        ADD CONSTRAINT fk_venta_caja_sesion
        FOREIGN KEY (id_caja_sesion) REFERENCES "Caja_sesion"(id_caja_sesion);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Caja_movimiento" (
      id_caja_movimiento serial PRIMARY KEY,
      id_caja_sesion integer NOT NULL REFERENCES "Caja_sesion"(id_caja_sesion),
      id_usuario integer NOT NULL REFERENCES "Usuario"(id_usuario),
      tipo character varying(20) NOT NULL,
      categoria character varying(50),
      monto numeric(12,2) NOT NULL,
      descripcion text,
      fecha timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  await ensureAuditColumnsForTable("Caja_movimiento");
  await ensureUpdatedAtTriggerForTable("Caja_movimiento");

  await pool.query(`
    ALTER TABLE "Caja_movimiento"
    ADD COLUMN IF NOT EXISTS autorizado_por_admin_id integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Caja_movimiento"
    ADD COLUMN IF NOT EXISTS autorizado_por_admin_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Caja_movimiento"
    ADD COLUMN IF NOT EXISTS autorizacion_admin_nota text
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_caja_movimiento_sesion_fecha"
    ON "Caja_movimiento" (id_caja_sesion, fecha DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Comprobante_serie" (
      id_comprobante_serie serial PRIMARY KEY,
      modulo character varying(30) NOT NULL,
      tipo_comprobante character varying(30) NOT NULL,
      nombre character varying(80) NOT NULL,
      serie character varying(20) NOT NULL,
      descripcion text,
      ultimo_correlativo integer NOT NULL DEFAULT 0,
      activo boolean NOT NULL DEFAULT true
    )
  `);

  await ensureAuditColumnsForTable("Comprobante_serie");
  await ensureSoftDeleteColumnsForTable("Comprobante_serie", "activo");
  await ensureUpdatedAtTriggerForTable("Comprobante_serie");

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_comprobante_serie_modulo_tipo_serie"
    ON "Comprobante_serie" (modulo, tipo_comprobante, serie)
  `);

  await pool.query(`
    INSERT INTO "Comprobante_serie"
      (modulo, tipo_comprobante, nombre, serie, descripcion, ultimo_correlativo)
    VALUES
      ('VENTA', 'TICKET', 'Ticket de venta', 'TKT', 'Comprobante interno de punto de venta', 0),
      ('VENTA', 'FACTURA', 'Factura', 'FAC', 'Documento fiscal correlativo para venta', 0),
      ('VENTA', 'CCF', 'Credito fiscal', 'CCF', 'Comprobante fiscal con serie correlativa', 0)
    ON CONFLICT ("modulo", "tipo_comprobante", "serie") DO NOTHING
  `);

  await pool.query(`
    UPDATE "Comprobante_serie" serie
    SET ultimo_correlativo = GREATEST(
      COALESCE(serie.ultimo_correlativo, 0),
      COALESCE(data.max_correlativo, 0)
    )
    FROM (
      SELECT
        COALESCE(tipo_comprobante, 'TICKET') AS tipo_comprobante,
        COALESCE(serie_comprobante, 'TKT') AS serie_comprobante,
        MAX(COALESCE(correlativo_comprobante, id_venta)) AS max_correlativo
      FROM "Venta"
      GROUP BY COALESCE(tipo_comprobante, 'TICKET'), COALESCE(serie_comprobante, 'TKT')
    ) data
    WHERE serie.modulo = 'VENTA'
      AND serie.tipo_comprobante = data.tipo_comprobante
      AND serie.serie = data.serie_comprobante
  `);

  await pool.query(`
    UPDATE "Venta"
    SET tipo_comprobante = COALESCE(tipo_comprobante, 'TICKET'),
        serie_comprobante = COALESCE(serie_comprobante, 'TKT'),
        correlativo_comprobante = COALESCE(correlativo_comprobante, id_venta),
        numero_comprobante = COALESCE(
          numero_comprobante,
          CONCAT(
            COALESCE(serie_comprobante, 'TKT'),
            '-',
            LPAD(COALESCE(correlativo_comprobante, id_venta)::text, 6, '0')
          )
        )
    WHERE tipo_comprobante IS NULL
       OR serie_comprobante IS NULL
       OR correlativo_comprobante IS NULL
       OR numero_comprobante IS NULL
  `);

  await pool.query(`
    UPDATE "Venta" v
    SET id_comprobante_serie = serie.id_comprobante_serie
    FROM "Comprobante_serie" serie
    WHERE serie.modulo = 'VENTA'
      AND serie.tipo_comprobante = COALESCE(v.tipo_comprobante, 'TICKET')
      AND serie.serie = COALESCE(v.serie_comprobante, 'TKT')
      AND (v.id_comprobante_serie IS NULL OR v.id_comprobante_serie <> serie.id_comprobante_serie)
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'Venta'
          AND constraint_name = 'fk_venta_comprobante_serie'
      ) THEN
        ALTER TABLE "Venta"
        ADD CONSTRAINT fk_venta_comprobante_serie
        FOREIGN KEY (id_comprobante_serie) REFERENCES "Comprobante_serie"(id_comprobante_serie);
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_venta_numero_comprobante"
    ON "Venta" (numero_comprobante)
    WHERE numero_comprobante IS NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Servicio_tipo_vehiculo" (
      id_tipo_vehiculo serial PRIMARY KEY,
      modulo character varying(30) NOT NULL,
      nombre character varying(80) NOT NULL,
      slug character varying(80) NOT NULL,
      descripcion text,
      icono character varying(80),
      orden integer NOT NULL DEFAULT 0,
      activo boolean NOT NULL DEFAULT true
    )
  `);

  await ensureAuditColumnsForTable("Servicio_tipo_vehiculo");
  await ensureSoftDeleteColumnsForTable("Servicio_tipo_vehiculo", "activo");
  await ensureUpdatedAtTriggerForTable("Servicio_tipo_vehiculo");

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_servicio_tipo_vehiculo_modulo_slug"
    ON "Servicio_tipo_vehiculo" (modulo, slug)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Servicio_catalogo" (
      id_servicio_catalogo serial PRIMARY KEY,
      id_tipo_vehiculo integer NOT NULL REFERENCES "Servicio_tipo_vehiculo"(id_tipo_vehiculo),
      modulo character varying(30) NOT NULL,
      nombre character varying(100) NOT NULL,
      slug character varying(100) NOT NULL,
      descripcion text,
      precio_base numeric(12,2) NOT NULL DEFAULT 0,
      duracion_minutos integer,
      icono character varying(80),
      orden integer NOT NULL DEFAULT 0,
      activo boolean NOT NULL DEFAULT true
    )
  `);

  await ensureAuditColumnsForTable("Servicio_catalogo");
  await ensureSoftDeleteColumnsForTable("Servicio_catalogo", "activo");
  await ensureUpdatedAtTriggerForTable("Servicio_catalogo");

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_servicio_catalogo_tipo_slug"
    ON "Servicio_catalogo" (id_tipo_vehiculo, slug)
  `);

  await pool.query(`
    INSERT INTO "Servicio_tipo_vehiculo" (
      modulo,
      nombre,
      slug,
      descripcion,
      icono,
      orden,
      activo
    )
    SELECT
      v.modulo,
      v.nombre,
      v.slug,
      v.descripcion,
      v.icono,
      v.orden,
      true
    FROM (
      VALUES
        ('AUTOLAVADO', 'Moto', 'moto', 'Servicios de lavado para motocicletas.', 'two_wheeler', 1),
        ('AUTOLAVADO', 'Carro', 'carro', 'Servicios de lavado para automoviles.', 'directions_car', 2),
        ('AUTOLAVADO', 'Pickup', 'pickup', 'Servicios de limpieza para pickups y camionetas.', 'airport_shuttle', 3),
        ('AUTOLAVADO', 'Camion', 'camion', 'Servicios de lavado para camiones y vehiculos pesados.', 'local_shipping', 4)
    ) AS v(modulo, nombre, slug, descripcion, icono, orden)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Servicio_tipo_vehiculo" stv
      WHERE stv.modulo = v.modulo
        AND stv.slug = v.slug
    )
  `);

  await pool.query(`
    INSERT INTO "Servicio_tipo_vehiculo" (
      modulo,
      nombre,
      slug,
      descripcion,
      icono,
      orden,
      activo
    )
    SELECT
      v.modulo,
      v.nombre,
      v.slug,
      v.descripcion,
      v.icono,
      v.orden,
      true
    FROM (
      VALUES
        ('REPARACION', 'Moto', 'moto', 'Servicios de taller para motocicletas.', 'two_wheeler', 1),
        ('REPARACION', 'Sedan', 'sedan', 'Trabajos mecanicos para sedan y automoviles livianos.', 'directions_car', 2),
        ('REPARACION', 'SUV', 'suv', 'Servicios de mecanica para SUV y camionetas familiares.', 'airport_shuttle', 3),
        ('REPARACION', 'Pickup', 'pickup', 'Mantenimiento y reparacion para pickups de trabajo.', 'airport_shuttle', 4),
        ('REPARACION', 'Camion', 'camion', 'Servicios mecanicos para camiones y flotillas.', 'local_shipping', 5),
        ('REPARACION', 'Microbus', 'microbus', 'Diagnostico y mantenimiento para microbuses.', 'directions_bus', 6)
    ) AS v(modulo, nombre, slug, descripcion, icono, orden)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Servicio_tipo_vehiculo" stv
      WHERE stv.modulo = v.modulo
        AND stv.slug = v.slug
    )
  `);

  await pool.query(`
    INSERT INTO "Servicio_catalogo" (
      id_tipo_vehiculo,
      modulo,
      nombre,
      slug,
      descripcion,
      precio_base,
      duracion_minutos,
      icono,
      orden,
      activo
    )
    SELECT
      stv.id_tipo_vehiculo,
      data.modulo,
      data.nombre,
      data.slug,
      data.descripcion,
      data.precio_base,
      data.duracion_minutos,
      data.icono,
      data.orden,
      true
    FROM (
      VALUES
        ('AUTOLAVADO', 'moto', 'Solo lavado', 'solo-lavado', 'Lavado exterior agil para motocicletas.', 20.00, 20, 'cleaning_services', 1),
        ('AUTOLAVADO', 'moto', 'Lavado y brillo', 'lavado-y-brillo', 'Lavado con acabado brillante para motocicletas.', 30.00, 30, 'auto_awesome', 2),
        ('AUTOLAVADO', 'moto', 'Lavado completo', 'lavado-completo', 'Lavado detallado de motocicleta con llantas y asiento.', 40.00, 40, 'workspace_premium', 3),
        ('AUTOLAVADO', 'moto', 'Otro', 'otro', 'Servicio personalizado con precio variable para motocicleta.', 0.00, 20, 'auto_awesome', 4),
        ('AUTOLAVADO', 'carro', 'Solo lavado', 'solo-lavado', 'Lavado exterior rapido para carro.', 35.00, 25, 'cleaning_services', 1),
        ('AUTOLAVADO', 'carro', 'Lavado y aspirado', 'lavado-y-aspirado', 'Lavado exterior con aspirado basico de interior.', 50.00, 40, 'airline_seat_recline_extra', 2),
        ('AUTOLAVADO', 'carro', 'Lavado completo', 'lavado-completo', 'Lavado, aspirado y detalles basicos del vehiculo.', 75.00, 60, 'workspace_premium', 3),
        ('AUTOLAVADO', 'carro', 'Lavado premium', 'lavado-premium', 'Servicio completo con acabado y brillo final.', 95.00, 75, 'auto_awesome', 4),
        ('AUTOLAVADO', 'carro', 'Otro', 'otro', 'Servicio personalizado con precio variable para carro.', 0.00, 30, 'auto_awesome', 5),
        ('AUTOLAVADO', 'pickup', 'Solo lavado', 'solo-lavado', 'Lavado exterior para pickup.', 45.00, 30, 'cleaning_services', 1),
        ('AUTOLAVADO', 'pickup', 'Lavado y aspirado', 'lavado-y-aspirado', 'Lavado exterior con limpieza de cabina.', 65.00, 45, 'airline_seat_recline_extra', 2),
        ('AUTOLAVADO', 'pickup', 'Lavado completo', 'lavado-completo', 'Servicio completo para pickup con detalles generales.', 90.00, 65, 'workspace_premium', 3),
        ('AUTOLAVADO', 'pickup', 'Otro', 'otro', 'Servicio personalizado con precio variable para pickup.', 0.00, 30, 'auto_awesome', 4),
        ('AUTOLAVADO', 'camion', 'Lavado basico', 'lavado-basico', 'Lavado exterior basico para camion.', 80.00, 45, 'cleaning_services', 1),
        ('AUTOLAVADO', 'camion', 'Lavado y cabina', 'lavado-y-cabina', 'Lavado exterior con limpieza de cabina.', 110.00, 70, 'airline_seat_recline_extra', 2),
        ('AUTOLAVADO', 'camion', 'Lavado completo', 'lavado-completo', 'Servicio completo con cabina, rines y acabados.', 140.00, 90, 'workspace_premium', 3),
        ('AUTOLAVADO', 'camion', 'Otro', 'otro', 'Servicio personalizado con precio variable para camion.', 0.00, 45, 'auto_awesome', 4)
    ) AS data(modulo, tipo_slug, nombre, slug, descripcion, precio_base, duracion_minutos, icono, orden)
    INNER JOIN "Servicio_tipo_vehiculo" stv
      ON stv.modulo = data.modulo
     AND stv.slug = data.tipo_slug
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Servicio_catalogo" sc
      WHERE sc.id_tipo_vehiculo = stv.id_tipo_vehiculo
        AND sc.slug = data.slug
    )
  `);

  await pool.query(`
    INSERT INTO "Servicio_catalogo" (
      id_tipo_vehiculo,
      modulo,
      nombre,
      slug,
      descripcion,
      precio_base,
      duracion_minutos,
      icono,
      orden,
      activo
    )
    SELECT
      stv.id_tipo_vehiculo,
      data.modulo,
      data.nombre,
      data.slug,
      data.descripcion,
      data.precio_base,
      data.duracion_minutos,
      data.icono,
      data.orden,
      true
    FROM (
      VALUES
        ('REPARACION', 'moto', 'Diagnostico general', 'diagnostico-general', 'Revision general de motocicleta para detectar fallas mecanicas.', 35.00, 30, 'build', 1),
        ('REPARACION', 'moto', 'Cambio de aceite', 'cambio-de-aceite', 'Cambio de aceite y revision basica para motocicleta.', 55.00, 35, 'oil_barrel', 2),
        ('REPARACION', 'moto', 'Revision de frenos', 'revision-de-frenos', 'Inspeccion y ajuste de sistema de frenos.', 65.00, 45, 'car_repair', 3),
        ('REPARACION', 'moto', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para motocicleta.', 0.00, 30, 'build', 4),
        ('REPARACION', 'sedan', 'Diagnostico general', 'diagnostico-general', 'Revision mecanica y electronica inicial del vehiculo.', 75.00, 45, 'build', 1),
        ('REPARACION', 'sedan', 'Cambio de aceite', 'cambio-de-aceite', 'Cambio de aceite, filtro y revision rapida.', 120.00, 40, 'oil_barrel', 2),
        ('REPARACION', 'sedan', 'Servicio de frenos', 'servicio-de-frenos', 'Revision, limpieza y ajuste del sistema de frenos.', 185.00, 70, 'car_repair', 3),
        ('REPARACION', 'sedan', 'Afinacion', 'afinacion', 'Afinacion general con revision de bujias y filtros.', 240.00, 90, 'tune', 4),
        ('REPARACION', 'sedan', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para sedan.', 0.00, 45, 'build', 5),
        ('REPARACION', 'suv', 'Diagnostico general', 'diagnostico-general', 'Revision integral para SUV y camionetas.', 90.00, 50, 'build', 1),
        ('REPARACION', 'suv', 'Cambio de aceite', 'cambio-de-aceite', 'Cambio de aceite y chequeo de fluidos.', 145.00, 45, 'oil_barrel', 2),
        ('REPARACION', 'suv', 'Suspension y direccion', 'suspension-y-direccion', 'Revision de suspension, direccion y holguras.', 260.00, 110, 'settings', 3),
        ('REPARACION', 'suv', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para SUV.', 0.00, 50, 'build', 4),
        ('REPARACION', 'pickup', 'Diagnostico general', 'diagnostico-general', 'Revision de motor, tren delantero y sistema electrico.', 95.00, 55, 'build', 1),
        ('REPARACION', 'pickup', 'Servicio de clutch', 'servicio-de-clutch', 'Evaluacion y ajuste del sistema de clutch.', 320.00, 150, 'settings', 2),
        ('REPARACION', 'pickup', 'Sistema electrico', 'sistema-electrico', 'Revision de alternador, bateria y cableado.', 210.00, 100, 'electrical_services', 3),
        ('REPARACION', 'pickup', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para pickup.', 0.00, 55, 'build', 4),
        ('REPARACION', 'camion', 'Diagnostico general', 'diagnostico-general', 'Inspeccion general para vehiculos pesados.', 150.00, 70, 'build', 1),
        ('REPARACION', 'camion', 'Servicio de frenos', 'servicio-de-frenos', 'Revision del sistema de frenos para camion.', 380.00, 150, 'car_repair', 2),
        ('REPARACION', 'camion', 'Sistema electrico', 'sistema-electrico', 'Diagnostico de sistema electrico y arranque.', 340.00, 140, 'electrical_services', 3),
        ('REPARACION', 'camion', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para camion.', 0.00, 70, 'build', 4),
        ('REPARACION', 'microbus', 'Diagnostico general', 'diagnostico-general', 'Chequeo completo para transporte liviano.', 110.00, 60, 'build', 1),
        ('REPARACION', 'microbus', 'Afinacion', 'afinacion', 'Afinacion con pruebas operativas y revision de inyeccion.', 280.00, 110, 'tune', 2),
        ('REPARACION', 'microbus', 'Suspension y direccion', 'suspension-y-direccion', 'Revision de suspension, bujes y direccion.', 330.00, 140, 'settings', 3),
        ('REPARACION', 'microbus', 'Otro', 'otro', 'Trabajo mecanico personalizado con precio variable para microbus.', 0.00, 60, 'build', 4)
    ) AS data(modulo, tipo_slug, nombre, slug, descripcion, precio_base, duracion_minutos, icono, orden)
    INNER JOIN "Servicio_tipo_vehiculo" stv
      ON stv.modulo = data.modulo
     AND stv.slug = data.tipo_slug
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Servicio_catalogo" sc
      WHERE sc.id_tipo_vehiculo = stv.id_tipo_vehiculo
        AND sc.slug = data.slug
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Autolavado_orden" (
      id_autolavado_orden serial PRIMARY KEY,
      id_tipo_vehiculo integer NOT NULL REFERENCES "Servicio_tipo_vehiculo"(id_tipo_vehiculo),
      id_servicio_catalogo integer NOT NULL REFERENCES "Servicio_catalogo"(id_servicio_catalogo),
      id_usuario integer NOT NULL REFERENCES "Usuario"(id_usuario),
      id_caja_sesion integer NOT NULL REFERENCES "Caja_sesion"(id_caja_sesion),
      id_sucursal integer NOT NULL DEFAULT 1,
      nombre_cliente character varying(150),
      placa character varying(30),
      color character varying(60),
      observaciones text,
      metodo_pago character varying(20) NOT NULL DEFAULT 'EFECTIVO',
      precio_servicio numeric(12,2) NOT NULL DEFAULT 0,
      monto_cobrado numeric(12,2) NOT NULL DEFAULT 0,
      monto_recibido numeric(12,2),
      vuelto numeric(12,2) NOT NULL DEFAULT 0,
      estado character varying(20) NOT NULL DEFAULT 'PAGADO',
      estado_trabajo character varying(20) NOT NULL DEFAULT 'RECIBIDO',
      fecha timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  await ensureAuditColumnsForTable("Autolavado_orden");
  await ensureUpdatedAtTriggerForTable("Autolavado_orden");

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS estado_trabajo character varying(20) NOT NULL DEFAULT 'RECIBIDO'
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS id_tecnico_asignado integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS tecnico_asignado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS tecnico_asignado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS fecha_inicio_proceso timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS fecha_lavado timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS fecha_finalizado timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS fecha_entregado timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_motivo text
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Autolavado_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validacion_nota text
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_autolavado_orden_caja_fecha"
    ON "Autolavado_orden" (id_caja_sesion, fecha DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_autolavado_orden_usuario_fecha"
    ON "Autolavado_orden" (id_usuario, fecha DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_autolavado_orden_tecnico"
    ON "Autolavado_orden" (id_tecnico_asignado)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Reparacion_orden" (
      id_reparacion_orden serial PRIMARY KEY,
      id_tipo_vehiculo integer NOT NULL REFERENCES "Servicio_tipo_vehiculo"(id_tipo_vehiculo),
      id_servicio_catalogo integer NOT NULL REFERENCES "Servicio_catalogo"(id_servicio_catalogo),
      id_usuario integer NOT NULL REFERENCES "Usuario"(id_usuario),
      id_caja_sesion integer NOT NULL REFERENCES "Caja_sesion"(id_caja_sesion),
      id_sucursal integer NOT NULL DEFAULT 1,
      nombre_cliente character varying(150),
      placa character varying(30),
      color character varying(60),
      kilometraje integer,
      diagnostico_inicial text,
      observaciones text,
      metodo_pago character varying(20) NOT NULL DEFAULT 'EFECTIVO',
      precio_servicio numeric(12,2) NOT NULL DEFAULT 0,
      monto_cobrado numeric(12,2) NOT NULL DEFAULT 0,
      monto_recibido numeric(12,2),
      vuelto numeric(12,2) NOT NULL DEFAULT 0,
      estado character varying(20) NOT NULL DEFAULT 'PAGADO',
      estado_trabajo character varying(20) NOT NULL DEFAULT 'RECIBIDO',
      fecha timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  await ensureAuditColumnsForTable("Reparacion_orden");
  await ensureUpdatedAtTriggerForTable("Reparacion_orden");

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS fecha_diagnostico timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS id_tecnico_asignado integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS tecnico_asignado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS tecnico_asignado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS fecha_en_reparacion timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS fecha_pruebas timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS fecha_listo timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS fecha_entregado timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_motivo text
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_autorizado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_por integer REFERENCES "Usuario"(id_usuario)
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validado_en timestamp with time zone
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ADD COLUMN IF NOT EXISTS no_cobrado_validacion_nota text
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ALTER COLUMN id_caja_sesion DROP NOT NULL
  `);

  await pool.query(`
    ALTER TABLE "Reparacion_orden"
    ALTER COLUMN metodo_pago DROP NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_reparacion_orden_caja_fecha"
    ON "Reparacion_orden" (id_caja_sesion, fecha DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_reparacion_orden_usuario_fecha"
    ON "Reparacion_orden" (id_usuario, fecha DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_reparacion_orden_tecnico"
    ON "Reparacion_orden" (id_tecnico_asignado)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "Reparacion_orden_producto" (
      id_reparacion_orden_producto serial PRIMARY KEY,
      id_reparacion_orden integer NOT NULL REFERENCES "Reparacion_orden"(id_reparacion_orden),
      id_producto integer NOT NULL REFERENCES "Producto"(id_producto),
      cantidad integer NOT NULL,
      precio_unitario numeric(12,2) NOT NULL DEFAULT 0,
      precio_compra_unitario numeric(12,2) NOT NULL DEFAULT 0,
      cobra_al_cliente boolean NOT NULL DEFAULT true,
      subtotal_cobrado numeric(12,2) NOT NULL DEFAULT 0,
      fecha timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  await ensureAuditColumnsForTable("Reparacion_orden_producto");
  await ensureUpdatedAtTriggerForTable("Reparacion_orden_producto");

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_reparacion_orden_producto_orden"
    ON "Reparacion_orden_producto" (id_reparacion_orden, fecha DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "idx_reparacion_orden_producto_producto"
    ON "Reparacion_orden_producto" (id_producto)
  `);

  await pool.query(`
    ALTER TABLE "Rol"
    ALTER COLUMN nombre_rol TYPE character varying(40)
  `);

  await pool.query(`
    INSERT INTO "Rol" (nombre_rol)
    SELECT rol.nombre_rol
    FROM (
        VALUES
          ('SUPER_ADMIN'),
          ('ADMIN'),
          ('CAJERO'),
          ('MECANICO'),
          ('ENCARGADO_SERVICIOS'),
          ('LECTURA')
    ) AS rol(nombre_rol)
    WHERE NOT EXISTS (
      SELECT 1
      FROM "Rol" existing
      WHERE UPPER(TRIM(existing.nombre_rol)) = rol.nombre_rol
    )
  `);

  await pool.query(`
    UPDATE "Detalle_usuario" du
    SET id_rol = canonical.id_rol
    FROM (
      SELECT MIN(id_rol) AS id_rol
      FROM "Rol"
      WHERE UPPER(TRIM(nombre_rol)) = 'SUPER_ADMIN'
    ) AS canonical
    INNER JOIN "Rol" legacy
      ON UPPER(TRIM(legacy.nombre_rol)) = 'SUPERADMIN'
    WHERE du.id_rol = legacy.id_rol
      AND canonical.id_rol IS NOT NULL
  `);

  await pool.query(`
    WITH canonical_roles AS (
      SELECT
        MIN(id_rol) AS canonical_id_rol,
        CASE
          WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
          ELSE UPPER(TRIM(nombre_rol))
        END AS normalized_name
      FROM "Rol"
      GROUP BY CASE
        WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
        ELSE UPPER(TRIM(nombre_rol))
      END
    )
    UPDATE "Detalle_usuario" du
    SET id_rol = cr.canonical_id_rol
    FROM "Rol" r
    INNER JOIN canonical_roles cr
      ON cr.normalized_name = CASE
        WHEN UPPER(TRIM(r.nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
        ELSE UPPER(TRIM(r.nombre_rol))
      END
    WHERE du.id_rol = r.id_rol
      AND du.id_rol <> cr.canonical_id_rol
  `);

  await pool.query(`
    WITH ranked AS (
      SELECT
        ctid,
        ROW_NUMBER() OVER (
          PARTITION BY id_usuario, id_rol
          ORDER BY
            COALESCE(activo, true) DESC,
            updated_at DESC NULLS LAST,
            created_at DESC NULLS LAST,
            ctid DESC
        ) AS rn
      FROM "Detalle_usuario"
    )
    DELETE FROM "Detalle_usuario" du
    USING ranked
    WHERE du.ctid = ranked.ctid
      AND ranked.rn > 1
  `);

  await pool.query(`
    WITH canonical_roles AS (
      SELECT
        MIN(id_rol) AS canonical_id_rol,
        CASE
          WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
          ELSE UPPER(TRIM(nombre_rol))
        END AS normalized_name
      FROM "Rol"
      GROUP BY CASE
        WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
        ELSE UPPER(TRIM(nombre_rol))
      END
    )
    DELETE FROM "Rol" r
    USING canonical_roles cr
    WHERE (
      CASE
        WHEN UPPER(TRIM(r.nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
        ELSE UPPER(TRIM(r.nombre_rol))
      END
    ) = cr.normalized_name
      AND r.id_rol <> cr.canonical_id_rol
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_detalle_usuario_usuario_rol"
    ON "Detalle_usuario" (id_usuario, id_rol)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_rol_nombre_normalizado"
    ON "Rol" (
      (
        CASE
          WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
          ELSE UPPER(TRIM(nombre_rol))
        END
      )
    )
  `);

  await pool.query(`
    ALTER TABLE "Persona"
    ALTER COLUMN fecha_inicio SET DEFAULT CURRENT_DATE
  `);

  await ensureBootstrapUser();
}

export async function testDB() {
  await ensureSchema();
  const r = await pool.query("SELECT NOW() AS ahora");
  console.log("Postgres conectado:", r.rows[0].ahora);
}
