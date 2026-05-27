import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";

// Patron RLS: usa el client de la request si paso por withTenantDb.
const resolveDb = (db) => db || pool;
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import {
  ensureFinanceModuleEnabled,
  isCreditPurchase,
  resolveCreditDays,
  resolveDueDate,
  upsertCuentaPorPagarFromCompra,
} from "../../shared/finance/accounts.js";
import { assertPeriodOpen } from "../../shared/finance/period-closure.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const PURCHASE_REVERSAL_TYPES = ["DEVOLUCION_PROVEEDOR"];

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const roundQuantity = (value) => Number(Number(value || 0).toFixed(3));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const normalizeText = (value) => String(value || "").trim();

const getBranchFilter = (auth, startIndex, alias = "c") => {
  if (PRIVILEGED_ROLES.has(normalizeRole(auth.rol))) {
    return {
      clause: "",
      params: [],
    };
  }

  return {
    clause: `and ${alias}.id_sucursal = any($${startIndex}::bigint[])`,
    params: [auth.sucursales.map(Number)],
  };
};

const ensureProvider = async (client, { idEmpresa, idProveedor }) => {
  const result = await client.query(
    `
      select id_proveedor, nombre
      from proveedores
      where id_empresa = $1
        and id_proveedor = $2
        and activo = true
      limit 1
    `,
    [idEmpresa, idProveedor]
  );

  const provider = result.rows[0];

  if (!provider) {
    throw HttpError.badRequest("El proveedor no pertenece a la empresa activa");
  }

  return provider;
};

const getDefaultWarehouseId = async (client, { auth, scope }) => {
  const idBodega = await getPrincipalSucursal(client, {
    idEmpresa: auth.id_empresa,
    idSucursal: scope.id_sucursal,
  });

  if (!idBodega) {
    throw HttpError.conflict(
      "La sucursal activa no tiene bodega principal configurada"
    );
  }

  return Number(idBodega);
};

const ensureStockRow = async (client, { auth, scope, idProducto, idBodega }) => {
  await client.query(
    `
      insert into stock_sucursal (
        id_empresa,
        id_sucursal,
        id_bodega,
        id_producto,
        stock_actual,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,0,$5,$5)
      on conflict (id_empresa, id_sucursal, id_bodega, id_producto) do nothing
    `,
    [auth.id_empresa, scope.id_sucursal, idBodega, idProducto, auth.id_usuario]
  );
};

const getNextPurchaseReversionDocument = async (
  client,
  { idEmpresa, idSucursal, reversalType, idUsuario }
) => {
  const normalizedType = normalizeState(reversalType || "DEVOLUCION_PROVEEDOR");
  const defaultSeriesMap = {
    DEVOLUCION_PROVEEDOR: {
      serie: "DCP",
      nombre: "Devolucion de compra",
    },
  };
  const defaults =
    defaultSeriesMap[normalizedType] || defaultSeriesMap.DEVOLUCION_PROVEEDOR;

  await client.query(
    `
      insert into comprobante_series (
        id_empresa,
        id_sucursal,
        modulo,
        tipo_comprobante,
        nombre,
        serie,
        ultimo_correlativo,
        activo,
        created_by,
        updated_by
      )
      values ($1,$2,'COMPRA_REVERSION',$3,$4,$5,0,true,$6,$6)
      on conflict (id_empresa, id_sucursal, modulo, tipo_comprobante, serie) do nothing
    `,
    [
      idEmpresa,
      idSucursal,
      normalizedType,
      defaults.nombre,
      defaults.serie,
      idUsuario || null,
    ]
  );

  const result = await client.query(
    `
      select *
      from comprobante_series
      where id_empresa = $1
        and id_sucursal = $2
        and modulo = 'COMPRA_REVERSION'
        and tipo_comprobante = $3
        and activo = true
      order by id_comprobante_serie asc
      limit 1
      for update
    `,
    [idEmpresa, idSucursal, normalizedType]
  );

  const series = result.rows[0];
  const nextCorrelative = Number(series.ultimo_correlativo || 0) + 1;

  await client.query(
    `
      update comprobante_series
      set ultimo_correlativo = $1
      where id_comprobante_serie = $2
    `,
    [nextCorrelative, series.id_comprobante_serie]
  );

  return `${series.serie}-${String(nextCorrelative).padStart(8, "0")}`;
};

