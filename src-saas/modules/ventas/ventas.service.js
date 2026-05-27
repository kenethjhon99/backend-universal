import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";

// Patron RLS: usa el client transaccional de la request si esta presente
// (cuando la ruta paso por withTenantDb). Las escrituras siguen usando
// runInTransaction que abre su propia tx con applyRequestSettings.
const resolveDb = (db) => db || pool;
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { emitirComprobante } from "../../shared/comprobantes/comprobante-series.js";
import { verifyAdminAuthorization } from "../../shared/security/admin-auth.js";
import {
  ventasCreated,
  ventasReversiones,
} from "../../shared/metrics/registry.js";
import {
  getMonedaBase,
  getTasaVigente,
} from "../monedas/monedas.service.js";
import { notify } from "../notificaciones/notificaciones.service.js";
import { triggerEvent as triggerWebhook } from "../webhooks/webhooks.service.js";
import { certifyNotaCredito } from "../facturacion-electronica/fe.service.js";
import {
  registerPromotionUses,
  resolveActivePromotions,
} from "../promociones/promociones.service.js";
import {
  acumularPorVenta as acumularFidelidad,
  canjearEnVenta as canjearFidelidad,
} from "../fidelidad/fidelidad.service.js";
import {
  ensureFinanceModuleEnabled,
  isCreditSale,
  resolveCreditDays,
  resolveDueDate,
  upsertCuentaPorCobrarFromVenta,
} from "../../shared/finance/accounts.js";
import { assertPeriodOpen } from "../../shared/finance/period-closure.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const REVERSAL_TYPES = ["DEVOLUCION", "NOTA_CREDITO"];
const REVERSAL_METHODS = [
  "EFECTIVO",
  "TARJETA",
  "TRANSFERENCIA",
  "AJUSTE",
  "NOTA_CREDITO",
];

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const roundQuantity = (value) => Number(Number(value || 0).toFixed(3));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const normalizeText = (value) => String(value || "").trim();

const getBranchFilter = (auth, startIndex) => {
  if (PRIVILEGED_ROLES.has(normalizeRole(auth.rol))) {
    return {
      clause: "",
      params: [],
    };
  }

  return {
    clause: `and v.id_sucursal = any($${startIndex}::bigint[])`,
    params: [auth.sucursales.map(Number)],
  };
};

const ensureClient = async (client, { idEmpresa, idCliente }) => {
  if (!idCliente) return null;

  const result = await client.query(
    `
      select id_cliente, nombre
      from clientes
      where id_empresa = $1
        and id_cliente = $2
        and activo = true
      limit 1
    `,
    [idEmpresa, idCliente]
  );

  const row = result.rows[0];

  if (!row) {
    throw HttpError.badRequest("El cliente no pertenece a la empresa activa");
  }

  return row;
};

/**
 * Emite un comprobante de venta delegando en el helper compartido.
 * Mantiene la firma legacy { numero_comprobante, tipo_comprobante } para no
 * romper el resto del flujo de createVenta.
 */
const getNextComprobante = async (
  client,
  { idEmpresa, idSucursal, tipoComprobante, actorId = null }
) => {
  const result = await emitirComprobante(client, {
    idEmpresa,
    idSucursal,
    modulo: "VENTA",
    tipoComprobante: tipoComprobante || "TICKET",
    actorId,
  });

  return {
    numero_comprobante: result.numero_comprobante,
    tipo_comprobante: result.tipo_comprobante,
  };
};

/**
 * Emite el documento de una reversion de venta (DEVOLUCION / NOTA_CREDITO)
 * delegando en el helper compartido.
 */
const getNextReversionDocument = async (
  client,
  { idEmpresa, idSucursal, reversalType, actorId = null }
) => {
  const result = await emitirComprobante(client, {
    idEmpresa,
    idSucursal,
    modulo: "VENTA_REVERSION",
    tipoComprobante: reversalType || "DEVOLUCION",
    actorId,
  });

  return result.numero_comprobante;
};

