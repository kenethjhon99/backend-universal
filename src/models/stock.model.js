import { pool } from "../config/db.js";

export const getStock = async ({
  id_bodega = 1,
  q = "",
  solo_bajo_minimo = false,
} = {}) => {
  const values = [id_bodega];
  const where = [`s.id_bodega = $1`, `COALESCE(p.activo, true) = true`];
  let index = 2;

  if (q) {
    where.push(`(
      p.nombre ILIKE $${index}
      OR COALESCE(p.descripcion, '') ILIKE $${index}
      OR COALESCE(p.codigo_barras, '') ILIKE $${index}
    )`);
    values.push(`%${q}%`);
    index++;
  }

  if (solo_bajo_minimo) {
    where.push(`
      COALESCE(s.stock_minimo, 0) > 0
      AND COALESCE(s.existencia, 0) <= COALESCE(s.stock_minimo, 0)
    `);
  }

  const result = await pool.query(
    `
    SELECT
      p.id_producto,
      p.codigo_barras,
      p.nombre,
      p.descripcion,
      COALESCE(p.modulo_origen, 'GENERAL') AS modulo_origen,
      p.precio_compra,
      p.precio_venta,
      s.id_stock,
      s.existencia,
      s.stock_minimo,
      s.ubicacion,
      s.id_bodega,
      GREATEST(COALESCE(s.stock_minimo, 0) - COALESCE(s.existencia, 0), 0) AS faltante,
      (
        COALESCE(s.stock_minimo, 0) > 0
        AND COALESCE(s.existencia, 0) <= COALESCE(s.stock_minimo, 0)
      ) AS bajo_minimo
    FROM "Producto" p
    JOIN "Stock_producto" s
      ON s."id_producto" = p."id_producto"
    WHERE ${where.join(" AND ")}
    ORDER BY
      (
        COALESCE(s.stock_minimo, 0) > 0
        AND COALESCE(s.existencia, 0) <= COALESCE(s.stock_minimo, 0)
      ) DESC,
      p."nombre" ASC
  `,
    values
  );

  return result.rows;
};

export const getStockByProducto = async (id_producto, id_bodega = 1) => {
  const r = await pool.query(
    `SELECT * FROM "Stock_producto" 
     WHERE id_producto = $1 AND id_bodega = $2`,
    [id_producto, id_bodega]
  );
  return r.rows[0];
};

export const setExistencia = async (id_producto, existencia, id_bodega = 1) => {
  const r = await pool.query(
    `UPDATE "Stock_producto"
     SET existencia = $1
     WHERE id_producto = $2 AND id_bodega = $3
     RETURNING *`,
    [existencia, id_producto, id_bodega]
  );
  return r.rows[0];
};

