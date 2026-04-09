import { pool } from "../config/db.js";

const TIPO_COMPROBANTE_DEFAULT = "TICKET";

const emitirComprobanteVenta = async (client, tipoComprobante = TIPO_COMPROBANTE_DEFAULT) => {
  const normalizedTipo = String(tipoComprobante || TIPO_COMPROBANTE_DEFAULT)
    .trim()
    .toUpperCase();

  const serieResult = await client.query(
    `
      SELECT id_comprobante_serie, modulo, tipo_comprobante, nombre, serie, ultimo_correlativo
      FROM "Comprobante_serie"
      WHERE modulo = 'VENTA'
        AND tipo_comprobante = $1
        AND activo = true
      ORDER BY id_comprobante_serie ASC
      LIMIT 1
      FOR UPDATE
    `,
    [normalizedTipo]
  );

  if (serieResult.rowCount === 0) {
    throw new Error(`No existe una serie activa para el comprobante ${normalizedTipo}`);
  }

  const serie = serieResult.rows[0];
  const correlativo = Number(serie.ultimo_correlativo || 0) + 1;
  const numeroComprobante = `${serie.serie}-${String(correlativo).padStart(6, "0")}`;

  await client.query(
    `
      UPDATE "Comprobante_serie"
      SET ultimo_correlativo = $1
      WHERE id_comprobante_serie = $2
    `,
    [correlativo, serie.id_comprobante_serie]
  );

  return {
    id_comprobante_serie: serie.id_comprobante_serie,
    tipo_comprobante: serie.tipo_comprobante,
    serie_comprobante: serie.serie,
    correlativo_comprobante: correlativo,
    numero_comprobante: numeroComprobante,
    nombre_comprobante: serie.nombre,
  };
};

export const listarComprobantesVenta = async () => {
  const result = await pool.query(
    `
      SELECT
        id_comprobante_serie,
        tipo_comprobante,
        nombre,
        serie,
        descripcion,
        ultimo_correlativo,
        CONCAT(serie, '-', LPAD((COALESCE(ultimo_correlativo, 0) + 1)::text, 6, '0')) AS siguiente_numero
      FROM "Comprobante_serie"
      WHERE modulo = 'VENTA'
        AND activo = true
      ORDER BY id_comprobante_serie ASC
    `
  );

  return result.rows;
};

