#!/usr/bin/env node
/**
 * Migracion legacy -> SaaS multi-tenant.
 *
 * Uso:
 *   node scripts/migrate-legacy-to-saas.mjs --dry-run
 *   node scripts/migrate-legacy-to-saas.mjs --apply
 *   node scripts/migrate-legacy-to-saas.mjs --apply --empresa-slug=mi-empresa
 *
 * Variables de entorno requeridas (definir en .env.migration o exportar):
 *   LEGACY_PGHOST, LEGACY_PGPORT, LEGACY_PGDATABASE, LEGACY_PGUSER, LEGACY_PGPASSWORD
 *   SAAS_PGHOST,   SAAS_PGPORT,   SAAS_PGDATABASE,   SAAS_PGUSER,   SAAS_PGPASSWORD
 *
 * Los pares de variables pueden compartir valor si ambos schemas viven en la
 * misma instancia de Postgres pero en bases distintas.
 *
 * Banderas:
 *   --dry-run            (default) inspecciona y reporta sin escribir
 *   --apply              ejecuta la migracion real
 *   --empresa-slug=...   slug de la empresa destino (default: legacy-pos)
 *   --empresa-nombre=... nombre legal (default: "Empresa Legacy")
 *   --reset-mapping      borra la tabla migration_mapping antes de empezar
 *                        (cuidado: pierde idempotencia)
 *   --skip=ventas,caja   omite secciones especificas
 */

import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

import {
  mapLegacyRoleCode,
  mapMetodoPago,
  mapTipoVenta,
  mapEstadoVenta,
  mapEstadoCompra,
  mapEstadoOrdenServicio,
  mapEstadoCobroOrden,
  round2,
  round3,
  cleanString,
} from "./legacy-mappers.mjs";

const { Pool } = pg;

// ============================================================
// CLI parsing
// ============================================================
const parseArgs = () => {
  const args = {
    dryRun: true,
    apply: false,
    empresaSlug: "legacy-pos",
    empresaNombre: "Empresa Legacy",
    resetMapping: false,
    skip: new Set(),
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
      args.apply = false;
    } else if (arg.startsWith("--empresa-slug=")) {
      args.empresaSlug = arg.slice("--empresa-slug=".length);
    } else if (arg.startsWith("--empresa-nombre=")) {
      args.empresaNombre = arg.slice("--empresa-nombre=".length);
    } else if (arg === "--reset-mapping") {
      args.resetMapping = true;
    } else if (arg.startsWith("--skip=")) {
      args.skip = new Set(
        arg
          .slice("--skip=".length)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
    }
  }

  return args;
};

// ============================================================
// Config / loaders
// ============================================================
const loadEnv = () => {
  const candidates = [".env.migration", ".env"];
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      dotenv.config({ path });
      // eslint-disable-next-line no-console
      console.log(`[migration] env cargado desde ${candidate}`);
      return;
    }
  }
  dotenv.config();
};

const buildPool = (prefix) => {
  const get = (key, fallback = undefined) =>
    process.env[`${prefix}_${key}`] ?? process.env[key] ?? fallback;

  return new Pool({
    host: get("PGHOST", "localhost"),
    port: Number(get("PGPORT", 5432)),
    database: get("PGDATABASE"),
    user: get("PGUSER"),
    password: get("PGPASSWORD"),
    ssl:
      String(get("PGSSLMODE", "")).toLowerCase() === "require"
        ? { rejectUnauthorized: false }
        : false,
  });
};

// ============================================================
// Logging y mapeo persistente
// ============================================================
const log = (msg) => console.log(`[migration] ${msg}`);
const sub = (msg) => console.log(`  ${msg}`);

const ensureMappingTable = async (saasPool) => {
  const sqlPath = resolve(process.cwd(), "scripts/migration-mapping.sql");
  const sql = readFileSync(sqlPath, "utf8");
  await saasPool.query(sql);
};

const lookupMapping = async (saasPool, entidad, legacyId, idEmpresa) => {
  const result = await saasPool.query(
    `select saas_id from migration_mapping where entidad=$1 and legacy_id=$2 and id_empresa=$3`,
    [entidad, String(legacyId), idEmpresa]
  );
  return result.rows[0] ? Number(result.rows[0].saas_id) : null;
};

const recordMapping = async (saasPool, entidad, legacyId, saasId, idEmpresa) => {
  await saasPool.query(
    `insert into migration_mapping (entidad, legacy_id, saas_id, id_empresa)
     values ($1, $2, $3, $4)
     on conflict (entidad, legacy_id, id_empresa) do update
       set saas_id = excluded.saas_id, migrated_at = now()`,
    [entidad, String(legacyId), saasId, idEmpresa]
  );
};

// ============================================================
// Stats
// ============================================================
const stats = {};
const bump = (entidad, kind, n = 1) => {
  if (!stats[entidad]) {
    stats[entidad] = { read: 0, inserted: 0, skipped: 0, errors: 0 };
  }
  stats[entidad][kind] += n;
};

