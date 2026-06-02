/**
 * withTenantDb middleware
 * ============================================================
 * Adquiere un client Postgres del pool, setea los GUCs de sesion
 * (`app.current_empresa_id`, `app.current_sucursal_id`, `app.current_usuario_id`,
 *  `app.current_rol`) y lo expone como `req.db`.
 *
 * Las queries hechas con `req.db` quedan sujetas a las policies RLS porque
 * los GUCs estan presentes en la conexion.
 *
 * IMPORTANTE: este middleware NO abre transaccion. Asi convive con
 * `runInTransaction()` (que abre su propia tx con su propio client) sin
 * generar "nested transactions". Cada client del pool tiene su propio
 * estado de sesion, asi que el contexto GUC no se mezcla.
 *
 * Reset: antes de devolver el client al pool, llamamos RESET a cada GUC
 * para que el siguiente request que reuse este client no herede contexto
 * del anterior.
 *
 * USO:
 *   router.get("/algo", authenticate, withTenantDb, async (req, res) => {
 *     const r = await req.db.query("select * from ventas");
 *     res.json({ data: r.rows });
 *   });
 */
import { pool } from "../config/db.js";
import { logger } from "../shared/logging/logger.js";

const GUC_NAMES = [
  "app.current_empresa_id",
  "app.current_sucursal_id",
  "app.current_usuario_id",
  "app.current_rol",
];

export const withTenantDb = async (req, res, next) => {
  let client;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    try {
      // RESET ALL es caro; resetear solo los que nosotros seteamos
      for (const name of GUC_NAMES) {
        try {
          await client.query(`reset ${name}`);
        } catch {
          /* noop */
        }
      }
    } catch (err) {
      logger.debug(
        { err: err.message, reqId: req?.id },
        "withTenantDb: error reseteando GUCs"
      );
    } finally {
      try {
        client.release();
      } catch {
        /* noop */
      }
    }
  };

  try {
    client = await pool.connect();

    if (req.auth) {
      const settings = [
        ["app.current_empresa_id", req.auth.id_empresa || ""],
        ["app.current_sucursal_id", req.auth.id_sucursal || ""],
        ["app.current_usuario_id", req.auth.id_usuario || ""],
        ["app.current_rol", req.auth.rol || ""],
      ];
      for (const [key, value] of settings) {
        // set_config(name, value, is_local=false) → setting de SESION
        // (sobrevive a transacciones internas, reseteado manualmente al release)
        await client.query("select set_config($1, $2, false)", [
          key,
          String(value),
        ]);
      }
    }

    req.db = client;
    req.tenantDbContext = true;

    res.on("finish", () => {
      void release();
    });
    res.on("close", () => {
      if (!released) void release();
    });

    next();
  } catch (err) {
    if (client && !released) {
      released = true;
      try {
        // Marcar client como dirty para que el pool lo descarte (no reusa)
        client.release(err);
      } catch {
        /* noop */
      }
    }
    next(err);
  }
};

/**
 * Helper para usar el mismo patron fuera de Express (workers, jobs).
 * Sigue usando transaccion porque el caller controla el lifecycle del client.
 *
 *   await withTenantClient(auth, async (client) => {
 *     return client.query("select * from ventas where id = $1", [42]);
 *   });
 */
export const withTenantClient = async (auth, work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (auth) {
      const settings = [
        ["app.current_empresa_id", auth.id_empresa],
        ["app.current_sucursal_id", auth.id_sucursal],
        ["app.current_usuario_id", auth.id_usuario],
        ["app.current_rol", auth.rol],
      ];
      for (const [key, value] of settings) {
        if (value === undefined || value === null || value === "") continue;
        await client.query("select set_config($1, $2, true)", [
          key,
          String(value),
        ]);
      }
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* noop */
    }
    throw err;
  } finally {
    client.release();
  }
};
