#!/usr/bin/env node
/**
 * Post-migration: genera retroactivamente las cuentas por cobrar de todas las
 * ventas a credito que la migracion legacy -> SaaS dejo sin CXC.
 *
 * El script de migracion principal NO crea CXC para preservar fiabilidad de
 * los saldos historicos. Este helper las regenera "en frio" usando la misma
 * funcion `upsertCuentaPorCobrarFromVenta` del flujo normal de SaaS.
 *
 * Uso:
 *   node scripts/post-migration-cxc.mjs --dry-run --empresa-slug=legacy-pos
 *   node scripts/post-migration-cxc.mjs --apply  --empresa-slug=legacy-pos
 *
 * Variables de entorno:
 *   SAAS_PG* (mismas que el script de migracion)
 *   FINANCE_MODULE_CODE  (default "FINANZAS") - se asegura que la empresa lo
 *                        tenga activo, si no lo activa antes de generar.
 */

import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { upsertCuentaPorCobrarFromVenta } from "../src-saas/shared/finance/accounts.js";

const { Pool } = pg;

// ============================================================
// Args
// ============================================================
const parseArgs = () => {
  const args = {
    dryRun: true,
    apply: false,
    empresaSlug: null,
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
    }
  }

  return args;
};

// ============================================================
// Env loaders
// ============================================================
const loadEnv = () => {
  const candidates = [".env.migration", ".env"];
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      dotenv.config({ path });
      console.log(`[cxc] env cargado desde ${candidate}`);
      return;
    }
  }
  dotenv.config();
};

