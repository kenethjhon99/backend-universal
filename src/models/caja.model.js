import { pool } from "../config/db.js";

const toNumber = (value) => Number(Number(value || 0).toFixed(2));

const buildVentaCajaWhere = (baseAlias = "v", startIndex = 1) => `
  (
    ${baseAlias}.id_caja_sesion = $${startIndex}
    OR (
      ${baseAlias}.id_caja_sesion IS NULL
      AND ${baseAlias}.id_usuario = $${startIndex + 1}
      AND ${baseAlias}.id_sucursal = $${startIndex + 2}
      AND ${baseAlias}.fecha >= $${startIndex + 3}
      AND ${baseAlias}.fecha <= $${startIndex + 4}
    )
  )
`;

const getNoCobrosPendientesCaja = async (id_caja_sesion, sesion, fechaFin) => {
  const [ventasResult, autolavadoResult, reparacionesResult] = await Promise.all([
    pool.query(
      `
        SELECT
          'VENTA' AS modulo,
          v.id_venta::text AS referencia,
          v.numero_comprobante AS documento,
          v.fecha,
          COALESCE(c.nombre, 'Consumidor final') AS cliente_nombre,
          v.total AS monto,
          v.no_cobrado_motivo AS motivo,
          ua.nombre AS autorizado_por_nombre,
          ua.username AS autorizado_por_username
        FROM "Venta" v
        LEFT JOIN "Clientes" c ON c."Id_clientes" = v.id_cliente
        LEFT JOIN "Usuario" ua ON ua.id_usuario = v.no_cobrado_autorizado_por
        WHERE ${buildVentaCajaWhere("v")}
          AND v.estado = 'NO_COBRADO'
          AND v.no_cobrado_validado_en IS NULL
        ORDER BY v.fecha DESC
      `,
      [
        Number(id_caja_sesion),
        Number(sesion.id_usuario),
        Number(sesion.id_sucursal),
        sesion.fecha_apertura,
        fechaFin,
      ]
    ),
    pool.query(
      `
        SELECT
          'AUTOLAVADO' AS modulo,
          ao.id_autolavado_orden::text AS referencia,
          ao.placa AS documento,
          ao.fecha,
          COALESCE(ao.nombre_cliente, 'Consumidor final') AS cliente_nombre,
          ao.monto_cobrado AS monto,
          ao.no_cobrado_motivo AS motivo,
          ua.nombre AS autorizado_por_nombre,
          ua.username AS autorizado_por_username
        FROM "Autolavado_orden" ao
        LEFT JOIN "Usuario" ua ON ua.id_usuario = ao.no_cobrado_autorizado_por
        WHERE ao.id_caja_sesion = $1
          AND ao.estado = 'NO_COBRADO'
          AND ao.no_cobrado_validado_en IS NULL
        ORDER BY ao.fecha DESC
      `,
      [Number(id_caja_sesion)]
    ),
    pool.query(
      `
        SELECT
          'REPARACION' AS modulo,
          ro.id_reparacion_orden::text AS referencia,
          ro.placa AS documento,
          ro.fecha,
          COALESCE(ro.nombre_cliente, 'Consumidor final') AS cliente_nombre,
          ro.monto_cobrado AS monto,
          ro.no_cobrado_motivo AS motivo,
          ua.nombre AS autorizado_por_nombre,
          ua.username AS autorizado_por_username
        FROM "Reparacion_orden" ro
        LEFT JOIN "Usuario" ua ON ua.id_usuario = ro.no_cobrado_autorizado_por
        WHERE ro.id_caja_sesion = $1
          AND ro.estado = 'NO_COBRADO'
          AND ro.no_cobrado_validado_en IS NULL
        ORDER BY ro.fecha DESC
      `,
      [Number(id_caja_sesion)]
    ),
  ]);

  return [
    ...ventasResult.rows,
    ...autolavadoResult.rows,
    ...reparacionesResult.rows,
  ].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
};

