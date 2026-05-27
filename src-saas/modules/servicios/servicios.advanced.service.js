import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const OPERATIONAL_MODULES = ["SERVICIOS", "CARWASH"];
const PRIORITY_VALUES = ["BAJA", "NORMAL", "ALTA", "URGENTE"];
const AGENDA_STATES = [
  "NO_PROGRAMADA",
  "PROGRAMADA",
  "EN_EJECUCION",
  "FINALIZADA",
  "CANCELADA",
];
const CHECKLIST_STATES = ["PENDIENTE", "CUMPLIDO", "OMITIDO"];
const CHARGE_STATES = [
  "PENDIENTE",
  "COBRADO",
  "PARCIAL_REEMBOLSADO",
  "REEMBOLSADO",
  "ANULADA",
];
const REFUND_METHODS = ["EFECTIVO", "TARJETA", "TRANSFERENCIA", "AJUSTE"];
const DEFAULT_TOP_LIMIT = 8;
const DEFAULT_EVENT_LIMIT = 10;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const roundQuantity = (value) => Number(Number(value || 0).toFixed(3));
const toNumber = (value) => Number(value || 0);
const toInteger = (value) => Math.trunc(Number(value || 0));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeModule = (value) => String(value || "").trim().toUpperCase();
const normalizeText = (value) => String(value || "").trim();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const normalizeView = (value) =>
  String(value || "EMPRESA").trim().toUpperCase() === "SUCURSAL"
    ? "SUCURSAL"
    : "EMPRESA";

const isPrivilegedRole = (role) => PRIVILEGED_ROLES.has(normalizeRole(role));

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  return ["true", "1", "si", "yes", "on"].includes(normalized);
};

const parseInteger = (value, fieldName, { min = 1, allowNull = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (allowNull) {
      return null;
    }

    throw HttpError.badRequest(`${fieldName} es requerido`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw HttpError.badRequest(`${fieldName} es invalido`);
  }

  return parsed;
};

const parseMoney = (value, fieldName, { min = 0, allowNull = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (allowNull) {
      return null;
    }

    throw HttpError.badRequest(`${fieldName} es requerido`);
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < min) {
    throw HttpError.badRequest(`${fieldName} es invalido`);
  }

  return roundMoney(parsed);
};

const parseTimestamp = (value, fieldName, { allowNull = true } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (allowNull) {
      return null;
    }

    throw HttpError.badRequest(`${fieldName} es requerido`);
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest(`${fieldName} tiene un formato invalido`);
  }

  return parsed.toISOString();
};

const buildIsoDate = (date) => date.toISOString().slice(0, 10);

const shiftIsoDate = (isoDate, offsetDays) => {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Number(offsetDays || 0));
  return buildIsoDate(base);
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

const getDateRange = (query, { defaultDays = 7 } = {}) => {
  const defaultHasta = buildIsoDate(new Date());
  const hasta = String(query?.hasta || defaultHasta).trim();

  if (!ISO_DATE_PATTERN.test(hasta)) {
    throw HttpError.badRequest("hasta debe tener formato YYYY-MM-DD");
  }

  const defaultDesde = shiftIsoDate(hasta, -(Math.max(1, defaultDays) - 1));
  const desde = String(query?.desde || defaultDesde).trim();

  if (!ISO_DATE_PATTERN.test(desde)) {
    throw HttpError.badRequest("desde debe tener formato YYYY-MM-DD");
  }

  if (desde > hasta) {
    throw HttpError.badRequest("desde no puede ser mayor que hasta");
  }

  return { desde, hasta };
};

const getAccessibleModules = (auth) => {
  const activeModules = Array.isArray(auth?.modulos)
    ? auth.modulos.map(normalizeModule)
    : [];
  const modules = [...new Set(activeModules.filter((item) => OPERATIONAL_MODULES.includes(item)))];

  if (modules.length === 0) {
    throw HttpError.forbidden(
      "Tu empresa no tiene habilitado SERVICIOS o CARWASH"
    );
  }

  return modules;
};

const resolveRequestedModule = (auth, requestedModule) => {
  const accessibleModules = getAccessibleModules(auth);

  if (requestedModule === undefined || requestedModule === null || requestedModule === "") {
    return {
      requestedModule: null,
      accessibleModules,
    };
  }

  const normalized = normalizeModule(requestedModule);

  if (!accessibleModules.includes(normalized)) {
    throw HttpError.forbidden(
      `El modulo ${normalized} no esta habilitado para esta empresa`
    );
  }

  return {
    requestedModule: normalized,
    accessibleModules,
  };
};

const getAssignedBranchIds = (auth) =>
  [...new Set((Array.isArray(auth?.sucursales) ? auth.sucursales : []).map(Number))]
    .filter((branchId) => Number.isInteger(branchId) && branchId > 0);

const buildScopeBranchIds = (auth, scope) => {
  if (scope?.id_sucursal) {
    return [Number(scope.id_sucursal)];
  }

  if (isPrivilegedRole(auth?.rol)) {
    return [];
  }

  return getAssignedBranchIds(auth);
};

const buildArrayFilter = (alias, column, values, startIndex) => {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      clause: "",
      params: [],
    };
  }

  return {
    clause: `and ${alias}.${column} = any($${startIndex})`,
    params: [values],
  };
};

const normalizeTechnicianRow = (row) => ({
  ...row,
  especialidades: Array.isArray(row.especialidades) ? row.especialidades : [],
  activo: row.activo !== false,
  workload_programadas: Number(row.workload_programadas || 0),
  workload_en_ejecucion: Number(row.workload_en_ejecucion || 0),
});

const normalizeChecklistTemplateRow = (row) => ({
  ...row,
  orden: Number(row.orden || 0),
  obligatorio: row.obligatorio !== false,
  activo: row.activo !== false,
});

const normalizeChecklistItemRow = (row) => ({
  ...row,
  orden: Number(row.orden || 0),
  obligatorio: row.obligatorio !== false,
});

const normalizeReversionRow = (row) => ({
  ...row,
  monto: roundMoney(row.monto),
  reintegrar_stock: row.reintegrar_stock === true,
});