const buildSaasPool = () => {
  const get = (key, fallback = undefined) =>
    process.env[`SAAS_${key}`] ?? process.env[key] ?? fallback;

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

const log = (msg) => console.log(`[cxc] ${msg}`);
const sub = (msg) => console.log(`  ${msg}`);

// ============================================================
// Helpers
// ============================================================
const getEmpresa = async (pool, slug) => {
  if (!slug) {
    throw new Error("--empresa-slug es requerido");
  }
  const result = await pool.query(
    `select id_empresa, nombre_legal from empresas where slug = $1 limit 1`,
    [slug]
  );
  if (!result.rows[0]) {
    throw new Error(`No se encontro empresa con slug "${slug}"`);
  }
  return result.rows[0];
};

const ensureFinanceModule = async (pool, idEmpresa, financeCode) => {
  const result = await pool.query(
    `
      select em.activo
      from empresas_modulos em
      inner join modulos m on m.id_modulo = em.id_modulo
      where em.id_empresa = $1
        and m.codigo = $2
      limit 1
    `,
    [idEmpresa, financeCode]
  );

  if (result.rows[0]?.activo) return true;

  // Lo activa (o crea el modulo si no existe en catalogo)
  await pool.query(
    `insert into modulos (codigo, nombre, descripcion)
     values ($1, 'Finanzas', 'Cuentas por cobrar/pagar y cierres contables')
     on conflict (codigo) do nothing`,
    [financeCode]
  );

  await pool.query(
    `
      insert into empresas_modulos (id_empresa, id_modulo, activo)
      select $1, m.id_modulo, true
      from modulos m
      where m.codigo = $2
      on conflict (id_empresa, id_modulo) do update set activo = true
    `,
    [idEmpresa, financeCode]
  );

  log(`modulo ${financeCode} activado para la empresa`);
  return true;
};

const getSuperAdminUser = async (pool, idEmpresa) => {
  // Tomamos cualquier usuario con rol SUPER_ADMIN o ADMIN_EMPRESA para
  // que sirva de "actor" en los inserts (con permisos de ensureFinanceModuleEnabled).
  const result = await pool.query(
    `
      select distinct u.id_usuario
      from usuarios u
      inner join usuarios_roles ur on ur.id_empresa = u.id_empresa and ur.id_usuario = u.id_usuario
      inner join roles r on r.id_rol = ur.id_rol
      where u.id_empresa = $1
        and u.activo = true
        and r.codigo in ('SUPER_ADMIN', 'ADMIN_EMPRESA')
      order by u.id_usuario
      limit 1
    `,
    [idEmpresa]
  );

  if (!result.rows[0]) {
    throw new Error(
      "No se encontro un usuario admin para la empresa. Crea uno antes de correr CXC."
    );
  }
  return Number(result.rows[0].id_usuario);
};

const getModulosForEmpresa = async (pool, idEmpresa) => {
  const result = await pool.query(
    `
      select m.codigo
      from empresas_modulos em
      inner join modulos m on m.id_modulo = em.id_modulo
      where em.id_empresa = $1
        and em.activo = true
    `,
    [idEmpresa]
  );
  return result.rows.map((r) => r.codigo);
};

const findVentasCreditoSinCxc = async (pool, idEmpresa) => {
  const result = await pool.query(
    `
      select
        v.id_venta,
        v.numero_comprobante,
        v.id_cliente,
        v.id_sucursal,
        v.total,
        v.saldo_pendiente,
        v.tipo_venta,
        v.metodo_pago
      from ventas v
      where v.id_empresa = $1
        and (
          upper(coalesce(v.tipo_venta, '')) = 'CREDITO'
          or upper(coalesce(v.metodo_pago, '')) = 'CREDITO'
        )
        and v.id_cliente is not null
        and not exists (
          select 1 from cuentas_por_cobrar c
          where c.id_empresa = v.id_empresa
            and c.id_venta = v.id_venta
        )
      order by v.fecha_venta asc, v.id_venta asc
    `,
    [idEmpresa]
  );
  return result.rows;
};

// ============================================================
// Main
// ============================================================
const main = async () => {
  loadEnv();
  const args = parseArgs();

  if (!args.empresaSlug) {
    console.error(
      "[cxc] FATAL: --empresa-slug es requerido (ej. --empresa-slug=legacy-pos)"
    );
    process.exit(1);
  }

  log(args.dryRun ? "MODO DRY-RUN" : "MODO APPLY");
  log(`Empresa: ${args.empresaSlug}`);

  const pool = buildSaasPool();

  try {
    const empresa = await getEmpresa(pool, args.empresaSlug);
    const idEmpresa = Number(empresa.id_empresa);
    log(`Empresa id=${idEmpresa} nombre="${empresa.nombre_legal}"`);

    const financeCode = process.env.FINANCE_MODULE_CODE || "FINANZAS";
    if (args.apply) {
      await ensureFinanceModule(pool, idEmpresa, financeCode);
    }

    const idActor = await getSuperAdminUser(pool, idEmpresa);
    sub(`actor (admin) id=${idActor}`);

    const modulos = await getModulosForEmpresa(pool, idEmpresa);
    sub(`modulos activos: ${modulos.join(", ")}`);

    const ventas = await findVentasCreditoSinCxc(pool, idEmpresa);
    log(`ventas a credito sin CXC: ${ventas.length}`);

    if (ventas.length === 0) {
      log("Nada que hacer.");
      return;
    }

    if (args.dryRun) {
      sub("Listado de ventas que se procesarian:");
      for (const v of ventas.slice(0, 20)) {
        sub(
          `  #${v.id_venta} ${v.numero_comprobante} cliente=${v.id_cliente} total=${v.total}`
        );
      }
      if (ventas.length > 20) {
        sub(`  ... y ${ventas.length - 20} mas`);
      }
      log(
        "DRY-RUN COMPLETADO. Para crear las CXC: corre con --apply en lugar de --dry-run."
      );
      return;
    }

    // APPLY
    const auth = {
      id_empresa: idEmpresa,
      id_usuario: idActor,
      modulos,
    };

    let creadas = 0;
    let errores = 0;
    const errorDetalle = [];

    for (const v of ventas) {
      try {
        const result = await upsertCuentaPorCobrarFromVenta(pool, {
          auth,
          ventaId: Number(v.id_venta),
          actorId: idActor,
          movementType: "VENTA_CREDITO_RETROACTIVA",
          movementDate: new Date(),
        });

        if (result) {
          creadas += 1;
          if (creadas % 50 === 0) {
            sub(`procesadas ${creadas} CXC...`);
          }
        }
      } catch (error) {
        errores += 1;
        errorDetalle.push({
          id_venta: v.id_venta,
          numero_comprobante: v.numero_comprobante,
          error: error.message,
        });
      }
    }

    log(`>>> Resumen`);
    sub(`CXC creadas: ${creadas}`);
    sub(`Errores: ${errores}`);

    if (errorDetalle.length > 0) {
      log(`Primeros 10 errores:`);
      for (const e of errorDetalle.slice(0, 10)) {
        sub(`  venta #${e.id_venta} (${e.numero_comprobante}): ${e.error}`);
      }
    }

    log("APPLY COMPLETADO.");
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error("[cxc] FATAL:", error);
  process.exit(1);
});
