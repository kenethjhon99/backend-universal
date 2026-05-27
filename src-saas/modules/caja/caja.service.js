import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";

// Patron RLS: usa el client transaccional de la request si esta presente.
const resolveDb = (db) => db || pool;
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import {
  isPrivilegedRole as isPrivilegedRoleShared,
  verifyAdminAuthorization,
} from "../../shared/security/admin-auth.js";
import { HttpError } from "../../shared/http/http-error.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const BRANCH_MANAGER_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN_EMPRESA",
  "ENCARGADO_SUCURSAL",
]);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();

const normalizeSessionRow = (row) => {
  if (!row) return null;

  return {
    ...row,
    monto_apertura: roundMoney(row.monto_apertura),
    monto_cierre: row.monto_cierre != null ? roundMoney(row.monto_cierre) : null,
    monto_cierre_reportado:
      row.monto_cierre_reportado != null
        ? roundMoney(row.monto_cierre_reportado)
        : row.monto_cierre != null
          ? roundMoney(row.monto_cierre)
          : null,
    monto_cierre_calculado:
      row.monto_cierre_calculado != null
        ? roundMoney(row.monto_cierre_calculado)
        : null,
    diferencia: row.diferencia != null ? roundMoney(row.diferencia) : null,
  };
};

const normalizeMovementRow = (row) => ({
  ...row,
  monto: roundMoney(row.monto),
});

const normalizeSaleRow = (row) => ({
  ...row,
  subtotal: roundMoney(row.subtotal),
  total: roundMoney(row.total),
  monto_recibido:
    row.monto_recibido != null ? roundMoney(row.monto_recibido) : null,
  cambio: roundMoney(row.cambio),
});

const isPrivilegedRole = (role) => PRIVILEGED_ROLES.has(normalizeRole(role));
const canManageBranchSessions = (role) =>
  BRANCH_MANAGER_ROLES.has(normalizeRole(role));

const getCajaSessionBaseSelect = () => `
  select
    cs.*,
    s.codigo as sucursal_codigo,
    s.nombre as sucursal_nombre,
    u.username as usuario_username,
    concat(u.nombre, ' ', u.apellido) as usuario_nombre,
    ua.username as diferencia_validada_por_username,
    concat(ua.nombre, ' ', ua.apellido) as diferencia_validada_por_nombre
  from caja_sesiones cs
  inner join sucursales s
    on s.id_empresa = cs.id_empresa
   and s.id_sucursal = cs.id_sucursal
  inner join usuarios u
    on u.id_empresa = cs.id_empresa
   and u.id_usuario = cs.id_usuario
  left join usuarios ua
    on ua.id_empresa = cs.id_empresa
   and ua.id_usuario = cs.diferencia_validada_por
`;

const getCajaSesionByIdInternal = async (db, { auth, idCajaSesion }) => {
  const result = await db.query(
    `
      ${getCajaSessionBaseSelect()}
      where cs.id_empresa = $1
        and cs.id_caja_sesion = $2
      limit 1
    `,
    [auth.id_empresa, idCajaSesion]
  );

  return normalizeSessionRow(result.rows[0]);
};

const assertSessionAccess = (auth, session, { allowBranchManagers = true } = {}) => {
  if (!session) {
    throw HttpError.notFound("Sesion de caja no encontrada");
  }

  if (Number(session.id_empresa) !== Number(auth.id_empresa)) {
    throw HttpError.forbidden("La sesion no pertenece a la empresa activa");
  }

  if (isPrivilegedRole(auth.rol)) {
    return;
  }

  if (Number(session.id_usuario) === Number(auth.id_usuario)) {
    return;
  }

  if (
    allowBranchManagers &&
    canManageBranchSessions(auth.rol) &&
    auth.sucursales.map(Number).includes(Number(session.id_sucursal))
  ) {
    return;
  }

  throw HttpError.forbidden("No tienes acceso a esta sesion de caja");
};

const MANUAL_MOVEMENT_CONDITION = "coalesce(cm.referencia_tipo, 'MANUAL') = 'MANUAL'";

// verifyAdminAuthorization vive en shared/security/admin-auth.js
// (importado arriba). Todas las operaciones sensibles de caja la reutilizan.