const normalizeOrderRow = (row) => ({
  ...row,
  subtotal: roundMoney(row.subtotal),
  precio_servicio: roundMoney(row.precio_servicio),
  productos_total: roundMoney(row.productos_total),
  total: roundMoney(row.total),
  reembolso_monto: roundMoney(row.reembolso_monto),
  monto_recibido:
    row.monto_recibido != null ? roundMoney(row.monto_recibido) : null,
  cambio: roundMoney(row.cambio),
  anio: row.anio != null ? Number(row.anio) : null,
  duracion_minutos:
    row.duracion_minutos != null ? Number(row.duracion_minutos) : null,
  stock_reintegrado: row.stock_reintegrado === true,
});

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
  const assignedBranchIds = getAssignedBranchIds(auth);

  if (!isPrivileged && assignedBranchIds.length === 0) {
    throw HttpError.forbidden("El usuario no tiene sucursales asignadas");
  }

  const effectiveBranchId =
    requestedBranchId ||
    Number(scope?.id_sucursal || auth.id_sucursal || 0) ||
    assignedBranchIds[0];

  if (!Number.isInteger(effectiveBranchId) || effectiveBranchId <= 0) {
    throw HttpError.badRequest("No se pudo resolver la sucursal solicitada");
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

const getAdvancedOrderSelect = () => `
  select
    os.id_orden_servicio,
    os.id_empresa,
    os.id_sucursal,
    os.id_servicio_catalogo,
    os.id_cliente,
    os.id_usuario,
    os.id_usuario_asignado,
    os.id_caja_sesion,
    upper(os.modulo) as modulo,
    os.numero_orden,
    os.placa,
    os.vehiculo_tipo,
    os.color,
    os.marca,
    os.modelo,
    os.anio,
    os.kilometraje,
    upper(os.estado) as estado,
    upper(coalesce(os.estado_cobro, 'PENDIENTE')) as estado_cobro,
    upper(coalesce(os.metodo_pago, '')) as metodo_pago,
    upper(coalesce(os.prioridad, 'NORMAL')) as prioridad,
    upper(coalesce(os.agenda_estado, 'NO_PROGRAMADA')) as agenda_estado,
    os.subtotal,
    os.precio_servicio,
    coalesce(prod.productos_total, 0) as productos_total,
    os.total,
    os.reembolso_monto,
    os.reembolso_metodo,
    os.monto_recibido,
    os.cambio,
    os.nombre_contacto,
    os.telefono_contacto,
    os.observaciones,
    os.fecha_servicio,
    os.fecha_programada_inicio,
    os.fecha_programada_fin,
    os.fecha_promesa,
    os.fecha_inicio,
    os.fecha_finalizacion,
    os.fecha_entrega,
    os.fecha_cobro,
    os.fecha_reembolso,
    os.cancelada_en,
    os.cancelacion_motivo,
    os.reembolso_motivo,
    os.stock_reintegrado,
    os.stock_reintegrado_en,
    os.created_at,
    os.updated_at,
    s.codigo as sucursal_codigo,
    s.nombre as sucursal_nombre,
    sc.codigo as servicio_codigo,
    sc.nombre as servicio_nombre,
    sc.descripcion as servicio_descripcion,
    sc.duracion_minutos,
    c.nombre as cliente_nombre,
    c.telefono as cliente_telefono,
    u.username as usuario_username,
    concat(u.nombre, ' ', u.apellido) as usuario_nombre,
    ua.username as asignado_username,
    concat(ua.nombre, ' ', ua.apellido) as asignado_nombre
  from ordenes_servicio os
  inner join sucursales s
    on s.id_empresa = os.id_empresa
   and s.id_sucursal = os.id_sucursal
  inner join servicios_catalogo sc
    on sc.id_empresa = os.id_empresa
   and sc.id_servicio_catalogo = os.id_servicio_catalogo
  inner join usuarios u
    on u.id_empresa = os.id_empresa
   and u.id_usuario = os.id_usuario
  left join usuarios ua
    on ua.id_empresa = os.id_empresa
   and ua.id_usuario = os.id_usuario_asignado
  left join clientes c
    on c.id_empresa = os.id_empresa
   and c.id_cliente = os.id_cliente
  left join lateral (
    select
      coalesce(sum(case when osp.cobra_al_cliente then osp.subtotal else 0 end), 0) as productos_total
    from ordenes_servicio_productos osp
    where osp.id_empresa = os.id_empresa
      and osp.id_orden_servicio = os.id_orden_servicio
  ) prod on true
`;

const getOrderHeaderById = async (
  db,
  { auth, idOrdenServicio, branchIds = [], forUpdate = false }
) => {
  const { accessibleModules } = resolveRequestedModule(auth, null);
  const branchFilter = buildArrayFilter("os", "id_sucursal", branchIds, 3);
  const moduleStartIndex = 3 + branchFilter.params.length;
  const moduleFilter = buildArrayFilter(
    "os",
    "modulo",
    accessibleModules,
    moduleStartIndex
  );

  const result = await db.query(
    `
      ${getAdvancedOrderSelect()}
      where os.id_empresa = $1
        and os.id_orden_servicio = $2
        ${branchFilter.clause}
        ${moduleFilter.clause}
      limit 1
      ${forUpdate ? "for update of os" : ""}
    `,
    [
      auth.id_empresa,
      idOrdenServicio,
      ...branchFilter.params,
      ...moduleFilter.params,
    ]
  );

  return result.rows[0] ? normalizeOrderRow(result.rows[0]) : null;
};

const getOrderControlByIdInternal = async (
  db,
  { auth, idOrdenServicio, branchIds = [], forUpdate = false }
) => {
  const order = await getOrderHeaderById(db, {
    auth,
    idOrdenServicio,
    branchIds,
    forUpdate,
  });

  if (!order) {
    throw HttpError.notFound("Orden de servicio no encontrada");
  }

  const techniciansResult = await db.query(
    `
      select
        ost.id_orden_servicio_tecnico,
        ost.id_usuario,
        ost.es_principal,
        upper(ost.estado_asignacion) as estado_asignacion,
        ost.horas_estimadas,
        ost.horas_reales,
        ost.notas,
        u.username,
        u.nombre,
        u.apellido,
        st.alias,
        st.color_agenda
      from ordenes_servicio_tecnicos ost
      inner join usuarios u
        on u.id_empresa = ost.id_empresa
       and u.id_usuario = ost.id_usuario
      left join servicios_tecnicos st
        on st.id_empresa = ost.id_empresa
       and st.id_usuario = ost.id_usuario
      where ost.id_empresa = $1
        and ost.id_orden_servicio = $2
      order by ost.es_principal desc, u.nombre asc, u.apellido asc
    `,
    [auth.id_empresa, idOrdenServicio]
  );
  const checklistResult = await db.query(
    `
      select
        osc.id_orden_servicio_checklist,
        osc.id_servicio_checklist_template,
        osc.titulo,
        osc.instrucciones,
        osc.orden,
        osc.obligatorio,
        upper(osc.estado) as estado,
        osc.observacion,
        osc.completado_en,
        uc.username as completado_por_username,
        concat(uc.nombre, ' ', uc.apellido) as completado_por_nombre
      from ordenes_servicio_checklist osc
      left join usuarios uc
        on uc.id_empresa = osc.id_empresa
       and uc.id_usuario = osc.completado_por
      where osc.id_empresa = $1
        and osc.id_orden_servicio = $2
      order by osc.orden asc, osc.id_orden_servicio_checklist asc
    `,
    [auth.id_empresa, idOrdenServicio]
  );
  const reversionesResult = await db.query(
    `
      select
        osr.id_orden_servicio_reversion,
        upper(osr.tipo) as tipo,
        osr.monto,
        upper(coalesce(osr.metodo_pago, '')) as metodo_pago,
        osr.motivo,
        osr.reintegrar_stock,
        osr.created_at,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from ordenes_servicio_reversiones osr
      inner join usuarios u
        on u.id_empresa = osr.id_empresa
       and u.id_usuario = osr.id_usuario
      where osr.id_empresa = $1
        and osr.id_orden_servicio = $2
      order by osr.created_at desc, osr.id_orden_servicio_reversion desc
    `,
    [auth.id_empresa, idOrdenServicio]
  );

  return {
    orden: order,
    tecnicos: techniciansResult.rows.map((row) => ({
      ...row,
      horas_estimadas:
        row.horas_estimadas != null ? Number(row.horas_estimadas) : null,
      horas_reales: row.horas_reales != null ? Number(row.horas_reales) : null,
      es_principal: row.es_principal === true,
    })),
    checklist: checklistResult.rows.map(normalizeChecklistItemRow),
    reversiones: reversionesResult.rows.map(normalizeReversionRow),
  };
};

const ensureOrderMutable = (order) => {
  if (normalizeState(order.estado) === "ANULADA") {
    throw HttpError.badRequest("La orden ya esta anulada");
  }
};

const getDefaultWarehouseId = async (db, { auth, idSucursal }) => {
  const idBodega = await getPrincipalSucursal(db, {
    idEmpresa: auth.id_empresa,
    idSucursal,
  });

  if (!idBodega) {
    throw HttpError.badRequest(
      "La sucursal activa no tiene una bodega principal configurada"
    );
  }

  return Number(idBodega);
};

const ensureTechnicianProfiles = async (db, { auth, scope, technicianIds }) => {
  const uniqueIds = [...new Set((Array.isArray(technicianIds) ? technicianIds : []).map(Number))]
    .filter((idUsuario) => Number.isInteger(idUsuario) && idUsuario > 0);

  if (uniqueIds.length === 0) {
    return [];
  }

  const result = await db.query(
    `
      select
        st.id_usuario,
        st.alias,
        st.color_agenda,
        u.username,
        u.nombre,
        u.apellido
      from servicios_tecnicos st
      inner join usuarios u
        on u.id_empresa = st.id_empresa
       and u.id_usuario = st.id_usuario
      inner join usuarios_sucursales us
        on us.id_empresa = u.id_empresa
       and us.id_usuario = u.id_usuario
      where st.id_empresa = $1
        and st.activo = true
        and u.activo = true
        and us.id_sucursal = $2
        and st.id_usuario = any($3::bigint[])
    `,
    [auth.id_empresa, scope.id_sucursal, uniqueIds]
  );

  if (result.rows.length !== uniqueIds.length) {
    const foundIds = new Set(result.rows.map((row) => Number(row.id_usuario)));
    const missingId = uniqueIds.find((idUsuario) => !foundIds.has(idUsuario));
    throw HttpError.badRequest(
      `El tecnico ${missingId} no tiene perfil activo o no pertenece a la sucursal`
    );
  }

  return result.rows;
};

const deriveAgendaState = ({ estado, fechaProgramadaInicio }) => {
  const normalizedEstado = normalizeState(estado);

  if (normalizedEstado === "ANULADA") {
    return "CANCELADA";
  }

  if (normalizedEstado === "EN_PROCESO") {
    return "EN_EJECUCION";
  }

  if (["LISTO", "ENTREGADO"].includes(normalizedEstado)) {
    return "FINALIZADA";
  }

  if (fechaProgramadaInicio) {
    return "PROGRAMADA";
  }

  return "NO_PROGRAMADA";
};

const assertTechnicianAvailability = async (
  db,
  { auth, technicianIds, idOrdenServicio, fechaInicio, fechaFin }
) => {
  if (
    !Array.isArray(technicianIds) ||
    technicianIds.length === 0 ||
    !fechaInicio ||
    !fechaFin
  ) {
    return;
  }

  const result = await db.query(
    `
      select
        ost.id_usuario,
        u.username,
        os.numero_orden,
        os.fecha_programada_inicio,
        os.fecha_programada_fin
      from ordenes_servicio_tecnicos ost
      inner join ordenes_servicio os
        on os.id_empresa = ost.id_empresa
       and os.id_orden_servicio = ost.id_orden_servicio
      inner join usuarios u
        on u.id_empresa = ost.id_empresa
       and u.id_usuario = ost.id_usuario
      where ost.id_empresa = $1
        and ost.id_usuario = any($2::bigint[])
        and os.id_orden_servicio <> $3
        and upper(coalesce(os.estado, '')) <> 'ANULADA'
        and upper(coalesce(os.agenda_estado, '')) <> 'CANCELADA'
        and coalesce(os.fecha_programada_inicio, os.fecha_servicio) < $5::timestamptz
        and coalesce(os.fecha_programada_fin, os.fecha_programada_inicio, os.fecha_servicio) > $4::timestamptz
      order by os.fecha_programada_inicio asc nulls first
      limit 1
    `,
    [auth.id_empresa, technicianIds, idOrdenServicio || 0, fechaInicio, fechaFin]
  );

  const conflict = result.rows[0];

  if (conflict) {
    throw HttpError.conflict(
      `El tecnico ${conflict.username} ya tiene conflicto con la orden ${conflict.numero_orden}`
    );
  }
};

const syncOrderTechnicians = async (
  db,
  { auth, scope, idOrdenServicio, technicianIds, idPrincipal, actorId }
) => {
  const normalizedIds = [...new Set((Array.isArray(technicianIds) ? technicianIds : []).map(Number))]
    .filter((idUsuario) => Number.isInteger(idUsuario) && idUsuario > 0);

  if (idPrincipal && !normalizedIds.includes(Number(idPrincipal))) {
    normalizedIds.unshift(Number(idPrincipal));
  }

  if (normalizedIds.length > 0) {
    await ensureTechnicianProfiles(db, {
      auth,
      scope,
      technicianIds: normalizedIds,
    });
  }

  await db.query(
    `
      delete from ordenes_servicio_tecnicos
      where id_empresa = $1
        and id_orden_servicio = $2
    `,
    [auth.id_empresa, idOrdenServicio]
  );

  for (const idUsuario of normalizedIds) {
    await db.query(
      `
        insert into ordenes_servicio_tecnicos (
          id_empresa,
          id_orden_servicio,
          id_usuario,
          es_principal,
          estado_asignacion,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,'ASIGNADO',$5,$5)
      `,
      [
        auth.id_empresa,
        idOrdenServicio,
        idUsuario,
        Number(idUsuario) === Number(idPrincipal),
        actorId,
      ]
    );
  }

  return normalizedIds;
};

const restoreConsumedProducts = async (
  db,
  { auth, order, reasonLabel, actorId }
) => {
  const idBodega = await getDefaultWarehouseId(db, {
    auth,
    idSucursal: order.id_sucursal,
  });
  const itemsResult = await db.query(
    `
      select id_producto, cantidad
      from ordenes_servicio_productos
      where id_empresa = $1
        and id_orden_servicio = $2
    `,
    [auth.id_empresa, order.id_orden_servicio]
  );

  for (const item of itemsResult.rows) {
    const stockResult = await db.query(
      `
        select stock_actual
        from stock_sucursal
        where id_empresa = $1
          and id_sucursal = $2
          and id_bodega = $3
          and id_producto = $4
        limit 1
        for update
      `,
      [auth.id_empresa, order.id_sucursal, idBodega, item.id_producto]
    );

    const currentStock = Number(stockResult.rows[0]?.stock_actual || 0);
    const stockAfter = roundQuantity(currentStock + Number(item.cantidad || 0));

    await db.query(
      `
        update stock_sucursal
        set stock_actual = $1,
            updated_by = $2
        where id_empresa = $3
          and id_sucursal = $4
          and id_bodega = $5
          and id_producto = $6
      `,
      [
        stockAfter,
        actorId,
        auth.id_empresa,
        order.id_sucursal,
        idBodega,
        item.id_producto,
      ]
    );

    await db.query(
      `
        insert into movimientos_inventario (
          id_empresa,
          id_sucursal,
          id_bodega,
          id_producto,
          id_usuario,
          tipo,
          referencia_tipo,
          referencia_id,
          cantidad,
          stock_antes,
          stock_despues,
          observacion,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,'ENTRADA','REVERSA_ORDEN_SERVICIO',$6,$7,$8,$9,$10,$5,$5)
      `,
      [
        auth.id_empresa,
        order.id_sucursal,
        idBodega,
        item.id_producto,
        actorId,
        order.id_orden_servicio,
        Number(item.cantidad || 0),
        currentStock,
        stockAfter,
        reasonLabel,
      ]
    );
  }
};

const createRefundCashMovement = async (
  db,
  { auth, scope, order, amount, methodLabel, actorId }
) => {
  if (normalizeState(methodLabel) !== "EFECTIVO") {
    return null;
  }

  const cajaResult = await db.query(
    `
      select id_caja_sesion
      from caja_sesiones
      where id_empresa = $1
        and id_usuario = $2
        and id_sucursal = $3
        and estado = 'ABIERTA'
      order by fecha_apertura desc
      limit 1
    `,
    [auth.id_empresa, auth.id_usuario, scope.id_sucursal]
  );

  const session = cajaResult.rows[0];

  if (!session) {
    throw HttpError.badRequest(
      "Debes abrir una caja en la sucursal activa para procesar reembolsos en efectivo"
    );
  }

  await db.query(
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
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,'EGRESO','REEMBOLSO_SERVICIO',$5,$6,'ORDEN_SERVICIO',$7,$4,$4)
    `,
    [
      auth.id_empresa,
      session.id_caja_sesion,
      scope.id_sucursal,
      actorId,
      roundMoney(amount),
      `Reembolso orden ${order.numero_orden}`,
      order.id_orden_servicio,
    ]
  );

  return Number(session.id_caja_sesion);
};

export const listTechnicians = async ({ auth, scope, query, db = pool }) => {
  const branchIds = buildScopeBranchIds(auth, scope);
  const filters = ["st.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (branchIds.length > 0) {
    filters.push(
      `exists (
        select 1
        from usuarios_sucursales usf
        where usf.id_empresa = st.id_empresa
          and usf.id_usuario = st.id_usuario
          and usf.id_sucursal = any($${index}::bigint[])
      )`
    );
    params.push(branchIds);
    index += 1;
  }

  if (query?.activo === "true" || query?.activo === "false") {
    filters.push(`st.activo = $${index}`);
    params.push(query.activo === "true");
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(st.alias, '') ilike $${index} or coalesce(u.username, '') ilike $${index} or coalesce(u.nombre, '') ilike $${index} or coalesce(u.apellido, '') ilike $${index})`
    );
    params.push(`%${normalizeText(query.search)}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 80, 100));
  params.push(limit);

  const result = await db.query(
    `
      select
        st.id_servicio_tecnico,
        st.id_usuario,
        st.alias,
        st.especialidades,
        st.color_agenda,
        st.notas,
        st.activo,
        st.created_at,
        st.updated_at,
        u.username,
        u.nombre,
        u.apellido,
        (
          select coalesce(
            json_agg(
              json_build_object(
                'id_sucursal', s.id_sucursal,
                'codigo', s.codigo,
                'nombre', s.nombre
              )
              order by s.nombre asc
            ),
            '[]'::json
          )
          from usuarios_sucursales us
          inner join sucursales s
            on s.id_empresa = us.id_empresa
           and s.id_sucursal = us.id_sucursal
          where us.id_empresa = st.id_empresa
            and us.id_usuario = st.id_usuario
        ) as sucursales,
        coalesce(w.workload_programadas, 0) as workload_programadas,
        coalesce(w.workload_en_ejecucion, 0) as workload_en_ejecucion
      from servicios_tecnicos st
      inner join usuarios u
        on u.id_empresa = st.id_empresa
       and u.id_usuario = st.id_usuario
      left join lateral (
        select
          count(*) filter (where upper(coalesce(os.agenda_estado, '')) = 'PROGRAMADA')::int as workload_programadas,
          count(*) filter (where upper(coalesce(os.agenda_estado, '')) = 'EN_EJECUCION')::int as workload_en_ejecucion
        from ordenes_servicio_tecnicos ost
        inner join ordenes_servicio os
          on os.id_empresa = ost.id_empresa
         and os.id_orden_servicio = ost.id_orden_servicio
        where ost.id_empresa = st.id_empresa
          and ost.id_usuario = st.id_usuario
          and upper(coalesce(os.estado, '')) <> 'ANULADA'
      ) w on true
      where ${filters.join(" and ")}
      order by st.activo desc, u.nombre asc, u.apellido asc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeTechnicianRow);
};

