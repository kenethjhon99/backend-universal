/**
 * Tests de integracion para G4: reportes de corte de ventas.
 *
 * Para correr:
 *   1) Crear .env.test con credenciales a una BD vacia.
 *   2) npm install
 *   3) npm test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestPool,
  setSchemaSearchPath,
  setupTestSchema,
  teardownTestSchema,
} from "../setup/test-schema.js";
import {
  seedBaseTenant,
  seedCajaSesionAbierta,
  seedSampleSale,
  setupSalesSchema,
} from "../setup/sales-schema.js";

const isLive = Boolean(process.env.PGDATABASE);
const SKIP_REASON =
  "Saltado: PGDATABASE no definido. Crea un .env.test para correr estos tests.";

vi.mock("../../src-saas/config/db.js", () => ({
  pool: getTestPool(),
  applyRequestSettings: vi.fn(async () => {}),
}));

const importReportes = async () =>
  import("../../src-saas/modules/reportes/reportes.service.js");

const describeFn = isLive ? describe : describe.skip;

describeFn("G4 - reportes de corte de ventas", () => {
  let reportesService;

  const adminAuth = {
    id_empresa: 1,
    id_usuario: 1,
    id_sucursal: 1,
    rol: "ADMIN_EMPRESA",
    sucursales: [1],
    modulos: ["POS", "REPORTES"],
    permisos: ["reports.read"],
  };
  const scope = { id_empresa: 1, id_sucursal: 1 };

  const today = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Guatemala",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const baseQuery = () => ({
    desde: today(),
    hasta: today(),
    id_sucursal: 1,
  });

  beforeAll(async () => {
    await setupTestSchema();
    const pool = getTestPool();
    await setSchemaSearchPath(pool);

    await setupSalesSchema();
    await seedBaseTenant();
    await seedCajaSesionAbierta({ idEmpresa: 1, idSucursal: 1, idUsuario: 1 });

    reportesService = await importReportes();
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `truncate venta_reversion_detalles, venta_reversiones, venta_detalles, ventas restart identity cascade`
    );
  });

  it("getCorteVentas retorna resumen con ceros cuando no hay ventas", async () => {
    const corte = await reportesService.getCorteVentas({
      auth: adminAuth,
      scope,
      query: baseQuery(),
    });

    expect(corte.resumen.ventas_cantidad).toBe(0);
    expect(corte.resumen.total_neto).toBe(0);
    expect(corte.resumen.total_efectivo).toBe(0);
    expect(corte.por_usuario).toEqual([]);
    expect(corte.empresa.id_empresa).toBe(1);
    expect(corte.rango.desde).toBe(today());
  });

  it("getCorteVentas calcula totales por metodo de pago", async () => {
    const pool = getTestPool();
    // Tres ventas con metodos distintos
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-1','TICKET','CONTADO','EFECTIVO','CONFIRMADA',100)`
    );
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-2','TICKET','CONTADO','TARJETA','CONFIRMADA',150)`
    );
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-3','TICKET','CREDITO','CREDITO','CONFIRMADA',300)`
    );

    const corte = await reportesService.getCorteVentas({
      auth: adminAuth,
      scope,
      query: baseQuery(),
    });

    expect(corte.resumen.ventas_cantidad).toBe(3);
    expect(corte.resumen.total_efectivo).toBe(100);
    expect(corte.resumen.total_tarjeta).toBe(150);
    expect(corte.resumen.total_contado).toBe(250);
    expect(corte.resumen.total_credito).toBe(300);
    expect(corte.resumen.total_neto).toBe(550);
  });

  it("descuenta reversiones del total_neto y total_anulado", async () => {
    const pool = getTestPool();
    // Venta de 500 con reversion parcial de 200 (monto_revertido).
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total, monto_revertido, estado_reversion)
       values (1,1,1,1,'TKT-1','TICKET','CONTADO','EFECTIVO','CONFIRMADA',500,200,'PARCIAL')`
    );
    // Venta de 300 totalmente revertida (estado_reversion = TOTAL).
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total, monto_revertido, estado_reversion)
       values (1,1,1,1,'TKT-2','TICKET','CONTADO','EFECTIVO','CONFIRMADA',300,300,'TOTAL')`
    );

    const corte = await reportesService.getCorteVentas({
      auth: adminAuth,
      scope,
      query: baseQuery(),
    });

    // total_neto = (500-200) + (300-300) = 300
    expect(corte.resumen.total_neto).toBe(300);
    // total_original = 500 + 300 = 800
    expect(corte.resumen.total_original).toBe(800);
    // total_anulado = 200 + 300 = 500
    expect(corte.resumen.total_anulado).toBe(500);
    // estado_reversion contadores
    expect(corte.resumen.ventas_anuladas).toBe(1);
    expect(corte.resumen.ventas_con_reversion_parcial).toBe(1);
  });

  it("filtra por id_usuario cuando se proporciona", async () => {
    const pool = getTestPool();
    await pool.query(
      `insert into usuarios (id_empresa, username, nombre, apellido) values (1, 'cajero2', 'Juan', 'Perez')`
    );
    const u2Result = await pool.query(
      `select id_usuario from usuarios where username = 'cajero2'`
    );
    const idU2 = Number(u2Result.rows[0].id_usuario);

    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-A','TICKET','CONTADO','EFECTIVO','CONFIRMADA',100)`
    );
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,$1,1,'TKT-B','TICKET','CONTADO','EFECTIVO','CONFIRMADA',250)`,
      [idU2]
    );

    const corteFiltrado = await reportesService.getCorteVentas({
      auth: adminAuth,
      scope,
      query: { ...baseQuery(), id_usuario: idU2 },
    });

    expect(corteFiltrado.resumen.ventas_cantidad).toBe(1);
    expect(corteFiltrado.resumen.total_neto).toBe(250);
    expect(corteFiltrado.alcance.id_usuario).toBe(idU2);
  });

  it("ignora ventas ANULADAS (legacy state)", async () => {
    const pool = getTestPool();
    await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-X','TICKET','CONTADO','EFECTIVO','ANULADA',999)`
    );

    const corte = await reportesService.getCorteVentas({
      auth: adminAuth,
      scope,
      query: baseQuery(),
    });

    expect(corte.resumen.ventas_cantidad).toBe(0);
    expect(corte.resumen.total_neto).toBe(0);
  });

  it("getCorteVentasDetalladoPro retorna estructura completa", async () => {
    const pool = getTestPool();
    // Venta + 2 detalles
    const ventaResult = await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total)
       values (1,1,1,1,'TKT-1','TICKET','CONTADO','EFECTIVO','CONFIRMADA',300) returning id_venta`
    );
    const idVenta = Number(ventaResult.rows[0].id_venta);

    await pool.query(
      `insert into venta_detalles (id_empresa, id_venta, id_producto, cantidad, precio_unitario, subtotal, costo_unitario, utilidad)
       values (1, $1, 1, 2, 100, 200, 60, 80)`,
      [idVenta]
    );
    await pool.query(
      `insert into productos (id_empresa, sku, nombre, precio_compra, precio_venta) values (1, 'P-2', 'Producto 2', 30, 100)`
    );
    await pool.query(
      `insert into venta_detalles (id_empresa, id_venta, id_producto, cantidad, precio_unitario, subtotal, costo_unitario, utilidad)
       values (1, $1, 2, 1, 100, 100, 30, 70)`,
      [idVenta]
    );

    const detallado = await reportesService.getCorteVentasDetalladoPro({
      auth: adminAuth,
      scope,
      query: { ...baseQuery(), top: 5, page: 1, limit: 10 },
    });

    expect(detallado.resumen.ventas_cantidad).toBe(1);
    expect(detallado.resumen.utilidad_estimada).toBe(150); // 80 + 70
    expect(detallado.ventas).toHaveLength(1);
    expect(detallado.ventas[0].numero_comprobante).toBe("TKT-1");
    expect(detallado.por_metodo_pago).toContainEqual(
      expect.objectContaining({ metodo_pago: "EFECTIVO", total_neto: 300 })
    );
    expect(detallado.por_tipo_venta).toContainEqual(
      expect.objectContaining({ tipo_venta: "CONTADO", total_neto: 300 })
    );
    expect(detallado.top_productos_por_total).toHaveLength(2);
    expect(detallado.top_productos_por_total[0].total_neto).toBe(200); // producto 1
    expect(detallado.meta.top).toBe(5);
    expect(detallado.meta.page).toBe(1);
    expect(detallado.meta.totalRows).toBe(1);
  });

  it("top_productos_por_total descuenta cantidades revertidas", async () => {
    const pool = getTestPool();
    const ventaResult = await pool.query(
      `insert into ventas (id_empresa, id_sucursal, id_usuario, id_caja_sesion, numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado, total, monto_revertido, estado_reversion)
       values (1,1,1,1,'TKT-1','TICKET','CONTADO','EFECTIVO','CONFIRMADA',500,200,'PARCIAL') returning id_venta`
    );
    const idVenta = Number(ventaResult.rows[0].id_venta);

    const detalleResult = await pool.query(
      `insert into venta_detalles (id_empresa, id_venta, id_producto, cantidad, precio_unitario, subtotal, costo_unitario, utilidad)
       values (1, $1, 1, 5, 100, 500, 60, 200) returning id_venta_detalle`,
      [idVenta]
    );
    const idDet = Number(detalleResult.rows[0].id_venta_detalle);

    const reversionResult = await pool.query(
      `insert into venta_reversiones (id_empresa, id_venta, id_sucursal, id_usuario, tipo_reversion, numero_documento, metodo_resolucion, motivo, reintegrar_stock, total)
       values (1, $1, 1, 1, 'DEVOLUCION', 'DVV-1', 'AJUSTE', 'test', false, 200) returning id_venta_reversion`,
      [idVenta]
    );
    const idRev = Number(reversionResult.rows[0].id_venta_reversion);

    await pool.query(
      `insert into venta_reversion_detalles (id_empresa, id_venta_reversion, id_venta_detalle, id_producto, cantidad, precio_unitario, costo_unitario, subtotal)
       values (1, $1, $2, 1, 2, 100, 60, 200)`,
      [idRev, idDet]
    );

    const detallado = await reportesService.getCorteVentasDetalladoPro({
      auth: adminAuth,
      scope,
      query: baseQuery(),
    });

    const top = detallado.top_productos_por_total[0];
    // 5 - 2 = 3 unidades; 500 - 200 = 300 neto
    expect(top.cantidad_vendida_neta).toBe(3);
    expect(top.total_neto).toBe(300);
  });

  it("rechaza id_sucursal fuera del scope para usuarios no privilegiados", async () => {
    const cajeroAuth = {
      ...adminAuth,
      rol: "CAJERO",
      sucursales: [1],
    };

    await expect(
      reportesService.getCorteVentas({
        auth: cajeroAuth,
        scope,
        query: { ...baseQuery(), id_sucursal: 999 },
      })
    ).rejects.toThrow();
  });

  it("rechaza si desde > hasta", async () => {
    await expect(
      reportesService.getCorteVentas({
        auth: adminAuth,
        scope,
        query: { desde: "2030-01-01", hasta: "2020-01-01", id_sucursal: 1 },
      })
    ).rejects.toThrow(/desde no puede ser mayor que hasta/i);
  });
});

if (!isLive) {
  // eslint-disable-next-line no-console
  console.warn(`\n[tests] ${SKIP_REASON}\n`);
}
