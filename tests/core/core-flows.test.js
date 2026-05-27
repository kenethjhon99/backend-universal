import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTestPool,
  setupTestSchema,
  teardownTestSchema,
} from "../setup/test-schema.js";
import {
  seedBaseTenant,
  seedCajaSesionAbierta,
  setupSalesSchema,
} from "../setup/sales-schema.js";

const isLive = Boolean(process.env.PGDATABASE);
const describeFn = isLive ? describe : describe.skip;

vi.mock("../../src-saas/shared/audit/audit-log.js", () => ({
  writeAuditEvent: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/shared/finance/period-closure.js", () => ({
  assertPeriodOpen: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/shared/finance/accounts.js", () => ({
  ensureFinanceModuleEnabled: vi.fn(),
  isCreditSale: vi.fn(() => false),
  isCreditPurchase: vi.fn(() => false),
  resolveCreditDays: vi.fn(() => null),
  resolveDueDate: vi.fn(() => null),
  upsertCuentaPorCobrarFromVenta: vi.fn(async () => {}),
  upsertCuentaPorPagarFromCompra: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/modules/notificaciones/notificaciones.service.js", () => ({
  notify: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/modules/webhooks/webhooks.service.js", () => ({
  triggerEvent: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/modules/facturacion-electronica/fe.service.js", () => ({
  certifyNotaCredito: vi.fn(async () => ({})),
}));

vi.mock("../../src-saas/modules/promociones/promociones.service.js", () => ({
  registerPromotionUses: vi.fn(async () => {}),
  resolveActivePromotions: vi.fn(async () => []),
}));

vi.mock("../../src-saas/modules/fidelidad/fidelidad.service.js", () => ({
  acumularPorVenta: vi.fn(async () => {}),
  canjearEnVenta: vi.fn(async () => ({})),
}));

vi.mock("../../src-saas/config/db.js", () => ({
  pool: getTestPool(),
  applyRequestSettings: vi.fn(async () => {}),
}));

const importVentasService = async () =>
  import("../../src-saas/modules/ventas/ventas.service.js");

const importComprasService = async () =>
  import("../../src-saas/modules/compras/compras.service.js");

describeFn("Fase 2 core POS flows", () => {
  let ventasService;
  let comprasService;
  const auth = {
    id_empresa: 1,
    id_usuario: 1,
    id_sucursal: 1,
    rol: "ADMIN_EMPRESA",
    sucursales: [1],
    modulos: ["POS", "INVENTARIO", "COMPRAS"],
    permisos: ["sales.create", "purchases.create", "inventory.write"],
  };
  const scope = { id_empresa: 1, id_sucursal: 1 };

  beforeAll(async () => {
    await setupTestSchema();
    await setupSalesSchema();
    ventasService = await importVentasService();
    comprasService = await importComprasService();
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `truncate
        compra_ajustes_costo,
        compra_reversion_detalles,
        compra_reversiones,
        compra_detalles,
        compras,
        proveedores,
        venta_reversion_detalles,
        venta_reversiones,
        venta_detalles,
        ventas,
        movimientos_inventario,
        caja_movimientos,
        caja_sesiones,
        comprobante_series,
        stock_sucursal,
        productos,
        clientes,
        usuarios,
        bodegas,
        sucursales,
        empresas
       restart identity cascade`
    );
    await seedBaseTenant();
    await seedCajaSesionAbierta({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
    });
  });

  it("crea venta contado y actualiza stock, caja y kardex", async () => {
    const pool = getTestPool();
    await pool.query(
      `insert into clientes (id_cliente, id_empresa, nombre) values (1, 1, 'Cliente POS')`
    );

    const result = await ventasService.createVenta({
      auth,
      scope,
      body: {
        id_cliente: 1,
        tipo_venta: "CONTADO",
        metodo_pago: "EFECTIVO",
        monto_recibido: 250,
        items: [{ id_producto: 1, cantidad: 2 }],
      },
    });

    expect(result.venta.total).toBe(200);
    expect(result.detalles).toHaveLength(1);

    const stock = await pool.query(
      `select stock_actual from stock_sucursal where id_producto = 1`
    );
    expect(Number(stock.rows[0].stock_actual)).toBe(98);

    const caja = await pool.query(
      `select tipo, categoria, monto from caja_movimientos where referencia_tipo = 'VENTA'`
    );
    expect(caja.rows[0]).toMatchObject({
      tipo: "INGRESO",
      categoria: "VENTA_EFECTIVO",
    });
    expect(Number(caja.rows[0].monto)).toBe(200);

    const movimiento = await pool.query(
      `select tipo, referencia_tipo, cantidad, stock_antes, stock_despues
       from movimientos_inventario
       where referencia_tipo = 'VENTA'`
    );
    expect(movimiento.rows[0]).toMatchObject({
      tipo: "SALIDA",
      referencia_tipo: "VENTA",
    });
    expect(Number(movimiento.rows[0].cantidad)).toBe(2);
    expect(Number(movimiento.rows[0].stock_antes)).toBe(100);
    expect(Number(movimiento.rows[0].stock_despues)).toBe(98);
  });

  it("crea compra contado y actualiza costo, stock y kardex", async () => {
    const pool = getTestPool();
    await pool.query(
      `insert into proveedores (id_proveedor, id_empresa, nombre) values (1, 1, 'Proveedor POS')`
    );

    const result = await comprasService.createCompra({
      auth,
      scope,
      body: {
        id_proveedor: 1,
        numero_documento: "FC-100",
        condicion_pago: "CONTADO",
        items: [{ id_producto: 1, cantidad: 4, costo_unitario: 55 }],
      },
    });

    expect(result.compra.total).toBe(220);
    expect(result.detalles).toHaveLength(1);

    const stock = await pool.query(
      `select stock_actual from stock_sucursal where id_producto = 1`
    );
    expect(Number(stock.rows[0].stock_actual)).toBe(104);

    const product = await pool.query(
      `select precio_compra from productos where id_producto = 1`
    );
    expect(Number(product.rows[0].precio_compra)).toBe(55);

    const movimiento = await pool.query(
      `select tipo, referencia_tipo, cantidad, stock_antes, stock_despues
       from movimientos_inventario
       where referencia_tipo = 'COMPRA'`
    );
    expect(movimiento.rows[0]).toMatchObject({
      tipo: "ENTRADA",
      referencia_tipo: "COMPRA",
    });
    expect(Number(movimiento.rows[0].cantidad)).toBe(4);
    expect(Number(movimiento.rows[0].stock_antes)).toBe(100);
    expect(Number(movimiento.rows[0].stock_despues)).toBe(104);
  });
});

