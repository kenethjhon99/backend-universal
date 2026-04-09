import { pool } from "../config/db.js";

const AUDIT_ENTITIES = {
  PRODUCTOS: {
    table: "Producto",
    alias: "p",
    idColumn: "id_producto",
    codeExpr: `COALESCE(p.codigo_barras, '')`,
    nameExpr: `COALESCE(p.nombre, 'Sin nombre')`,
    detailExpr: `COALESCE(p.descripcion, '')`,
    activeExpr: `COALESCE(p.activo, true)`,
    fromSql: `"Producto" p`,
    createdAtExpr: "p.created_at",
    updatedAtExpr: "p.updated_at",
    inactivatedAtExpr: "p.inactivado_en",
    createdByExpr: "p.created_by",
    updatedByExpr: "p.updated_by",
    inactivatedByExpr: "p.inactivado_por",
    referenceExpr: "NULL::text",
    quantityExpr: "NULL::integer",
    reasonExpr: "NULL::text",
  },
  PROVEEDORES: {
    table: "Proveedor",
    alias: "p",
    idColumn: "id_proveedor",
    codeExpr: `COALESCE(p.nit, '')`,
    nameExpr: `COALESCE(p.nombre, 'Sin nombre')`,
    detailExpr: `COALESCE(p.correo, '')`,
    activeExpr: `COALESCE(p.estado, true)`,
    fromSql: `"Proveedor" p`,
    createdAtExpr: "p.created_at",
    updatedAtExpr: "p.updated_at",
    inactivatedAtExpr: "p.inactivado_en",
    createdByExpr: "p.created_by",
    updatedByExpr: "p.updated_by",
    inactivatedByExpr: "p.inactivado_por",
    referenceExpr: "NULL::text",
    quantityExpr: "NULL::integer",
    reasonExpr: "NULL::text",
  },
  CLIENTES: {
    table: "Clientes",
    alias: "p",
    idColumn: `"Id_clientes"`,
    codeExpr: `COALESCE(p.codigo, '')`,
    nameExpr: `COALESCE(p.nombre, 'Sin nombre')`,
    detailExpr: `COALESCE(p.nit, '')`,
    activeExpr: `COALESCE(p.estado, true)`,
    fromSql: `"Clientes" p`,
    createdAtExpr: "p.created_at",
    updatedAtExpr: "p.updated_at",
    inactivatedAtExpr: "p.inactivado_en",
    createdByExpr: "p.created_by",
    updatedByExpr: "p.updated_by",
    inactivatedByExpr: "p.inactivado_por",
    referenceExpr: "NULL::text",
    quantityExpr: "NULL::integer",
    reasonExpr: "NULL::text",
  },
  USUARIOS: {
    table: "Usuario",
    alias: "p",
    idColumn: "id_usuario",
    codeExpr: `COALESCE(p.username, '')`,
    nameExpr: `COALESCE(p.nombre, 'Sin nombre')`,
    detailExpr: `COALESCE(per.nombre || ' ' || per.apellido, '')`,
    activeExpr: `COALESCE(p.activo, true)`,
    fromSql: `"Usuario" p LEFT JOIN "Persona" per ON per.id_usuario = p.id_usuario`,
    createdAtExpr: "p.created_at",
    updatedAtExpr: "p.updated_at",
    inactivatedAtExpr: "p.inactivado_en",
    createdByExpr: "p.created_by",
    updatedByExpr: "p.updated_by",
    inactivatedByExpr: "p.inactivado_por",
    referenceExpr: "NULL::text",
    quantityExpr: "NULL::integer",
    reasonExpr: "NULL::text",
  },
  ROLES_USUARIO: {
    table: "Detalle_usuario",
    alias: "du",
    idColumn: "id_usuario",
    codeExpr: `COALESCE(u.username, '')`,
    nameExpr: `COALESCE(r.nombre_rol, 'Sin rol')`,
    detailExpr: `COALESCE(u.nombre, '')`,
    activeExpr: `COALESCE(du.activo, true)`,
    fromSql: `"Detalle_usuario" du JOIN "Usuario" u ON u.id_usuario = du.id_usuario JOIN "Rol" r ON r.id_rol = du.id_rol`,
    createdAtExpr: "du.created_at",
    updatedAtExpr: "du.updated_at",
    inactivatedAtExpr: "du.inactivado_en",
    createdByExpr: "du.created_by",
    updatedByExpr: "du.updated_by",
    inactivatedByExpr: "du.inactivado_por",
    referenceExpr: "NULL::text",
    quantityExpr: "NULL::integer",
    reasonExpr: "NULL::text",
  },
  VENTA_ANULACIONES: {
    table: "Detalle_venta_anulacion",
    alias: "a",
    idColumn: "id_anulacion",
    codeExpr: `CONCAT('Venta #', a.id_venta)`,
    nameExpr: `COALESCE(p.nombre, 'Producto sin nombre')`,
    detailExpr: `CONCAT('Detalle #', a.id_detalle, ' | Cantidad: ', a.cantidad, ' | Motivo: ', COALESCE(a.motivo, 'Sin motivo'))`,
    activeExpr: `true`,
    fromSql: `"Detalle_venta_anulacion" a LEFT JOIN "Producto" p ON p.id_producto = a.id_producto`,
    createdAtExpr: "a.created_at",
    updatedAtExpr: "a.updated_at",
    inactivatedAtExpr: "NULL::timestamp with time zone",
    createdByExpr: "a.created_by",
    updatedByExpr: "a.updated_by",
    inactivatedByExpr: "NULL::integer",
    referenceExpr: `CONCAT('Venta #', a.id_venta, ' | Detalle #', a.id_detalle)`,
    quantityExpr: "a.cantidad",
    reasonExpr: "COALESCE(a.motivo, 'Sin motivo')",
  },
  COMPRA_ANULACIONES: {
    table: "Detalle_compra_anulacion",
    alias: "a",
    idColumn: "id_anulacion",
    codeExpr: `CONCAT('Compra #', a.id_compra)`,
    nameExpr: `COALESCE(p.nombre, 'Producto sin nombre')`,
    detailExpr: `CONCAT('Detalle #', a.id_detalle_compra, ' | Cantidad: ', a.cantidad, ' | Motivo: ', COALESCE(a.motivo, 'Sin motivo'))`,
    activeExpr: `true`,
    fromSql: `"Detalle_compra_anulacion" a LEFT JOIN "Producto" p ON p.id_producto = a.id_producto`,
    createdAtExpr: "a.created_at",
    updatedAtExpr: "a.updated_at",
    inactivatedAtExpr: "NULL::timestamp with time zone",
    createdByExpr: "a.created_by",
    updatedByExpr: "a.updated_by",
    inactivatedByExpr: "NULL::integer",
    referenceExpr: `CONCAT('Compra #', a.id_compra, ' | Detalle #', a.id_detalle_compra)`,
    quantityExpr: "a.cantidad",
    reasonExpr: "COALESCE(a.motivo, 'Sin motivo')",
  },
};

