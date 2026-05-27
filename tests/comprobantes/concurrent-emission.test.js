/**
 * Pruebas de concurrencia para la emision atomica de comprobantes.
 *
 * Para correr:
 *   1) Crear .env.test con PGHOST, PGPORT, PGDATABASE (vacia), PGUSER, PGPASSWORD.
 *   2) npm install
 *   3) npm test
 *
 * Estas pruebas requieren un Postgres real porque el bloqueo `FOR UPDATE`
 * solo se puede validar con MVCC verdadero.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getTestPool,
  setSchemaSearchPath,
  setupTestSchema,
  teardownTestSchema,
} from "../setup/test-schema.js";
import { emitirComprobante } from "../../src-saas/shared/comprobantes/comprobante-series.js";

const SKIP_REASON =
  "Saltado: PGDATABASE no definido. Crea un .env.test para correr estos tests.";

const isLive = Boolean(process.env.PGDATABASE);

const describeFn = isLive ? describe : describe.skip;

describeFn("emitirComprobante (concurrencia atomica)", () => {
  beforeAll(async () => {
    await setupTestSchema();
    const pool = getTestPool();
    await setSchemaSearchPath(pool);
  });

  afterAll(async () => {
    await teardownTestSchema();
  });

  /**
   * Helper que abre una transaccion, fija el search_path al schema de test,
   * llama a emitirComprobante y commitea.
   */
  const emitirEnTransaccion = async (params) => {
    const pool = getTestPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await setSchemaSearchPath(client);

      const result = await emitirComprobante(client, params);

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("emite un comprobante VENTA/TICKET con formato SERIE-XXXXXXXX", async () => {
    const result = await emitirEnTransaccion({
      idEmpresa: 1,
      idSucursal: 1,
      modulo: "VENTA",
      tipoComprobante: "TICKET",
    });

    expect(result.modulo).toBe("VENTA");
    expect(result.tipo_comprobante).toBe("TICKET");
    expect(result.serie).toBe("TKT");
    expect(result.correlativo).toBe(1);
    expect(result.numero_comprobante).toBe("TKT-00000001");
  });

  it("incrementa correlativos secuencialmente cuando se llama serial", async () => {
    const correlativos = [];

    for (let i = 0; i < 5; i += 1) {
      const result = await emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 1,
        modulo: "VENTA",
        tipoComprobante: "FACTURA",
      });
      correlativos.push(result.correlativo);
    }

    // Esperamos 1, 2, 3, 4, 5 (porque la serie FACTURA es nueva en este test).
    expect(correlativos).toEqual([1, 2, 3, 4, 5]);
  });

  it("nunca devuelve dos veces el mismo correlativo bajo concurrencia (50 emisiones paralelas)", async () => {
    const N = 50;
    const promises = Array.from({ length: N }, () =>
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 1,
        modulo: "VENTA",
        tipoComprobante: "CCF",
      })
    );

    const results = await Promise.all(promises);
    const correlativos = results.map((r) => r.correlativo).sort((a, b) => a - b);

    // Sin huecos ni duplicados: 1..N
    const expected = Array.from({ length: N }, (_, i) => i + 1);
    expect(correlativos).toEqual(expected);

    // Numeros formateados unicos.
    const numeros = new Set(results.map((r) => r.numero_comprobante));
    expect(numeros.size).toBe(N);
  });

  it("aisla correlativos por sucursal (misma empresa, distintas sucursales)", async () => {
    const [s1a, s2a, s1b] = await Promise.all([
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 100,
        modulo: "VENTA",
        tipoComprobante: "TICKET",
      }),
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 200,
        modulo: "VENTA",
        tipoComprobante: "TICKET",
      }),
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 100,
        modulo: "VENTA",
        tipoComprobante: "TICKET",
      }),
    ]);

    expect(s1a.correlativo).toBe(1);
    expect(s2a.correlativo).toBe(1);
    expect(s1b.correlativo).toBe(2);
  });

  it("aisla correlativos por empresa", async () => {
    const [e1, e2] = await Promise.all([
      emitirEnTransaccion({
        idEmpresa: 999,
        idSucursal: 1,
        modulo: "VENTA",
        tipoComprobante: "TICKET",
      }),
      emitirEnTransaccion({
        idEmpresa: 1000,
        idSucursal: 1,
        modulo: "VENTA",
        tipoComprobante: "TICKET",
      }),
    ]);

    expect(e1.correlativo).toBe(1);
    expect(e2.correlativo).toBe(1);
  });

  it("lanza 400 si el modulo no es valido", async () => {
    await expect(
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 1,
        modulo: "MODULO_INVENTADO",
        tipoComprobante: "TICKET",
      })
    ).rejects.toThrow(/Modulo de comprobante no soportado/);
  });

  it("lanza 400 si el tipo no es valido para el modulo", async () => {
    await expect(
      emitirEnTransaccion({
        idEmpresa: 1,
        idSucursal: 1,
        modulo: "VENTA",
        tipoComprobante: "ORDEN_SERVICIO",
      })
    ).rejects.toThrow(/Tipo de comprobante no soportado/);
  });

  it("emite ORDEN_SERVICIO para SERVICIOS y CARWASH con series distintas", async () => {
    const [srv, cwa] = await Promise.all([
      emitirEnTransaccion({
        idEmpresa: 2,
        idSucursal: 1,
        modulo: "SERVICIOS",
        tipoComprobante: "ORDEN_SERVICIO",
      }),
      emitirEnTransaccion({
        idEmpresa: 2,
        idSucursal: 1,
        modulo: "CARWASH",
        tipoComprobante: "ORDEN_SERVICIO",
      }),
    ]);

    expect(srv.serie).toBe("SRV");
    expect(cwa.serie).toBe("CWA");
    expect(srv.correlativo).toBe(1);
    expect(cwa.correlativo).toBe(1);
  });
});

if (!isLive) {
  // eslint-disable-next-line no-console
  console.warn(`\n[tests] ${SKIP_REASON}\n`);
}