export const crearMovimientoStock = async ({
  id_producto,
  id_bodega = 1,
  tipo,
  motivo = null,
  cantidad,
  nueva_existencia = null,
  id_usuario = null,
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) Traer stock actual
    const rStock = await client.query(
      `SELECT existencia
       FROM "Stock_producto"
       WHERE id_producto = $1 AND id_bodega = $2
       FOR UPDATE`,
      [id_producto, id_bodega]
    );

    if (rStock.rowCount === 0) {
      throw new Error("No existe registro de stock para ese producto en esa bodega");
    }

    const existencia_antes = Number(rStock.rows[0].existencia);
    let existencia_despues = existencia_antes;

    // 2) Calcular existencia nueva
    if (tipo === "ENTRADA") {
      if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error("cantidad debe ser entero > 0");
      existencia_despues = existencia_antes + cantidad;
    } else if (tipo === "SALIDA") {
      if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error("cantidad debe ser entero > 0");
      if (existencia_antes - cantidad < 0) throw new Error("No hay stock suficiente para salida");
      existencia_despues = existencia_antes - cantidad;
    } else if (tipo === "AJUSTE") {
      if (!Number.isInteger(nueva_existencia) || nueva_existencia < 0)
        throw new Error("nueva_existencia debe ser entero >= 0");
      // cantidad en ajuste = diferencia absoluta (para registro)
      cantidad = Math.abs(nueva_existencia - existencia_antes);
      existencia_despues = nueva_existencia;
    } else {
      throw new Error("tipo inválido (ENTRADA|SALIDA|AJUSTE)");
    }

    // 3) Actualizar stock_producto
    const rUpdate = await client.query(
      `UPDATE "Stock_producto"
       SET existencia = $1
       WHERE id_producto = $2 AND id_bodega = $3
       RETURNING *`,
      [existencia_despues, id_producto, id_bodega]
    );

    // 4) Insertar movimiento
    const rMov = await client.query(
      `INSERT INTO "Movimiento_stock"
       (tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tipo, motivo, cantidad, existencia_antes, existencia_despues, id_producto, id_bodega, id_usuario]
    );

    await client.query("COMMIT");

    return {
      stock: rUpdate.rows[0],
      movimiento: rMov.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getMovimientosStock = async ({
  id_producto = null,
  id_bodega = 1,
  tipo = null,
  desde = null,
  hasta = null,
  q = "",
  limit = 100,
} = {}) => {
  const values = [id_bodega];
  const where = [`ms.id_bodega = $1`];
  let index = 2;

  if (id_producto) {
    where.push(`ms.id_producto = $${index}`);
    values.push(id_producto);
    index++;
  }

  if (tipo && ["ENTRADA", "SALIDA", "AJUSTE"].includes(String(tipo).toUpperCase())) {
    where.push(`ms.tipo = $${index}`);
    values.push(String(tipo).toUpperCase());
    index++;
  }

  if (desde) {
    where.push(`ms.fecha::date >= $${index}::date`);
    values.push(desde);
    index++;
  }

  if (hasta) {
    where.push(`ms.fecha::date <= $${index}::date`);
    values.push(hasta);
    index++;
  }

  if (q) {
    where.push(`(
      COALESCE(p.nombre, '') ILIKE $${index}
      OR COALESCE(p.codigo_barras, '') ILIKE $${index}
      OR COALESCE(ms.motivo, '') ILIKE $${index}
      OR COALESCE(u.username, '') ILIKE $${index}
      OR COALESCE(u.nombre, '') ILIKE $${index}
    )`);
    values.push(`%${q}%`);
    index++;
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  values.push(normalizedLimit);

  const r = await pool.query(
    `
    SELECT
      ms.*,
      p.nombre AS producto_nombre,
      p.codigo_barras AS producto_codigo_barras,
      COALESCE(p.modulo_origen, 'GENERAL') AS producto_modulo_origen,
      p.descripcion AS producto_descripcion,
      COALESCE(u.nombre, u.username, 'Sistema') AS usuario_nombre,
      u.username AS usuario_username
    FROM "Movimiento_stock" ms
    LEFT JOIN "Producto" p
      ON p.id_producto = ms.id_producto
    LEFT JOIN "Usuario" u
      ON u.id_usuario = ms.id_usuario
    WHERE ${where.join(" AND ")}
    ORDER BY ms.fecha DESC, ms.updated_at DESC, ms.id_producto ASC
    LIMIT $${index}
    `,
    values
  );

  return r.rows;
};

export const updateDatosStock = async ({
  id_producto,
  id_bodega = 1,
  stock_minimo,
  ubicacion,
}) => {
  const fields = [];
  const values = [];
  let index = 1;

  if (stock_minimo !== undefined) {
    fields.push(`stock_minimo = $${index}`);
    values.push(stock_minimo);
    index++;
  }

  if (ubicacion !== undefined) {
    fields.push(`ubicacion = $${index}`);
    values.push(ubicacion);
    index++;
  }

  if (fields.length === 0) return null;

  values.push(id_producto);
  values.push(id_bodega);

  const query = `
    UPDATE "Stock_producto"
    SET ${fields.join(", ")}
    WHERE id_producto = $${index} AND id_bodega = $${index + 1}
    RETURNING *
  `;

  const r = await pool.query(query, values);
  return r.rows[0];
};