export const auditoriaCatalogo = async ({
  entidad = "PRODUCTOS",
  estado = "TODOS",
  q = "",
  page = 1,
  limit = 20,
}) => {
  const entidadKey = String(entidad || "PRODUCTOS").trim().toUpperCase();
  const config = AUDIT_ENTITIES[entidadKey] || AUDIT_ENTITIES.PRODUCTOS;
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 20));
  const offset = (safePage - 1) * safeLimit;

  const alias = config.alias;
  const where = [];
  const params = [];
  let i = 1;

  const estadoNormalizado = String(estado || "TODOS").trim().toUpperCase();
  if (estadoNormalizado === "ACTIVOS") {
    where.push(`${config.activeExpr} = true`);
  } else if (estadoNormalizado === "INACTIVOS") {
    where.push(`${config.activeExpr} = false`);
  }

  const qNormalizado = String(q || "").trim();
  if (qNormalizado) {
    where.push(`(${config.codeExpr} ILIKE $${i} OR ${config.nameExpr} ILIKE $${i} OR ${config.detailExpr} ILIKE $${i})`);
    params.push(`%${qNormalizado}%`);
    i++;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const baseSql = `
    FROM ${config.fromSql}
    LEFT JOIN "Usuario" uc ON uc.id_usuario = ${config.createdByExpr}
    LEFT JOIN "Usuario" uu ON uu.id_usuario = ${config.updatedByExpr}
    LEFT JOIN "Usuario" ui ON ui.id_usuario = ${config.inactivatedByExpr}
    ${whereSql}
  `;

  const rCount = await pool.query(
    `SELECT COUNT(*)::int AS total ${baseSql}`,
    params
  );

  const rData = await pool.query(
    `SELECT
        '${entidadKey}' AS entidad,
        ${alias}.${config.idColumn} AS registro_id,
        ${config.codeExpr} AS codigo,
        ${config.nameExpr} AS nombre,
        ${config.detailExpr} AS detalle,
        ${config.referenceExpr} AS referencia,
        ${config.quantityExpr} AS cantidad_evento,
        ${config.reasonExpr} AS motivo_evento,
        ${config.activeExpr} AS activo,
        ${config.createdAtExpr} AS created_at,
        ${config.updatedAtExpr} AS updated_at,
        ${config.inactivatedAtExpr} AS inactivado_en,
        ${config.createdByExpr} AS created_by,
        ${config.updatedByExpr} AS updated_by,
        ${config.inactivatedByExpr} AS inactivado_por,
        uc.username AS created_by_username,
        uc.nombre AS created_by_nombre,
        uu.username AS updated_by_username,
        uu.nombre AS updated_by_nombre,
        ui.username AS inactivado_por_username,
        ui.nombre AS inactivado_por_nombre
      ${baseSql}
      ORDER BY ${config.updatedAtExpr} DESC NULLS LAST, ${config.createdAtExpr} DESC NULLS LAST
      LIMIT $${i++} OFFSET $${i++}`,
    [...params, safeLimit, offset]
  );

  const totalRows = rCount.rows[0]?.total ?? 0;
  const totalPages = Math.ceil(totalRows / safeLimit);

  return {
    data: rData.rows,
    meta: {
      entidad: entidadKey,
      page: safePage,
      limit: safeLimit,
      totalRows,
      totalPages,
      estado: estadoNormalizado,
      q: qNormalizado,
    },
  };
};

