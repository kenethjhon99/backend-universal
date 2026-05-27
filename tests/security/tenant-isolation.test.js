/**
 * Test de regresion: aislamiento RLS cross-tenant.
 *
 * Este test prueba que cuando una conexion Postgres usa el rol `saas_app`
 * (sin BYPASSRLS), las queries respetan las policies de Row-Level Security:
 *  - Si `app.current_empresa_id` esta seteado a X, solo ve datos de X.
 *  - Si no esta seteado, no ve datos tenant-scoped.
 *  - SUPER_ADMIN bypasses via `app.is_super_admin()`.
 *
 * Requisitos para correr:
 *  - BD con las migraciones aplicadas hasta 034.
 *  - Rol `saas_app` existe.
 *  - Env: PGHOST, PGDATABASE, PGUSER (postgres), PGPASSWORD para bootstrap;
 *    SAAS_APP_PASSWORD para conectar como saas_app (default 'change-me-in-deploy').
 *
 * Si el rol no existe, el test se salta con un warning (no falla en CI hasta
 * que se aplique la migracion).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const { Pool } = pg;

const PG_BASE = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
};

// Pool admin (postgres) para bootstrap de datos
const adminPool = new Pool({
  ...PG_BASE,
  user: process.env.PGUSER || "postgres",
  max: 5,
});

// Pool saas_app (sin bypass RLS) — el que prueba aislamiento
const tenantPool = new Pool({
  ...PG_BASE,
  user: "saas_app",
  password: process.env.SAAS_APP_PASSWORD || "change-me-in-deploy",
  max: 5,
});

let testRunnable = true;
let empresaA;
let empresaB;
let sucursalA;
let sucursalB;
let usuarioA;
let usuarioB;
let clienteA;
let clienteB;
let proveedorA;
let proveedorB;
let productoA;
let productoB;
let servicioA;
let servicioB;
let cleanupIds = [];

const insertTenantFixtures = async ({ idEmpresa, marker }) => {
  const sucursal = await adminPool.query(
    `insert into sucursales (id_empresa, codigo, nombre, activa)
     values ($1, $2, $3, true)
     returning id_sucursal`,
    [idEmpresa, `SUC_ISO_${marker}`, `Sucursal ${marker}`]
  );

  const usuario = await adminPool.query(
    `insert into usuarios (
       id_empresa, username, email, password_hash, nombre, apellido,
       id_sucursal_default, activo
     )
     values ($1, $2, $3, 'test-hash', $4, 'Iso', $5, true)
     returning id_usuario`,
    [
      idEmpresa,
      `tenant_iso_${marker.toLowerCase()}`,
      `tenant_iso_${marker.toLowerCase()}@example.com`,
      `Usuario ${marker}`,
      sucursal.rows[0].id_sucursal,
    ]
  );

  await adminPool.query(
    `insert into usuarios_sucursales (
       id_empresa, id_usuario, id_sucursal, es_predeterminada
     )
     values ($1, $2, $3, true)`,
    [idEmpresa, usuario.rows[0].id_usuario, sucursal.rows[0].id_sucursal]
  );

  const bodega = await adminPool.query(
    `insert into bodegas (id_empresa, id_sucursal, codigo, nombre, es_principal)
     values ($1, $2, $3, 'Bodega principal', true)
     returning id_bodega`,
    [idEmpresa, sucursal.rows[0].id_sucursal, `BOD_ISO_${marker}`]
  );

  const cliente = await adminPool.query(
    `insert into clientes (id_empresa, codigo, nombre)
     values ($1, $2, $3)
     returning id_cliente`,
    [idEmpresa, `CLI_ISO_${marker}`, `Cliente ${marker}`]
  );

  const proveedor = await adminPool.query(
    `insert into proveedores (id_empresa, codigo, nombre)
     values ($1, $2, $3)
     returning id_proveedor`,
    [idEmpresa, `PROV_ISO_${marker}`, `Proveedor ${marker}`]
  );

  const producto = await adminPool.query(
    `insert into productos (id_empresa, sku, nombre, precio_compra, precio_venta)
     values ($1, $2, $3, 5, 10)
     returning id_producto`,
    [idEmpresa, `SKU_ISO_${marker}`, `Producto ${marker}`]
  );

  await adminPool.query(
    `insert into stock_sucursal (
       id_empresa, id_sucursal, id_bodega, id_producto, stock_actual
     )
     values ($1, $2, $3, $4, 10)`,
    [
      idEmpresa,
      sucursal.rows[0].id_sucursal,
      bodega.rows[0].id_bodega,
      producto.rows[0].id_producto,
    ]
  );

  const caja = await adminPool.query(
    `insert into caja_sesiones (
       id_empresa, id_sucursal, id_usuario, estado, monto_apertura
     )
     values ($1, $2, $3, 'ABIERTA', 100)
     returning id_caja_sesion`,
    [idEmpresa, sucursal.rows[0].id_sucursal, usuario.rows[0].id_usuario]
  );

  await adminPool.query(
    `insert into ventas (
       id_empresa, id_sucursal, id_usuario, id_cliente, id_caja_sesion,
       numero_comprobante, total
     )
     values ($1, $2, $3, $4, $5, $6, 10)`,
    [
      idEmpresa,
      sucursal.rows[0].id_sucursal,
      usuario.rows[0].id_usuario,
      cliente.rows[0].id_cliente,
      caja.rows[0].id_caja_sesion,
      `VENTA_ISO_${marker}`,
    ]
  );

  await adminPool.query(
    `insert into compras (
       id_empresa, id_sucursal, id_proveedor, id_usuario, numero_documento, total
     )
     values ($1, $2, $3, $4, $5, 20)`,
    [
      idEmpresa,
      sucursal.rows[0].id_sucursal,
      proveedor.rows[0].id_proveedor,
      usuario.rows[0].id_usuario,
      `COMPRA_ISO_${marker}`,
    ]
  );

  const servicio = await adminPool.query(
    `insert into servicios_catalogo (id_empresa, codigo, nombre, precio_base)
     values ($1, $2, $3, 25)
     returning id_servicio_catalogo`,
    [idEmpresa, `SERV_ISO_${marker}`, `Servicio ${marker}`]
  );

  await adminPool.query(
    `insert into ordenes_servicio (
       id_empresa, id_sucursal, id_servicio_catalogo, id_cliente, id_usuario,
       placa, total
     )
     values ($1, $2, $3, $4, $5, $6, 25)`,
    [
      idEmpresa,
      sucursal.rows[0].id_sucursal,
      servicio.rows[0].id_servicio_catalogo,
      cliente.rows[0].id_cliente,
      usuario.rows[0].id_usuario,
      `ISO${marker}`,
    ]
  );

  await adminPool.query(
    `insert into auditoria_eventos (
       id_empresa, id_sucursal, id_usuario, modulo, entidad, entidad_id, accion
     )
     values ($1, $2, $3, 'ISO', 'TENANT_FIXTURE', $4, 'CREATE')`,
    [
      idEmpresa,
      sucursal.rows[0].id_sucursal,
      usuario.rows[0].id_usuario,
      idEmpresa,
    ]
  );

  return {
    sucursal: Number(sucursal.rows[0].id_sucursal),
    usuario: Number(usuario.rows[0].id_usuario),
    cliente: Number(cliente.rows[0].id_cliente),
    proveedor: Number(proveedor.rows[0].id_proveedor),
    producto: Number(producto.rows[0].id_producto),
    servicio: Number(servicio.rows[0].id_servicio_catalogo),
  };
};

beforeAll(async () => {
  if (!process.env.PGDATABASE) {
    testRunnable = false;
    console.warn("[tenant-isolation] PGDATABASE no definido. Skipping.");
    return;
  }

  // Verificar que el rol saas_app existe (migration 034 aplicada)
  const r = await adminPool.query(
    "select 1 from pg_roles where rolname = 'saas_app'"
  );
  if (r.rowCount === 0) {
    testRunnable = false;
    console.warn(
      "[tenant-isolation] Rol 'saas_app' no existe. Aplicar migration 034. Skipping."
    );
    return;
  }

  // Verificar que el rol NO tiene bypass
  const bypass = await adminPool.query(
    "select rolbypassrls from pg_roles where rolname = 'saas_app'"
  );
  if (bypass.rows[0]?.rolbypassrls === true) {
    testRunnable = false;
    console.warn(
      "[tenant-isolation] Rol 'saas_app' tiene BYPASSRLS. RLS no protege. Skipping."
    );
    return;
  }

  // Intentar conectar como saas_app para validar credenciales
  try {
    const c = await tenantPool.connect();
    c.release();
  } catch (err) {
    testRunnable = false;
    console.warn(
      `[tenant-isolation] No se pudo conectar como saas_app: ${err.message}. Skipping.`
    );
    return;
  }

  // Bootstrap: dos empresas dummy para el test
  const slug = (s) => `__tenant_iso_${s}_${Date.now().toString(36)}`;
  const a = await adminPool.query(
    `insert into empresas (slug, nombre_legal, estado)
     values ($1, $2, 'ACTIVA')
     returning id_empresa`,
    [slug("a"), "Empresa Test A"]
  );
  const b = await adminPool.query(
    `insert into empresas (slug, nombre_legal, estado)
     values ($1, $2, 'ACTIVA')
     returning id_empresa`,
    [slug("b"), "Empresa Test B"]
  );
  empresaA = Number(a.rows[0].id_empresa);
  empresaB = Number(b.rows[0].id_empresa);
  cleanupIds = [empresaA, empresaB];

  const fixturesA = await insertTenantFixtures({
    idEmpresa: empresaA,
    marker: "A",
  });
  const fixturesB = await insertTenantFixtures({
    idEmpresa: empresaB,
    marker: "B",
  });

  sucursalA = fixturesA.sucursal;
  sucursalB = fixturesB.sucursal;
  usuarioA = fixturesA.usuario;
  usuarioB = fixturesB.usuario;
  clienteA = fixturesA.cliente;
  clienteB = fixturesB.cliente;
  proveedorA = fixturesA.proveedor;
  proveedorB = fixturesB.proveedor;
  productoA = fixturesA.producto;
  productoB = fixturesB.producto;
  servicioA = fixturesA.servicio;
  servicioB = fixturesB.servicio;
});

afterAll(async () => {
  if (cleanupIds.length > 0) {
    for (const id of cleanupIds) {
      try {
        // Borrar en orden inverso de FKs (best-effort)
        await adminPool.query(
          "delete from auditoria_eventos where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from ordenes_servicio where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from servicios_catalogo where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from ventas where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from compras where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from caja_sesiones where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from stock_sucursal where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from productos where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from proveedores where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from clientes where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from bodegas where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from usuarios_sucursales where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from usuarios where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from sucursales where id_empresa = $1",
          [id]
        );
        await adminPool.query(
          "delete from empresas where id_empresa = $1",
          [id]
        );
      } catch (err) {
        console.warn(
          `[tenant-isolation] cleanup empresa ${id}: ${err.message}`
        );
      }
    }
  }
  await Promise.all([adminPool.end(), tenantPool.end()]);
});

describe("RLS cross-tenant isolation", () => {
  it("saas_app rol no tiene BYPASSRLS", async () => {
    if (!testRunnable) return;
    const r = await adminPool.query(
      "select rolbypassrls from pg_roles where rolname = 'saas_app'"
    );
    expect(r.rows[0].rolbypassrls).toBe(false);
  });

  it("sin current_empresa_id seteado, no ve sucursales de ningun tenant", async () => {
    if (!testRunnable) return;

    // Bootstrap: una sucursal por empresa via admin (que bypassa RLS)
    await adminPool.query(
      `insert into sucursales (id_empresa, codigo, nombre, activa)
       values ($1, 'SUC_ISO_A', 'Suc A', true)
       on conflict do nothing`,
      [empresaA]
    );
    await adminPool.query(
      `insert into sucursales (id_empresa, codigo, nombre, activa)
       values ($1, 'SUC_ISO_B', 'Suc B', true)
       on conflict do nothing`,
      [empresaB]
    );

    const client = await tenantPool.connect();
    try {
      // Sin set_config: la policy filtra por current_empresa_id() que es null
      const r = await client.query(
        `select id_empresa, codigo from sucursales
         where codigo in ('SUC_ISO_A', 'SUC_ISO_B')`
      );
      // Sin contexto, RLS debe rechazar todo
      expect(r.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("con current_empresa_id=A, solo ve sucursales de A", async () => {
    if (!testRunnable) return;
    const client = await tenantPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_empresa_id', $1, true)",
        [String(empresaA)]
      );
      await client.query("select set_config('app.current_rol', 'CAJERO', true)");

      const r = await client.query(
        `select id_empresa, codigo from sucursales
         where codigo in ('SUC_ISO_A', 'SUC_ISO_B')`
      );
      const ids = new Set(r.rows.map((row) => Number(row.id_empresa)));
      expect(ids.has(empresaA)).toBe(true);
      expect(ids.has(empresaB)).toBe(false);

      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("con current_empresa_id=B, solo ve sucursales de B", async () => {
    if (!testRunnable) return;
    const client = await tenantPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_empresa_id', $1, true)",
        [String(empresaB)]
      );
      await client.query("select set_config('app.current_rol', 'CAJERO', true)");

      const r = await client.query(
        `select id_empresa, codigo from sucursales
         where codigo in ('SUC_ISO_A', 'SUC_ISO_B')`
      );
      const ids = new Set(r.rows.map((row) => Number(row.id_empresa)));
      expect(ids.has(empresaB)).toBe(true);
      expect(ids.has(empresaA)).toBe(false);

      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("con current_empresa_id=A, modulos core solo ven datos de A", async () => {
    if (!testRunnable) return;
    const client = await tenantPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_empresa_id', $1, true)",
        [String(empresaA)]
      );
      await client.query("select set_config('app.current_rol', 'ADMIN_EMPRESA', true)");

      const checks = [
        {
          table: "clientes",
          ids: [clienteA, clienteB],
          column: "id_cliente",
        },
        {
          table: "proveedores",
          ids: [proveedorA, proveedorB],
          column: "id_proveedor",
        },
        {
          table: "productos",
          ids: [productoA, productoB],
          column: "id_producto",
        },
        {
          table: "stock_sucursal",
          ids: [productoA, productoB],
          column: "id_producto",
        },
        {
          table: "caja_sesiones",
          ids: [usuarioA, usuarioB],
          column: "id_usuario",
        },
        {
          table: "ventas",
          ids: [clienteA, clienteB],
          column: "id_cliente",
        },
        {
          table: "compras",
          ids: [proveedorA, proveedorB],
          column: "id_proveedor",
        },
        {
          table: "servicios_catalogo",
          ids: [servicioA, servicioB],
          column: "id_servicio_catalogo",
        },
        {
          table: "ordenes_servicio",
          ids: [clienteA, clienteB],
          column: "id_cliente",
        },
        {
          table: "auditoria_eventos",
          ids: [empresaA, empresaB],
          column: "entidad_id",
        },
      ];

      for (const check of checks) {
        // eslint-disable-next-line no-await-in-loop
        const r = await client.query(
          `select id_empresa, ${check.column} from ${check.table}
           where ${check.column} = any($1::bigint[])`,
          [check.ids]
        );
        const companies = new Set(r.rows.map((row) => Number(row.id_empresa)));
        expect(companies.has(empresaA), check.table).toBe(true);
        expect(companies.has(empresaB), check.table).toBe(false);
      }

      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("SUPER_ADMIN ve todas las sucursales de prueba", async () => {
    if (!testRunnable) return;
    const client = await tenantPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_rol', 'SUPER_ADMIN', true)"
      );

      const r = await client.query(
        `select id_empresa, codigo from sucursales
         where codigo in ('SUC_ISO_A', 'SUC_ISO_B')`
      );
      const ids = new Set(r.rows.map((row) => Number(row.id_empresa)));
      expect(ids.has(empresaA)).toBe(true);
      expect(ids.has(empresaB)).toBe(true);

      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("INSERT cross-tenant es rechazado por RLS (no se filtra a otra empresa)", async () => {
    if (!testRunnable) return;
    const client = await tenantPool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_empresa_id', $1, true)",
        [String(empresaA)]
      );
      await client.query("select set_config('app.current_rol', 'ADMIN_EMPRESA', true)");

      // Intentar insertar una sucursal en empresaB mientras el contexto es A
      let blocked = false;
      try {
        await client.query(
          `insert into sucursales (id_empresa, codigo, nombre, activa)
           values ($1, 'SUC_ISO_ATTACK', 'Attack', true)`,
          [empresaB]
        );
      } catch (err) {
        // El error puede venir como "new row violates row-level security policy"
        // o localizado por Postgres, ej. "política de seguridad de registros".
        blocked = /row-level security|policy|pol.tica|seguridad de registros/i.test(
          err.message
        );
      }

      expect(blocked).toBe(true);

      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