const getNoCobrosValidadosCaja = async (id_caja_sesion, sesion, fechaFin) => {
  const [ventasResult, autolavadoResult, reparacionesResult] = await Promise.all([
    pool.query(
      `
        SELECT
          'VENTA' AS modulo,
          v.id_venta::text AS referencia,
          v.numero_comprobante AS documento,
          v.no_cobrado_validado_en AS fecha_validacion,
          v.no_cobrado_validacion_nota AS nota_validacion,
          ua.nombre AS admin_nombre,
          ua.username AS admin_username
        FROM "Venta" v
        LEFT JOIN "Usuario" ua ON ua.id_usuario = v.no_cobrado_validado_por
        WHERE ${buildVentaCajaWhere("v")}
          AND v.estado = 'NO_COBRADO'
          AND v.no_cobrado_validado_en IS NOT NULL
        ORDER BY v.no_cobrado_validado_en DESC
      `,
      [
        Number(id_caja_sesion),
        Number(sesion.id_usuario),
        Number(sesion.id_sucursal),
        sesion.fecha_apertura,
        fechaFin,
      ]
    ),
    pool.query(
      `
        SELECT
          'AUTOLAVADO' AS modulo,
          ao.id_autolavado_orden::text AS referencia,
          ao.placa AS documento,
          ao.no_cobrado_validado_en AS fecha_validacion,
          ao.no_cobrado_validacion_nota AS nota_validacion,
          ua.nombre AS admin_nombre,
          ua.username AS admin_username
        FROM "Autolavado_orden" ao
        LEFT JOIN "Usuario" ua ON ua.id_usuario = ao.no_cobrado_validado_por
        WHERE ao.id_caja_sesion = $1
          AND ao.estado = 'NO_COBRADO'
          AND ao.no_cobrado_validado_en IS NOT NULL
        ORDER BY ao.no_cobrado_validado_en DESC
      `,
      [Number(id_caja_sesion)]
    ),
    pool.query(
      `
        SELECT
          'REPARACION' AS modulo,
          ro.id_reparacion_orden::text AS referencia,
          ro.placa AS documento,
          ro.no_cobrado_validado_en AS fecha_validacion,
          ro.no_cobrado_validacion_nota AS nota_validacion,
          ua.nombre AS admin_nombre,
          ua.username AS admin_username
        FROM "Reparacion_orden" ro
        LEFT JOIN "Usuario" ua ON ua.id_usuario = ro.no_cobrado_validado_por
        WHERE ro.id_caja_sesion = $1
          AND ro.estado = 'NO_COBRADO'
          AND ro.no_cobrado_validado_en IS NOT NULL
        ORDER BY ro.no_cobrado_validado_en DESC
      `,
      [Number(id_caja_sesion)]
    ),
  ]);

  return [
    ...ventasResult.rows,
    ...autolavadoResult.rows,
    ...reparacionesResult.rows,
  ].sort(
    (a, b) =>
      new Date(b.fecha_validacion || 0).getTime() -
      new Date(a.fecha_validacion || 0).getTime()
  );
};

export const getCajaSesionActiva = async (id_usuario) => {
  const result = await pool.query(
    `
      SELECT
        cs.*,
        u.username,
        u.nombre
      FROM "Caja_sesion" cs
      JOIN "Usuario" u ON u.id_usuario = cs.id_usuario
      WHERE cs.id_usuario = $1
        AND cs.estado = 'ABIERTA'
      ORDER BY cs.fecha_apertura DESC
      LIMIT 1
    `,
    [Number(id_usuario)]
  );

  return result.rows[0] || null;
};

export const getCajaSesionById = async (id_caja_sesion) => {
  const result = await pool.query(
    `
      SELECT
        cs.*,
        u.username,
        u.nombre
      FROM "Caja_sesion" cs
      JOIN "Usuario" u ON u.id_usuario = cs.id_usuario
      WHERE cs.id_caja_sesion = $1
      LIMIT 1
    `,
    [Number(id_caja_sesion)]
  );

  return result.rows[0] || null;
};