// ============================================================
// Empresa destino + sucursal por defecto + bodega
// ============================================================
const ensureTargetEmpresa = async (saasPool, { slug, nombre }) => {
  const existing = await saasPool.query(
    `select id_empresa from empresas where slug = $1 limit 1`,
    [slug]
  );

  if (existing.rows[0]) {
    return Number(existing.rows[0].id_empresa);
  }

  const result = await saasPool.query(
    `insert into empresas (slug, nombre_legal, nombre_comercial, timezone, estado)
     values ($1, $2, $2, 'America/Guatemala', 'ACTIVA')
     returning id_empresa`,
    [slug, nombre]
  );
  return Number(result.rows[0].id_empresa);
};

const ensureDefaultSucursal = async (saasPool, idEmpresa) => {
  const existing = await saasPool.query(
    `select id_sucursal from sucursales where id_empresa = $1 and codigo = 'CENTRAL' limit 1`,
    [idEmpresa]
  );

  if (existing.rows[0]) {
    return Number(existing.rows[0].id_sucursal);
  }

  const result = await saasPool.query(
    `insert into sucursales (id_empresa, codigo, nombre, es_principal, activa)
     values ($1, 'CENTRAL', 'Sucursal Central', true, true)
     returning id_sucursal`,
    [idEmpresa]
  );
  return Number(result.rows[0].id_sucursal);
};

const ensureModulosEnabled = async (saasPool, idEmpresa) => {
  // Activa todos los modulos disponibles para la empresa migrada
  await saasPool.query(
    `insert into empresas_modulos (id_empresa, id_modulo, activo)
     select $1, m.id_modulo, true from modulos m
     on conflict (id_empresa, id_modulo) do update set activo = true`,
    [idEmpresa]
  );
};

// ============================================================
// Migradores por entidad
// ============================================================
const migrateRoles = async ({ saasPool }) => {
  // Los roles SaaS son globales (codigo unique). Solo nos aseguramos
  // de que existan los 4 roles esperados.
  await saasPool.query(
    `insert into roles (codigo, nombre, descripcion)
     values
       ('SUPER_ADMIN', 'Super administrador', 'Control total de la plataforma'),
       ('ADMIN_EMPRESA', 'Administrador de empresa', 'Administra la empresa'),
       ('ENCARGADO_SUCURSAL', 'Encargado de sucursal', 'Opera una o mas sucursales'),
       ('CAJERO', 'Cajero', 'Registra ventas y opera caja')
     on conflict (codigo) do nothing`
  );
  bump("roles", "inserted", 4);
  sub("roles base aseguradas");
};

