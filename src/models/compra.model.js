import { pool } from "../config/db.js";

const round2 = (n) => Number((Number(n) || 0).toFixed(2));

/**
 * Crea compra:
 * - Inserta Compra (total 0)
 * - Inserta Detalle_compra
 * - Sube Stock_producto
 * - Inserta Movimiento_stock (ENTRADA)
 * - Actualiza Producto.precio_compra (último costo)
 * - Recalcula total compra
 */
export const crearCompra = async ({
  tipo_documento,
  no_documento,
  fecha_compra,
  observaciones,
  id_usuario,
  id_proveedor,
  id_sucursal = 1,
  id_bodega = 1,
  items
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) Crear Compra
    const rCompra = await client.query(
      `INSERT INTO "Compra"(
        fecha,
        tipo_documento,
        no_documento,
        subtotal,
        descuento,
        total,
        estado,
        observaciones,
        id_proveedor,
        id_sucursal,
        id_bodega,
        id_usuario
      )
      VALUES (
        COALESCE($1::timestamptz, now()),
        $2,
        $3,
        0,
        0,
        0,
        'COMPLETADA',
        $4,
        $5,
        $6,
        $7,
        $8
      )
      RETURNING *`,
      [
        fecha_compra ?? null,
        tipo_documento ?? "FACTURA",
        no_documento ?? null,
        observaciones ?? null,
        id_proveedor,
        id_sucursal,
        id_bodega,
        id_usuario
      ]
    );

    const compra = rCompra.rows[0];
    let total = 0;

    // 2) Procesar items
    for (const it of items) {
      const id_producto = Number(it.id_producto);
      const cantidad = Number(it.cantidad);
      const precio_compra = Number(it.precio_compra);

      if (!Number.isInteger(id_producto) || id_producto <= 0) throw new Error("id_producto inválido");
      if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error("cantidad debe ser entero > 0");
      if (!Number.isFinite(precio_compra) || precio_compra < 0) throw new Error("precio_compra inválido");

      // Verificar producto existe
      const rProd = await client.query(
        `SELECT id_producto, nombre FROM "Producto" WHERE id_producto = $1`,
        [id_producto]
      );
      if (rProd.rowCount === 0) throw new Error(`Producto no existe: ${id_producto}`);

      const subtotal = round2(precio_compra * cantidad);
      total += subtotal;

      // Insert detalle compra
      await client.query(
        `INSERT INTO "Detalle_compra"(id_compra, id_producto, cantidad, precio_compra, subtotal, estado, cantidad_anulada)
         VALUES ($1,$2,$3,$4,$5,'ACTIVO',0)`,
        [compra.id_compra, id_producto, cantidad, precio_compra, subtotal]
      );

      // Stock lock (si no existe fila, la creamos)
      const rStock = await client.query(
        `SELECT existencia
         FROM "Stock_producto"
         WHERE id_producto = $1 AND id_bodega = $2
         FOR UPDATE`,
        [id_producto, id_bodega]
      );

      let antes = 0;
      if (rStock.rowCount === 0) {
        // crear stock
        await client.query(
          `INSERT INTO "Stock_producto"(id_producto, id_bodega, existencia)
           VALUES ($1,$2,0)`,
          [id_producto, id_bodega]
        );
      } else {
        antes = Number(rStock.rows[0].existencia);
      }

      const despues = antes + cantidad;

      await client.query(
        `UPDATE "Stock_producto"
         SET existencia = $1
         WHERE id_producto = $2 AND id_bodega = $3`,
        [despues, id_producto, id_bodega]
      );

      // Movimiento stock ENTRADA
      await client.query(
        `INSERT INTO "Movimiento_stock"
         (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
         VALUES ('ENTRADA', $1, $2, $3, $4, $5, $6, $7)`,
        [`Compra #${compra.id_compra}`, cantidad, antes, despues, id_producto, id_bodega, id_usuario]
      );

      // Actualizar costo (último costo). (Luego si quieres, hacemos costo promedio ponderado)
      await client.query(
        `UPDATE "Producto" SET precio_compra = $1 WHERE id_producto = $2`,
        [precio_compra, id_producto]
      );
    }

    // 3) actualizar total compra
    const totalFinal = round2(total);
    const rFinal = await client.query(
      `UPDATE "Compra"
       SET subtotal = $1,
           total = $1
       WHERE id_compra = $2
       RETURNING *`,
      [totalFinal, compra.id_compra]
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

// ===== Listar compras (pro) =====
const ALLOWED_SORT = new Set(["id_compra", "fecha", "total", "estado", "id_proveedor", "id_usuario"]);

export const listarCompras = async (filters) => {
  const {
    desde,
    hasta,
    estado,
    no_documento,
    proveedor,
    id_usuario,
    id_proveedor,
    id_sucursal,
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
  const estadoNormalizado = String(estado || "").trim().toUpperCase();

  if (desde) { where.push(`c.fecha >= $${i++}::timestamptz`); params.push(desde); }
  if (hasta) { where.push(`c.fecha < ($${i++}::date + interval '1 day')`); params.push(hasta); }
  if (no_documento) {
    where.push(`COALESCE(c.no_documento, '') ILIKE $${i++}`);
    params.push(`%${String(no_documento).trim()}%`);
  }
  if (proveedor) {
    where.push(`COALESCE(p.nombre, '') ILIKE $${i++}`);
    params.push(`%${String(proveedor).trim()}%`);
  }

  if (estadoNormalizado === "PARCIAL") {
    where.push(`UPPER(COALESCE(c.estado, '')) <> 'ANULADA'`);
    where.push(`EXISTS (
      SELECT 1
      FROM "Detalle_compra" d_estado
      WHERE d_estado.id_compra = c.id_compra
        AND COALESCE(d_estado.cantidad_anulada, 0) > 0
    )`);
  } else if (estadoNormalizado === "COMPLETADA") {
    where.push(`UPPER(COALESCE(c.estado, '')) = 'COMPLETADA'`);
    where.push(`NOT EXISTS (
      SELECT 1
      FROM "Detalle_compra" d_estado
      WHERE d_estado.id_compra = c.id_compra
        AND COALESCE(d_estado.cantidad_anulada, 0) > 0
    )`);
  } else if (estadoNormalizado) {
    where.push(`c.estado = $${i++}`);
    params.push(estadoNormalizado);
  }
  if (id_usuario) { where.push(`c.id_usuario = $${i++}`); params.push(Number(id_usuario)); }
  if (id_proveedor) { where.push(`c.id_proveedor = $${i++}`); params.push(Number(id_proveedor)); }
  if (id_sucursal) { where.push(`c.id_sucursal = $${i++}`); params.push(Number(id_sucursal)); }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM "Compra" c
     JOIN "Proveedor" p ON p.id_proveedor = c.id_proveedor
     ${whereSql}`,
    params
  );

  const totalRows = rCount.rows[0]?.total ?? 0;
  const totalPages = Math.ceil(totalRows / safeLimit);

  const rData = await pool.query(
    `SELECT
        c.*,
        p.nombre AS proveedor_nombre,
        u.username AS usuario_username,
        COALESCE(ds.unidades_anuladas, 0) AS unidades_anuladas,
        COALESCE(ds.detalles_anulados, 0) AS detalles_anulados,
        CASE
          WHEN UPPER(COALESCE(c.estado, '')) = 'ANULADA' THEN 'ANULADA'
          WHEN COALESCE(ds.unidades_anuladas, 0) > 0 THEN 'PARCIAL'
          ELSE c.estado
        END AS estado_visual
     FROM "Compra" c
     JOIN "Proveedor" p ON p.id_proveedor = c.id_proveedor
     JOIN "Usuario" u ON u.id_usuario = c.id_usuario
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(d.cantidad_anulada), 0) AS unidades_anuladas,
         COUNT(*) FILTER (WHERE COALESCE(d.cantidad_anulada, 0) > 0) AS detalles_anulados
       FROM "Detalle_compra" d
       WHERE d.id_compra = c.id_compra
     ) ds ON true
     ${whereSql}
     ORDER BY c.${safeSortBy} ${safeSortDir}
     LIMIT $${i++} OFFSET $${i++}`,
    [...params, safeLimit, offset]
  );

  return {
    data: rData.rows,
    meta: { page: safePage, limit: safeLimit, totalRows, totalPages, sortBy: safeSortBy, sortDir: safeSortDir }
  };
};

// ===== Compra completa =====
export const getCompraCompleta = async (id_compra) => {
  const rC = await pool.query(
    `SELECT
        c.*,
        p.nombre AS proveedor_nombre,
        u.username AS usuario_username,
        u.nombre AS usuario_nombre
     FROM "Compra" c
     JOIN "Proveedor" p ON p.id_proveedor = c.id_proveedor
     JOIN "Usuario" u ON u.id_usuario = c.id_usuario
     WHERE c.id_compra = $1`,
    [id_compra]
  );
  const compra = rC.rows[0];
  if (!compra) return null;

  const rD = await pool.query(
    `SELECT
        d.*,
        pr.nombre AS producto_nombre,
        pr.codigo_barras
     FROM "Detalle_compra" d
     JOIN "Producto" pr ON pr.id_producto = d.id_producto
     WHERE d.id_compra = $1
     ORDER BY d.id_detalle_compra ASC`,
    [id_compra]
  );
  const detalles = rD.rows;

  const rA = await pool.query(
    `SELECT
        a.*,
        u.username AS anulada_por_username,
        u.nombre AS anulada_por_nombre
     FROM "Detalle_compra_anulacion" a
     LEFT JOIN "Usuario" u ON u.id_usuario = a.id_usuario
     WHERE a.id_compra = $1
     ORDER BY a.fecha DESC, a.id_anulacion DESC`,
    [id_compra]
  );
  const anulaciones = rA.rows;

  const resumen = detalles.reduce(
    (acc, d) => {
      const cant = Number(d.cantidad) || 0;
      const an = Number(d.cantidad_anulada) || 0;
      const pu = Number(d.precio_compra) || 0;

      acc.total_original += cant * pu;
      acc.total_actual += (cant - an) * pu;
      acc.total_anulado += an * pu;

      acc.items_original += cant;
      acc.items_anulados += an;
      acc.items_actual += (cant - an);
      return acc;
    },
    { total_original: 0, total_actual: 0, total_anulado: 0, items_original: 0, items_actual: 0, items_anulados: 0 }
  );

  resumen.total_original = round2(resumen.total_original);
  resumen.total_actual = round2(resumen.total_actual);
  resumen.total_anulado = round2(resumen.total_anulado);

  const todoAnulado = resumen.items_actual === 0;
  const estado_real = todoAnulado ? "ANULADA" : compra.estado;

  return { compra: { ...compra, estado_real }, detalles, anulaciones, resumen };
};

// ===== Anulación parcial de un detalle compra (revierte stock con SALIDA) =====
export const anularDetalleCompra = async ({ id_compra, id_detalle, cantidad, motivo, id_usuario, id_bodega = 1 }) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rDet = await client.query(
      `SELECT id_detalle_compra, id_compra, id_producto, cantidad, cantidad_anulada, precio_compra
       FROM "Detalle_compra"
       WHERE id_detalle_compra = $1 AND id_compra = $2
       FOR UPDATE`,
      [id_detalle, id_compra]
    );
    if (rDet.rowCount === 0) throw new Error("Detalle de compra no encontrado");

    const det = rDet.rows[0];
    const disponible = Number(det.cantidad) - Number(det.cantidad_anulada);

    if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error("cantidad debe ser entero > 0");
    if (cantidad > disponible) throw new Error(`No puedes anular ${cantidad}. Disponible: ${disponible}`);

    // stock lock
    const rStock = await client.query(
      `SELECT existencia
       FROM "Stock_producto"
       WHERE id_producto = $1 AND id_bodega = $2
       FOR UPDATE`,
      [det.id_producto, id_bodega]
    );
    if (rStock.rowCount === 0) throw new Error("No existe stock para este producto en la bodega");

    const antes = Number(rStock.rows[0].existencia);
    if (antes < cantidad) throw new Error(`No hay stock suficiente para revertir. Existencia: ${antes}`);

    const despues = antes - cantidad;

    await client.query(
      `UPDATE "Stock_producto"
       SET existencia = $1
       WHERE id_producto = $2 AND id_bodega = $3`,
      [despues, det.id_producto, id_bodega]
    );

    // Movimiento SALIDA por anulación compra
    await client.query(
      `INSERT INTO "Movimiento_stock"
       (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
       VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)`,
      [`Anulación compra #${id_compra} detalle #${id_detalle}`, cantidad, antes, despues, det.id_producto, id_bodega, id_usuario]
    );

    const nueva_anulada = Number(det.cantidad_anulada) + cantidad;
    const nuevo_estado = nueva_anulada === Number(det.cantidad) ? "ANULADO" : "PARCIAL";

    await client.query(
      `UPDATE "Detalle_compra"
       SET cantidad_anulada = $1,
           estado = $2,
           anulada_en = now(),
           anulada_por = $3,
           motivo_anulacion = $4
       WHERE id_detalle_compra = $5`,
      [nueva_anulada, nuevo_estado, id_usuario, motivo ?? null, id_detalle]
    );

    await client.query(
      `INSERT INTO "Detalle_compra_anulacion"
       (id_compra, id_detalle_compra, id_producto, cantidad, motivo, id_usuario)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id_compra, id_detalle, det.id_producto, cantidad, motivo ?? null, id_usuario]
    );

    // Recalcular total compra
    const rTotal = await client.query(
      `SELECT COALESCE(SUM((cantidad - cantidad_anulada) * precio_compra),0) AS total
       FROM "Detalle_compra"
       WHERE id_compra = $1`,
      [id_compra]
    );
    const total = round2(rTotal.rows[0].total);

    // Si todo anulado -> compra ANULADA
    const rActivos = await client.query(
      `SELECT COUNT(*)::int AS activos
       FROM "Detalle_compra"
       WHERE id_compra = $1 AND (cantidad - cantidad_anulada) > 0`,
      [id_compra]
    );
    const compraAnulada = rActivos.rows[0].activos === 0;

    await client.query(
      `UPDATE "Compra"
       SET subtotal = $1,
           total = $1,
           estado = CASE WHEN $2 THEN 'ANULADA' ELSE estado END,
           anulada_en = CASE WHEN $2 THEN now() ELSE anulada_en END,
           anulada_por = CASE WHEN $2 THEN $3 ELSE anulada_por END,
           motivo_anulacion = CASE WHEN $2 THEN COALESCE($4, motivo_anulacion) ELSE motivo_anulacion END
       WHERE id_compra = $5`,
      [total, compraAnulada, id_usuario, motivo ?? null, id_compra]
    );

    await client.query("COMMIT");
    return { ok: true, compra_anulada: compraAnulada, total };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

// ===== Anulación total compra: revierte TODO stock (SALIDA) =====
export const anularCompra = async ({ id_compra, motivo, id_usuario, id_bodega = 1 }) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const rCompra = await client.query(
      `SELECT * FROM "Compra" WHERE id_compra = $1 FOR UPDATE`,
      [id_compra]
    );
    if (rCompra.rowCount === 0) throw new Error("Compra no encontrada");

    if (String(rCompra.rows[0].estado).toUpperCase() === "ANULADA") {
      throw new Error("La compra ya está ANULADA");
    }

    // Traer detalles
    const rDet = await client.query(
      `SELECT id_detalle_compra, id_producto, cantidad, cantidad_anulada
       FROM "Detalle_compra"
       WHERE id_compra = $1
       FOR UPDATE`,
      [id_compra]
    );

    for (const d of rDet.rows) {
      const pendiente = Number(d.cantidad) - Number(d.cantidad_anulada);
      if (pendiente <= 0) continue;

      // lock stock
      const rStock = await client.query(
        `SELECT existencia
         FROM "Stock_producto"
         WHERE id_producto = $1 AND id_bodega = $2
         FOR UPDATE`,
        [d.id_producto, id_bodega]
      );
      if (rStock.rowCount === 0) throw new Error("No existe stock para producto/bodega");

      const antes = Number(rStock.rows[0].existencia);
      if (antes < pendiente) throw new Error(`No hay stock para revertir compra. Producto ${d.id_producto}, existencia ${antes}, requiere ${pendiente}`);

      const despues = antes - pendiente;

      await client.query(
        `UPDATE "Stock_producto" SET existencia = $1 WHERE id_producto = $2 AND id_bodega = $3`,
        [despues, d.id_producto, id_bodega]
      );

      await client.query(
        `INSERT INTO "Movimiento_stock"
         (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
         VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)`,
        [`Anulación total compra #${id_compra}`, pendiente, antes, despues, d.id_producto, id_bodega, id_usuario]
      );

      // marcar detalle anulado completo
      await client.query(
        `UPDATE "Detalle_compra"
         SET cantidad_anulada = cantidad,
             estado = 'ANULADO',
             anulada_en = now(),
             anulada_por = $1,
             motivo_anulacion = $2
         WHERE id_detalle_compra = $3`,
        [id_usuario, motivo ?? null, d.id_detalle_compra]
      );

      await client.query(
        `INSERT INTO "Detalle_compra_anulacion"
         (id_compra, id_detalle_compra, id_producto, cantidad, motivo, id_usuario)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id_compra, d.id_detalle_compra, d.id_producto, pendiente, motivo ?? null, id_usuario]
      );
    }

    // total a 0 y compra ANULADA
    await client.query(
      `UPDATE "Compra"
       SET subtotal = 0,
           total = 0,
           estado = 'ANULADA',
           anulada_en = now(),
           anulada_por = $1,
           motivo_anulacion = $2
       WHERE id_compra = $3`,
      [id_usuario, motivo ?? null, id_compra]
    );

    await client.query("COMMIT");
    return { ok: true, compra_anulada: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};