export const corteVentas = async ({ desde, hasta, id_sucursal = 1, id_usuario = null }) => {
  const params = [desde, hasta, Number(id_sucursal)];
  let i = 4;
  let filtroUsuario = "";

  if (id_usuario) {
    filtroUsuario = `AND v.id_usuario = $${i++}`;
    params.push(Number(id_usuario));
  }

  // total neto por venta calculado desde detalle (considera cantidad_anulada)
  const sql = `
    WITH ventas_filtradas AS (
      SELECT v.id_venta, v.fecha, v.estado, v.tipo_venta, v.metodo_pago, v.id_sucursal, v.id_usuario
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT
        d.id_venta,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario), 0) AS total_neto,
        COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS total_original,
        COALESCE(SUM(d.cantidad_anulada * d.precio_unitario), 0) AS total_anulado
      FROM "Detalle_venta" d
      JOIN ventas_filtradas vf ON vf.id_venta = d.id_venta
      GROUP BY d.id_venta
    ),
    ventas_con_total AS (
      SELECT
        vf.*,
        tp.total_neto,
        tp.total_original,
        tp.total_anulado
      FROM ventas_filtradas vf
      LEFT JOIN totales_por_venta tp ON tp.id_venta = vf.id_venta
    )
    SELECT
      -- global
      COUNT(*)::int AS ventas_cantidad,
      COUNT(*) FILTER (WHERE estado = 'ANULADA')::int AS ventas_anuladas,
      COALESCE(SUM(total_neto),0) AS total_neto,
      COALESCE(SUM(total_original),0) AS total_original,
      COALESCE(SUM(total_anulado),0) AS total_anulado,

      -- por método de pago (neto)
      COALESCE(SUM(total_neto) FILTER (WHERE metodo_pago = 'EFECTIVO'),0) AS total_efectivo,
      COALESCE(SUM(total_neto) FILTER (WHERE metodo_pago = 'TARJETA'),0) AS total_tarjeta,
      COALESCE(SUM(total_neto) FILTER (WHERE metodo_pago = 'TRANSFERENCIA'),0) AS total_transferencia,

      -- por tipo de venta (neto)
      COALESCE(SUM(total_neto) FILTER (WHERE tipo_venta = 'CONTADO'),0) AS total_contado,
      COALESCE(SUM(total_neto) FILTER (WHERE tipo_venta = 'CREDITO'),0) AS total_credito
    FROM ventas_con_total;
  `;

  const rResumen = await pool.query(sql, params);

  // resumen por usuario (para auditoría)
  const sqlUsuarios = `
    WITH ventas_filtradas AS (
      SELECT v.id_venta, v.id_usuario
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT d.id_venta, COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
      FROM "Detalle_venta" d
      JOIN ventas_filtradas vf ON vf.id_venta = d.id_venta
      GROUP BY d.id_venta
    )
    SELECT
      u.id_usuario,
      u.username,
      u.nombre,
      COUNT(vf.id_venta)::int AS ventas,
      COALESCE(SUM(tp.total_neto),0) AS total_neto
    FROM ventas_filtradas vf
    JOIN "Usuario" u ON u.id_usuario = vf.id_usuario
    LEFT JOIN totales_por_venta tp ON tp.id_venta = vf.id_venta
    GROUP BY u.id_usuario, u.username, u.nombre
    ORDER BY total_neto DESC;
  `;

  const rUsuarios = await pool.query(sqlUsuarios, params);

  return {
    rango: { desde, hasta, id_sucursal: Number(id_sucursal), id_usuario: id_usuario ? Number(id_usuario) : null },
    resumen: rResumen.rows[0],
    por_usuario: rUsuarios.rows
  };
};