const migrateUsuarios = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select u.id_usuario, u.username, u.password_hash, u.nombre, u.activo,
            p.apellido, p.dpi_persona, p.telefono
     from "Usuario" u
     left join "Persona" p on p.id_usuario = u.id_usuario`
  );

  bump("usuarios", "read", result.rowCount);
  sub(`leidos ${result.rowCount} usuarios legacy`);

  for (const row of result.rows) {
    const username = cleanString(row.username, 60);
    if (!username) {
      bump("usuarios", "skipped");
      continue;
    }

    const existingMap = await lookupMapping(
      saasPool,
      "usuario",
      row.id_usuario,
      idEmpresa
    );
    if (existingMap) {
      bump("usuarios", "skipped");
      continue;
    }

    if (!apply) {
      bump("usuarios", "inserted");
      continue;
    }

    // Si por unique (id_empresa, username) ya existe, lo capturamos.
    let saasUserId;
    const existing = await saasPool.query(
      `select id_usuario from usuarios where id_empresa = $1 and username = $2`,
      [idEmpresa, username]
    );

    if (existing.rows[0]) {
      saasUserId = Number(existing.rows[0].id_usuario);
    } else {
      const nombrePartes = String(row.nombre || "").trim().split(/\s+/);
      const nombre = nombrePartes[0] || username;
      const apellido =
        cleanString(row.apellido, 80) ||
        nombrePartes.slice(1).join(" ") ||
        ".";

      const insert = await saasPool.query(
        `insert into usuarios (
            id_empresa, username, password_hash, nombre, apellido,
            id_sucursal_default, activo, created_by, updated_by
         )
         values ($1, $2, $3, $4, $5, $6, $7, null, null)
         returning id_usuario`,
        [
          idEmpresa,
          username,
          row.password_hash || "$2b$04$migration.placeholder.no.login.allowed",
          cleanString(nombre, 80),
          cleanString(apellido, 80),
          idSucursal,
          row.activo !== false,
        ]
      );
      saasUserId = Number(insert.rows[0].id_usuario);
    }

    // Asegurar que pertenezca a la sucursal por defecto
    await saasPool.query(
      `insert into usuarios_sucursales (id_empresa, id_usuario, id_sucursal, es_predeterminada)
       values ($1, $2, $3, true)
       on conflict (id_empresa, id_usuario, id_sucursal) do nothing`,
      [idEmpresa, saasUserId, idSucursal]
    );

    // Roles: leer "Detalle_usuario" + "Rol" del legacy
    const rolesResult = await legacyPool.query(
      `select r.nombre_rol
       from "Detalle_usuario" du
       join "Rol" r on r.id_rol = du.id_rol
       where du.id_usuario = $1
         and coalesce(du.activo, true) = true`,
      [row.id_usuario]
    );

    for (const rol of rolesResult.rows) {
      const codigoSaas = mapLegacyRoleCode(rol.nombre_rol);
      const rolId = await saasPool.query(
        `select id_rol from roles where codigo = $1 limit 1`,
        [codigoSaas]
      );
      if (rolId.rows[0]) {
        await saasPool.query(
          `insert into usuarios_roles (id_empresa, id_usuario, id_rol)
           values ($1, $2, $3)
           on conflict (id_empresa, id_usuario, id_rol) do nothing`,
          [idEmpresa, saasUserId, Number(rolId.rows[0].id_rol)]
        );
      }
    }

    await recordMapping(saasPool, "usuario", row.id_usuario, saasUserId, idEmpresa);
    bump("usuarios", "inserted");
  }
};

const migrateClientes = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  apply,
}) => {
  const result = await legacyPool.query(
    `select "Id_clientes" as id_legacy, codigo, nombre, nit,
            telefono, correo, direccion, coalesce(estado, true) as activo
     from "Clientes"`
  );

  bump("clientes", "read", result.rowCount);

  for (const row of result.rows) {
    const nombre = cleanString(row.nombre, 150);
    if (!nombre) {
      bump("clientes", "skipped");
      continue;
    }

    if (await lookupMapping(saasPool, "cliente", row.id_legacy, idEmpresa)) {
      bump("clientes", "skipped");
      continue;
    }

    if (!apply) {
      bump("clientes", "inserted");
      continue;
    }

    const insert = await saasPool.query(
      `insert into clientes (id_empresa, codigo, nombre, nit, telefono, email, direccion, activo)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id_empresa, nit) where nit is not null
         do update set nombre = excluded.nombre, telefono = excluded.telefono
       returning id_cliente`,
      [
        idEmpresa,
        cleanString(row.codigo, 30),
        nombre,
        cleanString(row.nit, 30),
        cleanString(row.telefono, 30),
        cleanString(row.correo, 150),
        cleanString(row.direccion, 250),
        row.activo !== false,
      ]
    );

    await recordMapping(
      saasPool,
      "cliente",
      row.id_legacy,
      Number(insert.rows[0].id_cliente),
      idEmpresa
    );
    bump("clientes", "inserted");
  }
};

const migrateProveedores = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  apply,
}) => {
  // El legacy puede tener tabla "Proveedor" (singular) o variantes.
  const result = await legacyPool.query(
    `select id_proveedor as id_legacy, nombre, nit, telefono, correo, direccion,
            coalesce(estado, true) as activo
     from "Proveedor"`
  );

  bump("proveedores", "read", result.rowCount);

  for (const row of result.rows) {
    const nombre = cleanString(row.nombre, 150);
    if (!nombre) {
      bump("proveedores", "skipped");
      continue;
    }

    if (await lookupMapping(saasPool, "proveedor", row.id_legacy, idEmpresa)) {
      bump("proveedores", "skipped");
      continue;
    }

    if (!apply) {
      bump("proveedores", "inserted");
      continue;
    }

    const insert = await saasPool.query(
      `insert into proveedores (id_empresa, nombre, nit, telefono, email, direccion, activo)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id_proveedor`,
      [
        idEmpresa,
        nombre,
        cleanString(row.nit, 30),
        cleanString(row.telefono, 30),
        cleanString(row.correo, 150),
        cleanString(row.direccion, 250),
        row.activo !== false,
      ]
    );

    await recordMapping(
      saasPool,
      "proveedor",
      row.id_legacy,
      Number(insert.rows[0].id_proveedor),
      idEmpresa
    );
    bump("proveedores", "inserted");
  }
};

const migrateProductos = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select p.id_producto as id_legacy, p.nombre, p.descripcion, p.codigo_barras,
            p.precio_compra, p.precio_venta, coalesce(p.activo, true) as activo,
            coalesce(p.modulo_origen, 'GENERAL') as modulo_origen,
            coalesce(s.existencia, 0) as existencia,
            coalesce(s.stock_minimo, 0) as stock_minimo,
            s.ubicacion
     from "Producto" p
     left join "Stock_producto" s on s.id_producto = p.id_producto and s.id_bodega = 1`
  );

  bump("productos", "read", result.rowCount);

  for (const row of result.rows) {
    const nombre = cleanString(row.nombre, 150);
    if (!nombre) {
      bump("productos", "skipped");
      continue;
    }

    if (await lookupMapping(saasPool, "producto", row.id_legacy, idEmpresa)) {
      bump("productos", "skipped");
      continue;
    }

    if (!apply) {
      bump("productos", "inserted");
      continue;
    }

    // SKU sintetico si no existe (legacy no tiene SKU)
    const sku = cleanString(row.codigo_barras, 50) || `LEG-${row.id_legacy}`;

    const insert = await saasPool.query(
      `insert into productos (
          id_empresa, sku, codigo_barras, nombre, descripcion,
          precio_compra, precio_venta, tipo_producto, modulo_origen, activo
       )
       values ($1, $2, $3, $4, $5, $6, $7, 'PRODUCTO', $8, $9)
       on conflict (id_empresa, sku) do update set nombre = excluded.nombre
       returning id_producto`,
      [
        idEmpresa,
        sku,
        cleanString(row.codigo_barras, 50),
        nombre,
        cleanString(row.descripcion, 500),
        round2(row.precio_compra),
        round2(row.precio_venta),
        String(row.modulo_origen || "POS").toUpperCase() === "SERVICIOS"
          ? "SERVICIOS"
          : "POS",
        row.activo !== false,
      ]
    );

    const idProductoSaas = Number(insert.rows[0].id_producto);

    await saasPool.query(
      `insert into stock_sucursal (id_empresa, id_sucursal, id_producto, stock_actual, stock_minimo, ubicacion)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id_empresa, id_sucursal, id_producto)
         do update set stock_actual = excluded.stock_actual,
                       stock_minimo = excluded.stock_minimo,
                       ubicacion = excluded.ubicacion`,
      [
        idEmpresa,
        idSucursal,
        idProductoSaas,
        round3(row.existencia),
        round3(row.stock_minimo),
        cleanString(row.ubicacion, 120),
      ]
    );

    await recordMapping(
      saasPool,
      "producto",
      row.id_legacy,
      idProductoSaas,
      idEmpresa
    );
    bump("productos", "inserted");
  }
};

