import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const DEFAULT_TOP_LIMIT = 8;
const DEFAULT_STOCK_LIMIT = 12;
const DEFAULT_RANGE_DAYS = 7;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const NET_SALE_TOTAL_SQL =
  "greatest(coalesce(v.total, 0) - coalesce(v.monto_revertido, 0), 0)";
const NET_PURCHASE_TOTAL_SQL =
  "greatest(coalesce(c.total, 0) - coalesce(c.monto_revertido, 0), 0)";

/**
 * CTE estandar de utilidad neta por venta:
 *   utilidad_estimada = utilidad_bruta(venta_detalles) - utilidad_revertida(venta_reversion_detalles)
 *
 * Importante: la utilidad revertida se calcula como cantidad * (precio - costo)
 * de cada linea revertida. Asi una reversion parcial baja la utilidad solo
 * en la proporcion correspondiente.
 *
 * Se utiliza con el parametro $1 = id_empresa en los reportes que ya filtran
 * por empresa antes de cualquier otra clausula.
 */
const UTILIDAD_POR_VENTA_CTE = `
  utilidad_bruta_por_venta as (
    select
      vd.id_empresa,
      vd.id_venta,
      coalesce(sum(vd.utilidad), 0) as utilidad_bruta
    from venta_detalles vd
    where vd.id_empresa = $1
    group by vd.id_empresa, vd.id_venta
  ),
  utilidad_revertida_por_venta as (
    select
      vrd.id_empresa,
      vr.id_venta,
      coalesce(
        sum(vrd.cantidad * (coalesce(vrd.precio_unitario, 0) - coalesce(vrd.costo_unitario, 0))),
        0
      ) as utilidad_revertida
    from venta_reversion_detalles vrd
    inner join venta_reversiones vr
      on vr.id_empresa = vrd.id_empresa
     and vr.id_venta_reversion = vrd.id_venta_reversion
    where vrd.id_empresa = $1
    group by vrd.id_empresa, vr.id_venta
  ),
  utilidad_por_venta as (
    select
      ub.id_empresa,
      ub.id_venta,
      greatest(ub.utilidad_bruta - coalesce(urv.utilidad_revertida, 0), 0) as utilidad_estimada
    from utilidad_bruta_por_venta ub
    left join utilidad_revertida_por_venta urv
      on urv.id_empresa = ub.id_empresa
     and urv.id_venta = ub.id_venta
  )
`;

const toNumber = (value) => Number(value || 0);
const toInteger = (value) => Math.trunc(Number(value || 0));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeView = (value) =>
  String(value || "EMPRESA").trim().toUpperCase() === "SUCURSAL"
    ? "SUCURSAL"
    : "EMPRESA";

const buildIsoDate = (date) => date.toISOString().slice(0, 10);

const shiftIsoDate = (isoDate, offsetDays) => {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return buildIsoDate(base);
};

const getDateRange = (query) => {
  const defaultHasta = buildIsoDate(new Date());
  const hasta = String(query?.hasta || defaultHasta).trim();

  if (!ISO_DATE_PATTERN.test(hasta)) {
    throw HttpError.badRequest("hasta debe tener formato YYYY-MM-DD");
  }

  const defaultDesde = shiftIsoDate(hasta, -(DEFAULT_RANGE_DAYS - 1));
  const desde = String(query?.desde || defaultDesde).trim();

  if (!ISO_DATE_PATTERN.test(desde)) {
    throw HttpError.badRequest("desde debe tener formato YYYY-MM-DD");
  }

  if (desde > hasta) {
    throw HttpError.badRequest("desde no puede ser mayor que hasta");
  }

  return { desde, hasta };
};

const getPositiveInteger = (value, fallback, { min = 1, max = 100 } = {}) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
};

const mapNumericFields = (row, numericFields = [], integerFields = []) => {
  const nextRow = { ...row };

  for (const field of numericFields) {
    nextRow[field] = toNumber(nextRow[field]);
  }

  for (const field of integerFields) {
    nextRow[field] = toInteger(nextRow[field]);
  }

  return nextRow;
};

const getCompanyProfile = async (idEmpresa) => {
  const result = await pool.query(
    `
      select id_empresa, nombre_legal, timezone
      from empresas
      where id_empresa = $1
      limit 1
    `,
    [idEmpresa]
  );

  const company = result.rows[0];

  if (!company) {
    throw HttpError.notFound("Empresa no encontrada");
  }

  return company;
};