const getCajaResumenInternal = async (db, { auth, session }) => {
  const movementsResult = await db.query(
    `
      select
        count(*)::int as movimientos_total,
        count(*) filter (where ${MANUAL_MOVEMENT_CONDITION})::int as movimientos_manuales,
        count(*) filter (where ${MANUAL_MOVEMENT_CONDITION} and cm.autorizado_por_admin_id is null)::int as movimientos_pendientes_validacion,
        count(*) filter (where ${MANUAL_MOVEMENT_CONDITION} and cm.autorizado_por_admin_id is not null)::int as movimientos_validados,
        coalesce(sum(cm.monto) filter (where cm.tipo = 'INGRESO'), 0) as ingresos_totales,
        coalesce(sum(cm.monto) filter (where cm.tipo = 'EGRESO'), 0) as egresos_totales,
        coalesce(sum(cm.monto) filter (where cm.tipo = 'INGRESO' and ${MANUAL_MOVEMENT_CONDITION}), 0) as ingresos_manuales,
        coalesce(sum(cm.monto) filter (where cm.tipo = 'EGRESO' and ${MANUAL_MOVEMENT_CONDITION}), 0) as egresos_manuales
      from caja_movimientos cm
      where cm.id_empresa = $1
        and cm.id_caja_sesion = $2
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  // No-cobrados: ventas creadas con estado NO_COBRADO en esta sesion
  // que aun no fueron validadas por un admin.
  const noCobradosPendientesResult = await db.query(
    `
      select
        v.id_venta,
        v.numero_comprobante,
        v.tipo_comprobante,
        v.total,
        v.no_cobrado_motivo,
        v.no_cobrado_autorizado_por,
        v.no_cobrado_autorizado_en,
        v.fecha_venta,
        c.nombre as cliente_nombre,
        ua.username as autorizado_por_username,
        concat(ua.nombre, ' ', ua.apellido) as autorizado_por_nombre
      from ventas v
      left join clientes c
        on c.id_empresa = v.id_empresa
       and c.id_cliente = v.id_cliente
      left join usuarios ua
        on ua.id_empresa = v.id_empresa
       and ua.id_usuario = v.no_cobrado_autorizado_por
      where v.id_empresa = $1
        and v.id_caja_sesion = $2
        and v.estado = 'NO_COBRADO'
        and v.no_cobrado_validado_en is null
      order by v.fecha_venta desc
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  const noCobradosValidadosResult = await db.query(
    `
      select
        v.id_venta,
        v.numero_comprobante,
        v.total,
        v.no_cobrado_motivo,
        v.no_cobrado_validado_por,
        v.no_cobrado_validado_en,
        v.no_cobrado_validacion_nota,
        uv.username as validado_por_username,
        concat(uv.nombre, ' ', uv.apellido) as validado_por_nombre
      from ventas v
      left join usuarios uv
        on uv.id_empresa = v.id_empresa
       and uv.id_usuario = v.no_cobrado_validado_por
      where v.id_empresa = $1
        and v.id_caja_sesion = $2
        and v.estado = 'NO_COBRADO'
        and v.no_cobrado_validado_en is not null
      order by v.no_cobrado_validado_en desc
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  const salesSummaryResult = await db.query(
    `
      select
        count(*) filter (where v.estado = 'CONFIRMADA')::int as ventas_cantidad,
        coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA'), 0) as total_ventas,
        coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'EFECTIVO'), 0) as total_efectivo,
        coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'TARJETA'), 0) as total_tarjeta,
        coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'TRANSFERENCIA'), 0) as total_transferencia,
        coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.tipo_venta = 'CREDITO'), 0) as total_credito
      from ventas v
      where v.id_empresa = $1
        and v.id_caja_sesion = $2
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  const movimientosRows = await db.query(
    `
      select
        cm.*,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        ua.username as autorizado_por_admin_username,
        concat(ua.nombre, ' ', ua.apellido) as autorizado_por_admin_nombre
      from caja_movimientos cm
      inner join usuarios u
        on u.id_empresa = cm.id_empresa
       and u.id_usuario = cm.id_usuario
      left join usuarios ua
        on ua.id_empresa = cm.id_empresa
       and ua.id_usuario = cm.autorizado_por_admin_id
      where cm.id_empresa = $1
        and cm.id_caja_sesion = $2
      order by cm.created_at desc, cm.id_caja_movimiento desc
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  const ventasRows = await db.query(
    `
      select
        v.id_venta,
        v.numero_comprobante,
        v.tipo_comprobante,
        v.tipo_venta,
        v.metodo_pago,
        v.estado,
        v.subtotal,
        v.total,
        v.monto_recibido,
        v.cambio,
        v.fecha_venta,
        c.nombre as cliente_nombre
      from ventas v
      left join clientes c
        on c.id_empresa = v.id_empresa
       and c.id_cliente = v.id_cliente
      where v.id_empresa = $1
        and v.id_caja_sesion = $2
      order by v.fecha_venta desc, v.id_venta desc
      limit 25
    `,
    [auth.id_empresa, session.id_caja_sesion]
  );

  const movementSummary = movementsResult.rows[0] || {};
  const saleSummary = salesSummaryResult.rows[0] || {};
  const montoApertura = roundMoney(session.monto_apertura);
  const ingresosTotales = roundMoney(movementSummary.ingresos_totales);
  const egresosTotales = roundMoney(movementSummary.egresos_totales);
  const ingresosManuales = roundMoney(movementSummary.ingresos_manuales);
  const egresosManuales = roundMoney(movementSummary.egresos_manuales);
  const totalEfectivo = roundMoney(saleSummary.total_efectivo);
  const totalTarjeta = roundMoney(saleSummary.total_tarjeta);
  const totalTransferencia = roundMoney(saleSummary.total_transferencia);
  const totalCredito = roundMoney(saleSummary.total_credito);
  const cierreCalculado = roundMoney(
    montoApertura + ingresosTotales - egresosTotales
  );
  const montoCierreReportado =
    session.monto_cierre_reportado != null
      ? roundMoney(session.monto_cierre_reportado)
      : session.monto_cierre != null
        ? roundMoney(session.monto_cierre)
        : null;

  const noCobradosPendientes = noCobradosPendientesResult.rows.map((row) => ({
    ...row,
    total: roundMoney(row.total),
  }));
  const noCobradosValidados = noCobradosValidadosResult.rows.map((row) => ({
    ...row,
    total: roundMoney(row.total),
  }));

  return {
    sesion: session,
    resumen: {
      monto_apertura: montoApertura,
      total_ventas: roundMoney(saleSummary.total_ventas),
      total_efectivo: totalEfectivo,
      total_tarjeta: totalTarjeta,
      total_transferencia: totalTransferencia,
      total_credito: totalCredito,
      ventas_cantidad: Number(saleSummary.ventas_cantidad || 0),
      ingresos_totales: ingresosTotales,
      egresos_totales: egresosTotales,
      ingresos_manuales: ingresosManuales,
      egresos_manuales: egresosManuales,
      movimientos_total: Number(movementSummary.movimientos_total || 0),
      movimientos_manuales: Number(movementSummary.movimientos_manuales || 0),
      movimientos_pendientes_validacion_count: Number(
        movementSummary.movimientos_pendientes_validacion || 0
      ),
      movimientos_validados_count: Number(
        movementSummary.movimientos_validados || 0
      ),
      no_cobrados_pendientes_count: noCobradosPendientes.length,
      no_cobrados_pendientes: noCobradosPendientes,
      no_cobrados_validados_count: noCobradosValidados.length,
      no_cobrados_validados: noCobradosValidados,
      cierre_calculado: cierreCalculado,
      monto_cierre_reportado: montoCierreReportado,
      diferencia:
        session.diferencia != null ? roundMoney(session.diferencia) : null,
      requiere_aprobacion_diferencia:
        session.diferencia != null
          ? roundMoney(session.diferencia) !== 0
          : false,
    },
    movimientos: movimientosRows.rows.map(normalizeMovementRow),
    ventas: ventasRows.rows.map(normalizeSaleRow),
  };
};

/**
 * Aprobacion para diferencia de caja al cerrar.
 * Si la diferencia es 0, no necesita autorizacion.
 * Si != 0, exige admin (excepto si quien cierra ya es admin).
 */
const ensureDifferenceApproval = (db, { auth, body, difference }) => {
  if (roundMoney(difference) === 0) {
    return Promise.resolve({ authorizedBy: null, note: null });
  }

  return verifyAdminAuthorization(db, {
    auth,
    body,
    requireAlways: true,
    noteField: "validacion_diferencia_nota",
  });
};

export const getCajaSesionActiva = async ({ db, auth, scope }) => {
  const result = await resolveDb(db).query(
    `
      ${getCajaSessionBaseSelect()}
      where cs.id_empresa = $1
        and cs.id_usuario = $2
        and cs.id_sucursal = $3
        and cs.estado = 'ABIERTA'
      order by cs.fecha_apertura desc
      limit 1
    `,
    [auth.id_empresa, auth.id_usuario, scope.id_sucursal]
  );

  const session = normalizeSessionRow(result.rows[0]);

  if (!session) {
    return {
      sesion: null,
      resumen: null,
      movimientos: [],
      ventas: [],
    };
  }

  return getCajaResumenInternal(pool, { auth, session });
};

export const listCajaSesiones = async ({ db, auth, scope, query }) => {
  const filters = ["cs.id_empresa = $1", "cs.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (!canManageBranchSessions(auth.rol)) {
    filters.push(`cs.id_usuario = $${index}`);
    params.push(auth.id_usuario);
    index += 1;
  }

  if (query?.estado) {
    filters.push(`cs.estado = $${index}`);
    params.push(String(query.estado).trim().toUpperCase());
    index += 1;
  }

  if (query?.desde) {
    filters.push(`cs.fecha_apertura::date >= $${index}::date`);
    params.push(String(query.desde).trim());
    index += 1;
  }

  if (query?.hasta) {
    filters.push(`cs.fecha_apertura::date <= $${index}::date`);
    params.push(String(query.hasta).trim());
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(u.username, '') ilike $${index} or coalesce(s.nombre, '') ilike $${index} or cast(cs.id_caja_sesion as text) = $${index + 1})`
    );
    params.push(`%${String(query.search).trim()}%`);
    params.push(String(query.search).trim());
    index += 2;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 20, 100));
  params.push(limit);

  const result = await resolveDb(db).query(
    `
      select
        cs.*,
        s.codigo as sucursal_codigo,
        s.nombre as sucursal_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre,
        coalesce(mov.ingresos_totales, 0) as ingresos_totales,
        coalesce(mov.egresos_totales, 0) as egresos_totales,
        coalesce(mov.ingresos_manuales, 0) as ingresos_manuales,
        coalesce(mov.egresos_manuales, 0) as egresos_manuales,
        coalesce(mov.movimientos_manuales, 0) as movimientos_manuales,
        coalesce(ven.ventas_cantidad, 0) as ventas_cantidad,
        coalesce(ven.total_efectivo, 0) as total_efectivo,
        coalesce(ven.total_tarjeta, 0) as total_tarjeta,
        coalesce(ven.total_transferencia, 0) as total_transferencia
      from caja_sesiones cs
      inner join sucursales s
        on s.id_empresa = cs.id_empresa
       and s.id_sucursal = cs.id_sucursal
      inner join usuarios u
        on u.id_empresa = cs.id_empresa
       and u.id_usuario = cs.id_usuario
      left join lateral (
        select
          count(*) filter (where ${MANUAL_MOVEMENT_CONDITION})::int as movimientos_manuales,
          coalesce(sum(cm.monto) filter (where cm.tipo = 'INGRESO'), 0) as ingresos_totales,
          coalesce(sum(cm.monto) filter (where cm.tipo = 'EGRESO'), 0) as egresos_totales,
          coalesce(sum(cm.monto) filter (where cm.tipo = 'INGRESO' and ${MANUAL_MOVEMENT_CONDITION}), 0) as ingresos_manuales,
          coalesce(sum(cm.monto) filter (where cm.tipo = 'EGRESO' and ${MANUAL_MOVEMENT_CONDITION}), 0) as egresos_manuales
        from caja_movimientos cm
        where cm.id_empresa = cs.id_empresa
          and cm.id_caja_sesion = cs.id_caja_sesion
      ) mov on true
      left join lateral (
        select
          count(*) filter (where v.estado = 'CONFIRMADA')::int as ventas_cantidad,
          coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'EFECTIVO'), 0) as total_efectivo,
          coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'TARJETA'), 0) as total_tarjeta,
          coalesce(sum(v.total) filter (where v.estado = 'CONFIRMADA' and v.metodo_pago = 'TRANSFERENCIA'), 0) as total_transferencia
        from ventas v
        where v.id_empresa = cs.id_empresa
          and v.id_caja_sesion = cs.id_caja_sesion
      ) ven on true
      where ${filters.join(" and ")}
      order by cs.fecha_apertura desc, cs.id_caja_sesion desc
      limit $${index}
    `,
    params
  );

  return result.rows.map((row) => {
    const montoApertura = roundMoney(row.monto_apertura);
    const ingresosTotales = roundMoney(row.ingresos_totales);
    const egresosTotales = roundMoney(row.egresos_totales);
    const ingresosManuales = roundMoney(row.ingresos_manuales);
    const egresosManuales = roundMoney(row.egresos_manuales);
    const totalEfectivo = roundMoney(row.total_efectivo);

    return {
      ...normalizeSessionRow(row),
      ingresos_totales: ingresosTotales,
      egresos_totales: egresosTotales,
      ingresos_manuales: ingresosManuales,
      egresos_manuales: egresosManuales,
      movimientos_manuales: Number(row.movimientos_manuales || 0),
      ventas_cantidad: Number(row.ventas_cantidad || 0),
      total_efectivo: totalEfectivo,
      total_tarjeta: roundMoney(row.total_tarjeta),
      total_transferencia: roundMoney(row.total_transferencia),
      cierre_calculado: roundMoney(
        montoApertura + ingresosTotales - egresosTotales
      ),
    };
  });
};