const getPurchaseReversionState = ({ total, reverted }) => {
  const safeTotal = roundMoney(total);
  const safeReverted = roundMoney(reverted);

  if (safeReverted <= 0) return "SIN_REVERSION";
  if (safeReverted >= safeTotal) return "TOTAL";
  return "PARCIAL";
};

const normalizePurchaseRow = (row) => ({
  ...row,
  subtotal: roundMoney(row.subtotal),
  descuento: roundMoney(row.descuento),
  impuesto: roundMoney(row.impuesto),
  total: roundMoney(row.total),
  monto_revertido: roundMoney(row.monto_revertido),
  total_neto: roundMoney(row.total_neto),
});

const normalizePurchaseDetailRow = (row) => ({
  ...row,
  cantidad: roundQuantity(row.cantidad),
  costo_unitario: roundMoney(row.costo_unitario),
  subtotal: roundMoney(row.subtotal),
  cantidad_devuelta: roundQuantity(row.cantidad_devuelta),
  cantidad_disponible_reversion: roundQuantity(row.cantidad_disponible_reversion),
});

const normalizePurchaseReversionRow = (row) => ({
  ...row,
  total: roundMoney(row.total),
});

const normalizeCostAdjustmentRow = (row) => ({
  ...row,
  cantidad: roundQuantity(row.cantidad),
  costo_unitario_anterior: roundMoney(row.costo_unitario_anterior),
  costo_unitario_nuevo: roundMoney(row.costo_unitario_nuevo),
  diferencia_total: roundMoney(row.diferencia_total),
});

const getCompraCompleta = async (db, auth, idCompra) => {
  const branchAccess = getBranchFilter(auth, 3, "c");
  const params = [auth.id_empresa, idCompra, ...branchAccess.params];

  const purchaseResult = await db.query(
    `
      select
        c.*,
        coalesce(c.monto_revertido, 0) as monto_revertido,
        upper(coalesce(c.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
        greatest(coalesce(c.total, 0) - coalesce(c.monto_revertido, 0), 0) as total_neto,
        p.nombre as proveedor_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from compras c
      inner join proveedores p
        on p.id_empresa = c.id_empresa
       and p.id_proveedor = c.id_proveedor
      inner join usuarios u
        on u.id_empresa = c.id_empresa
       and u.id_usuario = c.id_usuario
      where c.id_empresa = $1
        and c.id_compra = $2
        ${branchAccess.clause}
      limit 1
    `,
    params
  );

  const compra = purchaseResult.rows[0];

  if (!compra) {
    throw HttpError.notFound("Compra no encontrada");
  }

  const detailResult = await db.query(
    `
      with devuelto_por_detalle as (
        select
          crd.id_empresa,
          crd.id_compra_detalle,
          coalesce(sum(crd.cantidad), 0) as cantidad_devuelta
        from compra_reversion_detalles crd
        inner join compra_reversiones cr
          on cr.id_compra_reversion = crd.id_compra_reversion
        where crd.id_empresa = $1
        group by crd.id_empresa, crd.id_compra_detalle
      )
      select
        cd.*,
        pr.sku,
        pr.nombre as producto_nombre,
        coalesce(dpd.cantidad_devuelta, 0) as cantidad_devuelta,
        greatest(coalesce(cd.cantidad, 0) - coalesce(dpd.cantidad_devuelta, 0), 0) as cantidad_disponible_reversion
      from compra_detalles cd
      inner join productos pr
        on pr.id_empresa = cd.id_empresa
       and pr.id_producto = cd.id_producto
      left join devuelto_por_detalle dpd
        on dpd.id_empresa = cd.id_empresa
       and dpd.id_compra_detalle = cd.id_compra_detalle
      where cd.id_empresa = $1
        and cd.id_compra = $2
      order by cd.id_compra_detalle asc
    `,
    [auth.id_empresa, idCompra]
  );

  const reversionsResult = await db.query(
    `
      select
        cr.*,
        upper(cr.tipo_reversion) as tipo_reversion,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from compra_reversiones cr
      inner join usuarios u
        on u.id_empresa = cr.id_empresa
       and u.id_usuario = cr.id_usuario
      where cr.id_empresa = $1
        and cr.id_compra = $2
      order by cr.created_at desc, cr.id_compra_reversion desc
    `,
    [auth.id_empresa, idCompra]
  );

  const reversionIds = reversionsResult.rows.map((row) =>
    Number(row.id_compra_reversion)
  );

  const reversionDetailsResult =
    reversionIds.length > 0
      ? await db.query(
          `
            select
              crd.*,
              p.sku,
              p.nombre as producto_nombre
            from compra_reversion_detalles crd
            inner join productos p
              on p.id_empresa = crd.id_empresa
             and p.id_producto = crd.id_producto
            where crd.id_empresa = $1
              and crd.id_compra_reversion = any($2::bigint[])
            order by crd.id_compra_reversion asc, crd.id_compra_reversion_detalle asc
          `,
          [auth.id_empresa, reversionIds]
        )
      : { rows: [] };

  const adjustmentResult = await db.query(
    `
      select
        cac.*,
        cd.cantidad,
        p.sku,
        p.nombre as producto_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from compra_ajustes_costo cac
      inner join compra_detalles cd
        on cd.id_compra_detalle = cac.id_compra_detalle
      inner join productos p
        on p.id_empresa = cac.id_empresa
       and p.id_producto = cac.id_producto
      inner join usuarios u
        on u.id_empresa = cac.id_empresa
       and u.id_usuario = cac.id_usuario
      where cac.id_empresa = $1
        and cac.id_compra = $2
      order by cac.created_at desc, cac.id_compra_ajuste_costo desc
    `,
    [auth.id_empresa, idCompra]
  );

  const detailsByReversion = reversionDetailsResult.rows.reduce((acc, row) => {
    const key = Number(row.id_compra_reversion);
    if (!acc[key]) {
      acc[key] = [];
    }

    acc[key].push({
      ...row,
      cantidad: roundQuantity(row.cantidad),
      costo_unitario: roundMoney(row.costo_unitario),
      subtotal: roundMoney(row.subtotal),
    });

    return acc;
  }, {});

  return {
    compra: normalizePurchaseRow(compra),
    detalles: detailResult.rows.map(normalizePurchaseDetailRow),
    devoluciones: reversionsResult.rows.map((row) => ({
      ...normalizePurchaseReversionRow(row),
      detalles: detailsByReversion[Number(row.id_compra_reversion)] || [],
    })),
    ajustes_costo: adjustmentResult.rows.map(normalizeCostAdjustmentRow),
  };
};