const getVisibleBranches = async ({
  auth,
  scope,
  requestedBranchId,
  requestedView,
}) => {
  const currentRole = normalizeRole(auth.rol);
  const isPrivileged = PRIVILEGED_ROLES.has(currentRole);
  const assignedBranchIds = Array.isArray(auth.sucursales)
    ? [...new Set(auth.sucursales.map(Number).filter(Number.isInteger))]
    : [];

  if (!isPrivileged && assignedBranchIds.length === 0) {
    throw HttpError.forbidden("El usuario no tiene sucursales asignadas");
  }

  const effectiveBranchId =
    requestedBranchId ||
    Number(scope?.id_sucursal || auth.id_sucursal || 0) ||
    assignedBranchIds[0];

  if (!Number.isInteger(effectiveBranchId) || effectiveBranchId <= 0) {
    throw HttpError.badRequest("No se pudo resolver la sucursal del reporte");
  }

  if (!isPrivileged && !assignedBranchIds.includes(effectiveBranchId)) {
    throw HttpError.forbidden("No tienes acceso a la sucursal solicitada");
  }

  let branchRows = [];
  let resolvedView = requestedView;

  if (requestedView === "SUCURSAL" || requestedBranchId) {
    resolvedView = "SUCURSAL";
    const params = [auth.id_empresa, effectiveBranchId];
    let whereSql = `
      where s.id_empresa = $1
        and s.id_sucursal = $2
    `;

    if (!isPrivileged) {
      params.push(assignedBranchIds);
      whereSql += `
        and s.id_sucursal = any($3::bigint[])
      `;
    }

    const result = await pool.query(
      `
        select s.id_sucursal, s.codigo, s.nombre, s.activa, s.es_principal
        from sucursales s
        ${whereSql}
        limit 1
      `,
      params
    );

    branchRows = result.rows;
  } else if (isPrivileged) {
    const result = await pool.query(
      `
        select s.id_sucursal, s.codigo, s.nombre, s.activa, s.es_principal
        from sucursales s
        where s.id_empresa = $1
        order by s.es_principal desc, s.nombre asc
      `,
      [auth.id_empresa]
    );

    branchRows = result.rows;
  } else {
    const result = await pool.query(
      `
        select s.id_sucursal, s.codigo, s.nombre, s.activa, s.es_principal
        from sucursales s
        where s.id_empresa = $1
          and s.id_sucursal = any($2::bigint[])
        order by s.es_principal desc, s.nombre asc
      `,
      [auth.id_empresa, assignedBranchIds]
    );

    branchRows = result.rows;
  }

  if (branchRows.length === 0) {
    throw HttpError.notFound(
      "No se encontraron sucursales para el alcance solicitado"
    );
  }

  return {
    branchRows,
    branchIds: branchRows.map((branch) => Number(branch.id_sucursal)),
    resolvedView,
    isPrivileged,
  };
};

const getSummary = async ({ idEmpresa, desde, hasta, branchIds }) => {
  const result = await pool.query(
    `
      with ${UTILIDAD_POR_VENTA_CTE},
      ventas_resumen as (
        select
          count(*)::int as ventas_cantidad,
          coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total_ventas,
          coalesce(avg(${NET_SALE_TOTAL_SQL}), 0) as ticket_promedio,
          coalesce(sum(case when upper(coalesce(v.metodo_pago, '')) = 'EFECTIVO' then ${NET_SALE_TOTAL_SQL} else 0 end), 0) as total_efectivo,
          coalesce(sum(case when upper(coalesce(v.metodo_pago, '')) = 'TARJETA' then ${NET_SALE_TOTAL_SQL} else 0 end), 0) as total_tarjeta,
          coalesce(sum(case when upper(coalesce(v.metodo_pago, '')) = 'TRANSFERENCIA' then ${NET_SALE_TOTAL_SQL} else 0 end), 0) as total_transferencia,
          coalesce(sum(case when upper(coalesce(v.tipo_venta, '')) = 'CREDITO' or upper(coalesce(v.metodo_pago, '')) = 'CREDITO' then ${NET_SALE_TOTAL_SQL} else 0 end), 0) as total_credito,
          coalesce(sum(coalesce(upv.utilidad_estimada, 0)), 0) as utilidad_estimada
        from ventas v
        left join utilidad_por_venta upv
          on upv.id_empresa = v.id_empresa
         and upv.id_venta = v.id_venta
        where v.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
      ),
      compras_resumen as (
        select
          count(*)::int as compras_cantidad,
          coalesce(sum(${NET_PURCHASE_TOTAL_SQL}), 0) as total_compras
        from compras c
        where c.id_empresa = $1
          and c.fecha_compra::date >= $2::date
          and c.fecha_compra::date <= $3::date
          and c.id_sucursal = any($4::bigint[])
          and upper(coalesce(c.estado, '')) <> 'ANULADA'
      ),
      stock_resumen as (
        select count(*)::int as productos_stock_bajo
        from stock_sucursal ss
        inner join productos p
          on p.id_empresa = ss.id_empresa
         and p.id_producto = ss.id_producto
        where ss.id_empresa = $1
          and ss.id_sucursal = any($4::bigint[])
          and p.activo = true
          and coalesce(ss.stock_minimo, 0) > 0
          and coalesce(ss.stock_actual, 0) <= coalesce(ss.stock_minimo, 0)
      ),
      caja_resumen as (
        select count(*)::int as cajas_abiertas
        from caja_sesiones cs
        where cs.id_empresa = $1
          and cs.id_sucursal = any($4::bigint[])
          and upper(coalesce(cs.estado, '')) = 'ABIERTA'
      )
      select
        vr.ventas_cantidad,
        cr.compras_cantidad,
        vr.total_ventas,
        cr.total_compras,
        vr.utilidad_estimada,
        vr.ticket_promedio,
        vr.total_efectivo,
        vr.total_tarjeta,
        vr.total_transferencia,
        vr.total_credito,
        sr.productos_stock_bajo,
        caj.cajas_abiertas
      from ventas_resumen vr
      cross join compras_resumen cr
      cross join stock_resumen sr
      cross join caja_resumen caj
    `,
    [idEmpresa, desde, hasta, branchIds]
  );

  return mapNumericFields(
    result.rows[0] || {},
    [
      "total_ventas",
      "total_compras",
      "utilidad_estimada",
      "ticket_promedio",
      "total_efectivo",
      "total_tarjeta",
      "total_transferencia",
      "total_credito",
    ],
    [
      "ventas_cantidad",
      "compras_cantidad",
      "productos_stock_bajo",
      "cajas_abiertas",
    ]
  );
};

