import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { aplicarPromociones } from "./engine.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

// ============================================================
// CRUD
// ============================================================
export const list = async ({ auth, query }) => {
  const filters = ["id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.activa !== undefined && query.activa !== "") {
    filters.push(`activa = $${i}`);
    params.push(["true", "1", "si", "yes"].includes(String(query.activa).toLowerCase()));
    i += 1;
  }

  const result = await pool.query(
    `select * from promociones where ${filters.join(" and ")} order by activa desc, prioridad asc, nombre asc`,
    params
  );
  return result.rows;
};

export const create = async ({ auth, scope, body, requestMeta }) => {
  const tipo = String(body?.tipo || "").toUpperCase();
  if (!["PORCENTAJE_VENTA", "MONTO_VENTA", "PORCENTAJE_LINEA", "NX_M", "CUPON"].includes(tipo)) {
    throw HttpError.badRequest("tipo invalido");
  }
  const nombre = String(body?.nombre || "").trim();
  if (!nombre) throw HttpError.badRequest("nombre es requerido");

  const valor = Number(body?.valor || 0);
  if (tipo.startsWith("PORCENTAJE") && (valor < 0 || valor > 100)) {
    throw HttpError.badRequest("valor de porcentaje debe estar entre 0 y 100");
  }

  const insert = await pool.query(
    `
      insert into promociones (
        id_empresa, codigo, nombre, descripcion, tipo, valor,
        nx_n, nx_m, productos_elegibles, monto_minimo,
        vigente_desde, vigente_hasta, dias_semana, horario_desde, horario_hasta,
        usos_max_total, usos_max_por_cliente, prioridad, combinable, activa,
        created_by, updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14::time,$15::time,$16,$17,$18,$19,$20,$21,$21)
      returning *
    `,
    [
      auth.id_empresa,
      body?.codigo ? String(body.codigo).toUpperCase() : null,
      nombre,
      body?.descripcion || null,
      tipo,
      valor,
      body?.nx_n || null,
      body?.nx_m || null,
      JSON.stringify(body?.productos_elegibles || null),
      Number(body?.monto_minimo || 0),
      body?.vigente_desde || null,
      body?.vigente_hasta || null,
      body?.dias_semana ? JSON.stringify(body.dias_semana) : null,
      body?.horario_desde || null,
      body?.horario_hasta || null,
      body?.usos_max_total || null,
      body?.usos_max_por_cliente || null,
      Number(body?.prioridad ?? 100),
      body?.combinable === true,
      body?.activa !== false,
      auth.id_usuario,
    ]
  );

  const created = insert.rows[0];

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "PROMOCIONES",
    entidad: "PROMOCION",
    entidadId: created.id_promocion,
    accion: "CREATE",
    despues: created,
  });

  return created;
};

// ============================================================
// Aplicacion durante venta
// ============================================================

/**
 * Carga las promociones automaticas activas + valida (si viene) un codigo
 * de cupon. Aplica el motor y devuelve el breakdown.
 *
 * @param {{idEmpresa:number, items:Array, idCliente?:number|null, cupon?:string|null}} params
 */
export const resolveActivePromotions = async ({
  idEmpresa,
  items,
  idCliente = null,
  cupon = null,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { descuento_total: 0, aplicadas: [] };
  }

  // Promociones automaticas (sin codigo)
  const automaticasResult = await pool.query(
    `select * from promociones
     where id_empresa = $1
       and activa = true
       and codigo is null
     order by prioridad asc`,
    [idEmpresa]
  );
  const candidates = [...automaticasResult.rows];

  // Cupon especifico, si fue ingresado
  if (cupon) {
    const cuponResult = await pool.query(
      `select * from promociones
       where id_empresa = $1 and codigo = $2 and activa = true`,
      [idEmpresa, String(cupon).toUpperCase()]
    );
    if (cuponResult.rowCount === 0) {
      throw HttpError.badRequest(`Cupon "${cupon}" invalido o no aplicable`);
    }
    candidates.push(cuponResult.rows[0]);
  }

  // Filtro: respetar limite global y por cliente
  const filtradas = [];
  for (const promo of candidates) {
    if (promo.usos_max_total) {
      const r = await pool.query(
        `select count(*)::int as n from promociones_uso where id_empresa = $1 and id_promocion = $2`,
        [idEmpresa, promo.id_promocion]
      );
      if (Number(r.rows[0].n) >= Number(promo.usos_max_total)) {
        if (cupon && promo.codigo === String(cupon).toUpperCase()) {
          throw HttpError.badRequest(`Cupon "${cupon}" agotado`);
        }
        continue;
      }
    }
    if (promo.usos_max_por_cliente && idCliente) {
      const r = await pool.query(
        `select count(*)::int as n from promociones_uso
         where id_empresa = $1 and id_promocion = $2 and id_cliente = $3`,
        [idEmpresa, promo.id_promocion, idCliente]
      );
      if (Number(r.rows[0].n) >= Number(promo.usos_max_por_cliente)) {
        if (cupon && promo.codigo === String(cupon).toUpperCase()) {
          throw HttpError.badRequest(
            `Ya alcanzaste el limite de uso del cupon "${cupon}"`
          );
        }
        continue;
      }
    }
    filtradas.push(promo);
  }

  return aplicarPromociones(filtradas, { items });
};

/**
 * Registra el uso de cada promocion aplicada en una venta.
 * Idempotente por (id_empresa, id_venta) — si la venta ya tiene usos
 * registrados, no duplica.
 */
export const registerPromotionUses = async (
  client,
  { idEmpresa, idVenta, idCliente, aplicadas }
) => {
  if (!Array.isArray(aplicadas) || aplicadas.length === 0) return;

  for (const a of aplicadas) {
    await client.query(
      `
        insert into promociones_uso (
          id_empresa, id_promocion, id_venta, id_cliente, monto_descontado, detalle
        )
        values ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        idEmpresa,
        a.id_promocion,
        idVenta,
        idCliente,
        round2(a.monto_descontado),
        JSON.stringify(a),
      ]
    );
  }
};