const getCompraHeaderForUpdate = async (client, { auth, scope, idCompra }) => {
  const result = await client.query(
    `
      select *
      from compras c
      where c.id_empresa = $1
        and c.id_compra = $2
        and c.id_sucursal = $3
      limit 1
      for update of c
    `,
    [auth.id_empresa, idCompra, scope.id_sucursal]
  );

  const compra = result.rows[0];

  if (!compra) {
    throw HttpError.notFound("Compra no encontrada");
  }

  if (normalizeState(compra.estado) === "ANULADA") {
    throw HttpError.badRequest("La compra esta anulada");
  }

  return compra;
};

const getPurchaseDetailsForReversion = async (client, { auth, idCompra }) => {
  const result = await client.query(
    `
      with devuelto_por_detalle as (
        select
          crd.id_empresa,
          crd.id_compra_detalle,
          coalesce(sum(crd.cantidad), 0) as cantidad_devuelta
        from compra_reversion_detalles crd
        inner join compra_reversiones cr
          on cr.id_compra_reversion = crd.id_compra_reversion
        where crd.id_empresa = $1
        group by crd.id_empresa, crd.id_compra_detalle
      )
      select
        cd.*,
        p.nombre as producto_nombre,
        coalesce(dpd.cantidad_devuelta, 0) as cantidad_devuelta,
        greatest(coalesce(cd.cantidad, 0) - coalesce(dpd.cantidad_devuelta, 0), 0) as cantidad_disponible_reversion
      from compra_detalles cd
      inner join productos p
        on p.id_empresa = cd.id_empresa
       and p.id_producto = cd.id_producto
      left join devuelto_por_detalle dpd
        on dpd.id_empresa = cd.id_empresa
       and dpd.id_compra_detalle = cd.id_compra_detalle
      where cd.id_empresa = $1
        and cd.id_compra = $2
      order by cd.id_compra_detalle asc
      for update of cd
    `,
    [auth.id_empresa, idCompra]
  );

  return result.rows;
};

const getPurchaseDetailsForAdjustment = async (client, { auth, idCompra }) => {
  const result = await client.query(
    `
      select
        cd.*,
        p.nombre as producto_nombre
      from compra_detalles cd
      inner join productos p
        on p.id_empresa = cd.id_empresa
       and p.id_producto = cd.id_producto
      where cd.id_empresa = $1
        and cd.id_compra = $2
      order by cd.id_compra_detalle asc
      for update of cd
    `,
    [auth.id_empresa, idCompra]
  );

  return result.rows;
};