export const abrirCaja = async ({
  id_usuario,
  id_sucursal = 1,
  monto_apertura,
  observaciones_apertura,
}) => {
  const existente = await getCajaSesionActiva(id_usuario);
  if (existente) {
    throw new Error("Ya existe una caja abierta para este usuario");
  }

  const monto = Number(monto_apertura);
  if (!Number.isFinite(monto) || monto < 0) {
    throw new Error("monto_apertura debe ser un numero mayor o igual a 0");
  }

  const result = await pool.query(
    `
      INSERT INTO "Caja_sesion" (
        id_usuario,
        id_sucursal,
        monto_apertura,
        observaciones_apertura,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $1, $1)
      RETURNING *
    `,
    [
      Number(id_usuario),
      Number(id_sucursal || 1),
      toNumber(monto),
      observaciones_apertura || null,
    ]
  );

  return result.rows[0];
};

export const listarSesionesCaja = async ({
  id_usuario = null,
  estado = "TODOS",
  q = "",
  page = 1,
  limit = 10,
}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const offset = (safePage - 1) * safeLimit;
  const params = [];
  const where = [];
  let index = 1;

  if (id_usuario) {
    where.push(`cs.id_usuario = $${index++}`);
    params.push(Number(id_usuario));
  }

  const queryText = String(q || "").trim();
  if (queryText) {
    where.push(`(u.username ILIKE $${index} OR COALESCE(u.nombre, '') ILIKE $${index})`);
    params.push(`%${queryText}%`);
    index += 1;
  }

  const estadoNormalizado = String(estado || "TODOS").trim().toUpperCase();
  if (estadoNormalizado === "ABIERTA" || estadoNormalizado === "CERRADA") {
    where.push(`cs.estado = $${index++}`);
    params.push(estadoNormalizado);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countResult = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM "Caja_sesion" cs
      JOIN "Usuario" u ON u.id_usuario = cs.id_usuario
      ${whereSql}
    `,
    params
  );

  const dataResult = await pool.query(
    `
      SELECT
        cs.*,
        u.username,
        u.nombre,
        COALESCE(m.total_ingresos, 0) AS total_ingresos,
        COALESCE(m.total_egresos, 0) AS total_egresos,
        COALESCE(m.movimientos, 0) AS movimientos
      FROM "Caja_sesion" cs
      JOIN "Usuario" u ON u.id_usuario = cs.id_usuario
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS movimientos,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'INGRESO'), 0) AS total_ingresos,
          COALESCE(SUM(monto) FILTER (WHERE tipo = 'EGRESO'), 0) AS total_egresos
        FROM "Caja_movimiento"
        WHERE id_caja_sesion = cs.id_caja_sesion
      ) m ON true
      ${whereSql}
      ORDER BY cs.fecha_apertura DESC
      LIMIT $${index++} OFFSET $${index++}
    `,
    [...params, safeLimit, offset]
  );

  const totalRows = countResult.rows[0]?.total ?? 0;

  return {
    data: dataResult.rows,
    meta: {
      page: safePage,
      limit: safeLimit,
      totalRows,
      totalPages: Math.ceil(totalRows / safeLimit),
      estado: estadoNormalizado,
      q: queryText,
    },
  };
};

export const getCajaMovimientos = async (id_caja_sesion) => {
  const result = await pool.query(
    `
      SELECT
        cm.*,
        u.username,
        u.nombre,
        ua.username AS admin_autoriza_username,
        ua.nombre AS admin_autoriza_nombre
      FROM "Caja_movimiento" cm
      JOIN "Usuario" u ON u.id_usuario = cm.id_usuario
      LEFT JOIN "Usuario" ua ON ua.id_usuario = cm.autorizado_por_admin_id
      WHERE cm.id_caja_sesion = $1
      ORDER BY cm.fecha DESC, cm.id_caja_movimiento DESC
    `,
    [Number(id_caja_sesion)]
  );

  return result.rows;
};

export const getCajaResumen = async (id_caja_sesion) => {
  const sesion = await getCajaSesionById(id_caja_sesion);
  if (!sesion) {
    throw new Error("Sesion de caja no encontrada");
  }

  const fechaFin = sesion.fecha_cierre || new Date().toISOString();

  const movimientosResult = await pool.query(
    `
      SELECT
        COALESCE(SUM(monto) FILTER (WHERE tipo = 'INGRESO'), 0) AS ingresos,
        COALESCE(SUM(monto) FILTER (WHERE tipo = 'EGRESO'), 0) AS egresos,
        COUNT(*)::int AS movimientos,
        COUNT(*) FILTER (WHERE autorizado_por_admin_id IS NULL)::int AS movimientos_pendientes_validacion,
        COUNT(*) FILTER (WHERE autorizado_por_admin_id IS NOT NULL)::int AS movimientos_validados
      FROM "Caja_movimiento"
      WHERE id_caja_sesion = $1
    `,
    [Number(id_caja_sesion)]
  );

  const ventasResult = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO'))::int AS ventas_cantidad,
        COUNT(*) FILTER (WHERE estado = 'ANULADA')::int AS ventas_anuladas,
        COUNT(*) FILTER (WHERE estado = 'NO_COBRADO')::int AS ventas_no_cobradas,
        COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO')), 0) AS total_neto,
        COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO') AND metodo_pago = 'EFECTIVO'), 0) AS total_efectivo,
        COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO') AND metodo_pago = 'TARJETA'), 0) AS total_tarjeta,
        COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO') AND metodo_pago = 'TRANSFERENCIA'), 0) AS total_transferencia,
        COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('ANULADA', 'NO_COBRADO') AND tipo_venta = 'CREDITO'), 0) AS total_credito
      FROM "Venta" v
      WHERE ${buildVentaCajaWhere("v")}
    `,
    [
      Number(id_caja_sesion),
      Number(sesion.id_usuario),
      Number(sesion.id_sucursal),
      sesion.fecha_apertura,
      fechaFin,
    ]
  );

  const serviciosResult = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE estado = 'PAGADO')::int AS servicios_cantidad,
        COUNT(*) FILTER (WHERE estado = 'NO_COBRADO')::int AS servicios_no_cobrados,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO'), 0) AS total_servicios,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'EFECTIVO'), 0) AS total_servicios_efectivo,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'TARJETA'), 0) AS total_servicios_tarjeta,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'TRANSFERENCIA'), 0) AS total_servicios_transferencia
      FROM "Autolavado_orden"
      WHERE id_caja_sesion = $1
    `,
    [Number(id_caja_sesion)]
  );

  const reparacionesResult = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE estado = 'PAGADO')::int AS reparaciones_cantidad,
        COUNT(*) FILTER (WHERE estado = 'NO_COBRADO')::int AS reparaciones_no_cobradas,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO'), 0) AS total_reparaciones,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'EFECTIVO'), 0) AS total_reparaciones_efectivo,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'TARJETA'), 0) AS total_reparaciones_tarjeta,
        COALESCE(SUM(monto_cobrado) FILTER (WHERE estado = 'PAGADO' AND metodo_pago = 'TRANSFERENCIA'), 0) AS total_reparaciones_transferencia
      FROM "Reparacion_orden"
      WHERE id_caja_sesion = $1
    `,
    [Number(id_caja_sesion)]
  );

  const gastosCategoriaResult = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(TRIM(categoria), ''), 'SIN_CATEGORIA') AS categoria,
        COUNT(*)::int AS cantidad,
        COALESCE(SUM(monto), 0) AS total
      FROM "Caja_movimiento"
      WHERE id_caja_sesion = $1
        AND tipo = 'EGRESO'
      GROUP BY COALESCE(NULLIF(TRIM(categoria), ''), 'SIN_CATEGORIA')
      ORDER BY COALESCE(SUM(monto), 0) DESC, categoria ASC
    `,
    [Number(id_caja_sesion)]
  );

  const movimientos = movimientosResult.rows[0] || {};
  const ventas = ventasResult.rows[0] || {};
  const servicios = serviciosResult.rows[0] || {};
  const reparaciones = reparacionesResult.rows[0] || {};
  const noCobradosPendientes = await getNoCobrosPendientesCaja(
    id_caja_sesion,
    sesion,
    fechaFin
  );
  const noCobradosValidados = await getNoCobrosValidadosCaja(
    id_caja_sesion,
    sesion,
    fechaFin
  );

  const montoApertura = toNumber(sesion.monto_apertura);
  const ingresos = toNumber(movimientos.ingresos);
  const egresos = toNumber(movimientos.egresos);
  const totalEfectivo = toNumber(ventas.total_efectivo);
  const totalServiciosEfectivo = toNumber(servicios.total_servicios_efectivo);
  const totalReparacionesEfectivo = toNumber(reparaciones.total_reparaciones_efectivo);
  const totalTarjeta =
    toNumber(ventas.total_tarjeta) +
    toNumber(servicios.total_servicios_tarjeta) +
    toNumber(reparaciones.total_reparaciones_tarjeta);
  const totalTransferencia =
    toNumber(ventas.total_transferencia) +
    toNumber(servicios.total_servicios_transferencia) +
    toNumber(reparaciones.total_reparaciones_transferencia);
  const cierreCalculado = toNumber(
    montoApertura +
      totalEfectivo +
      totalServiciosEfectivo +
      totalReparacionesEfectivo +
      ingresos -
      egresos
  );

  return {
    sesion,
    resumen: {
      monto_apertura: montoApertura,
      total_efectivo: totalEfectivo,
      total_servicios: toNumber(servicios.total_servicios),
      total_servicios_efectivo: totalServiciosEfectivo,
      total_servicios_tarjeta: toNumber(servicios.total_servicios_tarjeta),
      total_servicios_transferencia: toNumber(servicios.total_servicios_transferencia),
      servicios_cantidad: Number(servicios.servicios_cantidad || 0),
      total_reparaciones: toNumber(reparaciones.total_reparaciones),
      total_reparaciones_efectivo: totalReparacionesEfectivo,
      total_reparaciones_tarjeta: toNumber(reparaciones.total_reparaciones_tarjeta),
      total_reparaciones_transferencia: toNumber(reparaciones.total_reparaciones_transferencia),
      reparaciones_cantidad: Number(reparaciones.reparaciones_cantidad || 0),
      total_tarjeta: totalTarjeta,
      total_transferencia: totalTransferencia,
      total_credito: toNumber(ventas.total_credito),
      total_neto_ventas: toNumber(ventas.total_neto),
      ventas_cantidad: Number(ventas.ventas_cantidad || 0),
      ventas_anuladas: Number(ventas.ventas_anuladas || 0),
      ventas_no_cobradas: Number(ventas.ventas_no_cobradas || 0),
      servicios_no_cobrados: Number(servicios.servicios_no_cobrados || 0),
      reparaciones_no_cobradas: Number(reparaciones.reparaciones_no_cobradas || 0),
      ingresos_manuales: ingresos,
      egresos_manuales: egresos,
      movimientos_manuales: Number(movimientos.movimientos || 0),
      movimientos_pendientes_validacion_count: Number(
        movimientos.movimientos_pendientes_validacion || 0
      ),
      movimientos_validados_count: Number(movimientos.movimientos_validados || 0),
      gastos_por_categoria: gastosCategoriaResult.rows.map((item) => ({
        categoria: item.categoria,
        cantidad: Number(item.cantidad || 0),
        total: toNumber(item.total),
      })),
      conciliacion: {
        efectivo_sistema: cierreCalculado,
        efectivo_reportado:
          sesion.monto_cierre_reportado != null
            ? toNumber(sesion.monto_cierre_reportado)
            : null,
        diferencia_efectivo:
          sesion.diferencia != null ? toNumber(sesion.diferencia) : null,
        total_tarjeta: totalTarjeta,
        total_transferencia: totalTransferencia,
        total_credito: toNumber(ventas.total_credito),
        total_no_efectivo: toNumber(totalTarjeta + totalTransferencia),
      },
      cierre_calculado: cierreCalculado,
      monto_cierre_reportado: sesion.monto_cierre_reportado != null ? toNumber(sesion.monto_cierre_reportado) : null,
      diferencia: sesion.diferencia != null ? toNumber(sesion.diferencia) : null,
      no_cobrados_pendientes_count: noCobradosPendientes.length,
      no_cobrados_pendientes: noCobradosPendientes,
      no_cobrados_validados_count: noCobradosValidados.length,
      no_cobrados_validados: noCobradosValidados,
      no_cobrados_validados_admins: Array.from(
        new Map(
          noCobradosValidados
            .filter((item) => item.admin_nombre || item.admin_username)
            .map((item) => [
              item.admin_username || item.admin_nombre,
              {
                nombre: item.admin_nombre || item.admin_username,
                username: item.admin_username || null,
              },
            ])
        ).values()
      ),
    },
    movimientos: await getCajaMovimientos(id_caja_sesion),
  };
};

export const registrarMovimientoCaja = async ({
  id_caja_sesion,
  id_usuario,
  tipo,
  categoria,
  monto,
  descripcion,
  autorizado_por_admin_id,
  autorizacion_admin_nota = null,
}) => {
  const sesion = await getCajaSesionById(id_caja_sesion);
  if (!sesion || sesion.estado !== "ABIERTA") {
    throw new Error("La caja indicada no esta abierta");
  }

  const tipoNormalizado = String(tipo || "").trim().toUpperCase();
  if (!["INGRESO", "EGRESO"].includes(tipoNormalizado)) {
    throw new Error("tipo debe ser INGRESO o EGRESO");
  }

  const montoNormalizado = Number(monto);
  if (!Number.isFinite(montoNormalizado) || montoNormalizado <= 0) {
    throw new Error("monto debe ser un numero mayor a 0");
  }

  const adminAutorizadorId =
    Number.isInteger(Number(autorizado_por_admin_id)) &&
    Number(autorizado_por_admin_id) > 0
      ? Number(autorizado_por_admin_id)
      : null;

  const result = await pool.query(
    `
      INSERT INTO "Caja_movimiento" (
        id_caja_sesion,
        id_usuario,
        tipo,
        categoria,
        monto,
        descripcion,
        autorizado_por_admin_id,
        autorizado_por_admin_en,
        autorizacion_admin_nota,
        created_by,
        updated_by
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::integer,
        CASE WHEN $7::integer IS NOT NULL THEN now() ELSE NULL END,
        $8::text,
        $2,
        $2
      )
      RETURNING *
    `,
    [
      Number(id_caja_sesion),
      Number(id_usuario),
      tipoNormalizado,
      categoria || null,
      toNumber(montoNormalizado),
      descripcion || null,
      adminAutorizadorId,
      autorizacion_admin_nota || null,
    ]
  );

  return result.rows[0];
};

export const validarNoCobroPendienteCaja = async ({
  id_caja_sesion,
  modulo,
  referencia,
  admin_id,
  nota = null,
}) => {
  const sesion = await getCajaSesionById(id_caja_sesion);
  if (!sesion) {
    throw new Error("Sesion de caja no encontrada");
  }

  const fechaFin = sesion.fecha_cierre || new Date().toISOString();
  const moduloNormalizado = String(modulo || "").trim().toUpperCase();
  const referenciaId = Number(referencia);
  if (!Number.isInteger(referenciaId)) {
    throw new Error("Referencia invalida para validar el no cobro");
  }

  if (moduloNormalizado === "VENTA") {
    const result = await pool.query(
      `
        UPDATE "Venta" v
        SET no_cobrado_validado_por = $1,
            no_cobrado_validado_en = now(),
            no_cobrado_validacion_nota = $2
        WHERE ${buildVentaCajaWhere("v", 3)}
          AND v.id_venta = $8
          AND v.estado = 'NO_COBRADO'
          AND v.no_cobrado_validado_en IS NULL
        RETURNING v.id_venta
      `,
      [
        Number(admin_id),
        nota || null,
        Number(id_caja_sesion),
        Number(sesion.id_usuario),
        Number(sesion.id_sucursal),
        sesion.fecha_apertura,
        fechaFin,
        referenciaId,
      ]
    );

    if (!result.rowCount) {
      throw new Error("El registro no cobrado ya fue validado o no pertenece a esta caja");
    }

    return result.rows[0];
  }

  const tableName =
    moduloNormalizado === "AUTOLAVADO"
      ? '"Autolavado_orden"'
      : moduloNormalizado === "REPARACION"
        ? '"Reparacion_orden"'
        : null;
  const idColumn =
    moduloNormalizado === "AUTOLAVADO"
      ? "id_autolavado_orden"
      : moduloNormalizado === "REPARACION"
        ? "id_reparacion_orden"
        : null;

  if (!tableName || !idColumn) {
    throw new Error("Modulo de no cobro no soportado");
  }

  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET no_cobrado_validado_por = $1,
          no_cobrado_validado_en = now(),
          no_cobrado_validacion_nota = $2
      WHERE id_caja_sesion = $3
        AND ${idColumn} = $4
        AND estado = 'NO_COBRADO'
        AND no_cobrado_validado_en IS NULL
      RETURNING ${idColumn}
    `,
    [Number(admin_id), nota || null, Number(id_caja_sesion), referenciaId]
  );

  if (!result.rowCount) {
    throw new Error("El registro no cobrado ya fue validado o no pertenece a esta caja");
  }

  return result.rows[0];
};