export const anularDetalle = async ({ id_venta, id_detalle, cantidad, motivo, id_usuario, id_bodega = 1 }) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) Traer detalle con lock
    const rDet = await client.query(
      `SELECT id_detalle, id_venta, id_producto, cantidad, cantidad_anulada, precio_unitario
       FROM "Detalle_venta"
       WHERE id_detalle = $1 AND id_venta = $2
       FOR UPDATE`,
      [id_detalle, id_venta]
    );
    if (rDet.rowCount === 0) throw new Error("Detalle no encontrado para esa venta");

    const det = rDet.rows[0];
    const disponible = Number(det.cantidad) - Number(det.cantidad_anulada);

    if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error("cantidad debe ser entero > 0");
    if (cantidad > disponible) throw new Error(`No puedes anular ${cantidad}. Disponible para anular: ${disponible}`);

    const nueva_anulada = Number(det.cantidad_anulada) + cantidad;
    const nuevo_estado = nueva_anulada === Number(det.cantidad) ? "ANULADO" : "PARCIAL";

    // 2) Actualizar detalle
    await client.query(
      `UPDATE "Detalle_venta"
       SET cantidad_anulada = $1,
           estado = $2,
           anulada_en = now(),
           anulada_por = $3,
           motivo_anulacion = $4
       WHERE id_detalle = $5`,
      [nueva_anulada, nuevo_estado, id_usuario, motivo ?? null, id_detalle]
    );

    // 3) Subir stock (lock stock)
    const rStock = await client.query(
      `SELECT existencia
       FROM "Stock_producto"
       WHERE id_producto = $1 AND id_bodega = $2
       FOR UPDATE`,
      [det.id_producto, id_bodega]
    );
    if (rStock.rowCount === 0) throw new Error("No existe stock para este producto en la bodega");

    const antes = Number(rStock.rows[0].existencia);
    const despues = antes + cantidad;

    await client.query(
      `UPDATE "Stock_producto"
       SET existencia = $1
       WHERE id_producto = $2 AND id_bodega = $3`,
      [despues, det.id_producto, id_bodega]
    );

    // 4) Movimiento stock (ENTRADA por anulación)
    await client.query(
      `INSERT INTO "Movimiento_stock"
       (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
       VALUES ('ENTRADA', $1, $2, $3, $4, $5, $6, $7)`,
      [`Anulación venta #${id_venta} detalle #${id_detalle}`, cantidad, antes, despues, det.id_producto, id_bodega, id_usuario]
    );

    await client.query(
      `INSERT INTO "Detalle_venta_anulacion"
       (id_venta, id_detalle, id_producto, cantidad, motivo, id_usuario)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id_venta, id_detalle, det.id_producto, cantidad, motivo ?? null, id_usuario]
    );

    // 5) Recalcular total de venta
    const rTotal = await client.query(
      `SELECT COALESCE(SUM((cantidad - cantidad_anulada) * precio_unitario), 0) AS total
       FROM "Detalle_venta"
       WHERE id_venta = $1`,
      [id_venta]
    );
    const total = Number(rTotal.rows[0].total);

    // 6) Si todos anulados, marcar venta ANULADA
    const rActivos = await client.query(
      `SELECT COUNT(*)::int AS activos
       FROM "Detalle_venta"
       WHERE id_venta = $1 AND (cantidad - cantidad_anulada) > 0`,
      [id_venta]
    );

    const ventaAnulada = rActivos.rows[0].activos === 0;

    await client.query(
      `UPDATE "Venta"
       SET total = $1,
           estado = CASE WHEN $2 THEN 'ANULADA' ELSE estado END,
           anulada_en = CASE WHEN $2 THEN now() ELSE anulada_en END,
           anulada_por = CASE WHEN $2 THEN $3 ELSE anulada_por END,
           motivo_anulacion = CASE WHEN $2 THEN COALESCE($4, motivo_anulacion) ELSE motivo_anulacion END
       WHERE id_venta = $5`,
      [Number(total.toFixed(2)), ventaAnulada, id_usuario, motivo ?? null, id_venta]
    );

    await client.query("COMMIT");

    return { ok: true, venta_anulada: ventaAnulada, total };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const anularVentaCompleta = async ({
  id_venta,
  motivo,
  id_usuario,
  id_bodega = 1,
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rVenta = await client.query(
      `
        SELECT id_venta, estado
        FROM "Venta"
        WHERE id_venta = $1
        FOR UPDATE
      `,
      [id_venta]
    );

    if (rVenta.rowCount === 0) {
      throw new Error("Venta no encontrada");
    }

    if (rVenta.rows[0].estado === "ANULADA") {
      throw new Error("La venta ya se encuentra anulada");
    }

    const rDetalles = await client.query(
      `
        SELECT id_detalle, id_producto, cantidad, cantidad_anulada, precio_unitario
        FROM "Detalle_venta"
        WHERE id_venta = $1
        ORDER BY id_detalle ASC
        FOR UPDATE
      `,
      [id_venta]
    );

    if (rDetalles.rowCount === 0) {
      throw new Error("La venta no tiene detalles para anular");
    }

    for (const detalle of rDetalles.rows) {
      const cantidadOriginal = Number(detalle.cantidad) || 0;
      const cantidadAnulada = Number(detalle.cantidad_anulada) || 0;
      const cantidadPendiente = cantidadOriginal - cantidadAnulada;

      if (cantidadPendiente <= 0) {
        continue;
      }

      const rStock = await client.query(
        `
          SELECT existencia
          FROM "Stock_producto"
          WHERE id_producto = $1 AND id_bodega = $2
          FOR UPDATE
        `,
        [detalle.id_producto, id_bodega]
      );

      if (rStock.rowCount === 0) {
        throw new Error(`No existe stock para el producto ${detalle.id_producto} en la bodega`);
      }

      const antes = Number(rStock.rows[0].existencia);
      const despues = antes + cantidadPendiente;

      await client.query(
        `
          UPDATE "Stock_producto"
          SET existencia = $1
          WHERE id_producto = $2 AND id_bodega = $3
        `,
        [despues, detalle.id_producto, id_bodega]
      );

      await client.query(
        `
          INSERT INTO "Movimiento_stock"
          (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
          VALUES ('ENTRADA', $1, $2, $3, $4, $5, $6, $7)
        `,
        [`Anulacion total venta #${id_venta}`, cantidadPendiente, antes, despues, detalle.id_producto, id_bodega, id_usuario]
      );

      await client.query(
        `
          UPDATE "Detalle_venta"
          SET cantidad_anulada = cantidad,
              estado = 'ANULADO',
              anulada_en = now(),
              anulada_por = $1,
              motivo_anulacion = $2
          WHERE id_detalle = $3
        `,
        [id_usuario, motivo ?? null, detalle.id_detalle]
      );

      await client.query(
        `
          INSERT INTO "Detalle_venta_anulacion"
          (id_venta, id_detalle, id_producto, cantidad, motivo, id_usuario)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          id_venta,
          detalle.id_detalle,
          detalle.id_producto,
          cantidadPendiente,
          motivo ?? null,
          id_usuario,
        ]
      );
    }

    const rVentaActualizada = await client.query(
      `
        UPDATE "Venta"
        SET total = 0,
            utilidad_total = 0,
            estado = 'ANULADA',
            anulada_en = now(),
            anulada_por = $1,
            motivo_anulacion = $2
        WHERE id_venta = $3
        RETURNING *
      `,
      [id_usuario, motivo ?? null, id_venta]
    );

    await client.query("COMMIT");

    return rVentaActualizada.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const crearVenta = async ({
  id_usuario,
  id_sucursal = 1,
  id_caja_sesion = null,
  id_cliente = null,
  tipo_venta,
  metodo_pago,
  tipo_comprobante = TIPO_COMPROBANTE_DEFAULT,
  monto_recibido = null,
  no_cobrar = false,
  no_cobrado_motivo = null,
  no_cobrado_autorizado_por = null,
  items,
  id_bodega = 1,
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const comprobante = await emitirComprobanteVenta(client, tipo_comprobante);
    const ventaSinCobro = Boolean(no_cobrar);
    const metodoPagoNormalizado = String(metodo_pago ?? "EFECTIVO")
      .trim()
      .toUpperCase();
    const metodoPagoPersistido = ventaSinCobro
      ? "NO_COBRADO"
      : metodoPagoNormalizado;
    const montoRecibidoNormalizado =
      monto_recibido == null || monto_recibido === ""
        ? null
        : Number(monto_recibido);

    if (
      montoRecibidoNormalizado != null &&
      (!Number.isFinite(montoRecibidoNormalizado) || montoRecibidoNormalizado < 0)
    ) {
      throw new Error("monto_recibido debe ser un numero mayor o igual a 0");
    }

    const rVenta = await client.query(
  `INSERT INTO "Venta"(
      fecha,
      total,
      tipo_venta,
      metodo_pago,
      id_sucursal,
      id_usuario,
      id_caja_sesion,
      id_cliente,
      estado,
      id_comprobante_serie,
      tipo_comprobante,
      serie_comprobante,
      correlativo_comprobante,
      numero_comprobante,
      monto_recibido,
      cambio_entregado,
      no_cobrado_motivo,
      no_cobrado_autorizado_por,
      no_cobrado_autorizado_en,
      no_cobrado_validado_por,
      no_cobrado_validado_en,
      no_cobrado_validacion_nota
    )
   VALUES (
      now(), 0, $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, NULL, 0,
      $13, $14, CASE WHEN $15 THEN now() ELSE NULL END, NULL, NULL, NULL
   )
   RETURNING id_venta,
            (fecha AT TIME ZONE 'America/Guatemala') AS fecha,
            total, tipo_venta, metodo_pago, id_sucursal, id_usuario, id_caja_sesion, id_cliente, estado,
            id_comprobante_serie, tipo_comprobante, serie_comprobante, correlativo_comprobante, numero_comprobante,
            monto_recibido, cambio_entregado,
            (anulada_en AT TIME ZONE 'America/Guatemala') AS anulada_en,
            anulada_por, motivo_anulacion,
            no_cobrado_motivo, no_cobrado_autorizado_por,
            (no_cobrado_autorizado_en AT TIME ZONE 'America/Guatemala') AS no_cobrado_autorizado_en,
            no_cobrado_validado_por,
            (no_cobrado_validado_en AT TIME ZONE 'America/Guatemala') AS no_cobrado_validado_en,
            no_cobrado_validacion_nota`,
  [
    tipo_venta ?? "CONTADO",
    metodoPagoPersistido,
    id_sucursal,
    id_usuario,
    id_caja_sesion,
    id_cliente,
    ventaSinCobro ? "NO_COBRADO" : "COMPLETADA",
    comprobante.id_comprobante_serie,
    comprobante.tipo_comprobante,
    comprobante.serie_comprobante,
    comprobante.correlativo_comprobante,
    comprobante.numero_comprobante,
    ventaSinCobro ? no_cobrado_motivo : null,
    ventaSinCobro ? no_cobrado_autorizado_por : null,
    ventaSinCobro,
  ]
);

    const venta = rVenta.rows[0];
    let total = 0;
    let utilidad_total = 0;

    for (const it of items) {
      const id_producto = Number(it.id_producto);
      const cantidad = Number(it.cantidad);

      if (!Number.isInteger(id_producto) || !Number.isInteger(cantidad) || cantidad <= 0) {
        throw new Error("Items inválidos (id_producto y cantidad deben ser enteros > 0)");
      }

      // precio desde producto
     const rProd = await client.query(
  `SELECT id_producto, nombre, precio_venta, precio_compra
   FROM "Producto"
   WHERE id_producto = $1`,
  [id_producto]
);
      if (rProd.rowCount === 0) throw new Error(`Producto no existe: ${id_producto}`);

      //const precio_unitario = Number(rProd.rows[0].precio_venta);
      //const nombreProd = rProd.rows[0].nombre;

      const precio_unitario = Number(rProd.rows[0].precio_venta);
const costo_unitario = Number(rProd.rows[0].precio_compra || 0);
const nombreProd = rProd.rows[0].nombre;


      // stock lock
      const rStock = await client.query(
        `SELECT existencia
         FROM "Stock_producto"
         WHERE id_producto = $1 AND id_bodega = $2
         FOR UPDATE`,
        [id_producto, id_bodega]
      );
      if (rStock.rowCount === 0) throw new Error(`No hay stock para producto ${id_producto} en bodega ${id_bodega}`);

      const antes = Number(rStock.rows[0].existencia);
      if (antes < cantidad) throw new Error(`Stock insuficiente para "${nombreProd}". Disponible: ${antes}`);

      const despues = antes - cantidad;

      const subtotal = Number((precio_unitario * cantidad).toFixed(2));
      const costo_total = Number((costo_unitario * cantidad).toFixed(2));
      const utilidad = Number((subtotal - costo_total).toFixed(2));

      total += subtotal;
      utilidad_total += utilidad;

      await client.query(
  `INSERT INTO "Detalle_venta"(
      id_venta,
      id_producto,
      cantidad,
      precio_unitario,
      costo_unitario,
      subtotal,
      utilidad,
      estado,
      cantidad_anulada
   )
   VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVO',0)`,
  [
    venta.id_venta,
    id_producto,
    cantidad,
    precio_unitario,
    costo_unitario,
    subtotal,
    utilidad
  ]
);

      await client.query(
        `UPDATE "Stock_producto"
         SET existencia = $1
         WHERE id_producto = $2 AND id_bodega = $3`,
        [despues, id_producto, id_bodega]
      );

      await client.query(
        `INSERT INTO "Movimiento_stock"
         (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
         VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)`,
        [`Venta #${venta.id_venta}`, cantidad, antes, despues, id_producto, id_bodega, id_usuario]
      );
    }

    const rFinal = await client.query(
      `UPDATE "Venta"
       SET total = $1,
           utilidad_total = $2,
           monto_recibido = $3,
           cambio_entregado = $4
       WHERE id_venta = $5
       RETURNING *`,
      [
        Number(total.toFixed(2)),
        Number(utilidad_total.toFixed(2)),
        !ventaSinCobro && montoRecibidoNormalizado != null
          ? Number(montoRecibidoNormalizado.toFixed(2))
          : null,
        !ventaSinCobro &&
        metodoPagoNormalizado === "EFECTIVO" &&
        montoRecibidoNormalizado != null
          ? Number(Math.max(0, montoRecibidoNormalizado - total).toFixed(2))
          : 0,
        venta.id_venta,
      ]
    );

    await client.query("COMMIT");

    return rFinal.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

