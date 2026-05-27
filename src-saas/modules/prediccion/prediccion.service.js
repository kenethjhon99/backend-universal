import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

/**
 * Predicción de demanda básica por producto:
 *   - Carga las ventas (cantidad neta) de los últimos N días
 *   - Calcula:
 *       * promedio diario simple
 *       * promedio móvil ponderado (más peso a días recientes)
 *       * tendencia (slope simple por regresión lineal)
 *       * forecast a 7/14/30 días
 *   - Compara contra stock actual y calcula "días de cobertura"
 *
 * Robusto a productos sin venta histórica suficiente (devuelve 0 con flag).
 *
 * Modelo simple, sin dependencias externas. Suficiente para PYMES.
 * Una versión avanzada usaría ARIMA / Prophet pero requeriría un worker
 * separado y dependencias pesadas — fuera de alcance de un POS SaaS típico.
 */
const periodoSql = (dias) => `
  with serie as (
    select generate_series(
      (current_date - interval '${dias} days')::date,
      current_date,
      interval '1 day'
    )::date as fecha
  ),
  ventas_diarias as (
    select
      vd.id_producto,
      v.fecha_venta::date as fecha,
      sum(vd.cantidad)::numeric as cantidad
    from venta_detalles vd
    inner join ventas v
      on v.id_empresa = vd.id_empresa
     and v.id_venta = vd.id_venta
    where vd.id_empresa = $1
      and upper(coalesce(v.estado, '')) not in ('ANULADA', 'NO_COBRADO')
      and v.fecha_venta::date >= (current_date - interval '${dias} days')::date
      and ($2::bigint is null or vd.id_producto = $2)
    group by vd.id_producto, v.fecha_venta::date
  ),
  reversiones_diarias as (
    select
      vrd.id_producto,
      v.fecha_venta::date as fecha,
      sum(vrd.cantidad)::numeric as revertida
    from venta_reversion_detalles vrd
    inner join venta_reversiones vr
      on vr.id_empresa = vrd.id_empresa
     and vr.id_venta_reversion = vrd.id_venta_reversion
    inner join ventas v
      on v.id_empresa = vr.id_empresa
     and v.id_venta = vr.id_venta
    where vrd.id_empresa = $1
      and v.fecha_venta::date >= (current_date - interval '${dias} days')::date
      and ($2::bigint is null or vrd.id_producto = $2)
    group by vrd.id_producto, v.fecha_venta::date
  )
`;

/**
 * Devuelve el dataset diario de ventas netas (vendido - revertido) por producto
 * en el rango de N días.
 */
const fetchDailySeries = async ({ idEmpresa, idProducto = null, dias = 60 }) => {
  const result = await pool.query(
    `
      ${periodoSql(dias)}
      select
        coalesce(vd.id_producto, rd.id_producto) as id_producto,
        s.fecha,
        greatest(coalesce(vd.cantidad, 0) - coalesce(rd.revertida, 0), 0)::numeric as cantidad
      from serie s
      cross join (
        select distinct id_producto from ventas_diarias
        union
        select distinct id_producto from reversiones_diarias
        ${idProducto ? "union select $2::bigint" : ""}
      ) p(id_producto)
      left join ventas_diarias vd on vd.fecha = s.fecha and vd.id_producto = p.id_producto
      left join reversiones_diarias rd on rd.fecha = s.fecha and rd.id_producto = p.id_producto
      where p.id_producto is not null
      order by p.id_producto, s.fecha
    `,
    [idEmpresa, idProducto]
  );

  // Agrupar por producto
  const byProducto = new Map();
  for (const row of result.rows) {
    const pid = Number(row.id_producto);
    if (!byProducto.has(pid)) byProducto.set(pid, []);
    byProducto.get(pid).push({
      fecha: row.fecha,
      cantidad: Number(row.cantidad || 0),
    });
  }
  return byProducto;
};

/**
 * Calcula estadísticas y forecast de una serie diaria.
 * Series corta (<7 días): devuelve flags de baja confianza.
 */