export const upsertTechnician = async ({
  auth,
  scope,
  idUsuario,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const userId = parseInteger(idUsuario, "id_usuario");
      const userResult = await client.query(
        `
          select u.id_usuario, u.username, u.nombre, u.apellido, u.activo
          from usuarios u
          where u.id_empresa = $1
            and u.id_usuario = $2
          limit 1
        `,
        [auth.id_empresa, userId]
      );

      const user = userResult.rows[0];

      if (!user) {
        throw HttpError.notFound("Usuario no encontrado");
      }

      const beforeResult = await client.query(
        `
          select *
          from servicios_tecnicos
          where id_empresa = $1
            and id_usuario = $2
          limit 1
        `,
        [auth.id_empresa, userId]
      );

      const before = beforeResult.rows[0] || null;
      const especialidades = Array.isArray(body?.especialidades)
        ? [...new Set(body.especialidades.map((item) => normalizeText(item)).filter(Boolean))]
        : [];

      await client.query(
        `
          insert into servicios_tecnicos (
            id_empresa,
            id_usuario,
            alias,
            especialidades,
            color_agenda,
            notas,
            activo,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4::text[],$5,$6,$7,$8,$8)
          on conflict (id_empresa, id_usuario)
          do update
          set
            alias = excluded.alias,
            especialidades = excluded.especialidades,
            color_agenda = excluded.color_agenda,
            notas = excluded.notas,
            activo = excluded.activo,
            updated_by = excluded.updated_by
        `,
        [
          auth.id_empresa,
          userId,
          normalizeText(body?.alias) || null,
          especialidades,
          normalizeText(body?.color_agenda) || null,
          normalizeText(body?.notas) || null,
          body?.activo !== undefined ? normalizeBoolean(body.activo, true) : true,
          auth.id_usuario,
        ]
      );

      const after = (
        await listTechnicians({
          auth,
          scope,
          query: { search: user.username, limit: 1 },
          db: client,
        })
      ).find((item) => Number(item.id_usuario) === userId);

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "SERVICIOS",
        entidad: "SERVICIO_TECNICO",
        entidadId: userId,
        accion: before ? "UPDATE" : "CREATE",
        antes: before,
        despues: after,
      });

      return after;
    },
    { auth }
  );