export const getVentaById = async (id_venta) => {
  const r = await pool.query(
    `SELECT 
        v.*,
        u.username AS usuario_username,
        u.nombre   AS usuario_nombre,
        c.codigo   AS cliente_codigo,
        c.nombre   AS cliente_nombre,
        c.nit      AS cliente_nit,
        cs.nombre  AS comprobante_nombre
     FROM "Venta" v
     JOIN "Usuario" u ON u.id_usuario = v.id_usuario
     LEFT JOIN "Clientes" c ON c."Id_clientes" = v.id_cliente
     LEFT JOIN "Comprobante_serie" cs ON cs.id_comprobante_serie = v.id_comprobante_serie
     WHERE v.id_venta = $1`,
    [id_venta]
  );
  return r.rows[0];
};

export const getDetallesByVenta = async (id_venta) => {
  const r = await pool.query(
    `SELECT 
        d.*,
        p.nombre AS producto_nombre,
        p.codigo_barras
     FROM "Detalle_venta" d
     JOIN "Producto" p ON p.id_producto = d.id_producto
     WHERE d.id_venta = $1
     ORDER BY d.id_detalle ASC`,
    [id_venta]
  );
  return r.rows;
};

const ALLOWED_SORT = new Set([
  "id_venta",
  "fecha",
  "total",
  "utilidad_total",
  "estado",
  "id_usuario",
  "id_cliente",
  "correlativo_comprobante",
]);