const getVentasByDay = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  timezone,
}) => {
  const result = await pool.query(
    `
      with dias as (
        select generate_series($2::date, $3::date, interval '1 day')::date as fecha
      ),
      ${UTILIDAD_POR_VENTA_CTE},
      ventas_diarias as (
        select
          date(timezone($5, v.fecha_venta)) as fecha,
          count(*)::int as ventas_cantidad,
          coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total_ventas,
          coalesce(sum(coalesce(upv.utilidad_estimada, 0)), 0) as utilidad_estimada
        from ventas v
        left join utilidad_por_venta upv
          on upv.id_empresa = v.id_empresa
         and upv.id_venta = v.id_venta
        where v.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
        group by date(timezone($5, v.fecha_venta))
      )
      select
        to_char(d.fecha, 'YYYY-MM-DD') as fecha,
        coalesce(vd.ventas_cantidad, 0)::int as ventas_cantidad,
        coalesce(vd.total_ventas, 0) as total_ventas,
        coalesce(vd.utilidad_estimada, 0) as utilidad_estimada
      from dias d
      left join ventas_diarias vd
        on vd.fecha = d.fecha
      order by d.fecha asc
    `,
    [idEmpresa, desde, hasta, branchIds, timezone]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_ventas", "utilidad_estimada"],
      ["ventas_cantidad"]
    )
  );
};

const getComprasByDay = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  timezone,
}) => {
  const result = await pool.query(
    `
      with dias as (
        select generate_series($2::date, $3::date, interval '1 day')::date as fecha
      ),
      compras_diarias as (
        select
          date(timezone($5, c.fecha_compra)) as fecha,
          count(*)::int as compras_cantidad,
          coalesce(sum(${NET_PURCHASE_TOTAL_SQL}), 0) as total_compras
        from compras c
        where c.id_empresa = $1
          and c.fecha_compra::date >= $2::date
          and c.fecha_compra::date <= $3::date
          and c.id_sucursal = any($4::bigint[])
          and upper(coalesce(c.estado, '')) <> 'ANULADA'
        group by date(timezone($5, c.fecha_compra))
      )
      select
        to_char(d.fecha, 'YYYY-MM-DD') as fecha,
        coalesce(cd.compras_cantidad, 0)::int as compras_cantidad,
        coalesce(cd.total_compras, 0) as total_compras
      from dias d
      left join compras_diarias cd
        on cd.fecha = d.fecha
      order by d.fecha asc
    `,
    [idEmpresa, desde, hasta, branchIds, timezone]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["total_compras"], ["compras_cantidad"])
  );
};

const getPaymentMethods = async ({ idEmpresa, desde, hasta, branchIds }) => {
  const result = await pool.query(
    `
      select
        upper(coalesce(v.metodo_pago, 'SIN_DEFINIR')) as metodo_pago,
        count(*)::int as ventas_cantidad,
        coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total
      from ventas v
      where v.id_empresa = $1
        and v.fecha_venta::date >= $2::date
        and v.fecha_venta::date <= $3::date
        and v.id_sucursal = any($4::bigint[])
        and upper(coalesce(v.estado, '')) <> 'ANULADA'
      group by upper(coalesce(v.metodo_pago, 'SIN_DEFINIR'))
      order by total desc, metodo_pago asc
    `,
    [idEmpresa, desde, hasta, branchIds]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["total"], ["ventas_cantidad"])
  );
};