const getCajaSesionActivaForVenta = async (client, { auth, scope }) => {
  const result = await client.query(
    `
      select id_caja_sesion, estado, fecha_apertura
      from caja_sesiones
      where id_empresa = $1
        and id_usuario = $2
        and id_sucursal = $3
        and estado = 'ABIERTA'
      order by fecha_apertura desc
      limit 1
    `,
    [auth.id_empresa, auth.id_usuario, scope.id_sucursal]
  );

  return result.rows[0] || null;
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

const getSaleReversionState = ({ total, reverted }) => {
  const safeTotal = roundMoney(total);
  const safeReverted = roundMoney(reverted);

  if (safeReverted <= 0) return "SIN_REVERSION";
  if (safeReverted >= safeTotal) return "TOTAL";
  return "PARCIAL";
};

const normalizeSaleRow = (row) => ({
  ...row,
  subtotal: roundMoney(row.subtotal),
  total: roundMoney(row.total),
  monto_recibido:
    row.monto_recibido != null ? roundMoney(row.monto_recibido) : null,
  cambio: roundMoney(row.cambio),
  monto_revertido: roundMoney(row.monto_revertido),
  total_neto: roundMoney(row.total_neto),
});

const normalizeSaleDetailRow = (row) => ({
  ...row,
  cantidad: roundQuantity(row.cantidad),
  precio_unitario: roundMoney(row.precio_unitario),
  descuento: roundMoney(row.descuento),
  subtotal: roundMoney(row.subtotal),
  costo_unitario: roundMoney(row.costo_unitario),
  utilidad: roundMoney(row.utilidad),
  cantidad_devuelta: roundQuantity(row.cantidad_devuelta),
  cantidad_disponible_reversion: roundQuantity(row.cantidad_disponible_reversion),
});

const normalizeSaleReversionRow = (row) => ({
  ...row,
  total: roundMoney(row.total),
  reintegrar_stock: row.reintegrar_stock === true,
});

const getVentaCompleta = async (db, auth, idVenta) => {
  const branchAccess = getBranchFilter(auth, 3);
  const params = [auth.id_empresa, idVenta, ...branchAccess.params];

  const saleResult = await db.query(
    `
      select
        v.*,
        coalesce(v.monto_revertido, 0) as monto_revertido,
        upper(coalesce(v.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
        greatest(coalesce(v.total, 0) - coalesce(v.monto_revertido, 0), 0) as total_neto,
        c.nombre as cliente_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from ventas v
      inner join usuarios u
        on u.id_empresa = v.id_empresa
       and u.id_usuario = v.id_usuario
      left join clientes c
        on c.id_empresa = v.id_empresa
       and c.id_cliente = v.id_cliente
      where v.id_empresa = $1
        and v.id_venta = $2
        ${branchAccess.clause}
      limit 1
    `,
    params
  );

  const venta = saleResult.rows[0];

  if (!venta) {
    throw HttpError.notFound("Venta no encontrada");
  }

  const detailResult = await db.query(
    `
      with devuelto_por_detalle as (
        select
          vrd.id_empresa,
          vrd.id_venta_detalle,
          coalesce(sum(vrd.cantidad), 0) as cantidad_devuelta
        from venta_reversion_detalles vrd
        inner join venta_reversiones vr
          on vr.id_venta_reversion = vrd.id_venta_reversion
        where vrd.id_empresa = $1
        group by vrd.id_empresa, vrd.id_venta_detalle
      )
      select
        vd.*,
        p.sku,
        p.nombre as producto_nombre,
        coalesce(dpd.cantidad_devuelta, 0) as cantidad_devuelta,
        greatest(coalesce(vd.cantidad, 0) - coalesce(dpd.cantidad_devuelta, 0), 0) as cantidad_disponible_reversion
      from venta_detalles vd
      inner join productos p
        on p.id_empresa = vd.id_empresa
       and p.id_producto = vd.id_producto
      left join devuelto_por_detalle dpd
        on dpd.id_empresa = vd.id_empresa
       and dpd.id_venta_detalle = vd.id_venta_detalle
      where vd.id_empresa = $1
        and vd.id_venta = $2
      order by vd.id_venta_detalle asc
    `,
    [auth.id_empresa, idVenta]
  );

  const reversionsResult = await db.query(
    `
      select
        vr.*,
        upper(vr.tipo_reversion) as tipo_reversion,
        upper(vr.metodo_resolucion) as metodo_resolucion,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from venta_reversiones vr
      inner join usuarios u
        on u.id_empresa = vr.id_empresa
       and u.id_usuario = vr.id_usuario
      where vr.id_empresa = $1
        and vr.id_venta = $2
      order by vr.created_at desc, vr.id_venta_reversion desc
    `,
    [auth.id_empresa, idVenta]
  );

  const reversionIds = reversionsResult.rows.map((row) =>
    Number(row.id_venta_reversion)
  );

  const reversionDetailsResult =
    reversionIds.length > 0
      ? await db.query(
          `
            select
              vrd.*,
              p.sku,
              p.nombre as producto_nombre
            from venta_reversion_detalles vrd
            inner join productos p
              on p.id_empresa = vrd.id_empresa
             and p.id_producto = vrd.id_producto
            where vrd.id_empresa = $1
              and vrd.id_venta_reversion = any($2::bigint[])
            order by vrd.id_venta_reversion asc, vrd.id_venta_reversion_detalle asc
          `,
          [auth.id_empresa, reversionIds]
        )
      : { rows: [] };

  const detailsByReversion = reversionDetailsResult.rows.reduce((acc, row) => {
    const key = Number(row.id_venta_reversion);
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push({
      ...row,
      cantidad: roundQuantity(row.cantidad),
      precio_unitario: roundMoney(row.precio_unitario),
      costo_unitario: roundMoney(row.costo_unitario),
      subtotal: roundMoney(row.subtotal),
    });
    return acc;
  }, {});

  return {
    venta: normalizeSaleRow(venta),
    detalles: detailResult.rows.map(normalizeSaleDetailRow),
    reversiones: reversionsResult.rows.map((row) => ({
      ...normalizeSaleReversionRow(row),
      detalles: detailsByReversion[Number(row.id_venta_reversion)] || [],
    })),
  };
};

const getVentaHeaderForUpdate = async (client, { auth, scope, idVenta }) => {
  const result = await client.query(
    `
      select *
      from ventas v
      where v.id_empresa = $1
        and v.id_venta = $2
        and v.id_sucursal = $3
      limit 1
      for update of v
    `,
    [auth.id_empresa, idVenta, scope.id_sucursal]
  );

  const venta = result.rows[0];

  if (!venta) {
    throw HttpError.notFound("Venta no encontrada");
  }

  if (normalizeState(venta.estado) === "ANULADA") {
    throw HttpError.badRequest("La venta esta anulada");
  }

  return venta;
};

const getSaleDetailsForReversion = async (client, { auth, idVenta }) => {
  const result = await client.query(
    `
      with devuelto_por_detalle as (
        select
          vrd.id_empresa,
          vrd.id_venta_detalle,
          coalesce(sum(vrd.cantidad), 0) as cantidad_devuelta
        from venta_reversion_detalles vrd
        inner join venta_reversiones vr
          on vr.id_venta_reversion = vrd.id_venta_reversion
        where vrd.id_empresa = $1
        group by vrd.id_empresa, vrd.id_venta_detalle
      )
      select
        vd.*,
        p.nombre as producto_nombre,
        coalesce(dpd.cantidad_devuelta, 0) as cantidad_devuelta,
        greatest(coalesce(vd.cantidad, 0) - coalesce(dpd.cantidad_devuelta, 0), 0) as cantidad_disponible_reversion
      from venta_detalles vd
      inner join productos p
        on p.id_empresa = vd.id_empresa
       and p.id_producto = vd.id_producto
      left join devuelto_por_detalle dpd
        on dpd.id_empresa = vd.id_empresa
       and dpd.id_venta_detalle = vd.id_venta_detalle
      where vd.id_empresa = $1
        and vd.id_venta = $2
      order by vd.id_venta_detalle asc
      for update of vd
    `,
    [auth.id_empresa, idVenta]
  );

  return result.rows;
};

export const listVentas = async ({ db, auth, scope, query }) => {
  const conn = resolveDb(db);
  const filters = ["v.id_empresa = $1", "v.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.estado) {
    filters.push(`upper(coalesce(v.estado, '')) = $${index}`);
    params.push(normalizeState(query.estado));
    index += 1;
  }

  if (query?.metodo_pago) {
    filters.push(`upper(coalesce(v.metodo_pago, '')) = $${index}`);
    params.push(normalizeState(query.metodo_pago));
    index += 1;
  }

  if (query?.tipo_venta) {
    filters.push(`upper(coalesce(v.tipo_venta, '')) = $${index}`);
    params.push(normalizeState(query.tipo_venta));
    index += 1;
  }

  if (query?.estado_reversion) {
    filters.push(`upper(coalesce(v.estado_reversion, 'SIN_REVERSION')) = $${index}`);
    params.push(normalizeState(query.estado_reversion));
    index += 1;
  }

  if (query?.desde) {
    filters.push(`v.fecha_venta::date >= $${index}::date`);
    params.push(String(query.desde).trim());
    index += 1;
  }

  if (query?.hasta) {
    filters.push(`v.fecha_venta::date <= $${index}::date`);
    params.push(String(query.hasta).trim());
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(v.numero_comprobante, '') ilike $${index} or coalesce(c.nombre, '') ilike $${index} or coalesce(u.username, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await conn.query(
    `
      select
        v.*,
        coalesce(v.monto_revertido, 0) as monto_revertido,
        upper(coalesce(v.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
        greatest(coalesce(v.total, 0) - coalesce(v.monto_revertido, 0), 0) as total_neto,
        c.nombre as cliente_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        (
          select count(*)::int
          from venta_detalles vd
          where vd.id_empresa = v.id_empresa
            and vd.id_venta = v.id_venta
        ) as total_items,
        (
          select coalesce(sum(vd.cantidad), 0)
          from venta_detalles vd
          where vd.id_empresa = v.id_empresa
            and vd.id_venta = v.id_venta
        ) as total_unidades
      from ventas v
      inner join usuarios u
        on u.id_empresa = v.id_empresa
       and u.id_usuario = v.id_usuario
      left join clientes c
        on c.id_empresa = v.id_empresa
       and c.id_cliente = v.id_cliente
      where ${filters.join(" and ")}
      order by v.fecha_venta desc, v.id_venta desc
      limit $${index}
    `,
    params
  );

  return result.rows.map((row) => ({
    ...normalizeSaleRow(row),
    total_items: Number(row.total_items || 0),
    total_unidades: roundQuantity(row.total_unidades),
  }));
};

export const createVenta = async ({ auth, scope, body, requestMeta = null }) =>
  runInTransaction(
    async (client) => {
      const items = Array.isArray(body?.items) ? body.items : [];
      const tipoVenta = String(body?.tipo_venta || "CONTADO").trim().toUpperCase();
      const metodoPago = String(body?.metodo_pago || "EFECTIVO")
        .trim()
        .toUpperCase();
      const noCobrar = body?.no_cobrar === true || body?.no_cobrar === "true";
      const isCredit =
        !noCobrar &&
        isCreditSale({
          tipo_venta: tipoVenta,
          metodo_pago: metodoPago,
        });
      const diasCredito = resolveCreditDays(body?.dias_credito);
      const fechaOperacion = new Date();
      const idBodega = await getDefaultWarehouseId(client, { auth, scope });

      if (items.length === 0) {
        throw HttpError.badRequest("Debes enviar al menos un item");
      }

      // Flujo NO_COBRADO: cliente se va sin pagar con autorizacion admin.
      // Requiere motivo explicito y firma de admin (o que quien factura sea admin).
      let noCobradoMotivo = null;
      let noCobradoAutorizadoPor = null;
      if (noCobrar) {
        noCobradoMotivo = String(body?.no_cobrado_motivo || "").trim();
        if (!noCobradoMotivo) {
          throw HttpError.badRequest(
            "Las ventas marcadas como NO_COBRADO requieren no_cobrado_motivo"
          );
        }
        const adminAuth = await verifyAdminAuthorization(client, {
          auth,
          body,
          requireAlways: true,
          noteField: "no_cobrado_motivo",
        });
        noCobradoAutorizadoPor = adminAuth.authorizedBy;
      }

      await assertPeriodOpen(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "VENTAS",
        fechaOperacion,
      });

      if (isCredit) {
        ensureFinanceModuleEnabled(auth);
      }

      await ensureClient(client, {
        idEmpresa: auth.id_empresa,
        idCliente: body?.id_cliente ? Number(body.id_cliente) : null,
      });

      if (isCredit && !body?.id_cliente) {
        throw HttpError.badRequest(
          "Las ventas a credito requieren un cliente asociado"
        );
      }

      const cajaSesion = await getCajaSesionActivaForVenta(client, {
        auth,
        scope,
      });

      if (!cajaSesion) {
        throw HttpError.badRequest(
          "Debes abrir una caja en la sucursal activa antes de registrar ventas"
        );
      }

      const comprobante = await getNextComprobante(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        tipoComprobante: body?.tipo_comprobante,
        actorId: auth.id_usuario,
      });
      const fechaVencimiento = isCredit
        ? resolveDueDate({
            baseDate: fechaOperacion,
            providedDueDate: body?.fecha_vencimiento,
            creditDays: diasCredito,
          })
        : null;

      // Multi-moneda: resolver moneda de la venta y tasa al momento.
      const monedaBase = await getMonedaBase({ idEmpresa: auth.id_empresa });
      const monedaVenta = String(body?.moneda || monedaBase).toUpperCase();
      const tasaCambio =
        monedaVenta === monedaBase
          ? 1
          : await getTasaVigente({
              idEmpresa: auth.id_empresa,
              monedaOrigen: monedaVenta,
              fecha: fechaOperacion,
            });

      const headerResult = await client.query(
        `
          insert into ventas (
            id_empresa,
            id_sucursal,
            id_usuario,
            id_cliente,
            id_caja_sesion,
            numero_comprobante,
            tipo_comprobante,
            tipo_venta,
            metodo_pago,
            estado,
            subtotal,
            descuento,
            impuesto,
            total,
            monto_recibido,
            cambio,
            dias_credito,
            fecha_vencimiento,
            saldo_pendiente,
            observaciones,
            no_cobrado_motivo,
            no_cobrado_autorizado_por,
            no_cobrado_autorizado_en,
            moneda,
            tasa_cambio,
            created_by,
            updated_by
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$14,0,0,0,0,$10,0,$11,$12::date,0,$13,
            $15, $16::bigint,
            case when $16::bigint is not null then now() else null end,
            $17, $18,
            $3,$3
          )
          returning id_venta
        `,
        [
          auth.id_empresa,
          scope.id_sucursal,
          auth.id_usuario,
          body?.id_cliente ? Number(body.id_cliente) : null,
          Number(cajaSesion.id_caja_sesion),
          comprobante.numero_comprobante,
          comprobante.tipo_comprobante,
          tipoVenta,
          noCobrar ? "NO_COBRADO" : metodoPago,
          !isCredit && !noCobrar && body?.monto_recibido != null
            ? Number(body.monto_recibido)
            : null,
          diasCredito,
          fechaVencimiento,
          body?.observaciones || null,
          noCobrar ? "NO_COBRADO" : "CONFIRMADA",
          noCobradoMotivo,
          noCobradoAutorizadoPor,
          monedaVenta,
          tasaCambio,
        ]
      );

      const ventaId = headerResult.rows[0].id_venta;
      let subtotal = 0;

      for (const item of items) {
        const idProducto = Number(item?.id_producto);
        const cantidad = roundQuantity(item?.cantidad);

        if (!Number.isInteger(idProducto) || idProducto <= 0) {
          throw HttpError.badRequest("id_producto invalido en items");
        }

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw HttpError.badRequest("cantidad invalida en items");
        }

        const productResult = await client.query(
          `
            select
              p.id_producto,
              p.nombre,
              p.precio_venta,
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

        if (stockBefore < cantidad) {
          throw HttpError.badRequest(
            `Stock insuficiente para ${product.nombre}. Disponible: ${stockBefore}`
          );
        }

        const stockAfter = roundQuantity(stockBefore - cantidad);
        const precioUnitario = roundMoney(product.precio_venta);
        const costoUnitario = roundMoney(product.precio_compra);
        const itemSubtotal = roundMoney(precioUnitario * cantidad);
        const utilidad = roundMoney((precioUnitario - costoUnitario) * cantidad);
        subtotal += itemSubtotal;

        await client.query(
          `
            insert into venta_detalles (
              id_empresa,
              id_venta,
              id_producto,
              cantidad,
              precio_unitario,
              descuento,
              subtotal,
              costo_unitario,
              utilidad,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$9)
          `,
          [
            auth.id_empresa,
            ventaId,
            idProducto,
            cantidad,
            precioUnitario,
            itemSubtotal,
            costoUnitario,
            utilidad,
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
            values ($1,$2,$3,$4,$5,'SALIDA','VENTA',$6,$7,$8,$9,$10,$5,$5)
          `,
          [
            auth.id_empresa,
            scope.id_sucursal,
            idBodega,
            idProducto,
            auth.id_usuario,
            ventaId,
            cantidad,
            stockBefore,
            stockAfter,
            `Venta ${comprobante.numero_comprobante}`,
          ]
        );
      }

      const total = roundMoney(subtotal);
      const montoRecibidoInput =
        body?.monto_recibido != null && body?.monto_recibido !== ""
          ? roundMoney(body.monto_recibido)
          : null;
      const montoRecibido =
        metodoPago === "EFECTIVO" && montoRecibidoInput == null
          ? total
          : montoRecibidoInput;

      if (
        metodoPago === "EFECTIVO" &&
        montoRecibido != null &&
        montoRecibido < total
      ) {
        throw HttpError.badRequest(
          "El monto recibido no cubre el total de la venta"
        );
      }

      const cambio =
        metodoPago === "EFECTIVO" && montoRecibido != null
          ? roundMoney(Math.max(0, montoRecibido - total))
          : 0;

      await client.query(
        `
          update ventas
          set subtotal = $1,
              total = $2,
              monto_recibido = $3,
              cambio = $4,
              saldo_pendiente = $5,
              updated_by = $6
          where id_empresa = $7
            and id_venta = $8
        `,
        [
          total,
          total,
          noCobrar || isCredit ? null : montoRecibido,
          noCobrar || isCredit ? 0 : cambio,
          isCredit ? total : 0,
          auth.id_usuario,
          auth.id_empresa,
          ventaId,
        ]
      );

      // NO_COBRADO no genera ingreso a caja (el dinero no entro).
      if (metodoPago === "EFECTIVO" && !isCredit && !noCobrar) {
        await client.query(
          `
            insert into caja_movimientos (
              id_empresa,
              id_caja_sesion,
              id_sucursal,
              id_usuario,
              tipo,
              categoria,
              monto,
              descripcion,
              referencia_tipo,
              referencia_id,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,'INGRESO','VENTA_EFECTIVO',$5,$6,'VENTA',$7,$4,$4)
          `,
          [
            auth.id_empresa,
            Number(cajaSesion.id_caja_sesion),
            scope.id_sucursal,
            auth.id_usuario,
            total,
            `Cobro venta ${comprobante.numero_comprobante}`,
            ventaId,
          ]
        );
      }

      if (isCredit && !noCobrar) {
        await upsertCuentaPorCobrarFromVenta(client, {
          auth,
          ventaId,
          actorId: auth.id_usuario,
        });
      }

      const created = await getVentaCompleta(client, auth, ventaId);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "VENTA",
        entidad: "VENTA",
        entidadId: ventaId,
        accion: "CREATE",
        despues: created.venta,
      });

      ventasCreated.inc({
        empresa: String(auth.id_empresa),
        tipo_venta: tipoVenta,
        metodo_pago: noCobrar ? "NO_COBRADO" : metodoPago,
        estado: noCobrar ? "NO_COBRADO" : "CONFIRMADA",
      });

      // Webhook outbound (best-effort, async)
      triggerWebhook({
        idEmpresa: auth.id_empresa,
        tipoEvento: "venta.creada",
        payload: {
          id_venta: ventaId,
          numero_comprobante: created.venta?.numero_comprobante,
          total: Number(created.venta?.total || 0),
          tipo_venta: tipoVenta,
          metodo_pago: noCobrar ? "NO_COBRADO" : metodoPago,
          estado: noCobrar ? "NO_COBRADO" : "CONFIRMADA",
          id_cliente: body?.id_cliente ? Number(body.id_cliente) : null,
        },
      }).catch(() => {});

      // Acumular puntos de fidelidad (si activo y hay cliente)
      if (!noCobrar && body?.id_cliente) {
        try {
          await acumularFidelidad(client, {
            idEmpresa: auth.id_empresa,
            idCliente: Number(body.id_cliente),
            idVenta: ventaId,
            total: Number(created.venta?.total || 0),
            actorId: auth.id_usuario,
          });
        } catch (e) {
          // best-effort: no bloquea la venta
        }
      }

      // Registrar uso de promociones (si vinieron en body)
      if (Array.isArray(body?.promociones_aplicadas) && body.promociones_aplicadas.length > 0) {
        try {
          await registerPromotionUses(client, {
            idEmpresa: auth.id_empresa,
            idVenta: ventaId,
            idCliente: body?.id_cliente ? Number(body.id_cliente) : null,
            aplicadas: body.promociones_aplicadas,
          });
        } catch (e) {
          // ya quedo en venta.descuento_promocional; solo se pierde el log
        }
      }

      // Notificaciones (best-effort, no bloquea la venta)
      const totalNum = Number(created.venta?.total || 0);
      if (noCobrar) {
        notify({
          idEmpresa: auth.id_empresa,
          tipoEvento: "NO_COBRADO",
          payload: {
            numero: created.venta?.numero_comprobante,
            total: totalNum,
            motivo: noCobradoMotivo,
            cajero: auth.id_usuario,
          },
        }).catch(() => {});
      } else if (totalNum >= Number(process.env.NOTIF_VENTA_GRANDE_UMBRAL || 5000)) {
        notify({
          idEmpresa: auth.id_empresa,
          tipoEvento: "VENTA_GRANDE",
          payload: {
            numero: created.venta?.numero_comprobante,
            total: totalNum,
            cajero: auth.id_usuario,
          },
        }).catch(() => {});
      }

      return created;
    },
    { auth }
  );

