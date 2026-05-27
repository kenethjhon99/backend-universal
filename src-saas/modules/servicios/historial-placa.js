import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));

/**
 * Devuelve el historial completo de un vehiculo identificado por placa
 * dentro de la empresa actual:
 *   - Total de visitas y monto gastado
 *   - Ultima visita
 *   - Lista de ordenes ordenadas por fecha desc
 *   - Productos consumidos en esas ordenes
 *
 * Permite al cliente o al cajero ver "todo lo que se le ha hecho" a un
 * vehiculo, util para taller (recordatorios de aceite, kilometraje, etc).
 */
export const getHistorialPorPlaca = async ({ auth, placa }) => {
  const placaNorm = String(placa || "").trim().toUpperCase();
  if (!placaNorm) {
    throw HttpError.badRequest("placa es requerida");
  }

  const ordenesResult = await pool.query(
    `
      select
        os.id_orden_servicio,
        os.numero_orden,
        upper(os.modulo) as modulo,
        upper(os.estado) as estado,
        upper(coalesce(os.estado_cobro, 'PENDIENTE')) as estado_cobro,
        os.total,
        os.metodo_pago,
        os.fecha_servicio,
        os.fecha_entrega,
        os.kilometraje,
        os.observaciones,
        sc.nombre as servicio_nombre,
        c.nombre as cliente_nombre,
        s.nombre as sucursal_nombre,
        u.username as usuario_username
      from ordenes_servicio os
      inner join servicios_catalogo sc
        on sc.id_empresa = os.id_empresa and sc.id_servicio_catalogo = os.id_servicio_catalogo
      inner join sucursales s
        on s.id_empresa = os.id_empresa and s.id_sucursal = os.id_sucursal
      inner join usuarios u
        on u.id_empresa = os.id_empresa and u.id_usuario = os.id_usuario
      left join clientes c
        on c.id_empresa = os.id_empresa and c.id_cliente = os.id_cliente
      where os.id_empresa = $1
        and upper(os.placa) = $2
      order by os.fecha_servicio desc, os.id_orden_servicio desc
      limit 200
    `,
    [auth.id_empresa, placaNorm]
  );

  if (ordenesResult.rows.length === 0) {
    return {
      placa: placaNorm,
      visitas: 0,
      total_gastado: 0,
      ultima_visita: null,
      ordenes: [],
      productos: [],
    };
  }

  const idOrdenes = ordenesResult.rows.map((r) => Number(r.id_orden_servicio));

  // Productos consumidos en esas ordenes
  const productosResult = await pool.query(
    `
      select
        osp.id_orden_servicio,
        osp.cantidad,
        osp.precio_unitario,
        osp.subtotal_cobrado as subtotal,
        p.nombre as producto_nombre,
        p.sku
      from ordenes_servicio_productos osp
      inner join productos p
        on p.id_empresa = osp.id_empresa and p.id_producto = osp.id_producto
      where osp.id_empresa = $1
        and osp.id_orden_servicio = any($2::bigint[])
      order by osp.fecha_consumo desc nulls last, osp.id_osp desc
    `,
    [auth.id_empresa, idOrdenes]
  ).catch(async () => {
    // Schema variante: la tabla puede llamarse distinto en algunas versiones
    return { rows: [] };
  });

  const productosByOrden = productosResult.rows.reduce((acc, p) => {
    const key = Number(p.id_orden_servicio);
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  const ordenes = ordenesResult.rows.map((row) => ({
    ...row,
    total: round2(row.total),
    productos: productosByOrden[Number(row.id_orden_servicio)] || [],
  }));

  // Resumen agregado
  const totalGastado = ordenes.reduce(
    (acc, o) => acc + (o.estado_cobro === "COBRADO" ? Number(o.total || 0) : 0),
    0
  );

  return {
    placa: placaNorm,
    visitas: ordenes.length,
    total_gastado: round2(totalGastado),
    ultima_visita: ordenes[0]?.fecha_servicio || null,
    ordenes,
  };
};