const getTopProducts = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  limit,
}) => {
  // Para cada producto descontamos las cantidades, subtotales y utilidades
  // que fueron revertidas dentro del rango de fechas. La utilidad revertida
  // por linea es cantidad * (precio - costo) de venta_reversion_detalles.
  const result = await pool.query(
    `
      with reversiones_por_producto as (
        select
          vrd.id_empresa,
          vrd.id_producto,
          coalesce(sum(vrd.cantidad), 0) as cantidad_revertida,
          coalesce(sum(vrd.subtotal), 0) as subtotal_revertido,
          coalesce(
            sum(vrd.cantidad * (coalesce(vrd.precio_unitario, 0) - coalesce(vrd.costo_unitario, 0))),
            0
          ) as utilidad_revertida
        from venta_reversion_detalles vrd
        inner join venta_reversiones vr
          on vr.id_empresa = vrd.id_empresa
         and vr.id_venta_reversion = vrd.id_venta_reversion
        inner join ventas v
          on v.id_empresa = vr.id_empresa
         and v.id_venta = vr.id_venta
        where vrd.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
        group by vrd.id_empresa, vrd.id_producto
      ),
      ventas_por_producto as (
        select
          vd.id_empresa,
          vd.id_producto,
          coalesce(sum(vd.cantidad), 0) as cantidad_vendida_bruta,
          coalesce(sum(vd.subtotal), 0) as total_ventas_bruto,
          coalesce(sum(vd.utilidad), 0) as utilidad_bruta
        from venta_detalles vd
        inner join ventas v
          on v.id_empresa = vd.id_empresa
         and v.id_venta = vd.id_venta
        where vd.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
        group by vd.id_empresa, vd.id_producto
      )
      select
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre as producto_nombre,
        greatest(vpp.cantidad_vendida_bruta - coalesce(rpp.cantidad_revertida, 0), 0) as cantidad_vendida,
        greatest(vpp.total_ventas_bruto - coalesce(rpp.subtotal_revertido, 0), 0) as total_ventas,
        greatest(vpp.utilidad_bruta - coalesce(rpp.utilidad_revertida, 0), 0) as utilidad_estimada
      from ventas_por_producto vpp
      inner join productos p
        on p.id_empresa = vpp.id_empresa
       and p.id_producto = vpp.id_producto
      left join reversiones_por_producto rpp
        on rpp.id_empresa = vpp.id_empresa
       and rpp.id_producto = vpp.id_producto
      order by total_ventas desc, cantidad_vendida desc, p.nombre asc
      limit $5
    `,
    [idEmpresa, desde, hasta, branchIds, limit]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["cantidad_vendida", "total_ventas", "utilidad_estimada"])
  );
};

const getLowStock = async ({ idEmpresa, branchIds, limit }) => {
  const result = await pool.query(
    `
      select
        ss.id_sucursal,
        s.codigo as sucursal_codigo,
        s.nombre as sucursal_nombre,
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre,
        coalesce(ss.stock_actual, 0) as stock_actual,
        coalesce(ss.stock_minimo, 0) as stock_minimo,
        greatest(coalesce(ss.stock_minimo, 0) - coalesce(ss.stock_actual, 0), 0) as faltante
      from stock_sucursal ss
      inner join productos p
        on p.id_empresa = ss.id_empresa
       and p.id_producto = ss.id_producto
      inner join sucursales s
        on s.id_empresa = ss.id_empresa
       and s.id_sucursal = ss.id_sucursal
      where ss.id_empresa = $1
        and ss.id_sucursal = any($2::bigint[])
        and p.activo = true
        and coalesce(ss.stock_minimo, 0) > 0
        and coalesce(ss.stock_actual, 0) <= coalesce(ss.stock_minimo, 0)
      order by faltante desc, p.nombre asc
      limit $3
    `,
    [idEmpresa, branchIds, limit]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["stock_actual", "stock_minimo", "faltante"])
  );
};

const getBranchSummary = async ({ idEmpresa, desde, hasta, branchIds }) => {
  const result = await pool.query(
    `
      with ${UTILIDAD_POR_VENTA_CTE},
      ventas_por_sucursal as (
        select
          v.id_sucursal,
          count(*)::int as ventas_cantidad,
          coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total_ventas,
          coalesce(avg(${NET_SALE_TOTAL_SQL}), 0) as ticket_promedio,
          coalesce(sum(coalesce(upv.utilidad_estimada, 0)), 0) as utilidad_estimada
        from ventas v
        left join utilidad_por_venta upv
          on upv.id_empresa = v.id_empresa
         and upv.id_venta = v.id_venta
        where v.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
        group by v.id_sucursal
      ),
      compras_por_sucursal as (
        select
          c.id_sucursal,
          count(*)::int as compras_cantidad,
          coalesce(sum(${NET_PURCHASE_TOTAL_SQL}), 0) as total_compras
        from compras c
        where c.id_empresa = $1
          and c.fecha_compra::date >= $2::date
          and c.fecha_compra::date <= $3::date
          and c.id_sucursal = any($4::bigint[])
          and upper(coalesce(c.estado, '')) <> 'ANULADA'
        group by c.id_sucursal
      ),
      stock_bajo_por_sucursal as (
        select
          ss.id_sucursal,
          count(*)::int as productos_stock_bajo
        from stock_sucursal ss
        inner join productos p
          on p.id_empresa = ss.id_empresa
         and p.id_producto = ss.id_producto
        where ss.id_empresa = $1
          and ss.id_sucursal = any($4::bigint[])
          and p.activo = true
          and coalesce(ss.stock_minimo, 0) > 0
          and coalesce(ss.stock_actual, 0) <= coalesce(ss.stock_minimo, 0)
        group by ss.id_sucursal
      ),
      cajas_abiertas_por_sucursal as (
        select
          cs.id_sucursal,
          count(*)::int as cajas_abiertas
        from caja_sesiones cs
        where cs.id_empresa = $1
          and cs.id_sucursal = any($4::bigint[])
          and upper(coalesce(cs.estado, '')) = 'ABIERTA'
        group by cs.id_sucursal
      )
      select
        s.id_sucursal,
        s.codigo,
        s.nombre,
        s.activa,
        coalesce(vps.ventas_cantidad, 0)::int as ventas_cantidad,
        coalesce(cps.compras_cantidad, 0)::int as compras_cantidad,
        coalesce(vps.total_ventas, 0) as total_ventas,
        coalesce(cps.total_compras, 0) as total_compras,
        coalesce(vps.ticket_promedio, 0) as ticket_promedio,
        coalesce(vps.utilidad_estimada, 0) as utilidad_estimada,
        coalesce(sbps.productos_stock_bajo, 0)::int as productos_stock_bajo,
        coalesce(caps.cajas_abiertas, 0)::int as cajas_abiertas
      from sucursales s
      left join ventas_por_sucursal vps
        on vps.id_sucursal = s.id_sucursal
      left join compras_por_sucursal cps
        on cps.id_sucursal = s.id_sucursal
      left join stock_bajo_por_sucursal sbps
        on sbps.id_sucursal = s.id_sucursal
      left join cajas_abiertas_por_sucursal caps
        on caps.id_sucursal = s.id_sucursal
      where s.id_empresa = $1
        and s.id_sucursal = any($4::bigint[])
      order by total_ventas desc, s.nombre asc
    `,
    [idEmpresa, desde, hasta, branchIds]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_ventas", "total_compras", "ticket_promedio", "utilidad_estimada"],
      [
        "ventas_cantidad",
        "compras_cantidad",
        "productos_stock_bajo",
        "cajas_abiertas",
      ]
    )
  );
};