export const corteVentasDetalladoPro = async ({
  desde,
  hasta,
  id_sucursal = 1,
  id_usuario = null,
  page = 1,
  limit = 50,
  top = 10,
}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (safePage - 1) * safeLimit;
  const safeTop = Math.min(50, Math.max(1, Number(top) || 10));

  const paramsBase = [desde, hasta, Number(id_sucursal)];
  let filtroUsuario = "";
  if (id_usuario) {
    filtroUsuario = `AND v.id_usuario = $4`;
    paramsBase.push(Number(id_usuario));
  }

  // ===== RESUMEN GLOBAL =====
  const rResumen = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.*
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT d.id_venta,
             COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto,
             COALESCE(SUM(d.cantidad * d.precio_unitario),0) AS total_original,
             COALESCE(SUM(d.cantidad_anulada * d.precio_unitario),0) AS total_anulado
      FROM "Detalle_venta" d
      JOIN ventas_filtradas v ON v.id_venta = d.id_venta
      GROUP BY d.id_venta
    ),
    ventas_con_total AS (
      SELECT v.*,
             tp.total_neto, tp.total_original, tp.total_anulado
      FROM ventas_filtradas v
      LEFT JOIN totales_por_venta tp ON tp.id_venta = v.id_venta
    )
    SELECT
      COUNT(*)::int AS ventas_cantidad,
      COUNT(*) FILTER (WHERE estado = 'ANULADA')::int AS ventas_anuladas,
      COALESCE(SUM(total_neto),0) AS total_neto,
      COALESCE(SUM(total_original),0) AS total_original,
      COALESCE(SUM(total_anulado),0) AS total_anulado
    FROM ventas_con_total;
    `,
    paramsBase
  );

  // ===== PAGINACIÓN =====
  const rCount = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM "Venta" v
    WHERE v.fecha >= $1::timestamptz
      AND v.fecha < ($2::date + interval '1 day')
      AND v.id_sucursal = $3
      ${filtroUsuario}
    `,
    paramsBase
  );
  const totalRows = rCount.rows[0]?.total ?? 0;
  const totalPages = Math.ceil(totalRows / safeLimit);

  // ===== LISTA DE VENTAS CON TOTAL NETO =====
  const paramsVentas = [...paramsBase, safeLimit, offset];
  const rVentas = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.*
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
      ORDER BY v.fecha DESC
      LIMIT $${paramsBase.length + 1} OFFSET $${paramsBase.length + 2}
    ),
    totales_por_venta AS (
      SELECT d.id_venta,
             COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto,
             COALESCE(SUM(d.cantidad_anulada * d.precio_unitario),0) AS total_anulado
      FROM "Detalle_venta" d
      JOIN ventas_filtradas v ON v.id_venta = d.id_venta
      GROUP BY d.id_venta
    )
    SELECT
      v.id_venta, v.fecha, v.estado, v.tipo_venta, v.metodo_pago, v.id_sucursal,
      v.id_usuario, u.username AS usuario_username, u.nombre AS usuario_nombre,
      COALESCE(tp.total_neto,0) AS total_neto,
      COALESCE(tp.total_anulado,0) AS total_anulado
    FROM ventas_filtradas v
    JOIN "Usuario" u ON u.id_usuario = v.id_usuario
    LEFT JOIN totales_por_venta tp ON tp.id_venta = v.id_venta
    ORDER BY v.fecha DESC;
    `,
    paramsVentas
  );

  // ===== POR USUARIO (NETO) =====
  const rPorUsuario = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.id_venta, v.id_usuario
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT d.id_venta,
             COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
      FROM "Detalle_venta" d
      JOIN ventas_filtradas v ON v.id_venta = d.id_venta
      GROUP BY d.id_venta
    )
    SELECT
      u.id_usuario, u.username, u.nombre,
      COUNT(vf.id_venta)::int AS ventas,
      COALESCE(SUM(tp.total_neto),0) AS total_neto
    FROM ventas_filtradas vf
    JOIN "Usuario" u ON u.id_usuario = vf.id_usuario
    LEFT JOIN totales_por_venta tp ON tp.id_venta = vf.id_venta
    GROUP BY u.id_usuario, u.username, u.nombre
    ORDER BY total_neto DESC;
    `,
    paramsBase
  );

  // ===== POR MÉTODO DE PAGO (DINÁMICO) =====
  const rPorMetodo = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.id_venta, v.metodo_pago
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT d.id_venta,
             COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
      FROM "Detalle_venta" d
      JOIN ventas_filtradas v ON v.id_venta = d.id_venta
      GROUP BY d.id_venta
    )
    SELECT
      vf.metodo_pago,
      COUNT(vf.id_venta)::int AS ventas,
      COALESCE(SUM(tp.total_neto),0) AS total_neto
    FROM ventas_filtradas vf
    LEFT JOIN totales_por_venta tp ON tp.id_venta = vf.id_venta
    GROUP BY vf.metodo_pago
    ORDER BY total_neto DESC;
    `,
    paramsBase
  );

  // ===== POR TIPO DE VENTA (DINÁMICO) =====
  const rPorTipo = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.id_venta, v.tipo_venta
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    ),
    totales_por_venta AS (
      SELECT d.id_venta,
             COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
      FROM "Detalle_venta" d
      JOIN ventas_filtradas v ON v.id_venta = d.id_venta
      GROUP BY d.id_venta
    )
    SELECT
      vf.tipo_venta,
      COUNT(vf.id_venta)::int AS ventas,
      COALESCE(SUM(tp.total_neto),0) AS total_neto
    FROM ventas_filtradas vf
    LEFT JOIN totales_por_venta tp ON tp.id_venta = vf.id_venta
    GROUP BY vf.tipo_venta
    ORDER BY total_neto DESC;
    `,
    paramsBase
  );

  // ===== TOP PRODUCTOS POR TOTAL (NETO) =====
  const paramsTop = [...paramsBase, safeTop];
  const rTopTotal = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.id_venta
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    )
    SELECT
      p.id_producto,
      p.nombre AS producto_nombre,
      p.codigo_barras,
      COALESCE(SUM(d.cantidad - d.cantidad_anulada),0)::int AS cantidad_vendida_neta,
      COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
    FROM "Detalle_venta" d
    JOIN ventas_filtradas vf ON vf.id_venta = d.id_venta
    JOIN "Producto" p ON p.id_producto = d.id_producto
    GROUP BY p.id_producto, p.nombre, p.codigo_barras
    ORDER BY total_neto DESC
    LIMIT $${paramsBase.length + 1};
    `,
    paramsTop
  );

  // ===== TOP PRODUCTOS POR CANTIDAD (NETO) =====
  const rTopCantidad = await pool.query(
    `
    WITH ventas_filtradas AS (
      SELECT v.id_venta
      FROM "Venta" v
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        ${filtroUsuario}
    )
    SELECT
      p.id_producto,
      p.nombre AS producto_nombre,
      p.codigo_barras,
      COALESCE(SUM(d.cantidad - d.cantidad_anulada),0)::int AS cantidad_vendida_neta,
      COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario),0) AS total_neto
    FROM "Detalle_venta" d
    JOIN ventas_filtradas vf ON vf.id_venta = d.id_venta
    JOIN "Producto" p ON p.id_producto = d.id_producto
    GROUP BY p.id_producto, p.nombre, p.codigo_barras
    ORDER BY cantidad_vendida_neta DESC, total_neto DESC
    LIMIT $${paramsBase.length + 1};
    `,
    paramsTop
  );

  return {
    rango: {
      desde,
      hasta,
      id_sucursal: Number(id_sucursal),
      id_usuario: id_usuario ? Number(id_usuario) : null,
    },
    resumen: rResumen.rows[0],
    ventas: rVentas.rows,
    por_usuario: rPorUsuario.rows,
    por_metodo_pago: rPorMetodo.rows,
    por_tipo_venta: rPorTipo.rows,
    top_productos_por_total: rTopTotal.rows,
    top_productos_por_cantidad: rTopCantidad.rows,
    meta: { page: safePage, limit: safeLimit, totalRows, totalPages, top: safeTop },
  };
};

export const reporteGeneral = async ({
  desde,
  hasta,
  id_sucursal = 1,
}) => {
  const params = [desde, hasta, Number(id_sucursal)];

  const rResumenVentas = await pool.query(
    `
      SELECT
        COUNT(DISTINCT v.id_venta)::int AS ventas_cantidad,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario), 0) AS total_ventas,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * (d.precio_unitario - COALESCE(d.costo_unitario, 0))), 0) AS utilidad_estimada
      FROM "Venta" v
      JOIN "Detalle_venta" d ON d.id_venta = v.id_venta
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        AND UPPER(COALESCE(v.estado, '')) <> 'ANULADA'
    `,
    params
  );

  const rResumenCompras = await pool.query(
    `
      SELECT
        COUNT(DISTINCT c.id_compra)::int AS compras_cantidad,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_compra), 0) AS total_compras
      FROM "Compra" c
      JOIN "Detalle_compra" d ON d.id_compra = c.id_compra
      WHERE c.fecha >= $1::timestamptz
        AND c.fecha < ($2::date + interval '1 day')
        AND c.id_sucursal = $3
        AND UPPER(COALESCE(c.estado, '')) <> 'ANULADA'
    `,
    params
  );

  const rVentasPorDia = await pool.query(
    `
      SELECT
        TO_CHAR(DATE(v.fecha AT TIME ZONE 'America/Guatemala'), 'YYYY-MM-DD') AS fecha,
        COUNT(DISTINCT v.id_venta)::int AS ventas,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario), 0) AS total_ventas,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * (d.precio_unitario - COALESCE(d.costo_unitario, 0))), 0) AS utilidad_estimada
      FROM "Venta" v
      JOIN "Detalle_venta" d ON d.id_venta = v.id_venta
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        AND UPPER(COALESCE(v.estado, '')) <> 'ANULADA'
      GROUP BY DATE(v.fecha AT TIME ZONE 'America/Guatemala')
      ORDER BY fecha ASC
    `,
    params
  );

  const rComprasPorFecha = await pool.query(
    `
      SELECT
        TO_CHAR(DATE(c.fecha AT TIME ZONE 'America/Guatemala'), 'YYYY-MM-DD') AS fecha,
        COUNT(DISTINCT c.id_compra)::int AS compras,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_compra), 0) AS total_compras
      FROM "Compra" c
      JOIN "Detalle_compra" d ON d.id_compra = c.id_compra
      WHERE c.fecha >= $1::timestamptz
        AND c.fecha < ($2::date + interval '1 day')
        AND c.id_sucursal = $3
        AND UPPER(COALESCE(c.estado, '')) <> 'ANULADA'
      GROUP BY DATE(c.fecha AT TIME ZONE 'America/Guatemala')
      ORDER BY fecha ASC
    `,
    params
  );

  const rVentasProducto = await pool.query(
    `
      SELECT
        p.id_producto,
        p.nombre AS producto_nombre,
        p.codigo_barras,
        COALESCE(SUM(d.cantidad - d.cantidad_anulada), 0)::int AS cantidad_vendida,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * d.precio_unitario), 0) AS total_ventas,
        COALESCE(SUM((d.cantidad - d.cantidad_anulada) * (d.precio_unitario - COALESCE(d.costo_unitario, 0))), 0) AS utilidad_estimada
      FROM "Venta" v
      JOIN "Detalle_venta" d ON d.id_venta = v.id_venta
      JOIN "Producto" p ON p.id_producto = d.id_producto
      WHERE v.fecha >= $1::timestamptz
        AND v.fecha < ($2::date + interval '1 day')
        AND v.id_sucursal = $3
        AND UPPER(COALESCE(v.estado, '')) <> 'ANULADA'
      GROUP BY p.id_producto, p.nombre, p.codigo_barras
      ORDER BY total_ventas DESC, cantidad_vendida DESC
      LIMIT 10
    `,
    params
  );

  const rStockBajo = await pool.query(
    `
      SELECT
        p.id_producto,
        p.nombre,
        p.codigo_barras,
        COALESCE(s.existencia, 0) AS stock,
        COALESCE(s.stock_minimo, 0) AS stock_minimo,
        GREATEST(COALESCE(s.stock_minimo, 0) - COALESCE(s.existencia, 0), 0) AS faltante
      FROM "Producto" p
      JOIN "Stock_producto" s
        ON s.id_producto = p.id_producto
       AND s.id_bodega = $1
      WHERE COALESCE(p.activo, true) = true
        AND COALESCE(s.stock_minimo, 0) > 0
        AND COALESCE(s.existencia, 0) <= COALESCE(s.stock_minimo, 0)
      ORDER BY faltante DESC, p.nombre ASC
      LIMIT 15
    `,
    [Number(id_sucursal)]
  );

  const resumenVentas = rResumenVentas.rows[0] || {};
  const resumenCompras = rResumenCompras.rows[0] || {};

  return {
    rango: {
      desde,
      hasta,
      id_sucursal: Number(id_sucursal),
    },
    resumen: {
      ventas_cantidad: Number(resumenVentas.ventas_cantidad || 0),
      compras_cantidad: Number(resumenCompras.compras_cantidad || 0),
      total_ventas: Number(resumenVentas.total_ventas || 0),
      total_compras: Number(resumenCompras.total_compras || 0),
      utilidad_estimada: Number(resumenVentas.utilidad_estimada || 0),
      productos_stock_bajo: rStockBajo.rows.length,
    },
    ventas_por_dia: rVentasPorDia.rows,
    compras_por_fecha: rComprasPorFecha.rows,
    ventas_de_producto: rVentasProducto.rows,
    productos_stock_bajo: rStockBajo.rows,
    utilidad_por_dia: rVentasPorDia.rows.map((row) => ({
      fecha: row.fecha,
      utilidad_estimada: Number(row.utilidad_estimada || 0),
    })),
  };
};