const migrateCajaSesiones = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select id_caja_sesion as id_legacy, id_usuario as legacy_id_usuario,
            estado, monto_apertura, monto_cierre_reportado, monto_cierre_calculado,
            diferencia, fecha_apertura, fecha_cierre,
            observaciones_apertura, observaciones_cierre
     from "Caja_sesion"`
  );

  bump("caja_sesiones", "read", result.rowCount);

  for (const row of result.rows) {
    if (await lookupMapping(saasPool, "caja_sesion", row.id_legacy, idEmpresa)) {
      bump("caja_sesiones", "skipped");
      continue;
    }

    if (!apply) {
      bump("caja_sesiones", "inserted");
      continue;
    }

    const idUsuario =
      (await lookupMapping(
        saasPool,
        "usuario",
        row.legacy_id_usuario,
        idEmpresa
      )) || null;

    if (!idUsuario) {
      bump("caja_sesiones", "skipped");
      continue;
    }

    const insert = await saasPool.query(
      `insert into caja_sesiones (
          id_empresa, id_sucursal, id_usuario, estado,
          monto_apertura, monto_cierre, monto_cierre_reportado, monto_cierre_calculado,
          diferencia, fecha_apertura, fecha_cierre, observaciones, observaciones_apertura, observaciones_cierre
       )
       values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $11, $12)
       returning id_caja_sesion`,
      [
        idEmpresa,
        idSucursal,
        idUsuario,
        String(row.estado || "CERRADA").toUpperCase(),
        round2(row.monto_apertura),
        row.monto_cierre_reportado != null
          ? round2(row.monto_cierre_reportado)
          : null,
        row.monto_cierre_calculado != null
          ? round2(row.monto_cierre_calculado)
          : null,
        row.diferencia != null ? round2(row.diferencia) : null,
        row.fecha_apertura,
        row.fecha_cierre,
        cleanString(row.observaciones_apertura, 500),
        cleanString(row.observaciones_cierre, 500),
      ]
    );

    await recordMapping(
      saasPool,
      "caja_sesion",
      row.id_legacy,
      Number(insert.rows[0].id_caja_sesion),
      idEmpresa
    );
    bump("caja_sesiones", "inserted");
  }
};

const migrateCajaMovimientos = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select id_caja_movimiento as id_legacy, id_caja_sesion as legacy_id_sesion,
            id_usuario as legacy_id_usuario, tipo, categoria, monto, descripcion, fecha,
            autorizado_por_admin_id as legacy_admin_id, autorizado_por_admin_en, autorizacion_admin_nota
     from "Caja_movimiento"`
  );

  bump("caja_movimientos", "read", result.rowCount);

  for (const row of result.rows) {
    if (await lookupMapping(saasPool, "caja_movimiento", row.id_legacy, idEmpresa)) {
      bump("caja_movimientos", "skipped");
      continue;
    }

    if (!apply) {
      bump("caja_movimientos", "inserted");
      continue;
    }

    const idCajaSesion = await lookupMapping(
      saasPool,
      "caja_sesion",
      row.legacy_id_sesion,
      idEmpresa
    );
    const idUsuario = await lookupMapping(
      saasPool,
      "usuario",
      row.legacy_id_usuario,
      idEmpresa
    );

    if (!idCajaSesion || !idUsuario) {
      bump("caja_movimientos", "skipped");
      continue;
    }

    const idAdmin = row.legacy_admin_id
      ? await lookupMapping(saasPool, "usuario", row.legacy_admin_id, idEmpresa)
      : null;

    const insert = await saasPool.query(
      `insert into caja_movimientos (
          id_empresa, id_caja_sesion, id_sucursal, id_usuario,
          tipo, categoria, monto, descripcion,
          referencia_tipo, referencia_id,
          autorizado_por_admin_id, autorizado_por_admin_en, autorizacion_admin_nota,
          created_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'MANUAL', null, $9, $10, $11, $12)
       returning id_caja_movimiento`,
      [
        idEmpresa,
        idCajaSesion,
        idSucursal,
        idUsuario,
        String(row.tipo || "INGRESO").toUpperCase(),
        cleanString(row.categoria, 50),
        round2(row.monto),
        cleanString(row.descripcion, 500),
        idAdmin,
        row.autorizado_por_admin_en,
        cleanString(row.autorizacion_admin_nota, 500),
        row.fecha,
      ]
    );

    await recordMapping(
      saasPool,
      "caja_movimiento",
      row.id_legacy,
      Number(insert.rows[0].id_caja_movimiento),
      idEmpresa
    );
    bump("caja_movimientos", "inserted");
  }
};