export const validarMovimientoPendienteCaja = async ({
  id_caja_sesion,
  id_caja_movimiento,
  admin_id,
  nota = null,
}) => {
  const result = await pool.query(
    `
      UPDATE "Caja_movimiento"
      SET autorizado_por_admin_id = $1,
          autorizado_por_admin_en = now(),
          autorizacion_admin_nota = $2
      WHERE id_caja_sesion = $3
        AND id_caja_movimiento = $4
        AND autorizado_por_admin_id IS NULL
      RETURNING id_caja_movimiento
    `,
    [
      Number(admin_id),
      nota || null,
      Number(id_caja_sesion),
      Number(id_caja_movimiento),
    ]
  );

  if (!result.rowCount) {
    throw new Error("El movimiento ya fue validado o no pertenece a esta caja");
  }

  return result.rows[0];
};

export const cerrarCaja = async ({
  id_caja_sesion,
  id_usuario,
  monto_cierre_reportado,
  observaciones_cierre,
  validacion_no_cobro_admin_id = null,
  validacion_no_cobro_nota = null,
  validacion_diferencia_admin_id = null,
  validacion_diferencia_nota = null,
  validacion_movimientos_admin_id = null,
  validacion_movimientos_nota = null,
}) => {
  const sesion = await getCajaSesionById(id_caja_sesion);
  if (!sesion || sesion.estado !== "ABIERTA") {
    throw new Error("La caja indicada no esta abierta");
  }

  const montoReportado = Number(monto_cierre_reportado);
  if (!Number.isFinite(montoReportado) || montoReportado < 0) {
    throw new Error("monto_cierre_reportado debe ser un numero mayor o igual a 0");
  }

  const { resumen, sesion: sesionActual } = await getCajaResumen(id_caja_sesion);
  if (Number(resumen.no_cobrados_pendientes_count || 0) > 0) {
    throw new Error("Debes validar uno por uno los registros no cobrados antes de cerrar caja");
  }

  if (Number(resumen.movimientos_pendientes_validacion_count || 0) > 0) {
    throw new Error("Debes validar uno por uno los movimientos manuales antes de cerrar caja");
  }

  const diferencia = toNumber(montoReportado - resumen.cierre_calculado);
  if (Number(diferencia) !== 0 && !Number.isInteger(Number(validacion_diferencia_admin_id || 0))) {
    throw new Error("La caja no esta cuadrada. Debes autorizar el cierre con la password de un admin");
  }

  const result = await pool.query(
    `
      UPDATE "Caja_sesion"
      SET
        estado = 'CERRADA',
        fecha_cierre = now(),
        monto_cierre_reportado = $1,
        monto_cierre_calculado = $2,
        diferencia = $3,
        observaciones_cierre = $4,
        diferencia_validada_por = $5::integer,
        diferencia_validada_en = CASE WHEN $5::integer IS NOT NULL THEN now() ELSE diferencia_validada_en END,
        diferencia_validacion_nota = $6::text,
        updated_by = $7
      WHERE id_caja_sesion = $8
      RETURNING *
    `,
    [
      toNumber(montoReportado),
      resumen.cierre_calculado,
      diferencia,
      observaciones_cierre || null,
      Number(validacion_diferencia_admin_id || 0) || null,
      validacion_diferencia_nota || null,
      Number(id_usuario),
      Number(id_caja_sesion),
    ]
  );

  return result.rows[0];
};