export const listCompras = async ({ db, auth, scope, query }) => {
  const conn = resolveDb(db);
  const filters = ["c.id_empresa = $1", "c.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.estado) {
    filters.push(`upper(coalesce(c.estado, '')) = $${index}`);
    params.push(normalizeState(query.estado));
    index += 1;
  }

  if (query?.estado_reversion) {
    filters.push(`upper(coalesce(c.estado_reversion, 'SIN_REVERSION')) = $${index}`);
    params.push(normalizeState(query.estado_reversion));
    index += 1;
  }

  if (query?.desde) {
    filters.push(`c.fecha_compra::date >= $${index}::date`);
    params.push(String(query.desde).trim());
    index += 1;
  }

  if (query?.hasta) {
    filters.push(`c.fecha_compra::date <= $${index}::date`);
    params.push(String(query.hasta).trim());
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(c.numero_documento, '') ilike $${index} or coalesce(p.nombre, '') ilike $${index} or coalesce(u.username, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await conn.query(
    `
      select
        c.*,
        coalesce(c.monto_revertido, 0) as monto_revertido,
        upper(coalesce(c.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
        greatest(coalesce(c.total, 0) - coalesce(c.monto_revertido, 0), 0) as total_neto,
        p.nombre as proveedor_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        (
          select count(*)::int
          from compra_detalles cd
          where cd.id_empresa = c.id_empresa
            and cd.id_compra = c.id_compra
        ) as total_items,
        (
          select coalesce(sum(cd.cantidad), 0)
          from compra_detalles cd
          where cd.id_empresa = c.id_empresa
            and cd.id_compra = c.id_compra
        ) as total_unidades
      from compras c
      inner join proveedores p
        on p.id_empresa = c.id_empresa
       and p.id_proveedor = c.id_proveedor
      inner join usuarios u
        on u.id_empresa = c.id_empresa
       and u.id_usuario = c.id_usuario
      where ${filters.join(" and ")}
      order by c.fecha_compra desc, c.id_compra desc
      limit $${index}
    `,
    params
  );

  return result.rows.map((row) => ({
    ...normalizePurchaseRow(row),
    total_items: Number(row.total_items || 0),
    total_unidades: roundQuantity(row.total_unidades),
  }));
};

export const createCompra = async ({ auth, scope, body, requestMeta = null }) =>
  runInTransaction(
    async (client) => {
      const items = Array.isArray(body?.items) ? body.items : [];
      const condicionPago = normalizeState(body?.condicion_pago || "CONTADO");
      const isCredit = isCreditPurchase({ condicion_pago: condicionPago });
      const diasCredito = resolveCreditDays(body?.dias_credito);
      const idBodega = await getDefaultWarehouseId(client, { auth, scope });

      if (items.length === 0) {
        throw HttpError.badRequest("Debes enviar al menos un item");
      }

      await assertPeriodOpen(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "COMPRAS",
        fechaOperacion: body?.fecha_compra || new Date(),
      });

      if (isCredit) {
        ensureFinanceModuleEnabled(auth);
      }

      const idProveedor = Number(body?.id_proveedor);

      if (!Number.isInteger(idProveedor) || idProveedor <= 0) {
        throw HttpError.badRequest("id_proveedor invalido");
      }

      await ensureProvider(client, {
        idEmpresa: auth.id_empresa,
        idProveedor,
      });

      const tipoDocumento = normalizeState(body?.tipo_documento || "FACTURA");
      const fechaCompra = normalizeText(body?.fecha_compra) || null;
      const fechaVencimiento = isCredit
        ? resolveDueDate({
            baseDate: fechaCompra || new Date(),
            providedDueDate: body?.fecha_vencimiento,
            creditDays: diasCredito,
          })
        : null;

      const headerResult = await client.query(
        `
          insert into compras (
            id_empresa,
            id_sucursal,
            id_proveedor,
            id_usuario,
            numero_documento,
            tipo_documento,
            estado,
            subtotal,
            descuento,
            impuesto,
            total,
            fecha_compra,
            condicion_pago,
            dias_credito,
            fecha_vencimiento,
            saldo_pendiente,
            observaciones,
            created_by,
            updated_by
          )
          values (
            $1,$2,$3,$4,$5,$6,'CONFIRMADA',0,0,0,0,coalesce($7::timestamptz, now()),$8,$9,$10::date,0,$11,$4,$4
          )
          returning id_compra
        `,
        [
          auth.id_empresa,
          scope.id_sucursal,
          idProveedor,
          auth.id_usuario,
          normalizeText(body?.numero_documento) || null,
          tipoDocumento,
          fechaCompra,
          condicionPago,
          diasCredito,
          fechaVencimiento,
          normalizeText(body?.observaciones) || null,
        ]
      );

      const compraId = Number(headerResult.rows[0].id_compra);
      let subtotal = 0;

      for (const item of items) {
        const idProducto = Number(item?.id_producto);
        const cantidad = roundQuantity(item?.cantidad);
        const costoUnitario = roundMoney(item?.costo_unitario);

        if (!Number.isInteger(idProducto) || idProducto <= 0) {
          throw HttpError.badRequest("id_producto invalido en items");
        }

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw HttpError.badRequest("cantidad invalida en items");
        }

        if (!Number.isFinite(costoUnitario) || costoUnitario < 0) {
          throw HttpError.badRequest("costo_unitario invalido en items");
        }

        await ensureStockRow(client, {
          auth,
          scope,
          idProducto,
          idBodega,
        });

        const productResult = await client.query(
          `
            select
              p.id_producto,
              p.nombre,
              p.precio_compra,
              ss.stock_actual
            from productos p
            inner join stock_sucursal ss
              on ss.id_empresa = p.id_empresa
             and ss.id_producto = p.id_producto
             and ss.id_sucursal = $3
             and ss.id_bodega = $4
            where p.id_empresa = $1
              and p.id_producto = $2
              and p.activo = true
            limit 1
            for update of ss
          `,
          [auth.id_empresa, idProducto, scope.id_sucursal, idBodega]
        );

        const product = productResult.rows[0];

        if (!product) {
          throw HttpError.badRequest(
            `El producto ${idProducto} no existe en la sucursal activa`
          );
        }

        const stockBefore = Number(product.stock_actual || 0);
        const stockAfter = roundQuantity(stockBefore + cantidad);
        const itemSubtotal = roundMoney(cantidad * costoUnitario);
        subtotal += itemSubtotal;

        await client.query(
          `
            insert into compra_detalles (
              id_empresa,
              id_compra,
              id_producto,
              cantidad,
              costo_unitario,
              subtotal,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$7)
          `,
          [
            auth.id_empresa,
            compraId,
            idProducto,
            cantidad,
            costoUnitario,
            itemSubtotal,
            auth.id_usuario,
          ]
        );

        await client.query(
          `
            update stock_sucursal
            set stock_actual = $1,
                updated_by = $4
            where id_empresa = $2
              and id_sucursal = $3
              and id_bodega = $5
              and id_producto = $6
          `,
          [
            stockAfter,
            auth.id_empresa,
            scope.id_sucursal,
            auth.id_usuario,
            idBodega,
            idProducto,
          ]
        );

        await client.query(
          `
            update productos
            set precio_compra = $1,
                updated_by = $2
            where id_empresa = $3
              and id_producto = $4
          `,
          [costoUnitario, auth.id_usuario, auth.id_empresa, idProducto]
        );

        await client.query(
          `
            insert into movimientos_inventario (
              id_empresa,
              id_sucursal,
              id_bodega,
              id_producto,
              id_usuario,
              tipo,
              referencia_tipo,
              referencia_id,
              cantidad,
              stock_antes,
              stock_despues,
              observacion,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,'ENTRADA','COMPRA',$6,$7,$8,$9,$10,$5,$5)
          `,
          [
            auth.id_empresa,
            scope.id_sucursal,
            idBodega,
            idProducto,
            auth.id_usuario,
            compraId,
            cantidad,
            stockBefore,
            stockAfter,
            `Compra ${body?.numero_documento || `#${compraId}`}`,
          ]
        );
      }

      const total = roundMoney(subtotal);

      await client.query(
        `
          update compras
          set subtotal = $1,
              total = $2,
              saldo_pendiente = $3,
              updated_by = $4
          where id_empresa = $5
            and id_compra = $6
        `,
        [
          total,
          total,
          isCredit ? total : 0,
          auth.id_usuario,
          auth.id_empresa,
          compraId,
        ]
      );

      if (isCredit) {
        await upsertCuentaPorPagarFromCompra(client, {
          auth,
          compraId,
          actorId: auth.id_usuario,
        });
      }

      const created = await getCompraCompleta(client, auth, compraId);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "COMPRA",
        entidad: "COMPRA",
        entidadId: compraId,
        accion: "CREATE",
        despues: created.compra,
      });

      return created;
    },
    { auth }
  );