export const getGeneralReport = async ({ auth, scope, query }) => {
  const { desde, hasta } = getDateRange(query);
  const requestedView = normalizeView(query?.vista);
  const requestedBranchId = query?.id_sucursal
    ? Number(query.id_sucursal)
    : null;

  if (
    query?.id_sucursal &&
    (!Number.isInteger(requestedBranchId) || requestedBranchId <= 0)
  ) {
    throw HttpError.badRequest("id_sucursal invalido");
  }

  const topLimit = getPositiveInteger(query?.top, DEFAULT_TOP_LIMIT, {
    min: 3,
    max: 25,
  });
  const stockLimit = getPositiveInteger(
    query?.stock_limit,
    DEFAULT_STOCK_LIMIT,
    {
      min: 5,
      max: 30,
    }
  );

  const company = await getCompanyProfile(auth.id_empresa);
  const scopeData = await getVisibleBranches({
    auth,
    scope,
    requestedBranchId,
    requestedView,
  });

  const context = {
    idEmpresa: auth.id_empresa,
    desde,
    hasta,
    branchIds: scopeData.branchIds,
    timezone: company.timezone || "America/Guatemala",
  };

  const [
    resumen,
    ventasPorDia,
    comprasPorDia,
    metodosPago,
    topProductos,
    stockBajo,
    sucursalesResumen,
  ] = await Promise.all([
    getSummary(context),
    getVentasByDay(context),
    getComprasByDay(context),
    getPaymentMethods(context),
    getTopProducts({ ...context, limit: topLimit }),
    getLowStock({ ...context, limit: stockLimit }),
    getBranchSummary(context),
  ]);

  return {
    empresa: {
      id_empresa: Number(company.id_empresa),
      nombre_legal: company.nombre_legal,
      timezone: company.timezone || "America/Guatemala",
    },
    rango: {
      desde,
      hasta,
    },
    alcance: {
      vista_solicitada: requestedView,
      vista_resuelta: scopeData.resolvedView,
      restringido_a_sucursales_asignadas: !scopeData.isPrivileged,
      sucursales_consideradas: scopeData.branchRows.map((branch) => ({
        id_sucursal: Number(branch.id_sucursal),
        codigo: branch.codigo,
        nombre: branch.nombre,
        activa: branch.activa,
        es_principal: branch.es_principal,
      })),
    },
    resumen,
    ventas_por_dia: ventasPorDia,
    compras_por_dia: comprasPorDia,
    utilidad_por_dia: ventasPorDia.map((row) => ({
      fecha: row.fecha,
      utilidad_estimada: toNumber(row.utilidad_estimada),
    })),
    metodos_pago: metodosPago,
    top_productos: topProductos,
    stock_bajo: stockBajo,
    sucursales: sucursalesResumen,
  };
};

// ============================================================
// G4 - Reportes de corte de ventas
// ============================================================

/**
 * Resuelve sucursales accesibles + valida id_usuario opcional para los cortes.
 * Devuelve: { branchIds, branchRows, idUsuario, isPrivileged, timezone }
 */