export const openCaja = async ({ auth, scope, body }) =>
  runInTransaction(
    async (client) => {
      const openResult = await client.query(
        `
          select id_caja_sesion, id_sucursal
          from caja_sesiones
          where id_empresa = $1
            and id_usuario = $2
            and estado = 'ABIERTA'
          limit 1
        `,
        [auth.id_empresa, auth.id_usuario]
      );

      const existing = openResult.rows[0];

      if (existing) {
        throw HttpError.conflict(
          "Ya existe una caja abierta para este usuario en otra sucursal",
          existing
        );
      }

      const montoApertura = Number(body?.monto_apertura);

      if (!Number.isFinite(montoApertura) || montoApertura < 0) {
        throw HttpError.badRequest(
          "monto_apertura debe ser un numero mayor o igual a 0"
        );
      }

      const insertResult = await client.query(
        `
          insert into caja_sesiones (
            id_empresa,
            id_sucursal,
            id_usuario,
            estado,
            monto_apertura,
            observaciones,
            observaciones_apertura,
            created_by,
            updated_by
          )
          values ($1,$2,$3,'ABIERTA',$4,$5,$5,$3,$3)
          returning id_caja_sesion
        `,
        [
          auth.id_empresa,
          scope.id_sucursal,
          auth.id_usuario,
          roundMoney(montoApertura),
          String(body?.observaciones_apertura || "").trim() || null,
        ]
      );

      const session = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion: insertResult.rows[0].id_caja_sesion,
      });

      return getCajaResumenInternal(client, { auth, session });
    },
    { auth }
  );