export const createVentaReversion = async ({
  auth,
  scope,
  idVenta,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      await assertPeriodOpen(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        area: "VENTAS",
        fechaOperacion: new Date(),
      });

      const venta = await getVentaHeaderForUpdate(client, {
        auth,
        scope,
        idVenta,
      });

      if (normalizeState(venta.estado_reversion) === "TOTAL") {
        throw HttpError.badRequest("La venta ya fue revertida totalmente");
      }

      const motivo = normalizeText(body?.motivo);
      const idBodega = await getDefaultWarehouseId(client, { auth, scope });
      if (!motivo) {
        throw HttpError.badRequest("motivo es requerido");
      }

      const items = Array.isArray(body?.items) ? body.items : [];
      if (items.length === 0) {
        throw HttpError.badRequest("Debes enviar al menos un item a revertir");
      }

      const reversalType = normalizeState(body?.tipo_reversion || "DEVOLUCION");
      if (!REVERSAL_TYPES.includes(reversalType)) {
        throw HttpError.badRequest("tipo_reversion es invalido");
      }

      const reintegrarStock =
        body?.reintegrar_stock !== undefined
          ? body.reintegrar_stock === true ||
            String(body.reintegrar_stock).trim().toLowerCase() === "true"
          : true;

      const resolutionMethod =
        reversalType === "NOTA_CREDITO"
          ? "NOTA_CREDITO"
          : normalizeState(body?.metodo_resolucion || "AJUSTE");

      if (!REVERSAL_METHODS.includes(resolutionMethod)) {
        throw HttpError.badRequest("metodo_resolucion es invalido");
      }

      const detailRows = await getSaleDetailsForReversion(client, {
        auth,
        idVenta,
      });
      const detailMap = new Map(
        detailRows.map((row) => [Number(row.id_venta_detalle), row])
      );

      const documentNumber = await getNextReversionDocument(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        reversalType,
        actorId: auth.id_usuario,
      });

      const headerResult = await client.query(
        `
          insert into venta_reversiones (
            id_empresa,
            id_venta,
            id_sucursal,
            id_usuario,
            tipo_reversion,
            numero_documento,
            metodo_resolucion,
            motivo,
            reintegrar_stock,
            total,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$4,$4)
          returning id_venta_reversion
        `,
        [
          auth.id_empresa,
          idVenta,
          scope.id_sucursal,
          auth.id_usuario,
          reversalType,
          documentNumber,
          resolutionMethod,
          motivo,
          reintegrarStock,
        ]
      );

      const idVentaReversion = Number(headerResult.rows[0].id_venta_reversion);
      let totalReversion = 0;

      for (const item of items) {
        const idVentaDetalle = Number(item?.id_venta_detalle);
        const cantidad = roundQuantity(item?.cantidad);

        if (!Number.isInteger(idVentaDetalle) || idVentaDetalle <= 0) {
          throw HttpError.badRequest("id_venta_detalle es invalido");
        }

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw HttpError.badRequest("cantidad es invalida");
        }

        const detail = detailMap.get(idVentaDetalle);

        if (!detail) {
          throw HttpError.badRequest(
            `El detalle ${idVentaDetalle} no pertenece a la venta`
          );
        }

        if (cantidad > Number(detail.cantidad_disponible_reversion || 0)) {
          throw HttpError.badRequest(
            `La cantidad excede lo disponible para ${detail.producto_nombre}`
          );
        }

        const subtotal = roundMoney(cantidad * Number(detail.precio_unitario || 0));
        totalReversion += subtotal;

        await client.query(
          `
            insert into venta_reversion_detalles (
              id_empresa,
              id_venta_reversion,
              id_venta_detalle,
              id_producto,
              cantidad,
              precio_unitario,
              costo_unitario,
              subtotal,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
          `,
          [
            auth.id_empresa,
            idVentaReversion,
            idVentaDetalle,
            Number(detail.id_producto),
            cantidad,
            roundMoney(detail.precio_unitario),
            roundMoney(detail.costo_unitario),
            subtotal,
            auth.id_usuario,
          ]
        );

        if (reintegrarStock) {
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
          const stockAfter = roundQuantity(stockBefore + cantidad);

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
              values ($1,$2,$3,$4,$5,'ENTRADA','VENTA_REVERSION',$6,$7,$8,$9,$10,$5,$5)
            `,
            [
              auth.id_empresa,
              scope.id_sucursal,
              idBodega,
              detail.id_producto,
              auth.id_usuario,
              idVentaReversion,
              cantidad,
              stockBefore,
              stockAfter,
              `${reversalType} ${documentNumber}`,
            ]
          );
        }
      }

      let idCajaSesion = null;

      if (resolutionMethod === "EFECTIVO" && totalReversion > 0) {
        const cajaSesion = await getCajaSesionActivaForVenta(client, {
          auth,
          scope,
        });

        if (!cajaSesion) {
          throw HttpError.badRequest(
            "Debes abrir una caja en la sucursal activa para devolver efectivo"
          );
        }

        idCajaSesion = Number(cajaSesion.id_caja_sesion);

        await client.query(
          `
            insert into caja_movimientos (
              id_empresa,
              id_caja_sesion,
              id_sucursal,
              id_usuario,
              tipo,
              categoria,
              monto,
              descripcion,
              referencia_tipo,
              referencia_id,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,'EGRESO','VENTA_DEVOLUCION',$5,$6,'VENTA_REVERSION',$7,$4,$4)
          `,
          [
            auth.id_empresa,
            idCajaSesion,
            scope.id_sucursal,
            auth.id_usuario,
            roundMoney(totalReversion),
            `${reversalType} ${documentNumber} sobre ${venta.numero_comprobante}`,
            idVentaReversion,
          ]
        );
      }

      await client.query(
        `
          update venta_reversiones
          set total = $1,
              id_caja_sesion = $2,
              updated_by = $3
          where id_venta_reversion = $4
        `,
        [roundMoney(totalReversion), idCajaSesion, auth.id_usuario, idVentaReversion]
      );

      const totalRevertido = roundMoney(
        Number(venta.monto_revertido || 0) + totalReversion
      );
      const saldoPendienteActual = roundMoney(
        Number(venta.saldo_pendiente || 0)
      );
      const saldoPendienteNuevo = isCreditSale(venta)
        ? roundMoney(Math.max(0, saldoPendienteActual - totalReversion))
        : 0;
      const estadoReversion = getSaleReversionState({
        total: venta.total,
        reverted: totalRevertido,
      });

      await client.query(
        `
          update ventas
          set monto_revertido = $1,
              estado_reversion = $2,
              fecha_ultima_reversion = now(),
              saldo_pendiente = $3,
              updated_by = $4
          where id_empresa = $5
            and id_venta = $6
        `,
        [
          totalRevertido,
          estadoReversion,
          saldoPendienteNuevo,
          auth.id_usuario,
          auth.id_empresa,
          idVenta,
        ]
      );

      if (isCreditSale(venta)) {
        await upsertCuentaPorCobrarFromVenta(client, {
          auth,
          ventaId: idVenta,
          actorId: auth.id_usuario,
          movementType:
            reversalType === "NOTA_CREDITO"
              ? "NOTA_CREDITO"
              : "VENTA_REVERSION",
          movementDate: new Date(),
        });
      }

      const updated = await getVentaCompleta(client, auth, idVenta);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "VENTA",
        entidad: "VENTA_REVERSION",
        entidadId: idVentaReversion,
        accion: "CREATE",
        antes: {
          numero_comprobante: venta.numero_comprobante,
          monto_revertido: roundMoney(venta.monto_revertido),
          estado_reversion: venta.estado_reversion,
        },
        despues: updated.venta,
      });

      ventasReversiones.inc({
        empresa: String(auth.id_empresa),
        tipo_reversion: reversalType,
        metodo_resolucion: resolutionMethod,
      });

      // NOTA_CREDITO formal: certificar contra el SAT/regulador (best-effort).
      // Si la empresa no tiene FE activa, la llamada lanza HttpError 400 y
      // simplemente seguimos (la reversion operativa queda registrada).
      if (String(reversalType).toUpperCase() === "NOTA_CREDITO") {
        try {
          await certifyNotaCredito({
            auth,
            idVentaReversion,
            clientOverride: client,
          });
        } catch (feError) {
          // No bloquea la reversion. El admin puede reintentar la cert despues
          // via POST /fe/notas-credito/:idReversion/certificar.
        }
      }

      return updated;
    },
    { auth }
  );

export const getVentaById = async ({ db, auth, idVenta }) =>
  getVentaCompleta(resolveDb(db), auth, idVenta);