export const listChecklistTemplates = async ({ auth, query, db = pool }) => {
  const { requestedModule, accessibleModules } = resolveRequestedModule(
    auth,
    query?.modulo
  );
  const filters = ["sct.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (query?.id_servicio_catalogo) {
    filters.push(`sct.id_servicio_catalogo = $${index}`);
    params.push(parseInteger(query.id_servicio_catalogo, "id_servicio_catalogo"));
    index += 1;
  }

  if (requestedModule) {
    filters.push(`upper(sc.modulo) = $${index}`);
    params.push(requestedModule);
    index += 1;
  } else {
    filters.push(`upper(sc.modulo) = any($${index})`);
    params.push(accessibleModules);
    index += 1;
  }

  if (query?.activo === "true" || query?.activo === "false") {
    filters.push(`sct.activo = $${index}`);
    params.push(query.activo === "true");
    index += 1;
  }

  const result = await db.query(
    `
      select
        sct.id_servicio_checklist_template,
        sct.id_servicio_catalogo,
        upper(sc.modulo) as modulo,
        sc.nombre as servicio_nombre,
        sct.titulo,
        sct.instrucciones,
        sct.orden,
        sct.obligatorio,
        sct.activo
      from servicios_checklist_templates sct
      inner join servicios_catalogo sc
        on sc.id_empresa = sct.id_empresa
       and sc.id_servicio_catalogo = sct.id_servicio_catalogo
      where ${filters.join(" and ")}
      order by sc.nombre asc, sct.orden asc, sct.id_servicio_checklist_template asc
    `,
    params
  );

  return result.rows.map(normalizeChecklistTemplateRow);
};

export const createChecklistTemplate = async ({
  auth,
  scope,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const idServicioCatalogo = parseInteger(
        body?.id_servicio_catalogo,
        "id_servicio_catalogo"
      );
      const serviceResult = await client.query(
        `
          select id_servicio_catalogo, upper(modulo) as modulo
          from servicios_catalogo
          where id_empresa = $1
            and id_servicio_catalogo = $2
          limit 1
        `,
        [auth.id_empresa, idServicioCatalogo]
      );

      const service = serviceResult.rows[0];

      if (!service) {
        throw HttpError.badRequest("El servicio seleccionado no existe");
      }

      const insertResult = await client.query(
        `
          insert into servicios_checklist_templates (
            id_empresa,
            id_servicio_catalogo,
            titulo,
            instrucciones,
            orden,
            obligatorio,
            activo,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
          returning id_servicio_checklist_template
        `,
        [
          auth.id_empresa,
          idServicioCatalogo,
          normalizeText(body?.titulo),
          normalizeText(body?.instrucciones) || null,
          body?.orden !== undefined ? parseInteger(body.orden, "orden", { min: 1 }) : 1,
          body?.obligatorio !== undefined
            ? normalizeBoolean(body.obligatorio, true)
            : true,
          body?.activo !== undefined ? normalizeBoolean(body.activo, true) : true,
          auth.id_usuario,
        ]
      );

      const created = await listChecklistTemplates({
        auth,
        query: {
          id_servicio_catalogo: idServicioCatalogo,
          activo: body?.activo !== undefined ? String(body.activo) : undefined,
        },
        db: client,
      });
      const item = created.find(
        (row) =>
          Number(row.id_servicio_checklist_template) ===
          Number(insertResult.rows[0].id_servicio_checklist_template)
      );

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: service.modulo,
        entidad: "SERVICIO_CHECKLIST_TEMPLATE",
        entidadId: insertResult.rows[0].id_servicio_checklist_template,
        accion: "CREATE",
        despues: item,
      });

      return item;
    },
    { auth }
  );