const migrateCompras = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select id_compra as id_legacy, fecha, tipo_documento, no_documento,
            subtotal, descuento, total, estado, observaciones,
            id_proveedor as legacy_id_proveedor, id_usuario as legacy_id_usuario
     from "Compra"`
  );

  bump("compras", "read", result.rowCount);

  for (const row of result.rows) {
    if (await lookupMapping(saasPool, "compra", row.id_legacy, idEmpresa)) {
      bump("compras", "skipped");
      continue;
    }

    if (!apply) {
      bump("compras", "inserted");
      continue;
    }

    const idProveedor = await lookupMapping(
      saasPool,
      "proveedor",
      row.legacy_id_proveedor,
      idEmpresa
    );
    const idUsuario = await lookupMapping(
      saasPool,
      "usuario",
      row.legacy_id_usuario,
      idEmpresa
    );

    if (!idProveedor || !idUsuario) {
      bump("compras", "skipped");
      continue;
    }

    const insert = await saasPool.query(
      `insert into compras (
          id_empresa, id_sucursal, id_proveedor, id_usuario,
          numero_documento, tipo_documento, estado,
          subtotal, descuento, impuesto, total, fecha_compra, observaciones
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12)
       returning id_compra`,
      [
        idEmpresa,
        idSucursal,
        idProveedor,
        idUsuario,
        cleanString(row.no_documento, 50),
        cleanString(row.tipo_documento, 30) || "FACTURA",
        mapEstadoCompra(row.estado),
        round2(row.subtotal),
        round2(row.descuento),
        round2(row.total),
        row.fecha,
        cleanString(row.observaciones, 500),
      ]
    );

    const idCompraSaas = Number(insert.rows[0].id_compra);

    // Detalles
    const detalles = await legacyPool.query(
      `select id_detalle_compra as id_legacy, id_producto as legacy_id_producto,
              cantidad, precio_compra, subtotal
       from "Detalle_compra"
       where id_compra = $1`,
      [row.id_legacy]
    );

    for (const det of detalles.rows) {
      const idProducto = await lookupMapping(
        saasPool,
        "producto",
        det.legacy_id_producto,
        idEmpresa
      );
      if (!idProducto) continue;

      await saasPool.query(
        `insert into compra_detalles (id_empresa, id_compra, id_producto, cantidad, costo_unitario, subtotal)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          idEmpresa,
          idCompraSaas,
          idProducto,
          round3(det.cantidad),
          round2(det.precio_compra),
          round2(det.subtotal),
        ]
      );
    }

    await recordMapping(saasPool, "compra", row.id_legacy, idCompraSaas, idEmpresa);
    bump("compras", "inserted");
  }
};