const getCorteContext = async ({ auth, scope, query }) => {
  const { desde, hasta } = getDateRange(query);
  const requestedView = normalizeView(query?.vista);
  const requestedBranchId = query?.id_sucursal
    ? Number(query.id_sucursal)
    : null;

  if (
    query?.id_sucursal &&
    (!Number.isInteger(requestedBranchId) || requestedBranchId <= 0)
  ) {
    throw HttpError.badRequest("id_sucursal invalido");
  }

  const company = await getCompanyProfile(auth.id_empresa);
  const scopeData = await getVisibleBranches({
    auth,
    scope,
    requestedBranchId,
    requestedView,
  });

  let idUsuario = null;
  if (query?.id_usuario) {
    idUsuario = Number(query.id_usuario);
    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
      throw HttpError.badRequest("id_usuario invalido");
    }
  }

  return {
    desde,
    hasta,
    branchIds: scopeData.branchIds,
    branchRows: scopeData.branchRows,
    isPrivileged: scopeData.isPrivileged,
    resolvedView: scopeData.resolvedView,
    requestedView,
    idUsuario,
    timezone: company.timezone || "America/Guatemala",
    empresa: {
      id_empresa: Number(company.id_empresa),
      nombre_legal: company.nombre_legal,
      timezone: company.timezone || "America/Guatemala",
    },
  };
};

/**
 * Resumen del corte. Considera reversiones (parciales y totales) descontando
 * monto_revertido del total y trata como "anulada" toda venta con
 * estado_reversion = 'TOTAL'.
 */
const getCorteResumen = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  idUsuario,
}) => {
  const params = [idEmpresa, desde, hasta, branchIds];
  let userClause = "";
  if (idUsuario) {
    params.push(idUsuario);
    userClause = `and v.id_usuario = $5`;
  }

  const result = await pool.query(
    `
      with ${UTILIDAD_POR_VENTA_CTE},
      ventas_filtradas as (
        select
          v.id_venta,
          v.estado,
          upper(coalesce(v.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
          v.tipo_venta,
          v.metodo_pago,
          v.total,
          coalesce(v.monto_revertido, 0) as monto_revertido,
          ${NET_SALE_TOTAL_SQL} as total_neto
        from ventas v
        where v.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
          ${userClause}
      )
      select
        count(*)::int as ventas_cantidad,
        count(*) filter (where vf.estado_reversion = 'TOTAL')::int as ventas_anuladas,
        count(*) filter (where vf.estado_reversion = 'PARCIAL')::int as ventas_con_reversion_parcial,
        coalesce(sum(vf.total_neto), 0) as total_neto,
        coalesce(sum(vf.total), 0) as total_original,
        coalesce(sum(vf.monto_revertido), 0) as total_anulado,
        coalesce(sum(vf.total_neto) filter (where upper(coalesce(vf.metodo_pago, '')) = 'EFECTIVO'), 0) as total_efectivo,
        coalesce(sum(vf.total_neto) filter (where upper(coalesce(vf.metodo_pago, '')) = 'TARJETA'), 0) as total_tarjeta,
        coalesce(sum(vf.total_neto) filter (where upper(coalesce(vf.metodo_pago, '')) = 'TRANSFERENCIA'), 0) as total_transferencia,
        coalesce(sum(vf.total_neto) filter (where upper(coalesce(vf.tipo_venta, '')) = 'CONTADO'), 0) as total_contado,
        coalesce(sum(vf.total_neto) filter (
          where upper(coalesce(vf.tipo_venta, '')) = 'CREDITO'
             or upper(coalesce(vf.metodo_pago, '')) = 'CREDITO'
        ), 0) as total_credito,
        coalesce(sum(coalesce(upv.utilidad_estimada, 0)), 0) as utilidad_estimada
      from ventas_filtradas vf
      left join utilidad_por_venta upv
        on upv.id_empresa = $1
       and upv.id_venta = vf.id_venta
    `,
    params
  );

  const row = result.rows[0] || {};
  return mapNumericFields(
    row,
    [
      "total_neto",
      "total_original",
      "total_anulado",
      "total_efectivo",
      "total_tarjeta",
      "total_transferencia",
      "total_contado",
      "total_credito",
      "utilidad_estimada",
    ],
    ["ventas_cantidad", "ventas_anuladas", "ventas_con_reversion_parcial"]
  );
};

const getCorteUsuarios = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  idUsuario,
}) => {
  const params = [idEmpresa, desde, hasta, branchIds];
  let userClause = "";
  if (idUsuario) {
    params.push(idUsuario);
    userClause = `and v.id_usuario = $5`;
  }

  const result = await pool.query(
    `
      select
        u.id_usuario,
        u.username,
        concat(u.nombre, ' ', u.apellido) as nombre,
        count(v.id_venta)::int as ventas,
        coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total_neto
      from ventas v
      inner join usuarios u
        on u.id_empresa = v.id_empresa
       and u.id_usuario = v.id_usuario
      where v.id_empresa = $1
        and v.fecha_venta::date >= $2::date
        and v.fecha_venta::date <= $3::date
        and v.id_sucursal = any($4::bigint[])
        and upper(coalesce(v.estado, '')) <> 'ANULADA'
        ${userClause}
      group by u.id_usuario, u.username, u.nombre, u.apellido
      order by total_neto desc, ventas desc
    `,
    params
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["total_neto"], ["ventas", "id_usuario"])
  );
};