export const createCompraDevolucion = async ({
  auth,
  scope,
  idCompra,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      await assertPeriodOpen(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "COMPRAS",
        fechaOperacion: new Date(),
      });

      const compra = await getCompraHeaderForUpdate(client, {
        auth,
        scope,
        idCompra,
      });

      if (normalizeState(compra.estado_reversion) === "TOTAL") {
        throw HttpError.badRequest("La compra ya fue devuelta totalmente");
      }

      const motivo = normalizeText(body?.motivo);
      const idBodega = await getDefaultWarehouseId(client, { auth, scope });
      if (!motivo) {
        throw HttpError.badRequest("motivo es requerido");
      }

      const reversalType = normalizeState(
        body?.tipo_reversion || "DEVOLUCION_PROVEEDOR"
      );
      if (!PURCHASE_REVERSAL_TYPES.includes(reversalType)) {
        throw HttpError.badRequest("tipo_reversion es invalido");
      }

      const items = Array.isArray(body?.items) ? body.items : [];
      if (items.length === 0) {
        throw HttpError.badRequest("Debes enviar al menos un item a devolver");
      }

      const detailRows = await getPurchaseDetailsForReversion(client, {
        auth,
        idCompra,
      });
      const detailMap = new Map(
        detailRows.map((row) => [Number(row.id_compra_detalle), row])
      );

      const documentNumber = await getNextPurchaseReversionDocument(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        reversalType,
        idUsuario: auth.id_usuario,
      });

      const headerResult = await client.query(
        `
          insert into compra_reversiones (
            id_empresa,
            id_compra,
            id_sucursal,
            id_usuario,
            tipo_reversion,
            numero_documento,
            motivo,
            total,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,0,$4,$4)
          returning id_compra_reversion
        `,
        [
          auth.id_empresa,
          idCompra,
          scope.id_sucursal,
          auth.id_usuario,
          reversalType,
          documentNumber,
          motivo,
        ]
      );

      const idCompraReversion = Number(
        headerResult.rows[0].id_compra_reversion
      );
      let totalReversion = 0;

      for (const item of items) {
        const idCompraDetalle = Number(item?.id_compra_detalle);
        const cantidad = roundQuantity(item?.cantidad);

        if (!Number.isInteger(idCompraDetalle) || idCompraDetalle <= 0) {
          throw HttpError.badRequest("id_compra_detalle es invalido");
        }

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw HttpError.badRequest("cantidad es invalida");
        }

        const detail = detailMap.get(idCompraDetalle);

        if (!detail) {
          throw HttpError.badRequest(
            `El detalle ${idCompraDetalle} no pertenece a la compra`
          );
        }

        if (cantidad > Number(detail.cantidad_disponible_reversion || 0)) {
          throw HttpError.badRequest(
            `La cantidad excede lo disponible para ${detail.producto_nombre}`
          );
        }

        const stockResult = await client.query(
          `
            select stock_actual
            from stock_sucursal
            where id_empresa = $1
              and id_sucursal = $2
              and id_bodega = $3
              and id_producto = $4
            limit 1
            for update
          `,
          [auth.id_empresa, scope.id_sucursal, idBodega, detail.id_producto]
        );

        const stockBefore = Number(stockResult.rows[0]?.stock_actual || 0);
        const stockAfter = roundQuantity(stockBefore - cantidad);

        if (stockAfter < 0) {
          throw HttpError.badRequest(
            `Stock insuficiente para devolver ${detail.producto_nombre} al proveedor. Disponible: ${stockBefore}`
          );
        }

        const subtotal = roundMoney(cantidad * Number(detail.costo_unitario || 0));
        totalReversion += subtotal;

        await client.query(
          `
            insert into compra_reversion_detalles (
              id_empresa,
              id_compra_reversion,
              id_compra_detalle,
              id_producto,
              cantidad,
              costo_unitario,
              subtotal,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
          `,
          [
            auth.id_empresa,
            idCompraReversion,
            idCompraDetalle,
            Number(detail.id_producto),
            cantidad,
            roundMoney(detail.costo_unitario),
            subtotal,
            auth.id_usuario,
          ]
        );

        await client.query(
          `
            update stock_sucursal
            set stock_actual = $1,
                updated_by = $2
            where id_empresa = $3
              and id_sucursal = $4
              and id_bodega = $5
              and id_producto = $6
          `,
          [
            stockAfter,
            auth.id_usuario,
            auth.id_empresa,
            scope.id_sucursal,
            idBodega,
            detail.id_producto,
          ]
        );

        await client.query(
          `
            insert into movimientos_inventario (
              id_empresa,
              id_sucursal,
              id_bodega,
              id_producto,
              id_usuario,
              tipo,
              referencia_tipo,
              referencia_id,
              cantidad,
              stock_antes,
              stock_despues,
              observacion,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,'SALIDA','COMPRA_REVERSION',$6,$7,$8,$9,$10,$5,$5)
          `,
          [
            auth.id_empresa,
            scope.id_sucursal,
            idBodega,
            detail.id_producto,
            auth.id_usuario,
            idCompraReversion,
            cantidad,
            stockBefore,
            stockAfter,
            `${reversalType} ${documentNumber}`,
          ]
        );
      }

      await client.query(
        `
          update compra_reversiones
          set total = $1,
              updated_by = $2
          where id_compra_reversion = $3
        `,
        [roundMoney(totalReversion), auth.id_usuario, idCompraReversion]
      );

      const totalRevertido = roundMoney(
        Number(compra.monto_revertido || 0) + totalReversion
      );
      const saldoPendienteActual = roundMoney(
        Number(compra.saldo_pendiente || 0)
      );
      const saldoPendienteNuevo = isCreditPurchase(compra)
        ? roundMoney(Math.max(0, saldoPendienteActual - totalReversion))
        : 0;
      const estadoReversion = getPurchaseReversionState({
        total: compra.total,
        reverted: totalRevertido,
      });

      await client.query(
        `
          update compras
          set monto_revertido = $1,
              estado_reversion = $2,
              fecha_ultima_reversion = now(),
              saldo_pendiente = $3,
              updated_by = $4
          where id_empresa = $5
            and id_compra = $6
        `,
        [
          totalRevertido,
          estadoReversion,
          saldoPendienteNuevo,
          auth.id_usuario,
          auth.id_empresa,
          idCompra,
        ]
      );

      if (isCreditPurchase(compra)) {
        await upsertCuentaPorPagarFromCompra(client, {
          auth,
          compraId: idCompra,
          actorId: auth.id_usuario,
          movementType: "COMPRA_REVERSION",
          movementDate: new Date(),
        });
      }

      const updated = await getCompraCompleta(client, auth, idCompra);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "COMPRA",
        entidad: "COMPRA_REVERSION",
        entidadId: idCompraReversion,
        accion: "CREATE",
        antes: {
          numero_documento: compra.numero_documento,
          monto_revertido: roundMoney(compra.monto_revertido),
          estado_reversion: compra.estado_reversion,
        },
        despues: updated.compra,
      });

      return updated;
    },
    { auth }
  );