export const updateChecklistTemplate = async ({
  auth,
  scope,
  idChecklistTemplate,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const templateId = parseInteger(
        idChecklistTemplate,
        "id_servicio_checklist_template"
      );
      const currentResult = await client.query(
        `
          select
            sct.*,
            upper(sc.modulo) as modulo
          from servicios_checklist_templates sct
          inner join servicios_catalogo sc
            on sc.id_empresa = sct.id_empresa
           and sc.id_servicio_catalogo = sct.id_servicio_catalogo
          where sct.id_empresa = $1
            and sct.id_servicio_checklist_template = $2
          limit 1
        `,
        [auth.id_empresa, templateId]
      );

      const current = currentResult.rows[0];

      if (!current) {
        throw HttpError.notFound("Plantilla de checklist no encontrada");
      }

      await client.query(
        `
          update servicios_checklist_templates
          set
            titulo = $1,
            instrucciones = $2,
            orden = $3,
            obligatorio = $4,
            activo = $5,
            updated_by = $6
          where id_empresa = $7
            and id_servicio_checklist_template = $8
        `,
        [
          body?.titulo !== undefined ? normalizeText(body.titulo) : current.titulo,
          body?.instrucciones !== undefined
            ? normalizeText(body.instrucciones) || null
            : current.instrucciones,
          body?.orden !== undefined
            ? parseInteger(body.orden, "orden", { min: 1 })
            : current.orden,
          body?.obligatorio !== undefined
            ? normalizeBoolean(body.obligatorio, true)
            : current.obligatorio,
          body?.activo !== undefined
            ? normalizeBoolean(body.activo, true)
            : current.activo,
          auth.id_usuario,
          auth.id_empresa,
          templateId,
        ]
      );

      const updated = await listChecklistTemplates({
        auth,
        query: { id_servicio_catalogo: current.id_servicio_catalogo },
        db: client,
      });
      const item = updated.find(
        (row) => Number(row.id_servicio_checklist_template) === templateId
      );

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.modulo,
        entidad: "SERVICIO_CHECKLIST_TEMPLATE",
        entidadId: templateId,
        accion: "UPDATE",
        antes: current,
        despues: item,
      });

      return item;
    },
    { auth }
  );

export const listAgenda = async ({ auth, scope, query }) => {
  const { desde, hasta } = getDateRange(query, { defaultDays: 14 });
  const { requestedModule, accessibleModules } = resolveRequestedModule(
    auth,
    query?.modulo
  );
  const filters = ["os.id_empresa = $1", "os.id_sucursal = $2"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (requestedModule) {
    filters.push(`upper(os.modulo) = $${index}`);
    params.push(requestedModule);
    index += 1;
  } else {
    filters.push(`upper(os.modulo) = any($${index})`);
    params.push(accessibleModules);
    index += 1;
  }

  filters.push(
    `(coalesce(os.fecha_programada_inicio::date, os.fecha_servicio::date) >= $${index}::date and coalesce(os.fecha_programada_inicio::date, os.fecha_servicio::date) <= $${index + 1}::date)`
  );
  params.push(desde);
  params.push(hasta);
  index += 2;

  if (query?.agenda_estado) {
    filters.push(`upper(coalesce(os.agenda_estado, 'NO_PROGRAMADA')) = $${index}`);
    params.push(normalizeState(query.agenda_estado));
    index += 1;
  }

  if (query?.id_usuario) {
    filters.push(
      `exists (
        select 1
        from ordenes_servicio_tecnicos ostf
        where ostf.id_empresa = os.id_empresa
          and ostf.id_orden_servicio = os.id_orden_servicio
          and ostf.id_usuario = $${index}
      )`
    );
    params.push(parseInteger(query.id_usuario, "id_usuario"));
    index += 1;
  }

  const result = await pool.query(
    `
      ${getAdvancedOrderSelect()}
      where ${filters.join(" and ")}
      order by coalesce(os.fecha_programada_inicio, os.fecha_servicio) asc, os.id_orden_servicio asc
    `,
    params
  );

  const agendaRows = result.rows.map(normalizeOrderRow);

  if (agendaRows.length === 0) {
    return {
      rango: { desde, hasta },
      items: [],
    };
  }

  const technicianResult = await pool.query(
    `
      select
        ost.id_orden_servicio,
        ost.id_usuario,
        ost.es_principal,
        u.username,
        concat(u.nombre, ' ', u.apellido) as nombre,
        st.alias,
        st.color_agenda
      from ordenes_servicio_tecnicos ost
      inner join usuarios u
        on u.id_empresa = ost.id_empresa
       and u.id_usuario = ost.id_usuario
      left join servicios_tecnicos st
        on st.id_empresa = ost.id_empresa
       and st.id_usuario = ost.id_usuario
      where ost.id_empresa = $1
        and ost.id_orden_servicio = any($2::bigint[])
      order by ost.es_principal desc, nombre asc
    `,
    [auth.id_empresa, agendaRows.map((row) => row.id_orden_servicio)]
  );

  const techniciansByOrder = technicianResult.rows.reduce((acc, row) => {
    const key = Number(row.id_orden_servicio);
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push({
      id_usuario: Number(row.id_usuario),
      es_principal: row.es_principal === true,
      username: row.username,
      nombre: row.nombre,
      alias: row.alias,
      color_agenda: row.color_agenda,
    });
    return acc;
  }, {});

  return {
    rango: { desde, hasta },
    items: agendaRows.map((row) => ({
      ...row,
      tecnicos: techniciansByOrder[Number(row.id_orden_servicio)] || [],
    })),
  };
};

export const getOrderControlById = async ({ auth, idOrdenServicio }) =>
  getOrderControlByIdInternal(pool, {
    auth,
    idOrdenServicio,
    branchIds: isPrivilegedRole(auth.rol) ? [] : getAssignedBranchIds(auth),
  });

export const scheduleOrder = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      ensureOrderMutable(current.orden);

      const fechaProgramadaInicio =
        body?.fecha_programada_inicio !== undefined
          ? parseTimestamp(
              body.fecha_programada_inicio,
              "fecha_programada_inicio"
            )
          : current.orden.fecha_programada_inicio;
      const fechaProgramadaFin =
        body?.fecha_programada_fin !== undefined
          ? parseTimestamp(body.fecha_programada_fin, "fecha_programada_fin")
          : current.orden.fecha_programada_fin;

      if (!!fechaProgramadaInicio !== !!fechaProgramadaFin) {
        throw HttpError.badRequest(
          "Debes enviar fecha_programada_inicio y fecha_programada_fin juntas"
        );
      }

      if (
        fechaProgramadaInicio &&
        fechaProgramadaFin &&
        new Date(fechaProgramadaFin) <= new Date(fechaProgramadaInicio)
      ) {
        throw HttpError.badRequest(
          "fecha_programada_fin debe ser mayor a fecha_programada_inicio"
        );
      }

      const prioridad =
        body?.prioridad !== undefined
          ? normalizeState(body.prioridad)
          : current.orden.prioridad;

      if (!PRIORITY_VALUES.includes(prioridad)) {
        throw HttpError.badRequest("prioridad es invalida");
      }

      const tecnicoIds = Array.isArray(body?.tecnico_ids)
        ? body.tecnico_ids.map(Number)
        : current.tecnicos.map((item) => Number(item.id_usuario));
      const idPrincipal =
        body?.id_tecnico_principal !== undefined
          ? body.id_tecnico_principal === null || body.id_tecnico_principal === ""
            ? null
            : parseInteger(body.id_tecnico_principal, "id_tecnico_principal", {
                allowNull: true,
              })
          : current.tecnicos.find((item) => item.es_principal)?.id_usuario ||
            current.orden.id_usuario_asignado ||
            null;

      if (tecnicoIds.length > 0 && !fechaProgramadaInicio) {
        throw HttpError.badRequest(
          "Debes programar fecha y hora para asignar tecnicos"
        );
      }

      await assertTechnicianAvailability(client, {
        auth,
        technicianIds: tecnicoIds,
        idOrdenServicio,
        fechaInicio: fechaProgramadaInicio,
        fechaFin: fechaProgramadaFin,
      });

      await syncOrderTechnicians(client, {
        auth,
        scope,
        idOrdenServicio,
        technicianIds: tecnicoIds,
        idPrincipal,
        actorId: auth.id_usuario,
      });

      const agendaState = deriveAgendaState({
        estado: current.orden.estado,
        fechaProgramadaInicio,
      });
      const fechaPromesa =
        body?.fecha_promesa !== undefined
          ? parseTimestamp(body.fecha_promesa, "fecha_promesa")
          : current.orden.fecha_promesa;

      await client.query(
        `
          update ordenes_servicio
          set
            prioridad = $1,
            agenda_estado = $2,
            fecha_programada_inicio = $3,
            fecha_programada_fin = $4,
            fecha_promesa = $5,
            id_usuario_asignado = $6,
            updated_by = $7
          where id_empresa = $8
            and id_orden_servicio = $9
        `,
        [
          prioridad,
          agendaState,
          fechaProgramadaInicio,
          fechaProgramadaFin,
          fechaPromesa,
          idPrincipal,
          auth.id_usuario,
          auth.id_empresa,
          idOrdenServicio,
        ]
      );

      const updated = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.orden.modulo,
        entidad: "ORDEN_SERVICIO_AGENDA",
        entidadId: idOrdenServicio,
        accion: "UPDATE",
        antes: current,
        despues: updated,
      });

      return updated;
    },
    { auth }
  );

