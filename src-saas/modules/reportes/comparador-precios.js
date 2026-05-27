import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

/**
 * Comparador de precios entre sucursales para una empresa.
 *
 * Devuelve, por producto activo:
 *   - precio en cada sucursal (de stock_sucursal o de productos.precio_venta
 *     como fallback)
 *   - stock en cada sucursal
 *   - dispersion (max - min) y ratio (max/min)
 *   - alerta cuando la dispersion supera el umbral
 *
 * Util para detectar sucursales con precios desactualizados, errores de
 * captura, o decisiones intencionales de pricing diferenciado.
 */
export const comparePrices = async ({ auth, query }) => {
  const dispersionMin = Number(query?.dispersion_min || 0);
  const onlyMissing = ["true", "1"].includes(
    String(query?.solo_faltantes || "").toLowerCase()
  );
  const limit = Math.min(500, Math.max(1, Number(query?.limit) || 200));

  // Para mantener simple, usamos productos.precio_venta como precio "global"
  // y stock_sucursal.stock_actual / stock_minimo como info de inventario.
  // Si en el futuro guardas precio_venta_sucursal por sucursal, este query
  // se puede extender trivialmente.

  const result = await pool.query(
    `
      with sucursales_empresa as (
        select id_sucursal, codigo, nombre
        from sucursales
        where id_empresa = $1 and activa = true
      ),
      producto_sucursal as (
        select
          p.id_producto,
          p.sku,
          p.codigo_barras,
          p.nombre as producto_nombre,
          p.precio_venta as precio_default,
          se.id_sucursal,
          se.codigo as sucursal_codigo,
          se.nombre as sucursal_nombre,
          ss.stock_actual,
          ss.stock_minimo,
          coalesce(ss.precio_venta, p.precio_venta) as precio_efectivo
        from productos p
        cross join sucursales_empresa se
        left join stock_sucursal ss
          on ss.id_empresa = p.id_empresa
         and ss.id_producto = p.id_producto
         and ss.id_sucursal = se.id_sucursal
        where p.id_empresa = $1
          and p.activo = true
      ),
      agregado as (
        select
          id_producto,
          sku,
          codigo_barras,
          producto_nombre,
          precio_default,
          jsonb_agg(jsonb_build_object(
            'id_sucursal', id_sucursal,
            'sucursal_codigo', sucursal_codigo,
            'sucursal_nombre', sucursal_nombre,
            'precio_efectivo', precio_efectivo,
            'stock_actual', coalesce(stock_actual, 0),
            'stock_minimo', coalesce(stock_minimo, 0),
            'tiene_stock_row', stock_actual is not null
          ) order by sucursal_codigo) as por_sucursal,
          min(precio_efectivo) as precio_min,
          max(precio_efectivo) as precio_max,
          avg(precio_efectivo) as precio_avg,
          count(*) filter (where stock_actual is null)::int as sucursales_sin_stock_row
        from producto_sucursal
        group by id_producto, sku, codigo_barras, producto_nombre, precio_default
      )
      select *
      from agregado
      where 1=1
        ${dispersionMin > 0 ? "and (precio_max - precio_min) >= $2" : ""}
        ${onlyMissing ? `and sucursales_sin_stock_row > 0` : ""}
      order by (precio_max - precio_min) desc, producto_nombre asc
      limit $${dispersionMin > 0 ? 3 : 2}
    `,
    dispersionMin > 0
      ? [auth.id_empresa, dispersionMin, limit]
      : [auth.id_empresa, limit]
  ).catch((error) => {
    // Schema variante: stock_sucursal puede no tener precio_venta (es
    // funcionalidad opcional). En ese caso, retry sin esa columna.
    if (String(error.message || "").includes("precio_venta")) {
      return pool.query(
        `
          with sucursales_empresa as (
            select id_sucursal, codigo, nombre
            from sucursales
            where id_empresa = $1 and activa = true
          ),
          producto_sucursal as (
            select
              p.id_producto, p.sku, p.codigo_barras,
              p.nombre as producto_nombre,
              p.precio_venta as precio_default,
              se.id_sucursal, se.codigo as sucursal_codigo, se.nombre as sucursal_nombre,
              ss.stock_actual, ss.stock_minimo,
              p.precio_venta as precio_efectivo
            from productos p
            cross join sucursales_empresa se
            left join stock_sucursal ss
              on ss.id_empresa = p.id_empresa
             and ss.id_producto = p.id_producto
             and ss.id_sucursal = se.id_sucursal
            where p.id_empresa = $1 and p.activo = true
          ),
          agregado as (
            select
              id_producto, sku, codigo_barras, producto_nombre, precio_default,
              jsonb_agg(jsonb_build_object(
                'id_sucursal', id_sucursal,
                'sucursal_codigo', sucursal_codigo,
                'sucursal_nombre', sucursal_nombre,
                'precio_efectivo', precio_efectivo,
                'stock_actual', coalesce(stock_actual, 0),
                'stock_minimo', coalesce(stock_minimo, 0),
                'tiene_stock_row', stock_actual is not null
              ) order by sucursal_codigo) as por_sucursal,
              min(precio_efectivo) as precio_min,
              max(precio_efectivo) as precio_max,
              avg(precio_efectivo) as precio_avg,
              count(*) filter (where stock_actual is null)::int as sucursales_sin_stock_row
            from producto_sucursal
            group by id_producto, sku, codigo_barras, producto_nombre, precio_default
          )
          select *
          from agregado
          where 1=1
            ${onlyMissing ? `and sucursales_sin_stock_row > 0` : ""}
          order by producto_nombre asc
          limit $2
        `,
        [auth.id_empresa, limit]
      );
    }
    throw error;
  });

  return result.rows.map((row) => ({
    id_producto: Number(row.id_producto),
    sku: row.sku,
    codigo_barras: row.codigo_barras,
    producto_nombre: row.producto_nombre,
    precio_default: round2(row.precio_default),
    precio_min: round2(row.precio_min),
    precio_max: round2(row.precio_max),
    precio_promedio: round2(row.precio_avg),
    dispersion_absoluta: round2(Number(row.precio_max) - Number(row.precio_min)),
    dispersion_porcentual:
      Number(row.precio_min) > 0
        ? round2(
            ((Number(row.precio_max) - Number(row.precio_min)) /
              Number(row.precio_min)) *
              100
          )
        : 0,
    por_sucursal: row.por_sucursal || [],
    sucursales_sin_stock_row: Number(row.sucursales_sin_stock_row || 0),
  }));
};