const computeForecast = (series) => {
  const n = series.length;
  if (n === 0) {
    return {
      promedio_diario: 0,
      promedio_movil_ponderado: 0,
      tendencia_diaria: 0,
      forecast_7d: 0,
      forecast_14d: 0,
      forecast_30d: 0,
      datos_suficientes: false,
      dias_con_data: 0,
    };
  }

  const values = series.map((p) => p.cantidad);
  const sum = values.reduce((a, b) => a + b, 0);
  const promedio = sum / n;

  // Promedio móvil ponderado: más peso a últimos 14 días
  const ventana = Math.min(14, n);
  const ultimos = values.slice(-ventana);
  let wSum = 0;
  let totalPeso = 0;
  ultimos.forEach((v, idx) => {
    const peso = idx + 1; // 1, 2, ..., ventana
    wSum += v * peso;
    totalPeso += peso;
  });
  const promedioPonderado = totalPeso > 0 ? wSum / totalPeso : promedio;

  // Tendencia diaria: regresión lineal simple (slope)
  let slope = 0;
  if (n >= 7) {
    const xMean = (n - 1) / 2;
    const yMean = promedio;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      num += (i - xMean) * (values[i] - yMean);
      den += (i - xMean) * (i - xMean);
    }
    slope = den > 0 ? num / den : 0;
  }

  // Forecast: parte del promedio ponderado y le suma tendencia escalada al horizonte
  const proyectar = (dias) => {
    const base = promedioPonderado * dias;
    const ajusteTendencia = (slope * dias * dias) / 2; // integral de slope sobre dias
    return Math.max(0, base + ajusteTendencia);
  };

  return {
    promedio_diario: round2(promedio),
    promedio_movil_ponderado: round2(promedioPonderado),
    tendencia_diaria: round2(slope),
    forecast_7d: Math.round(proyectar(7)),
    forecast_14d: Math.round(proyectar(14)),
    forecast_30d: Math.round(proyectar(30)),
    datos_suficientes: n >= 14,
    dias_con_data: values.filter((v) => v > 0).length,
  };
};

/**
 * Lista la predicción para todos los productos activos con sus stocks y
 * días de cobertura. Si un producto vende 5/día y tiene 50 en stock,
 * cobertura = 10 días.
 */
export const listForecastProductos = async ({ auth, query }) => {
  const dias = Math.min(180, Math.max(14, Number(query?.dias_historia) || 60));
  const idSucursal = query?.id_sucursal
    ? Number(query.id_sucursal)
    : Number(auth.id_sucursal);

  if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
    throw HttpError.badRequest("id_sucursal invalido");
  }

  // Cargar series diarias
  const byProducto = await fetchDailySeries({
    idEmpresa: auth.id_empresa,
    dias,
  });

  if (byProducto.size === 0) {
    return { productos: [], dias_historia: dias };
  }

  // Cargar stock actual en la sucursal
  const idsProducto = Array.from(byProducto.keys());
  const stockResult = await pool.query(
    `
      select p.id_producto, p.sku, p.nombre as producto_nombre,
             coalesce(ss.stock_actual, 0) as stock_actual,
             coalesce(ss.stock_minimo, 0) as stock_minimo
      from productos p
      left join stock_sucursal ss
        on ss.id_empresa = p.id_empresa
       and ss.id_producto = p.id_producto
       and ss.id_sucursal = $2
      where p.id_empresa = $1
        and p.id_producto = any($3::bigint[])
        and p.activo = true
    `,
    [auth.id_empresa, idSucursal, idsProducto]
  );

  const productosResult = stockResult.rows.map((row) => {
    const series = byProducto.get(Number(row.id_producto)) || [];
    const forecast = computeForecast(series);
    const stock = Number(row.stock_actual);

    const coberturaDias =
      forecast.promedio_movil_ponderado > 0
        ? Math.floor(stock / forecast.promedio_movil_ponderado)
        : null;

    // Sugerencia de pedido a 14 días con buffer del 20%
    const sugerido14 = Math.max(0, Math.ceil(forecast.forecast_14d * 1.2 - stock));

    return {
      id_producto: Number(row.id_producto),
      sku: row.sku,
      producto_nombre: row.producto_nombre,
      stock_actual: round2(stock),
      stock_minimo: round2(row.stock_minimo),
      cobertura_dias: coberturaDias,
      alerta_quiebre:
        coberturaDias !== null && coberturaDias <= 7,
      sugerido_reorden_14d: sugerido14,
      ...forecast,
    };
  });

  // Ordenar por urgencia: con datos suficientes y cobertura baja primero
  productosResult.sort((a, b) => {
    if (a.alerta_quiebre !== b.alerta_quiebre) {
      return a.alerta_quiebre ? -1 : 1;
    }
    if (a.cobertura_dias === null && b.cobertura_dias === null) return 0;
    if (a.cobertura_dias === null) return 1;
    if (b.cobertura_dias === null) return -1;
    return a.cobertura_dias - b.cobertura_dias;
  });

  return {
    dias_historia: dias,
    id_sucursal: idSucursal,
    productos: productosResult,
  };
};

/**
 * Forecast para un producto específico (detalle de la serie diaria + stats).
 */
export const getForecastProducto = async ({ auth, idProducto, query }) => {
  const dias = Math.min(365, Math.max(14, Number(query?.dias_historia) || 90));
  const byProducto = await fetchDailySeries({
    idEmpresa: auth.id_empresa,
    idProducto,
    dias,
  });

  const series = byProducto.get(idProducto) || [];
  const forecast = computeForecast(series);

  return {
    id_producto: idProducto,
    dias_historia: dias,
    serie_diaria: series,
    ...forecast,
  };
};