export const updateChecklistItem = async ({
  auth,
  scope,
  idOrdenServicio,
  idChecklistItem,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const order = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      ensureOrderMutable(order.orden);

      const checklistId = parseInteger(
        idChecklistItem,
        "id_orden_servicio_checklist"
      );
      const estado = normalizeState(body?.estado);

      if (!CHECKLIST_STATES.includes(estado)) {
        throw HttpError.badRequest("estado es invalido para checklist");
      }

      const before = order.checklist.find(
        (item) => Number(item.id_orden_servicio_checklist) === checklistId
      );

      if (!before) {
        throw HttpError.notFound("Item de checklist no encontrado");
      }

      await client.query(
        `
          update ordenes_servicio_checklist
          set
            estado = $1::varchar,
            observacion = $2,
            completado_por = $3,
            completado_en = case when $1::varchar = 'PENDIENTE' then null else now() end,
            updated_by = $3
          where id_empresa = $4
            and id_orden_servicio = $5
            and id_orden_servicio_checklist = $6
        `,
        [
          estado,
          normalizeText(body?.observacion) || null,
          auth.id_usuario,
          auth.id_empresa,
          idOrdenServicio,
          checklistId,
        ]
      );

      const updated = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: order.orden.modulo,
        entidad: "ORDEN_SERVICIO_CHECKLIST",
        entidadId: checklistId,
        accion: "UPDATE",
        antes: before,
        despues: updated.checklist.find(
          (item) => Number(item.id_orden_servicio_checklist) === checklistId
        ),
      });

      return updated;
    },
    { auth }
  );

export const cancelOrder = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      ensureOrderMutable(current.orden);

      const motivo = normalizeText(body?.motivo);

      if (!motivo) {
        throw HttpError.badRequest("motivo es requerido para anular");
      }

      const reintegrarStock =
        body?.reintegrar_stock !== undefined
          ? normalizeBoolean(body.reintegrar_stock, true)
          : current.orden.stock_reintegrado !== true;

      const chargeState = normalizeState(current.orden.estado_cobro);
      const paidStates = ["COBRADO", "PARCIAL_REEMBOLSADO"];
      let refundAmount = 0;
      let refundMethod = null;
      let refundCajaSesionId = null;

      if (paidStates.includes(chargeState)) {
        refundAmount = roundMoney(
          Math.max(0, Number(current.orden.total || 0) - Number(current.orden.reembolso_monto || 0))
        );

        if (refundAmount <= 0) {
          throw HttpError.badRequest(
            "La orden ya no tiene saldo pendiente para reembolso"
          );
        }

        refundMethod = normalizeState(
          body?.metodo_reembolso || current.orden.metodo_pago || "AJUSTE"
        );

        if (!REFUND_METHODS.includes(refundMethod)) {
          throw HttpError.badRequest(
            "metodo_reembolso invalido para la anulacion"
          );
        }

        refundCajaSesionId = await createRefundCashMovement(client, {
          auth,
          scope,
          order: current.orden,
          amount: refundAmount,
          methodLabel: refundMethod,
          actorId: auth.id_usuario,
        });
      }

      if (reintegrarStock && current.orden.stock_reintegrado !== true) {
        await restoreConsumedProducts(client, {
          auth,
          order: current.orden,
          reasonLabel: `Reversa por anulacion de orden ${current.orden.numero_orden}`,
          actorId: auth.id_usuario,
        });
      }

      const nextChargeState = paidStates.includes(chargeState)
        ? "REEMBOLSADO"
        : "ANULADA";

      await client.query(
        `
          update ordenes_servicio
          set
            estado = 'ANULADA',
            agenda_estado = 'CANCELADA',
            estado_cobro = $1,
            cancelada_por = $2,
            cancelada_en = now(),
            cancelacion_motivo = $3,
            reembolso_monto = reembolso_monto + $4,
            reembolso_metodo = coalesce($5, reembolso_metodo),
            reembolso_id_caja_sesion = coalesce($6, reembolso_id_caja_sesion),
            reembolsado_por = case when $4 > 0 then $2 else reembolsado_por end,
            fecha_reembolso = case when $4 > 0 then now() else fecha_reembolso end,
            reembolso_motivo = case when $4 > 0 then $3 else reembolso_motivo end,
            stock_reintegrado = case when $7 then true else stock_reintegrado end,
            stock_reintegrado_en = case when $7 then now() else stock_reintegrado_en end,
            stock_reintegrado_por = case when $7 then $2 else stock_reintegrado_por end,
            updated_by = $2
          where id_empresa = $8
            and id_orden_servicio = $9
        `,
        [
          nextChargeState,
          auth.id_usuario,
          motivo,
          refundAmount,
          refundMethod,
          refundCajaSesionId,
          reintegrarStock && current.orden.stock_reintegrado !== true,
          auth.id_empresa,
          idOrdenServicio,
        ]
      );

      await client.query(
        `
          update ordenes_servicio_tecnicos
          set estado_asignacion = 'CANCELADO',
              updated_by = $1
          where id_empresa = $2
            and id_orden_servicio = $3
        `,
        [auth.id_usuario, auth.id_empresa, idOrdenServicio]
      );

      await client.query(
        `
          insert into ordenes_servicio_reversiones (
            id_empresa,
            id_orden_servicio,
            tipo,
            monto,
            metodo_pago,
            motivo,
            reintegrar_stock,
            id_caja_sesion,
            id_usuario,
            created_by,
            updated_by
          )
          values ($1,$2,'ANULACION',$3,$4,$5,$6,$7,$8,$8,$8)
        `,
        [
          auth.id_empresa,
          idOrdenServicio,
          refundAmount,
          refundMethod,
          motivo,
          reintegrarStock,
          refundCajaSesionId,
          auth.id_usuario,
        ]
      );

      const updated = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.orden.modulo,
        entidad: "ORDEN_SERVICIO_ANULACION",
        entidadId: idOrdenServicio,
        accion: "CANCEL",
        antes: current,
        despues: updated,
      });

      return updated;
    },
    { auth }
  );

