import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";

const round8 = (n) => Number(Number(n || 0).toFixed(8));

/**
 * Lista el catalogo global de monedas activas.
 */
export const listMonedas = async () => {
  const result = await pool.query(
    `select codigo, nombre, simbolo, decimales, activa from monedas where activa = true order by codigo asc`
  );
  return result.rows;
};

/**
 * Devuelve la moneda base configurada para la empresa.
 */
export const getMonedaBase = async ({ idEmpresa }) => {
  const result = await pool.query(
    `select moneda_base from empresas where id_empresa = $1`,
    [idEmpresa]
  );
  return result.rows[0]?.moneda_base || "GTQ";
};

/**
 * Lista los tipos de cambio registrados, opcionalmente filtrando por moneda
 * o rango de fechas.
 */
export const listTiposCambio = async ({ auth, query }) => {
  const filters = ["tc.id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.moneda_origen) {
    filters.push(`tc.moneda_origen = $${i}`);
    params.push(String(query.moneda_origen).toUpperCase());
    i += 1;
  }

  if (query?.desde) {
    filters.push(`tc.fecha >= $${i}::date`);
    params.push(query.desde);
    i += 1;
  }

  if (query?.hasta) {
    filters.push(`tc.fecha <= $${i}::date`);
    params.push(query.hasta);
    i += 1;
  }

  const result = await pool.query(
    `
      select tc.*
      from tipos_cambio tc
      where ${filters.join(" and ")}
      order by tc.fecha desc, tc.created_at desc
      limit 200
    `,
    params
  );

  return result.rows.map((row) => ({
    ...row,
    tasa: round8(row.tasa),
  }));
};

/**
 * Devuelve la tasa vigente (mas reciente <= fecha) para convertir
 * `monedaOrigen` a la moneda base de la empresa. Si origen == base, devuelve 1.
 */
export const getTasaVigente = async ({
  idEmpresa,
  monedaOrigen,
  fecha = null,
}) => {
  const monedaBase = await getMonedaBase({ idEmpresa });
  const origen = String(monedaOrigen || monedaBase).toUpperCase();

  if (origen === monedaBase) return 1;

  const fechaParam = fecha
    ? new Date(fecha).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const result = await pool.query(
    `
      select tasa
      from tipos_cambio
      where id_empresa = $1
        and moneda_origen = $2
        and moneda_destino = $3
        and fecha <= $4::date
      order by fecha desc
      limit 1
    `,
    [idEmpresa, origen, monedaBase, fechaParam]
  );

  const row = result.rows[0];
  if (!row) {
    throw HttpError.badRequest(
      `No hay tipo de cambio configurado para ${origen} -> ${monedaBase} en o antes de ${fechaParam}`
    );
  }

  return round8(row.tasa);
};

/**
 * Registra un nuevo tipo de cambio.
 */
export const createTipoCambio = async ({ auth, scope, body, requestMeta }) => {
  const monedaBase = await getMonedaBase({ idEmpresa: auth.id_empresa });
  const monedaOrigen = String(body?.moneda_origen || "").toUpperCase().trim();
  const monedaDestino = String(body?.moneda_destino || monedaBase)
    .toUpperCase()
    .trim();
  const fecha = String(body?.fecha || new Date().toISOString().slice(0, 10)).trim();
  const tasa = Number(body?.tasa);

  if (!monedaOrigen) {
    throw HttpError.badRequest("moneda_origen es requerido");
  }
  if (monedaOrigen === monedaDestino) {
    throw HttpError.badRequest(
      "moneda_origen y moneda_destino no pueden ser iguales"
    );
  }
  if (!Number.isFinite(tasa) || tasa <= 0) {
    throw HttpError.badRequest("tasa debe ser un numero positivo");
  }

  const result = await pool.query(
    `
      insert into tipos_cambio (
        id_empresa, moneda_origen, moneda_destino, tasa, fecha, fuente, created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $7)
      on conflict (id_empresa, moneda_origen, moneda_destino, fecha)
      do update set tasa = excluded.tasa, fuente = excluded.fuente, updated_by = excluded.updated_by
      returning *
    `,
    [
      auth.id_empresa,
      monedaOrigen,
      monedaDestino,
      round8(tasa),
      fecha,
      body?.fuente || "manual",
      auth.id_usuario,
    ]
  );

  const created = { ...result.rows[0], tasa: round8(result.rows[0].tasa) };

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "MONEDAS",
    entidad: "TIPO_CAMBIO",
    entidadId: created.id_tipo_cambio,
    accion: "UPSERT",
    despues: created,
  });

  return created;
};
