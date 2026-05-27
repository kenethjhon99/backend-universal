import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { logger } from "../../shared/logging/logger.js";
import * as stubProvider from "./providers/stub.js";
import * as felGtProvider from "./providers/fel-gt.js";

const PROVIDERS = {
  STUB: stubProvider,
  FEL_GT: felGtProvider,
};

/**
 * Resuelve el adapter del provider configurado para la empresa.
 */
const getProvider = async (idEmpresa) => {
  const result = await pool.query(
    `select fe_proveedor, fe_config, fe_activa from empresas where id_empresa = $1`,
    [idEmpresa]
  );
  const row = result.rows[0];
  if (!row || !row.fe_activa) {
    return null;
  }
  const provider = PROVIDERS[String(row.fe_proveedor || "").toUpperCase()];
  if (!provider) {
    throw HttpError.badRequest(
      `Proveedor de facturacion electronica "${row.fe_proveedor}" no soportado`
    );
  }
  return { provider, config: row.fe_config || {}, codigo: row.fe_proveedor };
};

/**
 * Carga el detalle completo de la venta (necesario para construir el DTE).
 */
const loadVentaCompleta = async (idEmpresa, idVenta) => {
  const ventaResult = await pool.query(
    `
      select v.*, c.nombre as cliente_nombre, c.nit as cliente_nit
      from ventas v
      left join clientes c on c.id_empresa = v.id_empresa and c.id_cliente = v.id_cliente
      where v.id_empresa = $1 and v.id_venta = $2
    `,
    [idEmpresa, idVenta]
  );
  const venta = ventaResult.rows[0];
  if (!venta) throw HttpError.notFound("Venta no encontrada");

  const detallesResult = await pool.query(
    `
      select vd.*, p.nombre as producto_nombre, p.sku
      from venta_detalles vd
      inner join productos p on p.id_empresa = vd.id_empresa and p.id_producto = vd.id_producto
      where vd.id_empresa = $1 and vd.id_venta = $2
      order by vd.id_venta_detalle asc
    `,
    [idEmpresa, idVenta]
  );

  return {
    venta,
    cliente: { nombre: venta.cliente_nombre, nit: venta.cliente_nit },
    detalles: detallesResult.rows,
  };
};

/**
 * Certifica una venta ante el SAT/regulador. Idempotente: si la venta ya
 * tiene fe_uuid, retorna el existente.
 */
export const certifyVenta = async ({ auth, idVenta }) => {
  const cur = await pool.query(
    `select id_venta, fe_uuid, fe_estado from ventas where id_empresa = $1 and id_venta = $2`,
    [auth.id_empresa, idVenta]
  );
  if (cur.rowCount === 0) throw HttpError.notFound("Venta no encontrada");
  if (cur.rows[0].fe_estado === "CERTIFICADO" && cur.rows[0].fe_uuid) {
    return { ok: true, alreadyCertified: true, uuid: cur.rows[0].fe_uuid };
  }

  const providerEntry = await getProvider(auth.id_empresa);
  if (!providerEntry) {
    throw HttpError.badRequest(
      "Facturacion electronica no esta activa para esta empresa"
    );
  }

  const payload = await loadVentaCompleta(auth.id_empresa, idVenta);
  const start = Date.now();
  let result;
  let resultado = "OK";
  let httpStatus = 200;
  let error = null;

  try {
    result = await providerEntry.provider.certifyDocument(
      providerEntry.config,
      payload
    );
  } catch (err) {
    resultado = "ERROR";
    httpStatus = err?.response?.status || 0;
    error = err;
    result = null;
  }

  const duracion = Date.now() - start;

  await pool.query(
    `
      insert into fe_transmisiones (
        id_empresa, id_venta, proveedor, request_payload, response_payload,
        http_status, resultado, duracion_ms
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
    `,
    [
      auth.id_empresa,
      idVenta,
      providerEntry.codigo,
      JSON.stringify({ venta_id: idVenta, total: payload.venta.total }),
      result ? JSON.stringify(result) : JSON.stringify({ error: error?.message }),
      httpStatus,
      resultado,
      duracion,
    ]
  );

  if (error) {
    logger.error({ err: error, idVenta }, "FE certifyDocument fallo");
    await pool.query(
      `update ventas set fe_estado = 'RECHAZADO' where id_empresa = $1 and id_venta = $2`,
      [auth.id_empresa, idVenta]
    );
    throw HttpError.badRequest(
      `Certificacion fallo: ${error?.message || "error"}`
    );
  }

  await pool.query(
    `
      update ventas
        set fe_uuid = $1,
            fe_serie_dte = $2,
            fe_numero_dte = $3,
            fe_estado = 'CERTIFICADO',
            fe_fecha_certificacion = $4::timestamptz,
            fe_xml = $5,
            fe_url_pdf = $6
      where id_empresa = $7 and id_venta = $8
    `,
    [
      result.uuid,
      result.serie || null,
      result.numero || null,
      result.fecha_certificacion || new Date().toISOString(),
      result.xml || null,
      result.url_pdf || null,
      auth.id_empresa,
      idVenta,
    ]
  );

  return { ok: true, uuid: result.uuid, serie: result.serie, numero: result.numero };
};