const getCorteListaVentas = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  idUsuario,
  page,
  limit,
}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (safePage - 1) * safeLimit;

  const baseParams = [idEmpresa, desde, hasta, branchIds];
  let userClause = "";
  let nextIndex = 5;
  if (idUsuario) {
    baseParams.push(idUsuario);
    userClause = `and v.id_usuario = $${nextIndex}`;
    nextIndex += 1;
  }

  const countResult = await pool.query(
    `
      select count(*)::int as total
      from ventas v
      where v.id_empresa = $1
        and v.fecha_venta::date >= $2::date
        and v.fecha_venta::date <= $3::date
        and v.id_sucursal = any($4::bigint[])
        and upper(coalesce(v.estado, '')) <> 'ANULADA'
        ${userClause}
    `,
    baseParams
  );
  const totalRows = countResult.rows[0]?.total ?? 0;

  const dataParams = [...baseParams, safeLimit, offset];
  const limitIdx = nextIndex;
  const offsetIdx = nextIndex + 1;

  const dataResult = await pool.query(
    `
      select
        v.id_venta,
        v.fecha_venta,
        v.numero_comprobante,
        v.tipo_comprobante,
        v.tipo_venta,
        v.metodo_pago,
        v.estado,
        upper(coalesce(v.estado_reversion, 'SIN_REVERSION')) as estado_reversion,
        v.id_sucursal,
        s.nombre as sucursal_nombre,
        v.id_usuario,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        v.total as total_original,
        coalesce(v.monto_revertido, 0) as monto_revertido,
        ${NET_SALE_TOTAL_SQL} as total_neto,
        c.nombre as cliente_nombre
      from ventas v
      inner join sucursales s
        on s.id_empresa = v.id_empresa
       and s.id_sucursal = v.id_sucursal
      inner join usuarios u
        on u.id_empresa = v.id_empresa
       and u.id_usuario = v.id_usuario
      left join clientes c
        on c.id_empresa = v.id_empresa
       and c.id_cliente = v.id_cliente
      where v.id_empresa = $1
        and v.fecha_venta::date >= $2::date
        and v.fecha_venta::date <= $3::date
        and v.id_sucursal = any($4::bigint[])
        and upper(coalesce(v.estado, '')) <> 'ANULADA'
        ${userClause}
      order by v.fecha_venta desc, v.id_venta desc
      limit $${limitIdx} offset $${offsetIdx}
    `,
    dataParams
  );

  return {
    rows: dataResult.rows.map((row) =>
      mapNumericFields(
        row,
        ["total_original", "monto_revertido", "total_neto"],
        ["id_venta", "id_sucursal", "id_usuario"]
      )
    ),
    meta: {
      page: safePage,
      limit: safeLimit,
      totalRows,
      totalPages: Math.max(1, Math.ceil(totalRows / safeLimit)),
    },
  };
};

const getCorteAgregadoBy = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  idUsuario,
  field, // "metodo_pago" | "tipo_venta"
}) => {
  const params = [idEmpresa, desde, hasta, branchIds];
  let userClause = "";
  if (idUsuario) {
    params.push(idUsuario);
    userClause = `and v.id_usuario = $5`;
  }

  const result = await pool.query(
    `
      select
        upper(coalesce(v.${field}, 'SIN_DATO')) as ${field},
        count(*)::int as ventas,
        coalesce(sum(${NET_SALE_TOTAL_SQL}), 0) as total_neto
      from ventas v
      where v.id_empresa = $1
        and v.fecha_venta::date >= $2::date
        and v.fecha_venta::date <= $3::date
        and v.id_sucursal = any($4::bigint[])
        and upper(coalesce(v.estado, '')) <> 'ANULADA'
        ${userClause}
      group by upper(coalesce(v.${field}, 'SIN_DATO'))
      order by total_neto desc
    `,
    params
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["total_neto"], ["ventas"])
  );
};