const migrateVentas = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  const result = await legacyPool.query(
    `select v.id_venta as id_legacy, v.fecha, v.total, v.utilidad_total,
            v.tipo_venta, v.metodo_pago, v.estado,
            v.id_usuario as legacy_id_usuario, v.id_caja_sesion as legacy_id_sesion,
            v.id_cliente as legacy_id_cliente,
            v.numero_comprobante, v.tipo_comprobante,
            v.monto_recibido, v.cambio_entregado,
            v.no_cobrado_motivo, v.no_cobrado_autorizado_por as legacy_admin_id,
            v.no_cobrado_autorizado_en, v.no_cobrado_validado_por as legacy_admin_validador,
            v.no_cobrado_validado_en, v.no_cobrado_validacion_nota
     from "Venta" v`
  );

  bump("ventas", "read", result.rowCount);

  for (const row of result.rows) {
    if (await lookupMapping(saasPool, "venta", row.id_legacy, idEmpresa)) {
      bump("ventas", "skipped");
      continue;
    }

    if (!apply) {
      bump("ventas", "inserted");
      continue;
    }

    const idUsuario = await lookupMapping(
      saasPool,
      "usuario",
      row.legacy_id_usuario,
      idEmpresa
    );
    const idCajaSesion = row.legacy_id_sesion
      ? await lookupMapping(
          saasPool,
          "caja_sesion",
          row.legacy_id_sesion,
          idEmpresa
        )
      : null;
    const idCliente = row.legacy_id_cliente
      ? await lookupMapping(
          saasPool,
          "cliente",
          row.legacy_id_cliente,
          idEmpresa
        )
      : null;

    if (!idUsuario) {
      bump("ventas", "skipped");
      continue;
    }

    // Detalles primero para calcular subtotal
    const detalles = await legacyPool.query(
      `select id_detalle as id_legacy, id_producto as legacy_id_producto,
              cantidad, cantidad_anulada, precio_unitario, subtotal,
              costo_unitario, utilidad
       from "Detalle_venta"
       where id_venta = $1`,
      [row.id_legacy]
    );

    let totalRevertido = 0;
    let totalNeto = 0;
    for (const d of detalles.rows) {
      const cant = Number(d.cantidad || 0);
      const anul = Number(d.cantidad_anulada || 0);
      const precio = Number(d.precio_unitario || 0);
      totalRevertido += anul * precio;
      totalNeto += (cant - anul) * precio;
    }

    const idAdminAutoriz = row.legacy_admin_id
      ? await lookupMapping(saasPool, "usuario", row.legacy_admin_id, idEmpresa)
      : null;
    const idAdminValidador = row.legacy_admin_validador
      ? await lookupMapping(
          saasPool,
          "usuario",
          row.legacy_admin_validador,
          idEmpresa
        )
      : null;

    const estadoSaas = mapEstadoVenta(row.estado);
    const tipoVenta = mapTipoVenta(row.tipo_venta);
    const metodoPago = mapMetodoPago(row.metodo_pago);
    const estadoReversion =
      totalRevertido <= 0
        ? "SIN_REVERSION"
        : totalRevertido >= Number(row.total || 0)
          ? "TOTAL"
          : "PARCIAL";

    const insert = await saasPool.query(
      `insert into ventas (
          id_empresa, id_sucursal, id_usuario, id_cliente, id_caja_sesion,
          numero_comprobante, tipo_comprobante,
          tipo_venta, metodo_pago, estado,
          subtotal, descuento, impuesto, total,
          monto_recibido, cambio,
          dias_credito, fecha_vencimiento, saldo_pendiente,
          monto_revertido, estado_reversion,
          observaciones, fecha_venta,
          no_cobrado_motivo, no_cobrado_autorizado_por, no_cobrado_autorizado_en,
          no_cobrado_validado_por, no_cobrado_validado_en, no_cobrado_validacion_nota
       )
       values (
          $1, $2, $3, $4, $5,
          $6, $7,
          $8, $9, $10,
          $11, 0, 0, $11,
          $12, $13,
          null, null, $14,
          $15, $16,
          null, $17,
          $18, $19, $20,
          $21, $22, $23
       )
       on conflict (id_empresa, numero_comprobante) where numero_comprobante is not null do nothing
       returning id_venta`,
      [
        idEmpresa,
        idSucursal,
        idUsuario,
        idCliente,
        idCajaSesion,
        cleanString(row.numero_comprobante, 50),
        cleanString(row.tipo_comprobante, 30) || "TICKET",
        tipoVenta,
        estadoSaas === "NO_COBRADO" ? "NO_COBRADO" : metodoPago,
        estadoSaas,
        round2(row.total),
        estadoSaas === "NO_COBRADO" || tipoVenta === "CREDITO"
          ? null
          : row.monto_recibido != null
            ? round2(row.monto_recibido)
            : null,
        round2(row.cambio_entregado),
        tipoVenta === "CREDITO" ? round2(row.total) : 0,
        round2(totalRevertido),
        estadoReversion,
        row.fecha,
        cleanString(row.no_cobrado_motivo, 500),
        idAdminAutoriz,
        row.no_cobrado_autorizado_en,
        idAdminValidador,
        row.no_cobrado_validado_en,
        cleanString(row.no_cobrado_validacion_nota, 500),
      ]
    );

    if (insert.rowCount === 0) {
      // Hubo conflict por numero_comprobante existente; lo localizamos
      const existing = await saasPool.query(
        `select id_venta from ventas where id_empresa = $1 and numero_comprobante = $2`,
        [idEmpresa, row.numero_comprobante]
      );
      if (existing.rows[0]) {
        await recordMapping(
          saasPool,
          "venta",
          row.id_legacy,
          Number(existing.rows[0].id_venta),
          idEmpresa
        );
      }
      bump("ventas", "skipped");
      continue;
    }

    const idVentaSaas = Number(insert.rows[0].id_venta);

    // Detalles
    for (const d of detalles.rows) {
      const idProducto = await lookupMapping(
        saasPool,
        "producto",
        d.legacy_id_producto,
        idEmpresa
      );
      if (!idProducto) continue;

      await saasPool.query(
        `insert into venta_detalles (
            id_empresa, id_venta, id_producto,
            cantidad, precio_unitario, descuento, subtotal,
            costo_unitario, utilidad
         )
         values ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
        [
          idEmpresa,
          idVentaSaas,
          idProducto,
          round3(d.cantidad),
          round2(d.precio_unitario),
          round2(d.subtotal),
          round2(d.costo_unitario),
          round2(d.utilidad),
        ]
      );
    }

    await recordMapping(saasPool, "venta", row.id_legacy, idVentaSaas, idEmpresa);
    bump("ventas", "inserted");
  }
};

const migrateOrdenesServicio = async ({
  legacyPool,
  saasPool,
  idEmpresa,
  idSucursal,
  apply,
}) => {
  // El legacy tiene Autolavado_orden y Reparacion_orden separadas.
  // En SaaS van a ordenes_servicio con modulo CARWASH | SERVICIOS.
  // Necesitamos por cada orden encontrar (o crear) el id_servicio_catalogo en SaaS.
  // Para simplificar, agrupamos por servicio y creamos un servicios_catalogo
  // si no existe (slug = 'legacy-{tipo}-{servicio}').

  const fuentes = [
    {
      tabla: "Autolavado_orden",
      modulo: "CARWASH",
      key: "id_autolavado_orden",
    },
    {
      tabla: "Reparacion_orden",
      modulo: "SERVICIOS",
      key: "id_reparacion_orden",
    },
  ];

  for (const fuente of fuentes) {
    const stat = `ordenes_${fuente.modulo.toLowerCase()}`;
    let result;
    try {
      result = await legacyPool.query(
        `select o.${fuente.key} as id_legacy, o.fecha, o.placa, o.color,
                o.nombre_cliente, o.observaciones,
                o.metodo_pago, o.precio_servicio, o.monto_cobrado, o.monto_recibido, o.vuelto,
                o.estado, o.estado_trabajo,
                o.id_usuario as legacy_id_usuario, o.id_caja_sesion as legacy_id_sesion,
                sc.nombre as servicio_nombre, sc.slug as servicio_slug,
                stv.nombre as tipo_vehiculo_nombre, stv.slug as tipo_vehiculo_slug
         from "${fuente.tabla}" o
         left join "Servicio_catalogo" sc on sc.id_servicio_catalogo = o.id_servicio_catalogo
         left join "Servicio_tipo_vehiculo" stv on stv.id_tipo_vehiculo = o.id_tipo_vehiculo`
      );
    } catch (error) {
      // La tabla puede no existir si el legacy no tiene el modulo
      sub(`tabla legacy "${fuente.tabla}" no existe, saltando`);
      continue;
    }

    bump(stat, "read", result.rowCount);

    for (const row of result.rows) {
      if (await lookupMapping(saasPool, stat, row.id_legacy, idEmpresa)) {
        bump(stat, "skipped");
        continue;
      }

      if (!apply) {
        bump(stat, "inserted");
        continue;
      }

      const idUsuario = await lookupMapping(
        saasPool,
        "usuario",
        row.legacy_id_usuario,
        idEmpresa
      );
      if (!idUsuario) {
        bump(stat, "skipped");
        continue;
      }

      const idCajaSesion = row.legacy_id_sesion
        ? await lookupMapping(
            saasPool,
            "caja_sesion",
            row.legacy_id_sesion,
            idEmpresa
          )
        : null;

      // servicios_catalogo: buscar por slug, crear si no existe.
      const servicioSlug =
        cleanString(row.servicio_slug, 100) || `legacy-${fuente.modulo.toLowerCase()}-${row.id_legacy}`;
      const servicioNombre =
        cleanString(row.servicio_nombre, 100) || `Servicio legacy #${row.id_legacy}`;

      let idServicioCatalogo;
      const existingServicio = await saasPool.query(
        `select id_servicio_catalogo from servicios_catalogo
         where id_empresa = $1 and modulo = $2 and slug = $3 limit 1`,
        [idEmpresa, fuente.modulo, servicioSlug]
      );

      if (existingServicio.rows[0]) {
        idServicioCatalogo = Number(existingServicio.rows[0].id_servicio_catalogo);
      } else {
        const insertSc = await saasPool.query(
          `insert into servicios_catalogo (id_empresa, modulo, codigo, nombre, slug, precio_base, activo)
           values ($1, $2, $3, $4, $5, $6, true)
           returning id_servicio_catalogo`,
          [
            idEmpresa,
            fuente.modulo,
            servicioSlug.toUpperCase().slice(0, 30),
            servicioNombre,
            servicioSlug,
            round2(row.precio_servicio),
          ]
        );
        idServicioCatalogo = Number(insertSc.rows[0].id_servicio_catalogo);
      }

      const insert = await saasPool.query(
        `insert into ordenes_servicio (
            id_empresa, id_sucursal, id_servicio_catalogo, id_cliente, id_usuario, id_caja_sesion,
            modulo, placa, vehiculo_tipo, color,
            estado, metodo_pago, subtotal, total, observaciones, fecha_servicio,
            nombre_contacto
         )
         values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15)
         returning id_orden_servicio`,
        [
          idEmpresa,
          idSucursal,
          idServicioCatalogo,
          idUsuario,
          idCajaSesion,
          fuente.modulo,
          cleanString(row.placa, 30),
          cleanString(row.tipo_vehiculo_nombre, 30),
          cleanString(row.color, 40),
          mapEstadoOrdenServicio(row.estado_trabajo || row.estado),
          row.metodo_pago ? String(row.metodo_pago).toUpperCase() : null,
          round2(row.monto_cobrado || row.precio_servicio),
          cleanString(row.observaciones, 500),
          row.fecha,
          cleanString(row.nombre_cliente, 150),
        ]
      );

      await recordMapping(
        saasPool,
        stat,
        row.id_legacy,
        Number(insert.rows[0].id_orden_servicio),
        idEmpresa
      );
      bump(stat, "inserted");
    }
  }
};