export const refundOrder = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      ensureOrderMutable(current.orden);

      const chargeState = normalizeState(current.orden.estado_cobro);

      if (!["COBRADO", "PARCIAL_REEMBOLSADO"].includes(chargeState)) {
        throw HttpError.badRequest(
          "Solo puedes reembolsar ordenes con cobro registrado"
        );
      }

      const motivo = normalizeText(body?.motivo);

      if (!motivo) {
        throw HttpError.badRequest("motivo es requerido para reembolso");
      }

      const availableAmount = roundMoney(
        Math.max(0, Number(current.orden.total || 0) - Number(current.orden.reembolso_monto || 0))
      );
      const refundAmount = parseMoney(body?.monto, "monto", { min: 0.01 });

      if (refundAmount > availableAmount) {
        throw HttpError.badRequest(
          `El reembolso excede el saldo disponible. Disponible: ${availableAmount}`
        );
      }

      const refundMethod = normalizeState(
        body?.metodo_reembolso || current.orden.metodo_pago || "AJUSTE"
      );

      if (!REFUND_METHODS.includes(refundMethod)) {
        throw HttpError.badRequest("metodo_reembolso es invalido");
      }

      const refundCajaSesionId = await createRefundCashMovement(client, {
        auth,
        scope,
        order: current.orden,
        amount: refundAmount,
        methodLabel: refundMethod,
        actorId: auth.id_usuario,
      });

      const totalRefunded = roundMoney(
        Number(current.orden.reembolso_monto || 0) + refundAmount
      );
      const nextChargeState =
        totalRefunded >= Number(current.orden.total || 0)
          ? "REEMBOLSADO"
          : "PARCIAL_REEMBOLSADO";

      await client.query(
        `
          update ordenes_servicio
          set
            estado_cobro = $1,
            reembolso_monto = $2,
            reembolso_metodo = $3,
            reembolso_id_caja_sesion = coalesce($4, reembolso_id_caja_sesion),
            reembolsado_por = $5,
            fecha_reembolso = now(),
            reembolso_motivo = $6,
            updated_by = $5
          where id_empresa = $7
            and id_orden_servicio = $8
        `,
        [
          nextChargeState,
          totalRefunded,
          refundMethod,
          refundCajaSesionId,
          auth.id_usuario,
          motivo,
          auth.id_empresa,
          idOrdenServicio,
        ]
      );

      await client.query(
        `
          insert into ordenes_servicio_reversiones (
            id_empresa,
            id_orden_servicio,
            tipo,
            monto,
            metodo_pago,
            motivo,
            reintegrar_stock,
            id_caja_sesion,
            id_usuario,
            created_by,
            updated_by
          )
          values ($1,$2,'REEMBOLSO',$3,$4,$5,false,$6,$7,$7,$7)
        `,
        [
          auth.id_empresa,
          idOrdenServicio,
          refundAmount,
          refundMethod,
          motivo,
          refundCajaSesionId,
          auth.id_usuario,
        ]
      );

      const updated = await getOrderControlByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.orden.modulo,
        entidad: "ORDEN_SERVICIO_REEMBOLSO",
        entidadId: idOrdenServicio,
        accion: "REFUND",
        antes: current,
        despues: updated,
      });

      return updated;
    },
    { auth }
  );

const getServiceReportSummary = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
}) => {
  const result = await pool.query(
    `
      with base as (
        select
          os.id_orden_servicio,
          upper(coalesce(os.estado, '')) as estado,
          upper(coalesce(os.estado_cobro, 'PENDIENTE')) as estado_cobro,
          upper(coalesce(os.agenda_estado, 'NO_PROGRAMADA')) as agenda_estado,
          coalesce(os.total, 0) as total,
          coalesce(os.reembolso_monto, 0) as reembolso_monto,
          case
            when os.fecha_inicio is not null
             and coalesce(os.fecha_finalizacion, os.fecha_entrega) is not null
            then extract(epoch from (coalesce(os.fecha_finalizacion, os.fecha_entrega) - os.fecha_inicio)) / 60.0
            else null
          end as duracion_minutos
        from ordenes_servicio os
        where os.id_empresa = $1
          and os.id_sucursal = any($4::bigint[])
          and upper(os.modulo) = any($5::text[])
          and os.fecha_servicio::date >= $2::date
          and os.fecha_servicio::date <= $3::date
      )
      select
        count(*)::int as ordenes_total,
        count(*) filter (where estado_cobro in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO'))::int as ordenes_cobradas,
        count(*) filter (where estado_cobro = 'PENDIENTE')::int as ordenes_pendientes_cobro,
        count(*) filter (where estado = 'ANULADA')::int as ordenes_anuladas,
        count(*) filter (where agenda_estado = 'PROGRAMADA')::int as ordenes_programadas,
        count(*) filter (where agenda_estado = 'EN_EJECUCION')::int as ordenes_en_ejecucion,
        count(*) filter (where agenda_estado = 'FINALIZADA')::int as ordenes_finalizadas,
        coalesce(sum(case when estado_cobro in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO') then total else 0 end), 0) as total_facturado,
        coalesce(sum(reembolso_monto), 0) as reembolsos_total,
        coalesce(avg(case when estado <> 'ANULADA' then total end), 0) as ticket_promedio,
        coalesce(avg(duracion_minutos), 0) as duracion_promedio_minutos
      from base
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues]
  );

  return mapNumericFields(
    result.rows[0] || {},
    ["total_facturado", "reembolsos_total", "ticket_promedio", "duracion_promedio_minutos"],
    [
      "ordenes_total",
      "ordenes_cobradas",
      "ordenes_pendientes_cobro",
      "ordenes_anuladas",
      "ordenes_programadas",
      "ordenes_en_ejecucion",
      "ordenes_finalizadas",
    ]
  );
};

const getServiceOrdersByDay = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
  timezone,
}) => {
  const result = await pool.query(
    `
      with dias as (
        select generate_series($2::date, $3::date, interval '1 day')::date as fecha
      ),
      ordenes_diarias as (
        select
          date(timezone($6, os.fecha_servicio)) as fecha,
          count(*)::int as ordenes_total,
          count(*) filter (where upper(coalesce(os.estado, '')) = 'ANULADA')::int as anuladas,
          coalesce(sum(case when upper(coalesce(os.estado_cobro, 'PENDIENTE')) in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO') then os.total else 0 end), 0) as total_facturado,
          coalesce(sum(coalesce(os.reembolso_monto, 0)), 0) as reembolsos_total
        from ordenes_servicio os
        where os.id_empresa = $1
          and os.id_sucursal = any($4::bigint[])
          and upper(os.modulo) = any($5::text[])
          and os.fecha_servicio::date >= $2::date
          and os.fecha_servicio::date <= $3::date
        group by date(timezone($6, os.fecha_servicio))
      )
      select
        to_char(d.fecha, 'YYYY-MM-DD') as fecha,
        coalesce(od.ordenes_total, 0)::int as ordenes_total,
        coalesce(od.anuladas, 0)::int as anuladas,
        coalesce(od.total_facturado, 0) as total_facturado,
        coalesce(od.reembolsos_total, 0) as reembolsos_total
      from dias d
      left join ordenes_diarias od
        on od.fecha = d.fecha
      order by d.fecha asc
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues, timezone]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_facturado", "reembolsos_total"],
      ["ordenes_total", "anuladas"]
    )
  );
};