const getCorteTopProductos = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  idUsuario,
  topLimit,
  orderBy, // "TOTAL" | "CANTIDAD"
}) => {
  const params = [idEmpresa, desde, hasta, branchIds];
  let userClause = "";
  let nextIndex = 5;
  if (idUsuario) {
    params.push(idUsuario);
    userClause = `and v.id_usuario = $${nextIndex}`;
    nextIndex += 1;
  }
  params.push(topLimit);
  const limitIdx = nextIndex;

  const orderClause =
    orderBy === "CANTIDAD"
      ? "order by cantidad_vendida_neta desc, total_neto desc"
      : "order by total_neto desc, cantidad_vendida_neta desc";

  const result = await pool.query(
    `
      with reversiones_por_producto as (
        select
          vrd.id_empresa,
          vrd.id_producto,
          coalesce(sum(vrd.cantidad), 0) as cantidad_revertida,
          coalesce(sum(vrd.subtotal), 0) as subtotal_revertido
        from venta_reversion_detalles vrd
        inner join venta_reversiones vr
          on vr.id_empresa = vrd.id_empresa
         and vr.id_venta_reversion = vrd.id_venta_reversion
        inner join ventas v
          on v.id_empresa = vr.id_empresa
         and v.id_venta = vr.id_venta
        where vrd.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          ${userClause}
        group by vrd.id_empresa, vrd.id_producto
      ),
      ventas_por_producto as (
        select
          vd.id_empresa,
          vd.id_producto,
          coalesce(sum(vd.cantidad), 0) as cantidad_bruta,
          coalesce(sum(vd.subtotal), 0) as subtotal_bruto
        from venta_detalles vd
        inner join ventas v
          on v.id_empresa = vd.id_empresa
         and v.id_venta = vd.id_venta
        where vd.id_empresa = $1
          and v.fecha_venta::date >= $2::date
          and v.fecha_venta::date <= $3::date
          and v.id_sucursal = any($4::bigint[])
          and upper(coalesce(v.estado, '')) <> 'ANULADA'
          ${userClause}
        group by vd.id_empresa, vd.id_producto
      )
      select
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre as producto_nombre,
        greatest(vpp.cantidad_bruta - coalesce(rpp.cantidad_revertida, 0), 0) as cantidad_vendida_neta,
        greatest(vpp.subtotal_bruto - coalesce(rpp.subtotal_revertido, 0), 0) as total_neto
      from ventas_por_producto vpp
      inner join productos p
        on p.id_empresa = vpp.id_empresa
       and p.id_producto = vpp.id_producto
      left join reversiones_por_producto rpp
        on rpp.id_empresa = vpp.id_empresa
       and rpp.id_producto = vpp.id_producto
      ${orderClause}
      limit $${limitIdx}
    `,
    params
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["cantidad_vendida_neta", "total_neto"])
  );
};

/**
 * Corte basico: resumen + por_usuario.
 * Endpoint: GET /api/saas/reportes/corte
 */
export const getCorteVentas = async ({ auth, scope, query }) => {
  const ctx = await getCorteContext({ auth, scope, query });

  const baseParams = {
    idEmpresa: auth.id_empresa,
    desde: ctx.desde,
    hasta: ctx.hasta,
    branchIds: ctx.branchIds,
    idUsuario: ctx.idUsuario,
  };

  const [resumen, porUsuario] = await Promise.all([
    getCorteResumen(baseParams),
    getCorteUsuarios(baseParams),
  ]);

  return {
    empresa: ctx.empresa,
    rango: { desde: ctx.desde, hasta: ctx.hasta },
    alcance: {
      vista_solicitada: ctx.requestedView,
      vista_resuelta: ctx.resolvedView,
      restringido_a_sucursales_asignadas: !ctx.isPrivileged,
      sucursales_consideradas: ctx.branchRows.map((branch) => ({
        id_sucursal: Number(branch.id_sucursal),
        codigo: branch.codigo,
        nombre: branch.nombre,
      })),
      id_usuario: ctx.idUsuario,
    },
    resumen,
    por_usuario: porUsuario,
  };
};

/**
 * Corte detallado pro: resumen + ventas paginadas + por_usuario + por_metodo +
 * por_tipo + top productos por total y por cantidad.
 * Endpoint: GET /api/saas/reportes/corte-detallado-pro
 */
export const getCorteVentasDetalladoPro = async ({ auth, scope, query }) => {
  const ctx = await getCorteContext({ auth, scope, query });
  const topLimit = getPositiveInteger(query?.top, 10, { min: 3, max: 50 });

  const baseParams = {
    idEmpresa: auth.id_empresa,
    desde: ctx.desde,
    hasta: ctx.hasta,
    branchIds: ctx.branchIds,
    idUsuario: ctx.idUsuario,
  };

  const [
    resumen,
    porUsuario,
    porMetodo,
    porTipo,
    topPorTotal,
    topPorCantidad,
    ventas,
  ] = await Promise.all([
    getCorteResumen(baseParams),
    getCorteUsuarios(baseParams),
    getCorteAgregadoBy({ ...baseParams, field: "metodo_pago" }),
    getCorteAgregadoBy({ ...baseParams, field: "tipo_venta" }),
    getCorteTopProductos({ ...baseParams, topLimit, orderBy: "TOTAL" }),
    getCorteTopProductos({ ...baseParams, topLimit, orderBy: "CANTIDAD" }),
    getCorteListaVentas({
      ...baseParams,
      page: query?.page,
      limit: query?.limit,
    }),
  ]);

  return {
    empresa: ctx.empresa,
    rango: { desde: ctx.desde, hasta: ctx.hasta },
    alcance: {
      vista_solicitada: ctx.requestedView,
      vista_resuelta: ctx.resolvedView,
      restringido_a_sucursales_asignadas: !ctx.isPrivileged,
      sucursales_consideradas: ctx.branchRows.map((branch) => ({
        id_sucursal: Number(branch.id_sucursal),
        codigo: branch.codigo,
        nombre: branch.nombre,
      })),
      id_usuario: ctx.idUsuario,
    },
    resumen,
    por_usuario: porUsuario,
    por_metodo_pago: porMetodo,
    por_tipo_venta: porTipo,
    top_productos_por_total: topPorTotal,
    top_productos_por_cantidad: topPorCantidad,
    ventas: ventas.rows,
    meta: {
      ...ventas.meta,
      top: topLimit,
    },
  };
};
