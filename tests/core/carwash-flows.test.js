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

vi.mock("../../src-saas/modules/membresias/membresias.service.js", () => ({
  consumeMembresia: vi.fn(async () => {}),
  findActiveCoverage: vi.fn(async () => null),
}));

vi.mock("../../src-saas/modules/comisiones/comisiones.service.js", () => ({
  computeAndPersistCommission: vi.fn(async () => null),
}));

vi.mock("../../src-saas/config/db.js", () => ({
  pool: getTestPool(),
  applyRequestSettings: vi.fn(async () => {}),
}));

const importServiciosService = async () =>
  import("../../src-saas/modules/servicios/servicios.service.js");

const importServiciosAdvancedService = async () =>
  import("../../src-saas/modules/servicios/servicios.advanced.service.js");

describeFn("Fase 3 CarWash flows", () => {
  let serviciosService;
  let serviciosAdvancedService;
  const auth = {
    id_empresa: 1,
    id_usuario: 1,
    id_sucursal: 1,
    rol: "ADMIN_EMPRESA",
    sucursales: [1],
    modulos: ["CARWASH", "INVENTARIO", "CAJA"],
    permisos: [
      "services.read",
      "services.manage",
      "services.refund",
      "services.reports.read",
    ],
  };
  const scope = { id_empresa: 1, id_sucursal: 1 };

  beforeAll(async () => {
    await setupTestSchema();
    await setupSalesSchema();
    serviciosService = await importServiciosService();
    serviciosAdvancedService = await importServiciosAdvancedService();
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `truncate
        ordenes_servicio_reversiones,
        ordenes_servicio_checklist,
        servicios_checklist_templates,
        ordenes_servicio_tecnicos,
        servicios_tecnicos,
        ordenes_servicio_productos,
        ordenes_servicio,
        servicios_catalogo,
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
        usuarios_sucursales,
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
    await pool.query(
      `insert into usuarios (id_usuario, id_empresa, username, nombre, apellido)
       values (2, 1, 'tecnico1', 'Tecnico', 'Uno')`
    );
    await pool.query(
      `insert into usuarios_sucursales (id_empresa, id_usuario, id_sucursal)
       values (1, 2, 1)`
    );
    await pool.query(`select setval(pg_get_serial_sequence('usuarios', 'id_usuario'), 2, true)`);
  });

  it("crea, programa, ejecuta, cobra y reporta una orden CarWash con consumo de productos", async () => {
    const pool = getTestPool();
    await pool.query(
      `insert into clientes (id_cliente, id_empresa, nombre, telefono)
       values (1, 1, 'Cliente CarWash', '5555-0000')`
    );

    const servicio = await serviciosService.createCatalogItem({
      auth,
      scope,
      body: {
        modulo: "CARWASH",
        codigo: "LAVADO-BASICO",
        nombre: "Lavado basico",
        precio_base: 80,
        duracion_minutos: 45,
      },
    });

    await serviciosAdvancedService.createChecklistTemplate({
      auth,
      scope,
      body: {
        id_servicio_catalogo: servicio.id_servicio_catalogo,
        titulo: "Revision exterior",
        obligatorio: true,
      },
    });

    await serviciosAdvancedService.upsertTechnician({
      auth,
      scope,
      idUsuario: 2,
      body: {
        alias: "Tecnico 1",
        especialidades: ["Lavado"],
        activo: true,
      },
    });

    const created = await serviciosService.createOrder({
      auth,
      scope,
      body: {
        id_servicio_catalogo: servicio.id_servicio_catalogo,
        id_cliente: 1,
        placa: "P123ABC",
        vehiculo_tipo: "SEDAN",
        marca: "Toyota",
        modelo: "Corolla",
        precio_servicio: 80,
        productos: [
          {
            id_producto: 1,
            cantidad: 2,
            precio_unitario: 15,
            cobra_al_cliente: true,
          },
        ],
      },
    });

    expect(created.orden.modulo).toBe("CARWASH");
    expect(created.orden.total).toBe(110);
    expect(created.productos).toHaveLength(1);

    const stockAfterConsumption = await pool.query(
      `select id_bodega, stock_actual from stock_sucursal where id_producto = 1`
    );
    expect(Number(stockAfterConsumption.rows[0].id_bodega)).toBe(1);
    expect(Number(stockAfterConsumption.rows[0].stock_actual)).toBe(98);

    const movement = await pool.query(
      `select id_bodega, tipo, referencia_tipo, cantidad, stock_antes, stock_despues
       from movimientos_inventario
       where referencia_tipo = 'ORDEN_SERVICIO'`
    );
    expect(movement.rows[0]).toMatchObject({
      tipo: "SALIDA",
      referencia_tipo: "ORDEN_SERVICIO",
    });
    expect(Number(movement.rows[0].id_bodega)).toBe(1);
    expect(Number(movement.rows[0].cantidad)).toBe(2);
    expect(Number(movement.rows[0].stock_antes)).toBe(100);
    expect(Number(movement.rows[0].stock_despues)).toBe(98);

    const scheduled = await serviciosAdvancedService.scheduleOrder({
      auth,
      scope,
      idOrdenServicio: created.orden.id_orden_servicio,
      body: {
        fecha_programada_inicio: "2026-05-26T09:00:00.000Z",
        fecha_programada_fin: "2026-05-26T10:00:00.000Z",
        tecnico_ids: [2],
        id_tecnico_principal: 2,
        prioridad: "NORMAL",
      },
    });
    expect(scheduled.orden.agenda_estado).toBe("PROGRAMADA");
    expect(scheduled.tecnicos).toHaveLength(1);
    expect(Number(scheduled.tecnicos[0].id_usuario)).toBe(2);

    const checklistId = Number(scheduled.checklist[0].id_orden_servicio_checklist);
    const checked = await serviciosAdvancedService.updateChecklistItem({
      auth,
      scope,
      idOrdenServicio: created.orden.id_orden_servicio,
      idChecklistItem: checklistId,
      body: {
        estado: "CUMPLIDO",
        observacion: "Sin novedades",
      },
    });
    expect(checked.checklist[0].estado).toBe("CUMPLIDO");

    const inProcess = await serviciosService.updateOrderTracking({
      auth,
      scope,
      idOrdenServicio: created.orden.id_orden_servicio,
      body: { estado: "EN_PROCESO" },
    });
    expect(inProcess.orden.estado).toBe("EN_PROCESO");

    const ready = await serviciosService.updateOrderTracking({
      auth,
      scope,
      idOrdenServicio: created.orden.id_orden_servicio,
      body: { estado: "LISTO" },
    });
    expect(ready.orden.estado).toBe("LISTO");

    const charged = await serviciosService.chargeOrder({
      auth,
      scope,
      idOrdenServicio: created.orden.id_orden_servicio,
      body: {
        metodo_pago: "EFECTIVO",
        monto_recibido: 150,
      },
    });
    expect(charged.orden.estado_cobro).toBe("COBRADO");
    expect(charged.orden.cambio).toBe(40);

    const caja = await pool.query(
      `select tipo, categoria, monto from caja_movimientos where referencia_tipo = 'ORDEN_SERVICIO'`
    );
    expect(caja.rows[0]).toMatchObject({
      tipo: "INGRESO",
      categoria: "SERVICIO_EFECTIVO",
    });
    expect(Number(caja.rows[0].monto)).toBe(110);

    const todayStr = new Date().toISOString().split("T")[0];
    const report = await serviciosAdvancedService.getServiceOperationsReport({
      auth,
      scope,
      query: {
        modulo: "CARWASH",
        desde: todayStr,
        hasta: todayStr,
      },
    });
    expect(report.resumen.ordenes_total).toBe(1);
    expect(report.resumen.ordenes_cobradas).toBe(1);
    expect(report.resumen.total_facturado).toBe(110);
    expect(report.top_tecnicos[0]).toMatchObject({
      username: "tecnico1",
      ordenes_asignadas: 1,
    });
  });
});
