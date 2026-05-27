/**
 * Tests de integracion para G3: validacion admin de no-cobrados y movimientos
 * pendientes antes de cerrar caja.
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
  seedAdminUser,
  seedBaseTenant,
  seedCajaSesionAbierta,
  setupSalesSchema,
} from "../setup/sales-schema.js";

const isLive = Boolean(process.env.PGDATABASE);
const SKIP_REASON =
  "Saltado: PGDATABASE no definido. Crea un .env.test para correr estos tests.";

vi.mock("../../src-saas/shared/audit/audit-log.js", () => ({
  writeAuditEvent: vi.fn(async () => {}),
}));

vi.mock("../../src-saas/config/db.js", () => ({
  pool: getTestPool(),
  applyRequestSettings: vi.fn(async () => {}),
}));

const importCaja = async () =>
  import("../../src-saas/modules/caja/caja.service.js");

const describeFn = isLive ? describe : describe.skip;

describeFn("G3 - validacion admin de pendientes antes de cerrar caja", () => {
  let cajaService;
  let admin;
  let idCajaSesion;

  const cajeroAuth = {
    id_empresa: 1,
    id_usuario: 1,
    id_sucursal: 1,
    rol: "CAJERO",
    sucursales: [1],
    modulos: ["POS"],
    permisos: ["cash.manage"],
  };

  beforeAll(async () => {
    await setupTestSchema();
    const pool = getTestPool();
    await setSchemaSearchPath(pool);

    await setupSalesSchema();
    await seedBaseTenant();
    admin = await seedAdminUser({
      username: "admin1",
      password: "Admin1234!",
      idEmpresa: 1,
    });

    cajaService = await importCaja();
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  beforeEach(async () => {
    const pool = getTestPool();
    await pool.query(
      `truncate caja_movimientos, caja_sesiones, ventas restart identity cascade`
    );
    idCajaSesion = await seedCajaSesionAbierta({
      idEmpresa: 1,
      idSucursal: 1,
      idUsuario: 1,
    });
  });

  it("createCajaMovimiento sin admin auth deja el movimiento PENDIENTE", async () => {
    await cajaService.createCajaMovimiento({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      body: {
        tipo: "EGRESO",
        categoria: "COMPRAS_MENORES",
        monto: 50,
        descripcion: "Compra urgente",
      },
    });

    const pool = getTestPool();
    const result = await pool.query(
      `select autorizado_por_admin_id from caja_movimientos where id_caja_sesion = $1`,
      [idCajaSesion]
    );
    expect(result.rows[0].autorizado_por_admin_id).toBeNull();
  });

  it("createCajaMovimiento con admin password queda autorizado al instante", async () => {
    await cajaService.createCajaMovimiento({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      body: {
        tipo: "EGRESO",
        categoria: "COMPRAS_MENORES",
        monto: 50,
        descripcion: "Compra urgente",
        admin_username: admin.username,
        admin_password: admin.password,
        autorizacion_admin_nota: "Autorizado en el momento",
      },
    });

    const pool = getTestPool();
    const result = await pool.query(
      `select autorizado_por_admin_id, autorizacion_admin_nota from caja_movimientos where id_caja_sesion = $1`,
      [idCajaSesion]
    );
    expect(Number(result.rows[0].autorizado_por_admin_id)).toBe(admin.idUsuario);
    expect(result.rows[0].autorizacion_admin_nota).toBe("Autorizado en el momento");
  });

  it("closeCaja rechaza si hay movimientos manuales pendientes", async () => {
    await cajaService.createCajaMovimiento({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      body: {
        tipo: "EGRESO",
        categoria: "VIATICOS",
        monto: 25,
      },
    });

    await expect(
      cajaService.closeCaja({
        auth: cajeroAuth,
        idCajaSesion,
        body: {
          monto_cierre_reportado: 0,
          admin_username: admin.username,
          admin_password: admin.password,
        },
      })
    ).rejects.toThrow(/movimiento\(s\) manual\(es\) sin validar/i);
  });

  it("closeCaja rechaza si hay ventas NO_COBRADO sin validar", async () => {
    const pool = getTestPool();
    await pool.query(
      `
        insert into ventas (
          id_empresa, id_sucursal, id_usuario, id_caja_sesion,
          numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago,
          estado, total, no_cobrado_motivo, no_cobrado_autorizado_por,
          no_cobrado_autorizado_en
        )
        values (1, 1, 1, $1, 'TKT-1', 'TICKET', 'CONTADO', 'NO_COBRADO',
                'NO_COBRADO', 100, 'Cliente sin pagar', $2, now())
      `,
      [idCajaSesion, admin.idUsuario]
    );

    await expect(
      cajaService.closeCaja({
        auth: cajeroAuth,
        idCajaSesion,
        body: {
          monto_cierre_reportado: 0,
          admin_username: admin.username,
          admin_password: admin.password,
        },
      })
    ).rejects.toThrow(/NO_COBRADO sin validar/i);
  });

  it("validateCajaMovimientoPendiente requiere credenciales validas", async () => {
    await cajaService.createCajaMovimiento({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      body: { tipo: "EGRESO", categoria: "VIATICOS", monto: 25 },
    });

    const pool = getTestPool();
    const movResult = await pool.query(
      `select id_caja_movimiento from caja_movimientos where id_caja_sesion = $1`,
      [idCajaSesion]
    );
    const idMov = Number(movResult.rows[0].id_caja_movimiento);

    // Password invalido
    await expect(
      cajaService.validateCajaMovimientoPendiente({
        auth: cajeroAuth,
        scope: { id_empresa: 1, id_sucursal: 1 },
        idCajaSesion,
        idCajaMovimiento: idMov,
        body: {
          admin_username: admin.username,
          admin_password: "wrongpassword",
        },
      })
    ).rejects.toThrow(/Credenciales administrativas invalidas/i);

    // Password valido -> queda validado
    await cajaService.validateCajaMovimientoPendiente({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      idCajaMovimiento: idMov,
      body: {
        admin_username: admin.username,
        admin_password: admin.password,
        autorizacion_admin_nota: "Visto bueno",
      },
    });

    const after = await pool.query(
      `select autorizado_por_admin_id, autorizacion_admin_nota from caja_movimientos where id_caja_movimiento = $1`,
      [idMov]
    );
    expect(Number(after.rows[0].autorizado_por_admin_id)).toBe(admin.idUsuario);
    expect(after.rows[0].autorizacion_admin_nota).toBe("Visto bueno");
  });

  it("validateNoCobroPendiente marca la venta y permite cerrar caja", async () => {
    const pool = getTestPool();
    const ventaResult = await pool.query(
      `
        insert into ventas (
          id_empresa, id_sucursal, id_usuario, id_caja_sesion,
          numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago,
          estado, total, no_cobrado_motivo, no_cobrado_autorizado_por,
          no_cobrado_autorizado_en
        )
        values (1, 1, 1, $1, 'TKT-2', 'TICKET', 'CONTADO', 'NO_COBRADO',
                'NO_COBRADO', 80, 'Olvido billetera', $2, now())
        returning id_venta
      `,
      [idCajaSesion, admin.idUsuario]
    );
    const idVenta = Number(ventaResult.rows[0].id_venta);

    await cajaService.validateNoCobroPendiente({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      idVenta,
      body: {
        admin_username: admin.username,
        admin_password: admin.password,
        validacion_nota: "Confirmado por admin",
      },
    });

    const validatedRow = await pool.query(
      `select no_cobrado_validado_por, no_cobrado_validado_en, no_cobrado_validacion_nota from ventas where id_venta = $1`,
      [idVenta]
    );
    expect(Number(validatedRow.rows[0].no_cobrado_validado_por)).toBe(admin.idUsuario);
    expect(validatedRow.rows[0].no_cobrado_validado_en).not.toBeNull();
    expect(validatedRow.rows[0].no_cobrado_validacion_nota).toBe("Confirmado por admin");

    // Ahora se puede cerrar caja (sin diferencia, sin pendientes).
    const closed = await cajaService.closeCaja({
      auth: cajeroAuth,
      idCajaSesion,
      body: { monto_cierre_reportado: 0 },
    });

    expect(closed.sesion.estado).toBe("CERRADA");
  });

  it("getCajaResumen expone los conteos de pendientes", async () => {
    await cajaService.createCajaMovimiento({
      auth: cajeroAuth,
      scope: { id_empresa: 1, id_sucursal: 1 },
      idCajaSesion,
      body: { tipo: "EGRESO", categoria: "VIATICOS", monto: 30 },
    });

    const pool = getTestPool();
    await pool.query(
      `
        insert into ventas (
          id_empresa, id_sucursal, id_usuario, id_caja_sesion,
          numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago,
          estado, total, no_cobrado_motivo, no_cobrado_autorizado_por, no_cobrado_autorizado_en
        )
        values (1, 1, 1, $1, 'TKT-3', 'TICKET', 'CONTADO', 'NO_COBRADO',
                'NO_COBRADO', 60, 'Sin efectivo', $2, now())
      `,
      [idCajaSesion, admin.idUsuario]
    );

    const summary = await cajaService.getCajaResumen({
      auth: cajeroAuth,
      idCajaSesion,
    });

    expect(summary.resumen.movimientos_pendientes_validacion_count).toBe(1);
    expect(summary.resumen.no_cobrados_pendientes_count).toBe(1);
    expect(summary.resumen.no_cobrados_pendientes).toHaveLength(1);
    expect(summary.resumen.no_cobrados_pendientes[0].numero_comprobante).toBe(
      "TKT-3"
    );
  });
});

if (!isLive) {
  // eslint-disable-next-line no-console
  console.warn(`\n[tests] ${SKIP_REASON}\n`);
}