export const cancelVenta = async ({ auth, idVenta, motivo }) => {
  const providerEntry = await getProvider(auth.id_empresa);
  if (!providerEntry) {
    throw HttpError.badRequest(
      "Facturacion electronica no esta activa para esta empresa"
    );
  }

  const ventaResult = await pool.query(
    `select fe_uuid from ventas where id_empresa = $1 and id_venta = $2`,
    [auth.id_empresa, idVenta]
  );
  const v = ventaResult.rows[0];
  if (!v?.fe_uuid) {
    throw HttpError.badRequest("La venta no tiene UUID fiscal para anular");
  }

  await providerEntry.provider.cancelDocument(providerEntry.config, {
    uuid: v.fe_uuid,
    motivo: String(motivo || "anulado"),
  });

  await pool.query(
    `update ventas set fe_estado = 'ANULADO' where id_empresa = $1 and id_venta = $2`,
    [auth.id_empresa, idVenta]
  );

  return { ok: true };
};

// ============================================================
// Notas de crédito formales (DTE de NOTA_CREDITO)
// ============================================================

/**
 * Certifica una nota de crédito (venta_reversion con tipo_reversion='NOTA_CREDITO').
 * Idempotente: si ya tiene fe_uuid, retorna el existente.
 * Llamado desde createVentaReversion automaticamente cuando aplica.
 */
export const certifyNotaCredito = async ({
  auth,
  idVentaReversion,
  clientOverride = null,
}) => {
  const db = clientOverride || pool;

  const r = await db.query(
    `
      select vr.id_venta_reversion, vr.id_venta, vr.tipo_reversion,
             vr.total, vr.motivo, vr.fe_uuid, vr.fe_estado,
             vr.numero_documento,
             v.fe_uuid as venta_fe_uuid, v.numero_comprobante as venta_numero
      from venta_reversiones vr
      inner join ventas v
        on v.id_empresa = vr.id_empresa and v.id_venta = vr.id_venta
      where vr.id_empresa = $1 and vr.id_venta_reversion = $2
      limit 1
    `,
    [auth.id_empresa, idVentaReversion]
  );

  if (r.rowCount === 0) {
    throw HttpError.notFound("Reversion no encontrada");
  }
  const rev = r.rows[0];

  if (rev.fe_estado === "CERTIFICADO" && rev.fe_uuid) {
    return { ok: true, alreadyCertified: true, uuid: rev.fe_uuid };
  }
  if (String(rev.tipo_reversion).toUpperCase() !== "NOTA_CREDITO") {
    throw HttpError.badRequest(
      "Solo NOTA_CREDITO se certifica fiscalmente; las DEVOLUCION operativas no"
    );
  }

  // Cargar detalles de la reversion
  const detResult = await db.query(
    `
      select vrd.cantidad, vrd.precio_unitario, vrd.subtotal,
             p.nombre as producto_nombre, p.sku
      from venta_reversion_detalles vrd
      inner join productos p
        on p.id_empresa = vrd.id_empresa and p.id_producto = vrd.id_producto
      where vrd.id_empresa = $1 and vrd.id_venta_reversion = $2
    `,
    [auth.id_empresa, idVentaReversion]
  );

  const providerEntry = await getProvider(auth.id_empresa);
  if (!providerEntry) {
    throw HttpError.badRequest(
      "Facturacion electronica no esta activa para esta empresa"
    );
  }

  const payload = {
    venta: {
      tipo_comprobante: "NCV",
      numero_comprobante: rev.numero_documento,
      total: rev.total,
      fecha_venta: new Date().toISOString(),
      moneda: "GTQ",
      // Referencia al DTE original para que el receptor lo enlace
      referencia_dte_uuid: rev.venta_fe_uuid,
      referencia_venta: rev.venta_numero,
      motivo: rev.motivo,
    },
    cliente: { nombre: "Cliente" },
    detalles: detResult.rows,
  };

  const start = Date.now();
  let result;
  let resultado = "OK";
  let httpStatus = 200;
  let error = null;

  try {
    result = await providerEntry.provider.certifyDocument(providerEntry.config, payload);
  } catch (err) {
    resultado = "ERROR";
    httpStatus = err?.response?.status || 0;
    error = err;
  }

  // Log de transmisión
  await pool.query(
    `
      insert into fe_transmisiones (
        id_empresa, id_venta, proveedor, request_payload, response_payload,
        http_status, resultado, duracion_ms
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
    `,
    [
      auth.id_empresa,
      rev.id_venta,
      providerEntry.codigo,
      JSON.stringify({ tipo: "NOTA_CREDITO", id_venta_reversion: idVentaReversion, total: rev.total }),
      result ? JSON.stringify(result) : JSON.stringify({ error: error?.message }),
      httpStatus,
      resultado,
      Date.now() - start,
    ]
  );

  if (error) {
    logger.error({ err: error, idVentaReversion }, "FE NOTA_CREDITO fallo");
    await db.query(
      `update venta_reversiones set fe_estado = 'RECHAZADO' where id_empresa = $1 and id_venta_reversion = $2`,
      [auth.id_empresa, idVentaReversion]
    );
    throw HttpError.badRequest(
      `Certificacion de nota de credito fallo: ${error?.message || "error"}`
    );
  }

  await db.query(
    `
      update venta_reversiones
        set fe_uuid = $1,
            fe_serie_dte = $2,
            fe_numero_dte = $3,
            fe_estado = 'CERTIFICADO',
            fe_fecha_certificacion = $4::timestamptz,
            fe_xml = $5,
            fe_url_pdf = $6
      where id_empresa = $7 and id_venta_reversion = $8
    `,
    [
      result.uuid,
      result.serie || null,
      result.numero || null,
      result.fecha_certificacion || new Date().toISOString(),
      result.xml || null,
      result.url_pdf || null,
      auth.id_empresa,
      idVentaReversion,
    ]
  );

  return {
    ok: true,
    uuid: result.uuid,
    serie: result.serie,
    numero: result.numero,
  };
};
