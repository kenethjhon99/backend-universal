import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { logger } from "../../shared/logging/logger.js";
import * as shopify from "./providers/shopify.js";
import * as woocommerce from "./providers/woocommerce.js";

const ADAPTERS = {
  SHOPIFY: shopify,
  WOOCOMMERCE: woocommerce,
};

const getAdapter = (proveedor) => {
  const adapter = ADAPTERS[String(proveedor).toUpperCase()];
  if (!adapter) {
    throw HttpError.badRequest(`Provider ${proveedor} no soportado`);
  }
  return adapter;
};

// ============================================================
// CRUD integraciones
// ============================================================

export const list = async ({ auth }) => {
  const r = await pool.query(
    `select id_integracion, proveedor, nombre, id_sucursal_origen, modo_sync, activa,
            ultima_sync, estado_ultima_sync, notas_ultima_sync, created_at
     from marketplace_integraciones
     where id_empresa = $1
     order by activa desc, proveedor asc`,
    [auth.id_empresa]
  );
  return r.rows;
};

export const create = async ({ auth, scope, body, requestMeta }) => {
  const proveedor = String(body?.proveedor || "").toUpperCase();
  if (!["SHOPIFY", "WOOCOMMERCE", "TIENDANUBE", "MERCADOLIBRE"].includes(proveedor)) {
    throw HttpError.badRequest("proveedor invalido");
  }
  const nombre = String(body?.nombre || "").trim();
  if (!nombre) throw HttpError.badRequest("nombre requerido");

  const r = await pool.query(
    `
      insert into marketplace_integraciones (
        id_empresa, proveedor, nombre, config, id_sucursal_origen,
        modo_sync, activa, created_by, updated_by
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8)
      returning *
    `,
    [
      auth.id_empresa,
      proveedor,
      nombre,
      JSON.stringify(body?.config || {}),
      body?.id_sucursal_origen || null,
      body?.modo_sync || "STOCK",
      body?.activa !== false,
      auth.id_usuario,
    ]
  );

  await writeAuditEvent(pool, {
    auth, scope, requestMeta,
    modulo: "MARKETPLACE", entidad: "INTEGRACION",
    entidadId: r.rows[0].id_integracion, accion: "CREATE",
    despues: { ...r.rows[0], config: "[REDACTED]" },
  });

  return r.rows[0];
};

// ============================================================
// Mapeo de productos
// ============================================================

export const mapProduct = async ({ auth, body }) => {
  const idIntegracion = Number(body?.id_integracion);
  const idProducto = Number(body?.id_producto);
  const externalId = String(body?.external_id || "").trim();
  if (!idIntegracion || !idProducto || !externalId) {
    throw HttpError.badRequest("id_integracion, id_producto y external_id son requeridos");
  }

  const r = await pool.query(
    `
      insert into marketplace_producto_mapping (
        id_empresa, id_integracion, id_producto, external_id, external_variant_id,
        external_sku, sync_habilitado
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (id_empresa, id_integracion, external_id, external_variant_id)
      do update set id_producto = excluded.id_producto,
                    external_sku = excluded.external_sku,
                    sync_habilitado = excluded.sync_habilitado
      returning *
    `,
    [
      auth.id_empresa,
      idIntegracion,
      idProducto,
      externalId,
      body?.external_variant_id || null,
      body?.external_sku || null,
      body?.sync_habilitado !== false,
    ]
  );
  return r.rows[0];
};

// ============================================================
// Sync stock
// ============================================================

/**
 * Sincroniza el stock del producto en TODAS las integraciones activas que
 * tienen un mapping para ese producto. Best-effort: una integración que
 * falla no rompe las otras. Cada intento queda en marketplace_sync_log.
 *
 * Diseñado para llamarse desde:
 *   - createVenta (al descontar stock)
 *   - crearCompra (al ingresar stock)
 *   - ajusteStock manual
 */
export const syncStockProducto = async ({ idEmpresa, idProducto }) => {
  const integraciones = await pool.query(
    `
      select i.*, m.external_id, m.external_variant_id, m.id_mapping,
             ss.stock_actual
      from marketplace_integraciones i
      inner join marketplace_producto_mapping m
        on m.id_empresa = i.id_empresa and m.id_integracion = i.id_integracion
      left join stock_sucursal ss
        on ss.id_empresa = i.id_empresa
       and ss.id_producto = m.id_producto
       and ss.id_sucursal = i.id_sucursal_origen
      where i.id_empresa = $1
        and i.activa = true
        and m.id_producto = $2
        and m.sync_habilitado = true
    `,
    [idEmpresa, idProducto]
  );

  if (integraciones.rowCount === 0) return { dispatched: 0 };

  let dispatched = 0;
  for (const row of integraciones.rows) {
    const start = Date.now();
    let exito = false;
    let resultado = null;
    let errorMsg = null;

    try {
      const adapter = getAdapter(row.proveedor);
      const stock = Number(row.stock_actual || 0);
      resultado = await adapter.updateStock(row.config || {}, {
        external_id: row.external_id,
        external_variant_id: row.external_variant_id,
        available: stock,
      });
      exito = true;
      dispatched += 1;
    } catch (error) {
      errorMsg = error.message || String(error);
      logger.warn(
        { integracion: row.id_integracion, idProducto, err: errorMsg },
        "marketplace sync stock failed"
      );
    }

    await pool.query(
      `
        insert into marketplace_sync_log (
          id_empresa, id_integracion, direccion, tipo_recurso, exito,
          payload, resultado, error_msg, duracion_ms
        )
        values ($1, $2, 'LOCAL_A_EXTERNO', 'stock', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        idEmpresa,
        row.id_integracion,
        exito,
        JSON.stringify({ id_producto: idProducto, stock: row.stock_actual }),
        resultado ? JSON.stringify(resultado) : null,
        errorMsg,
        Date.now() - start,
      ]
    );

    if (exito) {
      await pool.query(
        `update marketplace_producto_mapping set ultima_sync = now() where id_mapping = $1`,
        [row.id_mapping]
      );
    }
  }

  return { dispatched };
};

export const getSyncLog = async ({ auth, query }) => {
  const r = await pool.query(
    `
      select id_log, id_integracion, direccion, tipo_recurso, exito,
             error_msg, duracion_ms, created_at
      from marketplace_sync_log
      where id_empresa = $1
        ${query?.id_integracion ? "and id_integracion = $2" : ""}
      order by created_at desc
      limit 100
    `,
    query?.id_integracion
      ? [auth.id_empresa, Number(query.id_integracion)]
      : [auth.id_empresa]
  );
  return r.rows;
};