// ============================================================
// Verificacion
// ============================================================
const verify = async ({ legacyPool, saasPool, idEmpresa }) => {
  const counts = {};
  const queries = [
    ["usuarios_legacy", `select count(*)::int as n from "Usuario"`, legacyPool],
    [
      "usuarios_saas",
      `select count(*)::int as n from usuarios where id_empresa = $1`,
      saasPool,
    ],
    ["productos_legacy", `select count(*)::int as n from "Producto"`, legacyPool],
    [
      "productos_saas",
      `select count(*)::int as n from productos where id_empresa = $1`,
      saasPool,
    ],
    ["ventas_legacy", `select count(*)::int as n from "Venta"`, legacyPool],
    [
      "ventas_saas",
      `select count(*)::int as n from ventas where id_empresa = $1`,
      saasPool,
    ],
    ["compras_legacy", `select count(*)::int as n from "Compra"`, legacyPool],
    [
      "compras_saas",
      `select count(*)::int as n from compras where id_empresa = $1`,
      saasPool,
    ],
  ];

  for (const [key, sql, pool] of queries) {
    try {
      const r = await pool.query(sql, sql.includes("$1") ? [idEmpresa] : []);
      counts[key] = r.rows[0].n;
    } catch (error) {
      counts[key] = `error: ${error.message}`;
    }
  }

  return counts;
};