export const createCajaMovimiento = async ({
  auth,
  scope,
  idCajaSesion,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      const session = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      assertSessionAccess(auth, session);

      if (String(session.estado).toUpperCase() !== "ABIERTA") {
        throw HttpError.badRequest("La caja indicada no esta abierta");
      }

      const tipo = String(body?.tipo || "").trim().toUpperCase();

      if (!["INGRESO", "EGRESO"].includes(tipo)) {
        throw HttpError.badRequest("tipo debe ser INGRESO o EGRESO");
      }

      const monto = Number(body?.monto);

      if (!Number.isFinite(monto) || monto <= 0) {
        throw HttpError.badRequest("monto debe ser un numero mayor a 0");
      }

      const categoria =
        String(body?.categoria || "")
          .trim()
          .toUpperCase() ||
        (tipo === "INGRESO" ? "AJUSTE_INGRESO" : "AJUSTE_EGRESO");

      // Movimientos manuales pueden venir pre-autorizados (admin captura
      // su credencial al hacer click) o quedar pendientes para validar
      // antes de cerrar caja. Si quien crea ya es admin, queda autorizado.
      const adminAuth = await verifyAdminAuthorization(client, {
        auth,
        body,
        requireAlways: false,
      });

      const insertResult = await client.query(
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
            autorizado_por_admin_id,
            autorizado_por_admin_en,
            autorizacion_admin_nota,
            created_by,
            updated_by
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,'MANUAL',null,
            $9::bigint,
            case when $9::bigint is not null then now() else null end,
            $10::text,
            $4,$4
          )
          returning id_caja_movimiento
        `,
        [
          auth.id_empresa,
          session.id_caja_sesion,
          session.id_sucursal,
          auth.id_usuario,
          tipo,
          categoria,
          roundMoney(monto),
          String(body?.descripcion || "").trim() || null,
          adminAuth.authorizedBy,
          adminAuth.note,
        ]
      );

      const idCajaMovimiento = Number(insertResult.rows[0].id_caja_movimiento);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "CAJA",
        entidad: "CAJA_MOVIMIENTO",
        entidadId: idCajaMovimiento,
        accion: "CREATE",
        despues: {
          id_caja_sesion: session.id_caja_sesion,
          tipo,
          categoria,
          monto: roundMoney(monto),
          autorizado_por_admin_id: adminAuth.authorizedBy,
        },
      });

      const updatedSession = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      return getCajaResumenInternal(client, { auth, session: updatedSession });
    },
    { auth }
  );

/**
 * Marca un movimiento manual como validado por un admin.
 * Solo aplica a movimientos con referencia_tipo = 'MANUAL' que no esten
 * ya validados.
 */
export const validateCajaMovimientoPendiente = async ({
  auth,
  scope,
  idCajaSesion,
  idCajaMovimiento,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      const session = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      assertSessionAccess(auth, session);

      if (String(session.estado).toUpperCase() !== "ABIERTA") {
        throw HttpError.badRequest(
          "Solo puedes validar movimientos de cajas abiertas"
        );
      }

      const adminAuth = await verifyAdminAuthorization(client, {
        auth,
        body,
        requireAlways: true,
      });

      const updateResult = await client.query(
        `
          update caja_movimientos
          set autorizado_por_admin_id = $1,
              autorizado_por_admin_en = now(),
              autorizacion_admin_nota = $2,
              updated_by = $3
          where id_empresa = $4
            and id_caja_sesion = $5
            and id_caja_movimiento = $6
            and coalesce(referencia_tipo, 'MANUAL') = 'MANUAL'
            and autorizado_por_admin_id is null
          returning id_caja_movimiento
        `,
        [
          adminAuth.authorizedBy,
          adminAuth.note,
          auth.id_usuario,
          auth.id_empresa,
          idCajaSesion,
          idCajaMovimiento,
        ]
      );

      if (updateResult.rowCount === 0) {
        throw HttpError.badRequest(
          "El movimiento ya fue validado o no pertenece a esta caja"
        );
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "CAJA",
        entidad: "CAJA_MOVIMIENTO_VALIDACION",
        entidadId: idCajaMovimiento,
        accion: "VALIDATE",
        despues: {
          autorizado_por_admin_id: adminAuth.authorizedBy,
          nota: adminAuth.note,
        },
      });

      const updatedSession = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      return getCajaResumenInternal(client, { auth, session: updatedSession });
    },
    { auth }
  );

/**
 * Marca una venta NO_COBRADO como validada por un admin (quedo pendiente al
 * crearla; ahora el admin la revisa y firma antes de cerrar caja).
 */
export const validateNoCobroPendiente = async ({
  auth,
  scope,
  idCajaSesion,
  idVenta,
  body,
  requestMeta = null,
}) =>
  runInTransaction(
    async (client) => {
      const session = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      assertSessionAccess(auth, session);

      if (String(session.estado).toUpperCase() !== "ABIERTA") {
        throw HttpError.badRequest(
          "Solo puedes validar no-cobrados de cajas abiertas"
        );
      }

      const adminAuth = await verifyAdminAuthorization(client, {
        auth,
        body,
        requireAlways: true,
        noteField: "validacion_nota",
      });

      const updateResult = await client.query(
        `
          update ventas
          set no_cobrado_validado_por = $1,
              no_cobrado_validado_en = now(),
              no_cobrado_validacion_nota = $2,
              updated_by = $3
          where id_empresa = $4
            and id_caja_sesion = $5
            and id_venta = $6
            and estado = 'NO_COBRADO'
            and no_cobrado_validado_en is null
          returning id_venta
        `,
        [
          adminAuth.authorizedBy,
          adminAuth.note,
          auth.id_usuario,
          auth.id_empresa,
          idCajaSesion,
          idVenta,
        ]
      );

      if (updateResult.rowCount === 0) {
        throw HttpError.badRequest(
          "La venta no-cobrado ya fue validada o no pertenece a esta caja"
        );
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "CAJA",
        entidad: "VENTA_NO_COBRADO_VALIDACION",
        entidadId: idVenta,
        accion: "VALIDATE",
        despues: {
          id_caja_sesion: idCajaSesion,
          autorizado_por_admin_id: adminAuth.authorizedBy,
          nota: adminAuth.note,
        },
      });

      const updatedSession = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      return getCajaResumenInternal(client, { auth, session: updatedSession });
    },
    { auth }
  );

export const closeCaja = async ({ auth, idCajaSesion, body }) =>
  runInTransaction(
    async (client) => {
      const session = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      assertSessionAccess(auth, session);

      if (String(session.estado).toUpperCase() !== "ABIERTA") {
        throw HttpError.badRequest("La caja indicada ya fue cerrada");
      }

      const amountReported = Number(body?.monto_cierre_reportado);

      if (!Number.isFinite(amountReported) || amountReported < 0) {
        throw HttpError.badRequest(
          "monto_cierre_reportado debe ser un numero mayor o igual a 0"
        );
      }

      const summary = await getCajaResumenInternal(client, { auth, session });

      // Rechazar cierre si hay no-cobrados o movimientos manuales sin validar.
      if (Number(summary.resumen.no_cobrados_pendientes_count || 0) > 0) {
        throw HttpError.badRequest(
          `Hay ${summary.resumen.no_cobrados_pendientes_count} venta(s) NO_COBRADO sin validar. Valida cada una antes de cerrar caja.`
        );
      }

      if (
        Number(summary.resumen.movimientos_pendientes_validacion_count || 0) > 0
      ) {
        throw HttpError.badRequest(
          `Hay ${summary.resumen.movimientos_pendientes_validacion_count} movimiento(s) manual(es) sin validar. Valida cada uno antes de cerrar caja.`
        );
      }

      const difference = roundMoney(
        roundMoney(amountReported) - roundMoney(summary.resumen.cierre_calculado)
      );
      const approval = await ensureDifferenceApproval(client, {
        auth,
        body,
        difference,
      });

      await client.query(
        `
          update caja_sesiones
          set
            estado = 'CERRADA',
            fecha_cierre = now(),
            monto_cierre = $1,
            monto_cierre_reportado = $1,
            monto_cierre_calculado = $2,
            diferencia = $3,
            observaciones = coalesce($4, observaciones),
            observaciones_cierre = $4,
            diferencia_validada_por = $5::bigint,
            diferencia_validada_en = case when $5::bigint is not null then now() else diferencia_validada_en end,
            diferencia_validacion_nota = $6::text,
            updated_by = $7
          where id_empresa = $8
            and id_caja_sesion = $9
        `,
        [
          roundMoney(amountReported),
          roundMoney(summary.resumen.cierre_calculado),
          difference,
          String(body?.observaciones_cierre || "").trim() || null,
          approval.authorizedBy,
          approval.note,
          auth.id_usuario,
          auth.id_empresa,
          idCajaSesion,
        ]
      );

      const closedSession = await getCajaSesionByIdInternal(client, {
        auth,
        idCajaSesion,
      });

      return getCajaResumenInternal(client, {
        auth,
        session: closedSession,
      });
    },
    { auth }
  );

export const getCajaResumen = async ({ db, auth, idCajaSesion }) => {
  const conn = resolveDb(db);
  const session = await getCajaSesionByIdInternal(conn, {
    auth,
    idCajaSesion,
  });

  assertSessionAccess(auth, session);

  return getCajaResumenInternal(conn, { auth, session });
};