export const createCompraCostAdjustment = async ({
  auth,
  scope,
  idCompra,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      await assertPeriodOpen(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "COMPRAS",
        fechaOperacion: new Date(),
      });

      const compra = await getCompraHeaderForUpdate(client, {
        auth,
        scope,
        idCompra,
      });

      const sharedReason = normalizeText(body?.motivo);
      const items = Array.isArray(body?.items)
        ? body.items
        : body?.id_compra_detalle
          ? [body]
          : [];

      if (items.length === 0) {
        throw HttpError.badRequest("Debes enviar al menos un ajuste de costo");
      }

      const detailRows = await getPurchaseDetailsForAdjustment(client, {
        auth,
        idCompra,
      });
      const detailMap = new Map(
        detailRows.map((row) => [Number(row.id_compra_detalle), row])
      );

      let totalDifference = 0;
      const adjustmentIds = [];

      for (const item of items) {
        const idCompraDetalle = Number(item?.id_compra_detalle);
        const costoUnitarioNuevo = roundMoney(item?.costo_unitario_nuevo);
        const motivo = normalizeText(item?.motivo) || sharedReason;

        if (!Number.isInteger(idCompraDetalle) || idCompraDetalle <= 0) {
          throw HttpError.badRequest("id_compra_detalle es invalido");
        }

        if (!Number.isFinite(costoUnitarioNuevo) || costoUnitarioNuevo < 0) {
          throw HttpError.badRequest("costo_unitario_nuevo es invalido");
        }

        if (!motivo) {
          throw HttpError.badRequest("motivo es requerido para ajustar costo");
        }

        const detail = detailMap.get(idCompraDetalle);

        if (!detail) {
          throw HttpError.badRequest(
            `El detalle ${idCompraDetalle} no pertenece a la compra`
          );
        }

        const costoUnitarioAnterior = roundMoney(detail.costo_unitario);

        if (costoUnitarioAnterior === costoUnitarioNuevo) {
          continue;
        }

        const subtotalAnterior = roundMoney(
          Number(detail.cantidad || 0) * costoUnitarioAnterior
        );
        const subtotalNuevo = roundMoney(
          Number(detail.cantidad || 0) * costoUnitarioNuevo
        );
        const diferenciaTotal = roundMoney(subtotalNuevo - subtotalAnterior);

        const adjustmentResult = await client.query(
          `
            insert into compra_ajustes_costo (
              id_empresa,
              id_compra,
              id_compra_detalle,
              id_sucursal,
              id_producto,
              id_usuario,
              costo_unitario_anterior,
              costo_unitario_nuevo,
              diferencia_total,
              motivo,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,$6)
            returning id_compra_ajuste_costo
          `,
          [
            auth.id_empresa,
            idCompra,
            idCompraDetalle,
            scope.id_sucursal,
            Number(detail.id_producto),
            auth.id_usuario,
            costoUnitarioAnterior,
            costoUnitarioNuevo,
            diferenciaTotal,
            motivo,
          ]
        );

        adjustmentIds.push(
          Number(adjustmentResult.rows[0].id_compra_ajuste_costo)
        );
        totalDifference += diferenciaTotal;

        await client.query(
          `
            update compra_detalles
            set costo_unitario = $1,
                subtotal = $2,
                updated_by = $3
            where id_empresa = $4
              and id_compra_detalle = $5
          `,
          [
            costoUnitarioNuevo,
            subtotalNuevo,
            auth.id_usuario,
            auth.id_empresa,
            idCompraDetalle,
          ]
        );

        await client.query(
          `
            update productos
            set precio_compra = $1,
                updated_by = $2
            where id_empresa = $3
              and id_producto = $4
          `,
          [
            costoUnitarioNuevo,
            auth.id_usuario,
            auth.id_empresa,
            detail.id_producto,
          ]
        );
      }

      if (adjustmentIds.length === 0) {
        throw HttpError.badRequest(
          "No hay cambios de costo para aplicar en esta compra"
        );
      }

      const subtotalNuevoCompra = roundMoney(
        Number(compra.subtotal || 0) + totalDifference
      );
      const totalNuevoCompra = roundMoney(Number(compra.total || 0) + totalDifference);
      const saldoPendienteNuevo = isCreditPurchase(compra)
        ? roundMoney(Math.max(0, Number(compra.saldo_pendiente || 0) + totalDifference))
        : 0;
      const estadoReversion = getPurchaseReversionState({
        total: totalNuevoCompra,
        reverted: Number(compra.monto_revertido || 0),
      });

      await client.query(
        `
          update compras
          set subtotal = $1,
              total = $2,
              estado_reversion = $3,
              saldo_pendiente = $4,
              updated_by = $5
          where id_empresa = $6
            and id_compra = $7
        `,
        [
          subtotalNuevoCompra,
          totalNuevoCompra,
          estadoReversion,
          saldoPendienteNuevo,
          auth.id_usuario,
          auth.id_empresa,
          idCompra,
        ]
      );

      if (isCreditPurchase(compra)) {
        await upsertCuentaPorPagarFromCompra(client, {
          auth,
          compraId: idCompra,
          actorId: auth.id_usuario,
          movementType: "AJUSTE_COSTO",
          movementDate: new Date(),
        });
      }

      const updated = await getCompraCompleta(client, auth, idCompra);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "COMPRA",
        entidad: "COMPRA_AJUSTE_COSTO",
        entidadId: adjustmentIds[adjustmentIds.length - 1],
        accion: "CREATE",
        antes: {
          subtotal: roundMoney(compra.subtotal),
          total: roundMoney(compra.total),
        },
        despues: updated.compra,
      });

      return updated;
    },
    { auth }
  );

export const getCompraById = async ({ db, auth, idCompra }) =>
  getCompraCompleta(resolveDb(db), auth, idCompra);