// ============================================================
// Main
// ============================================================
const main = async () => {
  loadEnv();
  const args = parseArgs();

  log(args.dryRun ? "MODO DRY-RUN (no se escribe nada)" : "MODO APPLY (escribiendo)");
  log(`Empresa destino: slug="${args.empresaSlug}" nombre="${args.empresaNombre}"`);

  const legacyPool = buildPool("LEGACY");
  const saasPool = buildPool("SAAS");

  try {
    await ensureMappingTable(saasPool);

    if (args.resetMapping) {
      await saasPool.query(`truncate migration_mapping`);
      log("migration_mapping reseteada");
    }

    const idEmpresa = await ensureTargetEmpresa(saasPool, {
      slug: args.empresaSlug,
      nombre: args.empresaNombre,
    });
    const idSucursal = await ensureDefaultSucursal(saasPool, idEmpresa);
    await ensureModulosEnabled(saasPool, idEmpresa);

    log(`Empresa SaaS id=${idEmpresa}, sucursal default id=${idSucursal}`);

    const ctx = {
      legacyPool,
      saasPool,
      idEmpresa,
      idSucursal,
      apply: args.apply,
    };

    const sections = [
      ["roles", () => migrateRoles(ctx)],
      ["usuarios", () => migrateUsuarios(ctx)],
      ["clientes", () => migrateClientes(ctx)],
      ["proveedores", () => migrateProveedores(ctx)],
      ["productos", () => migrateProductos(ctx)],
      ["caja_sesiones", () => migrateCajaSesiones(ctx)],
      ["caja_movimientos", () => migrateCajaMovimientos(ctx)],
      ["compras", () => migrateCompras(ctx)],
      ["ventas", () => migrateVentas(ctx)],
      ["ordenes_servicio", () => migrateOrdenesServicio(ctx)],
    ];

    for (const [name, fn] of sections) {
      if (args.skip.has(name)) {
        log(`SKIPPED: ${name}`);
        continue;
      }
      log(`>>> Migrando ${name}`);
      try {
        await fn();
      } catch (error) {
        bump(name, "errors");
        log(`ERROR en ${name}: ${error.message}`);
        if (process.env.MIGRATION_HALT_ON_ERROR === "true") throw error;
      }
    }

    log(">>> Verificacion de conteos");
    const counts = await verify({ legacyPool, saasPool, idEmpresa });
    for (const [key, value] of Object.entries(counts)) {
      sub(`${key}: ${value}`);
    }

    log(">>> Resumen por entidad");
    for (const [entidad, s] of Object.entries(stats)) {
      sub(
        `${entidad}: read=${s.read} inserted=${s.inserted} skipped=${s.skipped} errors=${s.errors}`
      );
    }

    if (args.dryRun) {
      log(
        "DRY-RUN COMPLETADO. Para aplicar: agrega --apply (los registros 'inserted' son simulados)."
      );
    } else {
      log("MIGRACION APLICADA. Verifica los conteos arriba.");
    }
  } finally {
    await Promise.all([legacyPool.end(), saasPool.end()]);
  }
};

main().catch((error) => {
  console.error("[migration] FATAL:", error);
  process.exit(1);
});