const getServiceTopCatalog = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
  limit,
}) => {
  const result = await pool.query(
    `
      select
        sc.id_servicio_catalogo,
        upper(sc.modulo) as modulo,
        sc.codigo,
        sc.nombre as servicio_nombre,
        count(*)::int as ordenes_total,
        count(*) filter (where upper(coalesce(os.estado, '')) = 'ANULADA')::int as anuladas,
        coalesce(sum(case when upper(coalesce(os.estado_cobro, 'PENDIENTE')) in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO') then os.total else 0 end), 0) as total_facturado,
        coalesce(avg(case when upper(coalesce(os.estado, '')) <> 'ANULADA' then os.total end), 0) as ticket_promedio
      from ordenes_servicio os
      inner join servicios_catalogo sc
        on sc.id_empresa = os.id_empresa
       and sc.id_servicio_catalogo = os.id_servicio_catalogo
      where os.id_empresa = $1
        and os.id_sucursal = any($4::bigint[])
        and upper(os.modulo) = any($5::text[])
        and os.fecha_servicio::date >= $2::date
        and os.fecha_servicio::date <= $3::date
      group by sc.id_servicio_catalogo, sc.modulo, sc.codigo, sc.nombre
      order by total_facturado desc, ordenes_total desc, sc.nombre asc
      limit $6
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues, limit]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_facturado", "ticket_promedio"],
      ["ordenes_total", "anuladas"]
    )
  );
};

const getServiceTopTechnicians = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
  limit,
}) => {
  const result = await pool.query(
    `
      select
        u.id_usuario,
        u.username,
        concat(u.nombre, ' ', u.apellido) as nombre,
        st.alias,
        count(distinct os.id_orden_servicio)::int as ordenes_asignadas,
        count(distinct os.id_orden_servicio) filter (where upper(coalesce(os.estado, '')) in ('LISTO', 'ENTREGADO'))::int as ordenes_finalizadas,
        count(distinct os.id_orden_servicio) filter (where upper(coalesce(os.estado, '')) = 'ANULADA')::int as ordenes_anuladas,
        coalesce(sum(case when upper(coalesce(os.estado_cobro, 'PENDIENTE')) in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO') then os.total else 0 end), 0) as total_facturado
      from ordenes_servicio_tecnicos ost
      inner join ordenes_servicio os
        on os.id_empresa = ost.id_empresa
       and os.id_orden_servicio = ost.id_orden_servicio
      inner join usuarios u
        on u.id_empresa = ost.id_empresa
       and u.id_usuario = ost.id_usuario
      left join servicios_tecnicos st
        on st.id_empresa = ost.id_empresa
       and st.id_usuario = ost.id_usuario
      where ost.id_empresa = $1
        and ost.es_principal = true
        and os.id_sucursal = any($4::bigint[])
        and upper(os.modulo) = any($5::text[])
        and os.fecha_servicio::date >= $2::date
        and os.fecha_servicio::date <= $3::date
      group by u.id_usuario, u.username, u.nombre, u.apellido, st.alias
      order by total_facturado desc, ordenes_asignadas desc, nombre asc
      limit $6
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues, limit]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_facturado"],
      ["ordenes_asignadas", "ordenes_finalizadas", "ordenes_anuladas"]
    )
  );
};

const getServiceStatusBreakdown = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
}) => {
  const result = await pool.query(
    `
      select
        upper(coalesce(os.estado, 'SIN_ESTADO')) as estado,
        count(*)::int as cantidad,
        coalesce(sum(os.total), 0) as total
      from ordenes_servicio os
      where os.id_empresa = $1
        and os.id_sucursal = any($4::bigint[])
        and upper(os.modulo) = any($5::text[])
        and os.fecha_servicio::date >= $2::date
        and os.fecha_servicio::date <= $3::date
      group by upper(coalesce(os.estado, 'SIN_ESTADO'))
      order by cantidad desc, estado asc
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["total"], ["cantidad"])
  );
};

const getServiceAgendaBreakdown = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
}) => {
  const result = await pool.query(
    `
      select
        upper(coalesce(os.agenda_estado, 'NO_PROGRAMADA')) as agenda_estado,
        count(*)::int as cantidad
      from ordenes_servicio os
      where os.id_empresa = $1
        and os.id_sucursal = any($4::bigint[])
        and upper(os.modulo) = any($5::text[])
        and os.fecha_servicio::date >= $2::date
        and os.fecha_servicio::date <= $3::date
      group by upper(coalesce(os.agenda_estado, 'NO_PROGRAMADA'))
      order by cantidad desc, agenda_estado asc
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, [], ["cantidad"])
  );
};

const getServiceBranchSummary = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
}) => {
  const result = await pool.query(
    `
      select
        s.id_sucursal,
        s.codigo,
        s.nombre,
        count(os.id_orden_servicio)::int as ordenes_total,
        count(os.id_orden_servicio) filter (where upper(coalesce(os.estado, '')) = 'ANULADA')::int as ordenes_anuladas,
        count(os.id_orden_servicio) filter (where upper(coalesce(os.agenda_estado, '')) = 'PROGRAMADA')::int as ordenes_programadas,
        coalesce(sum(case when upper(coalesce(os.estado_cobro, 'PENDIENTE')) in ('COBRADO', 'PARCIAL_REEMBOLSADO', 'REEMBOLSADO') then os.total else 0 end), 0) as total_facturado,
        coalesce(sum(coalesce(os.reembolso_monto, 0)), 0) as reembolsos_total
      from sucursales s
      left join ordenes_servicio os
        on os.id_empresa = s.id_empresa
       and os.id_sucursal = s.id_sucursal
       and upper(os.modulo) = any($5::text[])
       and os.fecha_servicio::date >= $2::date
       and os.fecha_servicio::date <= $3::date
      where s.id_empresa = $1
        and s.id_sucursal = any($4::bigint[])
      group by s.id_sucursal, s.codigo, s.nombre
      order by total_facturado desc, s.nombre asc
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues]
  );

  return result.rows.map((row) =>
    mapNumericFields(
      row,
      ["total_facturado", "reembolsos_total"],
      ["ordenes_total", "ordenes_anuladas", "ordenes_programadas"]
    )
  );
};

const getServiceRecentReversions = async ({
  idEmpresa,
  desde,
  hasta,
  branchIds,
  moduleValues,
  limit,
}) => {
  const result = await pool.query(
    `
      select
        osr.id_orden_servicio_reversion,
        upper(osr.tipo) as tipo,
        osr.monto,
        upper(coalesce(osr.metodo_pago, '')) as metodo_pago,
        osr.motivo,
        osr.reintegrar_stock,
        osr.created_at,
        os.numero_orden,
        upper(os.modulo) as modulo,
        s.codigo as sucursal_codigo,
        s.nombre as sucursal_nombre,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from ordenes_servicio_reversiones osr
      inner join ordenes_servicio os
        on os.id_empresa = osr.id_empresa
       and os.id_orden_servicio = osr.id_orden_servicio
      inner join sucursales s
        on s.id_empresa = os.id_empresa
       and s.id_sucursal = os.id_sucursal
      inner join usuarios u
        on u.id_empresa = osr.id_empresa
       and u.id_usuario = osr.id_usuario
      where osr.id_empresa = $1
        and os.id_sucursal = any($4::bigint[])
        and upper(os.modulo) = any($5::text[])
        and osr.created_at::date >= $2::date
        and osr.created_at::date <= $3::date
      order by osr.created_at desc, osr.id_orden_servicio_reversion desc
      limit $6
    `,
    [idEmpresa, desde, hasta, branchIds, moduleValues, limit]
  );

  return result.rows.map((row) =>
    mapNumericFields(row, ["monto"], [])
  );
};

export const getServiceOperationsReport = async ({ auth, scope, query }) => {
  const { desde, hasta } = getDateRange(query, { defaultDays: 14 });
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

  const { requestedModule, accessibleModules } = resolveRequestedModule(
    auth,
    query?.modulo
  );
  const moduleValues = requestedModule ? [requestedModule] : accessibleModules;
  const topLimit = getPositiveInteger(query?.top, DEFAULT_TOP_LIMIT, {
    min: 3,
    max: 20,
  });
  const eventLimit = getPositiveInteger(query?.eventos, DEFAULT_EVENT_LIMIT, {
    min: 3,
    max: 30,
  });

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
    moduleValues,
    timezone: company.timezone || "America/Guatemala",
  };

  const [
    resumen,
    ordenesPorDia,
    topServicios,
    topTecnicos,
    estados,
    agendaResumen,
    sucursalesResumen,
    reversionesRecientes,
  ] = await Promise.all([
    getServiceReportSummary(context),
    getServiceOrdersByDay(context),
    getServiceTopCatalog({ ...context, limit: topLimit }),
    getServiceTopTechnicians({ ...context, limit: topLimit }),
    getServiceStatusBreakdown(context),
    getServiceAgendaBreakdown(context),
    getServiceBranchSummary(context),
    getServiceRecentReversions({ ...context, limit: eventLimit }),
  ]);

  return {
    empresa: {
      id_empresa: Number(company.id_empresa),
      nombre_legal: company.nombre_legal,
      timezone: company.timezone || "America/Guatemala",
    },
    rango: { desde, hasta },
    modulo: requestedModule || "MULTIPLE",
    modulos_considerados: moduleValues,
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
    ordenes_por_dia: ordenesPorDia,
    top_servicios: topServicios,
    top_tecnicos: topTecnicos,
    estados,
    agenda_resumen: agendaResumen,
    sucursales_resumen: sucursalesResumen,
    reversiones_recientes: reversionesRecientes,
  };
};