export const listarVentas = async (filters) => {
  const {
    desde,
    hasta,
    estado,
    id_usuario,
    tipo_venta,
    metodo_pago,
    id_sucursal,
    q,
    page = 1,
    limit = 20,
    sortBy = "fecha",
    sortDir = "desc",
  } = filters;

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (safePage - 1) * safeLimit;

  const safeSortBy = ALLOWED_SORT.has(sortBy) ? sortBy : "fecha";
  const safeSortDir = String(sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";

  const where = [];
  const params = [];
  let i = 1;

  // Fecha (timestamptz): desde inclusive, hasta inclusive (hasta fin del día)
  if (desde) {
    where.push(`v.fecha >= $${i++}::timestamptz`);
    params.push(desde);
  }
  if (hasta) {
    // si te mandan "2026-02-23" lo convertimos a fin de día
    where.push(`v.fecha < ($${i++}::date + interval '1 day')`);
    params.push(hasta);
  }

  if (estado) {
    where.push(`v.estado = $${i++}`);
    params.push(String(estado).toUpperCase());
  }

  if (id_usuario) {
    where.push(`v.id_usuario = $${i++}`);
    params.push(Number(id_usuario));
  }

  if (tipo_venta) {
    where.push(`v.tipo_venta = $${i++}`);
    params.push(String(tipo_venta).toUpperCase());
  }

  if (metodo_pago) {
    where.push(`v.metodo_pago = $${i++}`);
    params.push(String(metodo_pago).toUpperCase());
  }

  if (id_sucursal) {
    where.push(`v.id_sucursal = $${i++}`);
    params.push(Number(id_sucursal));
  }

  // Búsqueda rápida (opcional): id_venta exacto o username contiene
  if (q) {
    const qq = String(q).trim();
    if (/^\d+$/.test(qq)) {
      where.push(`v.id_venta = $${i++}`);
      params.push(Number(qq));
      } else {
      where.push(`(
        u.username ILIKE $${i++}
        OR COALESCE(c.nombre, '') ILIKE $${i++}
        OR COALESCE(c.codigo, '') ILIKE $${i++}
        OR COALESCE(v.numero_comprobante, '') ILIKE $${i++}
      )`);
      params.push(`%${qq}%`, `%${qq}%`, `%${qq}%`, `%${qq}%`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Total rows (para paginación)
  const rCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM "Venta" v
     JOIN "Usuario" u ON u.id_usuario = v.id_usuario
     LEFT JOIN "Clientes" c ON c."Id_clientes" = v.id_cliente
     ${whereSql}`,
    params
  );

  const totalRows = rCount.rows[0]?.total ?? 0;
  const totalPages = Math.ceil(totalRows / safeLimit);

  // Data
  const rData = await pool.query(
    `SELECT
        v.*,
        u.username AS usuario_username,
        u.nombre   AS usuario_nombre,
        c.codigo   AS cliente_codigo,
        c.nombre   AS cliente_nombre,
        c.nit      AS cliente_nit,
        cs.nombre  AS comprobante_nombre
     FROM "Venta" v
     JOIN "Usuario" u ON u.id_usuario = v.id_usuario
     LEFT JOIN "Clientes" c ON c."Id_clientes" = v.id_cliente
     LEFT JOIN "Comprobante_serie" cs ON cs.id_comprobante_serie = v.id_comprobante_serie
     ${whereSql}
     ORDER BY v.${safeSortBy} ${safeSortDir}
     LIMIT $${i++} OFFSET $${i++}`,
    [...params, safeLimit, offset]
  );

  return {
    data: rData.rows,
    meta: {
      page: safePage,
      limit: safeLimit,
      totalRows,
      totalPages,
      sortBy: safeSortBy,
      sortDir: safeSortDir,
      filters: { desde, hasta, estado, id_usuario, tipo_venta, metodo_pago, id_sucursal, q },
    },
  };
};

export const getVentaCompleta = async (id_venta) => {
  // 1) Venta + usuario
  const rVenta = await pool.query(
    `SELECT
        v.*,
        u.username AS usuario_username,
        u.nombre   AS usuario_nombre,
        c.codigo   AS cliente_codigo,
        c.nombre   AS cliente_nombre,
        c.nit      AS cliente_nit,
        cs.nombre  AS comprobante_nombre
     FROM "Venta" v
     JOIN "Usuario" u ON u.id_usuario = v.id_usuario
     LEFT JOIN "Clientes" c ON c."Id_clientes" = v.id_cliente
     LEFT JOIN "Comprobante_serie" cs ON cs.id_comprobante_serie = v.id_comprobante_serie
     WHERE v.id_venta = $1`,
    [id_venta]
  );

  const venta = rVenta.rows[0];
  if (!venta) return null;

  // 2) Detalles + producto
  const rDet = await pool.query(
    `SELECT
        d.*,
        p.nombre AS producto_nombre,
        p.codigo_barras
     FROM "Detalle_venta" d
     JOIN "Producto" p ON p.id_producto = d.id_producto
     WHERE d.id_venta = $1
     ORDER BY d.id_detalle ASC`,
    [id_venta]
  );

  const detalles = rDet.rows;

  const rAnulaciones = await pool.query(
    `SELECT
        a.id_anulacion,
        a.id_venta,
        a.id_detalle,
        a.id_producto,
        a.cantidad,
        a.motivo,
        (a.fecha AT TIME ZONE 'America/Guatemala') AS fecha,
        a.id_usuario AS anulada_por,
        u.username AS anulada_por_username,
        u.nombre AS anulada_por_nombre,
        p.nombre AS producto_nombre,
        p.codigo_barras
     FROM "Detalle_venta_anulacion" a
     LEFT JOIN "Usuario" u ON u.id_usuario = a.id_usuario
     LEFT JOIN "Producto" p ON p.id_producto = a.id_producto
     WHERE a.id_venta = $1
     ORDER BY a.fecha DESC, a.id_anulacion DESC`,
    [id_venta]
  );

  const anulaciones = rAnulaciones.rows;

  // 3) Resumen calculado (para no depender de venta.total)
  const resumen = detalles.reduce(
    (acc, d) => {
      const cant = Number(d.cantidad) || 0;
      const an = Number(d.cantidad_anulada) || 0;
      const pu = Number(d.precio_unitario) || 0;

      const sub_original = cant * pu;
      const sub_actual = (cant - an) * pu;
      const sub_anulado = an * pu;

      acc.total_original += sub_original;
      acc.total_actual += sub_actual;
      acc.total_anulado += sub_anulado;

      acc.items_original += cant;
      acc.items_anulados += an;
      acc.items_actual += (cant - an);

      return acc;
    },
    {
      total_original: 0,
      total_actual: 0,
      total_anulado: 0,
      items_original: 0,
      items_actual: 0,
      items_anulados: 0,
    }
  );

  // redondeo 2 decimales
  const round2 = (n) => Number((Number(n) || 0).toFixed(2));
  resumen.total_original = round2(resumen.total_original);
  resumen.total_actual = round2(resumen.total_actual);
  resumen.total_anulado = round2(resumen.total_anulado);

  // 4) Estado “real” por si quieres coherencia
  const todoAnulado = resumen.items_actual === 0;
  const estado_real = todoAnulado ? "ANULADA" : venta.estado;

  return {
    venta: { ...venta, estado_real },
    detalles,
    anulaciones,
    resumen,
  };
};

