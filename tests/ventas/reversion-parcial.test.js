/**
 * Tests de integracion para anulacion parcial de venta (G2).
 *
 * Estrategia:
 *   - Levantar Postgres real con un schema temporal (igual que en G1).
 *   - Mockear las dependencias accesorias del service de ventas
 *     (auditoria, period-closure, finanzas/CXC) que no son foco de G2.
 *   - Importar createVentaReversion del service real e invocarlo varias veces
 *     contra la misma venta para validar invariantes:
 *       * monto_revertido se acumula
 *       * estado_reversion: SIN_REVERSION -> PARCIAL -> TOTAL
 *       * cantidad_disponible_reversion descuenta lo ya devuelto
 *       * stock se reintegra cuando reintegrar_stock = true
 *       * caja_movimientos recibe EGRESO al revertir con EFECTIVO
 *
 * Para correr:
 *   1) Crear .env.test (ver .env.test.example).
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

const SKIP_REASON =
  "Saltado: PGDATABASE no definido. Crea un .env.test para correr estos tests.";
const isLive = Boolean(process.env.PGDATABASE);

// ---------- mocks de dependencias accesorias ----------
// Estos modulos no son el foco de G2 y dependen de tablas que no creamos en
// el schema minimo de tests. Los neutralizamos para enfocar el test en la
// logica de reversion + stock + caja.

vi.mock("../../src-saas/shared/audit/audit-log.js", () => ({
  writeAuditEvent: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/shared/finance/period-closure.js", () => ({
  assertPeriodOpen: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/shared/finance/accounts.js", () => ({
  ensureFinanceModuleEnabled: vi.fn(),
  isCreditSale: vi.fn(() => false),
  resolveCreditDays: vi.fn(() => null),
  resolveDueDate: vi.fn(() => null),
  upsertCuentaPorCobrarFromVenta: vi.fn(async () => {}),
}));

// Mock del pool: el service usa import { pool } from "../../config/db.js".
// Como no podemos cambiar la BD del pool real, este mock devuelve nuestro pool de test.
vi.mock("../../src-saas/config/db.js", () => ({
  pool: getTestPool(),
  applyRequestSettings: vi.fn(async () => {}),
}));

// runInTransaction usa pool y applyRequestSettings; con los mocks anteriores
// ya queda apuntado a nuestro pool de test.

// ---------- import del service real DESPUES de los mocks ----------
const importService = async () =>
  import("../../src-saas/modules/ventas/ventas.service.js");

const describeFn = isLive ? describe : describe.skip;

describeFn("createVentaReversion (G2 - anulacion parcial)", () => {
  let service;
  const auth = {
    id_empresa: 1,
    id_usuario: 1,
    id_sucursal: 1,
    rol: "ADMIN_EMPRESA",
    sucursales: [1],
    modulos: ["POS"],
    permisos: ["sales.refund"],
  };
  const scope = { id_empresa: 1, id_sucursal: 1 };

  beforeAll(async () => {
    await setupTestSchema();
    const pool = getTestPool();
    await setSchemaSearchPath(pool);

    // Tabla comprobante_series ya creada por setupTestSchema (G1).
    await setupSalesSchema();
    await seedBaseTenant();
    await seedCajaSesionAbierta({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
    });

    service = await importService();
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    // Limpiar entre tests
    await pool.query(`truncate venta_reversion_detalles, venta_reversiones, venta_detalles, ventas, movimientos_inventario, caja_movimientos restart identity cascade`);
    // Restaurar stock
    await pool.query(`update stock_sucursal set stock_actual = 100 where id_producto = 1`);
  });

  it("reversion parcial deja estado_reversion = PARCIAL y descuenta solo lo revertido", async () => {
    const { idVenta, idVentaDetalle, subtotal } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    expect(subtotal).toBe(500);

    const result = await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Producto defectuoso",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 2 }],
      },
    });

    expect(result.venta.estado_reversion).toBe("PARCIAL");
    expect(Number(result.venta.monto_revertido)).toBe(200);
    expect(Number(result.venta.total_neto)).toBe(300);

    // Detalle: cantidad_disponible_reversion debe ser 5 - 2 = 3
    const detalle = result.detalles.find(
      (d) => Number(d.id_venta_detalle) === idVentaDetalle
    );
    expect(Number(detalle.cantidad_disponible_reversion)).toBe(3);
  });

  it("multiples reversiones parciales acumulan hasta TOTAL", async () => {
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    // Primera reversion: 2 unidades
    const r1 = await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Devolucion 1",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 2 }],
      },
    });
    expect(r1.venta.estado_reversion).toBe("PARCIAL");
    expect(Number(r1.venta.monto_revertido)).toBe(200);

    // Segunda reversion: 3 unidades restantes
    const r2 = await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Devolucion 2",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 3 }],
      },
    });
    expect(r2.venta.estado_reversion).toBe("TOTAL");
    expect(Number(r2.venta.monto_revertido)).toBe(500);
    expect(Number(r2.venta.total_neto)).toBe(0);
  });

  it("rechaza revertir mas cantidad de la disponible", async () => {
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    await expect(
      service.createVentaReversion({
        auth,
        scope,
        idVenta,
        body: {
          tipo_reversion: "DEVOLUCION",
          metodo_resolucion: "AJUSTE",
          reintegrar_stock: false,
          motivo: "Devolver demasiado",
          items: [{ id_venta_detalle: idVentaDetalle, cantidad: 10 }],
        },
      })
    ).rejects.toThrow(/excede lo disponible/i);
  });

  it("rechaza una segunda reversion que excede el saldo restante", async () => {
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    // Primera: 4 unidades
    await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Primera",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 4 }],
      },
    });

    // Segunda intento: 2 (solo queda 1)
    await expect(
      service.createVentaReversion({
        auth,
        scope,
        idVenta,
        body: {
          tipo_reversion: "DEVOLUCION",
          metodo_resolucion: "AJUSTE",
          reintegrar_stock: false,
          motivo: "Segunda",
          items: [{ id_venta_detalle: idVentaDetalle, cantidad: 2 }],
        },
      })
    ).rejects.toThrow(/excede lo disponible/i);
  });

  it("reintegra stock cuando reintegrar_stock = true", async () => {
    const pool = getTestPool();
    // Stock inicial 100, venta de 5 deja stock 100 (porque seedSampleSale no descuenta).
    // Para el test simulamos un descuento manual antes de revertir:
    await pool.query(`update stock_sucursal set stock_actual = 95 where id_producto = 1`);

    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: true,
        motivo: "Reintegro",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 3 }],
      },
    });

    const stockResult = await pool.query(
      `select stock_actual from stock_sucursal where id_producto = 1`
    );
    expect(Number(stockResult.rows[0].stock_actual)).toBe(98); // 95 + 3

    // Movimiento de inventario tipo ENTRADA
    const movResult = await pool.query(
      `select tipo, referencia_tipo, cantidad from movimientos_inventario where id_producto = 1 order by id_movimiento desc limit 1`
    );
    expect(movResult.rows[0].tipo).toBe("ENTRADA");
    expect(movResult.rows[0].referencia_tipo).toBe("VENTA_REVERSION");
    expect(Number(movResult.rows[0].cantidad)).toBe(3);
  });

  it("NO reintegra stock cuando reintegrar_stock = false", async () => {
    const pool = getTestPool();
    await pool.query(`update stock_sucursal set stock_actual = 95 where id_producto = 1`);

    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Sin reintegro",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 3 }],
      },
    });

    const stockResult = await pool.query(
      `select stock_actual from stock_sucursal where id_producto = 1`
    );
    expect(Number(stockResult.rows[0].stock_actual)).toBe(95); // sin cambio
  });

  it("registra EGRESO en caja_movimientos cuando metodo_resolucion = EFECTIVO", async () => {
    const pool = getTestPool();
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "EFECTIVO",
        reintegrar_stock: false,
        motivo: "Devolver efectivo",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 2 }],
      },
    });

    const cajaResult = await pool.query(
      `select tipo, categoria, monto from caja_movimientos where referencia_tipo = 'VENTA_REVERSION'`
    );
    expect(cajaResult.rows.length).toBe(1);
    expect(cajaResult.rows[0].tipo).toBe("EGRESO");
    expect(cajaResult.rows[0].categoria).toBe("VENTA_DEVOLUCION");
    expect(Number(cajaResult.rows[0].monto)).toBe(200);
  });

  it("NO registra movimiento de caja cuando metodo_resolucion = AJUSTE", async () => {
    const pool = getTestPool();
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "Solo ajuste interno",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 2 }],
      },
    });

    const cajaResult = await pool.query(
      `select count(*)::int as total from caja_movimientos where referencia_tipo = 'VENTA_REVERSION'`
    );
    expect(cajaResult.rows[0].total).toBe(0);
  });

  it("genera numero_documento atomico para cada reversion", async () => {
    const { idVenta, idVentaDetalle } = await seedSampleSale({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
      idProducto: 1,
      cantidad: 5,
      precioUnitario: 100,
    });

    const r1 = await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "1",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 1 }],
      },
    });
    const r2 = await service.createVentaReversion({
      auth,
      scope,
      idVenta,
      body: {
        tipo_reversion: "DEVOLUCION",
        metodo_resolucion: "AJUSTE",
        reintegrar_stock: false,
        motivo: "2",
        items: [{ id_venta_detalle: idVentaDetalle, cantidad: 1 }],
      },
    });

    const docs = r2.reversiones.map((r) => r.numero_documento).sort();
    expect(docs).toHaveLength(2);
    expect(new Set(docs).size).toBe(2);
    expect(docs.every((doc) => /^DVV-\d{8}$/.test(doc))).toBe(true);
  });
});

if (!isLive) {
  // eslint-disable-next-line no-console
  console.warn(`\n[tests] ${SKIP_REASON}\n`);
}
