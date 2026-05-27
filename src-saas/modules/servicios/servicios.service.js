import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { emitirComprobante } from "../../shared/comprobantes/comprobante-series.js";
import { ordenesServicioCreadas } from "../../shared/metrics/registry.js";
import { computeAndPersistCommission } from "../comisiones/comisiones.service.js";
import {
  consumeMembresia,
  findActiveCoverage,
} from "../membresias/membresias.service.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";
import { HttpError } from "../../shared/http/http-error.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);
const OPERATIONAL_MODULES = ["SERVICIOS", "CARWASH"];
const ORDER_STATES = ["RECIBIDO", "EN_PROCESO", "LISTO", "ENTREGADO", "ANULADA"];
const CHARGE_METHODS = ["EFECTIVO", "TARJETA", "TRANSFERENCIA", "CORTESIA"];
const CHARGE_STATES = [
  "PENDIENTE",
  "COBRADO",
  "PARCIAL_REEMBOLSADO",
  "REEMBOLSADO",
  "ANULADA",
];

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const roundQuantity = (value) => Number(Number(value || 0).toFixed(3));
const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeModule = (value) => String(value || "").trim().toUpperCase();
const normalizeState = (value) => String(value || "").trim().toUpperCase();
const normalizeSearch = (value) => String(value || "").trim();
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

const isPrivilegedRole = (role) => PRIVILEGED_ROLES.has(normalizeRole(role));

const parseTimestamp = (value, fieldName) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw HttpError.badRequest(`${fieldName} tiene un formato invalido`);
  }

  return parsed.toISOString();
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

const parseQuantity = (value, fieldName) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw HttpError.badRequest(`${fieldName} es invalida`);
  }

  return roundQuantity(parsed);
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

const mapPgError = (error) => {
  if (error?.code === "23505") {
    const constraint = String(error.constraint || "");

    if (constraint.includes("servicios_catalogo")) {
      throw HttpError.conflict("Ya existe un servicio con ese codigo en la empresa");
    }

    if (constraint.includes("uq_ordenes_servicio_empresa_numero")) {
      throw HttpError.conflict("Se genero un numero de orden duplicado");
    }
  }

  throw error;
};

const normalizeCatalogRow = (row) => ({
  ...row,
  precio_base: roundMoney(row.precio_base),
  duracion_minutos:
    row.duracion_minutos != null ? Number(row.duracion_minutos) : null,
  activo: row.activo !== false,
});

const normalizeOrderRow = (row) => ({
  ...row,
  subtotal: roundMoney(row.subtotal),
  precio_servicio: roundMoney(row.precio_servicio),
  productos_total: roundMoney(row.productos_total),
  total: roundMoney(row.total),
  monto_recibido:
    row.monto_recibido != null ? roundMoney(row.monto_recibido) : null,
  cambio: roundMoney(row.cambio),
  anio: row.anio != null ? Number(row.anio) : null,
  duracion_minutos:
    row.duracion_minutos != null ? Number(row.duracion_minutos) : null,
});

const normalizeOrderProductRow = (row) => ({
  ...row,
  cantidad: roundQuantity(row.cantidad),
  costo_unitario: roundMoney(row.costo_unitario),
  precio_unitario: roundMoney(row.precio_unitario),
  subtotal: roundMoney(row.subtotal),
  cobra_al_cliente: row.cobra_al_cliente !== false,
});

const getCatalogBaseSelect = () => `
  select
    sc.id_servicio_catalogo,
    sc.id_empresa,
    upper(sc.modulo) as modulo,
    sc.codigo,
    sc.nombre,
    sc.descripcion,
    sc.precio_base,
    sc.duracion_minutos,
    sc.activo,
    sc.created_at,
    sc.updated_at
  from servicios_catalogo sc
`;

const getOrderBaseSelect = () => `
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
    os.codigo_publico,
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
    os.subtotal,
    os.precio_servicio,
    coalesce(prod.productos_total, 0) as productos_total,
    os.total,
    os.monto_recibido,
    os.cambio,
    os.nombre_contacto,
    os.telefono_contacto,
    os.observaciones,
    os.fecha_servicio,
    os.fecha_inicio,
    os.fecha_finalizacion,
    os.fecha_entrega,
    os.fecha_cobro,
    os.tipo_comprobante_fiscal,
    os.numero_comprobante_fiscal,
    os.id_comprobante_serie_fiscal,
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

const getCatalogItemByIdInternal = async (db, { auth, idServicioCatalogo }) => {
  const { accessibleModules } = resolveRequestedModule(auth, null);
  const moduleFilter = buildArrayFilter("sc", "modulo", accessibleModules, 3);
  const result = await db.query(
    `
      ${getCatalogBaseSelect()}
      where sc.id_empresa = $1
        and sc.id_servicio_catalogo = $2
        ${moduleFilter.clause}
      limit 1
    `,
    [auth.id_empresa, idServicioCatalogo, ...moduleFilter.params]
  );

  const row = result.rows[0];
  return row ? normalizeCatalogRow(row) : null;
};

const ensureCatalogItem = async (db, { auth, idServicioCatalogo }) => {
  const item = await getCatalogItemByIdInternal(db, { auth, idServicioCatalogo });

  if (!item) {
    throw HttpError.notFound("Servicio no encontrado");
  }

  if (item.activo !== true) {
    throw HttpError.badRequest("El servicio seleccionado no esta activo");
  }

  return item;
};

const ensureClient = async (db, { auth, idCliente }) => {
  if (!idCliente) {
    return null;
  }

  const result = await db.query(
    `
      select id_cliente, nombre, telefono
      from clientes
      where id_empresa = $1
        and id_cliente = $2
        and activo = true
      limit 1
    `,
    [auth.id_empresa, idCliente]
  );

  const row = result.rows[0];

  if (!row) {
    throw HttpError.badRequest("El cliente no pertenece a la empresa activa");
  }

  return row;
};

const ensureAssignableUser = async (db, { auth, scope, idUsuarioAsignado }) => {
  if (!idUsuarioAsignado) {
    return null;
  }

  const result = await db.query(
    `
      select
        u.id_usuario,
        u.username,
        u.nombre,
        u.apellido
      from usuarios u
      inner join usuarios_sucursales us
        on us.id_empresa = u.id_empresa
       and us.id_usuario = u.id_usuario
      where u.id_empresa = $1
        and u.id_usuario = $2
        and u.activo = true
        and us.id_sucursal = $3
      limit 1
    `,
    [auth.id_empresa, idUsuarioAsignado, scope.id_sucursal]
  );

  const row = result.rows[0];

  if (!row) {
    throw HttpError.badRequest(
      "El usuario asignado no esta activo o no pertenece a la sucursal seleccionada"
    );
  }

  return row;
};

/**
 * Emite el numero de orden de servicio delegando en el helper compartido.
 * Internamente usa el modulo del servicio (SERVICIOS o CARWASH) con
 * tipo_comprobante = 'ORDEN_SERVICIO'.
 */
const getNextOrderNumber = async (
  client,
  { idEmpresa, idSucursal, modulo, actorId = null }
) => {
  const result = await emitirComprobante(client, {
    idEmpresa,
    idSucursal,
    modulo: normalizeModule(modulo),
    tipoComprobante: "ORDEN_SERVICIO",
    actorId,
  });

  return result.numero_comprobante;
};

const getCajaSesionActivaForCharge = async (db, { auth, scope }) => {
  const result = await db.query(
    `
      select id_caja_sesion, estado, fecha_apertura
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

  return result.rows[0] || null;
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

const assertOrderIsMutable = (order, { allowCharged = false } = {}) => {
  if (normalizeState(order.estado) === "ANULADA") {
    throw HttpError.badRequest("La orden esta anulada");
  }

  if (
    !allowCharged &&
    normalizeState(order.estado_cobro) !== "PENDIENTE"
  ) {
    throw HttpError.badRequest(
      "La orden ya tiene un cobro o reversion registrado"
    );
  }
};

const deriveAgendaStateFromOrderState = (orderState, scheduledStart) => {
  const normalizedState = normalizeState(orderState);

  if (normalizedState === "ANULADA") {
    return "CANCELADA";
  }

  if (normalizedState === "EN_PROCESO") {
    return "EN_EJECUCION";
  }

  if (["LISTO", "ENTREGADO"].includes(normalizedState)) {
    return "FINALIZADA";
  }

  if (scheduledStart) {
    return "PROGRAMADA";
  }

  return "NO_PROGRAMADA";
};

const recalculateOrderTotals = async (
  db,
  { idEmpresa, idOrdenServicio, actorId = null }
) => {
  const result = await db.query(
    `
      with totales as (
        select
          coalesce(sum(case when cobra_al_cliente then subtotal else 0 end), 0) as productos_total
        from ordenes_servicio_productos
        where id_empresa = $1
          and id_orden_servicio = $2
      )
      update ordenes_servicio os
      set
        subtotal = round(coalesce(os.precio_servicio, 0)::numeric, 2),
        total = round((coalesce(os.precio_servicio, 0) + coalesce(t.productos_total, 0))::numeric, 2),
        updated_by = coalesce($3, os.updated_by)
      from totales t
      where os.id_empresa = $1
        and os.id_orden_servicio = $2
      returning
        os.subtotal,
        os.precio_servicio,
        os.total,
        coalesce(t.productos_total, 0) as productos_total
    `,
    [idEmpresa, idOrdenServicio, actorId]
  );

  const row = result.rows[0] || {};

  return {
    subtotal: roundMoney(row.subtotal),
    precio_servicio: roundMoney(row.precio_servicio),
    productos_total: roundMoney(row.productos_total),
    total: roundMoney(row.total),
  };
};

const seedOrderChecklistFromTemplates = async (
  db,
  { auth, idOrdenServicio, idServicioCatalogo, actorId }
) => {
  await db.query(
    `
      insert into ordenes_servicio_checklist (
        id_empresa,
        id_orden_servicio,
        id_servicio_checklist_template,
        titulo,
        instrucciones,
        orden,
        obligatorio,
        estado,
        created_by,
        updated_by
      )
      select
        sct.id_empresa,
        $2,
        sct.id_servicio_checklist_template,
        sct.titulo,
        sct.instrucciones,
        sct.orden,
        sct.obligatorio,
        'PENDIENTE',
        $3,
        $3
      from servicios_checklist_templates sct
      where sct.id_empresa = $1
        and sct.id_servicio_catalogo = $4
        and sct.activo = true
      order by sct.orden asc, sct.id_servicio_checklist_template asc
    `,
    [auth.id_empresa, idOrdenServicio, actorId, idServicioCatalogo]
  );
};

export const listCatalog = async ({ auth, query }) => {
  const { requestedModule, accessibleModules } = resolveRequestedModule(
    auth,
    query?.modulo
  );

  const filters = ["sc.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

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
    filters.push(`sc.activo = $${index}`);
    params.push(query.activo === "true");
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(sc.codigo ilike $${index} or sc.nombre ilike $${index} or coalesce(sc.descripcion, '') ilike $${index})`
    );
    params.push(`%${normalizeSearch(query.search)}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 50, 100));
  params.push(limit);

  const result = await pool.query(
    `
      ${getCatalogBaseSelect()}
      where ${filters.join(" and ")}
      order by upper(sc.modulo) asc, sc.activo desc, sc.nombre asc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeCatalogRow);
};

export const createCatalogItem = async ({
  auth,
  body,
  scope,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const { requestedModule } = resolveRequestedModule(auth, body?.modulo);
      const codigo = normalizeSearch(body?.codigo).toUpperCase();
      const nombre = normalizeSearch(body?.nombre);

      if (!requestedModule || !codigo || !nombre) {
        throw HttpError.badRequest("modulo, codigo y nombre son requeridos");
      }

      const precioBase = parseMoney(body?.precio_base ?? 0, "precio_base");
      const duracionMinutos =
        body?.duracion_minutos !== undefined &&
        body?.duracion_minutos !== null &&
        body?.duracion_minutos !== ""
          ? parseInteger(body.duracion_minutos, "duracion_minutos", {
              min: 1,
            })
          : null;

      try {
        const insertResult = await client.query(
          `
            insert into servicios_catalogo (
              id_empresa,
              modulo,
              codigo,
              nombre,
              descripcion,
              precio_base,
              duracion_minutos,
              activo,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
            returning id_servicio_catalogo
          `,
          [
            auth.id_empresa,
            requestedModule,
            codigo,
            nombre,
            normalizeSearch(body?.descripcion) || null,
            precioBase,
            duracionMinutos,
            body?.activo !== undefined ? normalizeBoolean(body.activo, true) : true,
            auth.id_usuario,
          ]
        );

        const created = await getCatalogItemByIdInternal(client, {
          auth,
          idServicioCatalogo: insertResult.rows[0].id_servicio_catalogo,
        });

        await writeAuditEvent(client, {
          auth,
          scope,
          requestMeta,
          modulo: requestedModule,
          entidad: "SERVICIO_CATALOGO",
          entidadId: created.id_servicio_catalogo,
          accion: "CREATE",
          despues: created,
        });

        return created;
      } catch (error) {
        mapPgError(error);
      }
    },
    { auth }
  );

export const updateCatalogItem = async ({
  auth,
  idServicioCatalogo,
  body,
  scope,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getCatalogItemByIdInternal(client, {
        auth,
        idServicioCatalogo,
      });

      if (!current) {
        throw HttpError.notFound("Servicio no encontrado");
      }

      const nextModule =
        body?.modulo !== undefined
          ? resolveRequestedModule(auth, body.modulo).requestedModule
          : current.modulo;
      const codigo =
        body?.codigo !== undefined
          ? normalizeSearch(body.codigo).toUpperCase()
          : current.codigo;
      const nombre =
        body?.nombre !== undefined ? normalizeSearch(body.nombre) : current.nombre;

      if (!nextModule || !codigo || !nombre) {
        throw HttpError.badRequest("modulo, codigo y nombre son requeridos");
      }

      const precioBase =
        body?.precio_base !== undefined
          ? parseMoney(body.precio_base, "precio_base")
          : roundMoney(current.precio_base);
      const duracionMinutos =
        body?.duracion_minutos !== undefined
          ? body.duracion_minutos === null || body.duracion_minutos === ""
            ? null
            : parseInteger(body.duracion_minutos, "duracion_minutos", {
                min: 1,
              })
          : current.duracion_minutos;
      const activo =
        body?.activo !== undefined
          ? normalizeBoolean(body.activo, true)
          : current.activo;

      try {
        await client.query(
          `
            update servicios_catalogo
            set
              modulo = $1,
              codigo = $2,
              nombre = $3,
              descripcion = $4,
              precio_base = $5,
              duracion_minutos = $6,
              activo = $7,
              updated_by = $8
            where id_empresa = $9
              and id_servicio_catalogo = $10
          `,
          [
            nextModule,
            codigo,
            nombre,
            body?.descripcion !== undefined
              ? normalizeSearch(body.descripcion) || null
              : current.descripcion,
            precioBase,
            duracionMinutos,
            activo,
            auth.id_usuario,
            auth.id_empresa,
            idServicioCatalogo,
          ]
        );
      } catch (error) {
        mapPgError(error);
      }

      const updated = await getCatalogItemByIdInternal(client, {
        auth,
        idServicioCatalogo,
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: nextModule,
        entidad: "SERVICIO_CATALOGO",
        entidadId: idServicioCatalogo,
        accion: "UPDATE",
        antes: current,
        despues: updated,
      });

      return updated;
    },
    { auth }
  );

const getOrderByIdInternal = async (
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
  const params = [
    auth.id_empresa,
    idOrdenServicio,
    ...branchFilter.params,
    ...moduleFilter.params,
  ];

  const result = await db.query(
    `
      ${getOrderBaseSelect()}
      where os.id_empresa = $1
        and os.id_orden_servicio = $2
        ${branchFilter.clause}
        ${moduleFilter.clause}
      limit 1
      ${forUpdate ? "for update of os" : ""}
    `,
    params
  );

  return result.rows[0] ? normalizeOrderRow(result.rows[0]) : null;
};

const getOrderDetail = async (db, { auth, idOrdenServicio, branchIds = [] }) => {
  const order = await getOrderByIdInternal(db, {
    auth,
    idOrdenServicio,
    branchIds,
  });

  if (!order) {
    throw HttpError.notFound("Orden de servicio no encontrada");
  }

  const detailsResult = await db.query(
    `
      select
        osp.id_orden_servicio_producto,
        osp.id_orden_servicio,
        osp.id_producto,
        osp.cantidad,
        osp.costo_unitario,
        osp.precio_unitario,
        osp.subtotal,
        osp.cobra_al_cliente,
        osp.observacion,
        osp.created_at,
        p.sku,
        p.codigo_barras,
        p.nombre as producto_nombre
      from ordenes_servicio_productos osp
      inner join productos p
        on p.id_empresa = osp.id_empresa
       and p.id_producto = osp.id_producto
      where osp.id_empresa = $1
        and osp.id_orden_servicio = $2
      order by osp.created_at asc, osp.id_orden_servicio_producto asc
    `,
    [auth.id_empresa, idOrdenServicio]
  );

  return {
    orden: order,
    productos: detailsResult.rows.map(normalizeOrderProductRow),
  };
};

const consumeProductOnOrder = async (
  db,
  { auth, order, payload, referenceLabel }
) => {
  assertOrderIsMutable(order);

  const idProducto = parseInteger(payload?.id_producto, "id_producto");
  const cantidad = parseQuantity(payload?.cantidad, "cantidad");
  const cobraAlCliente = normalizeBoolean(payload?.cobra_al_cliente, true);
  const observacion = normalizeSearch(payload?.observacion) || null;
  const idBodega = await getDefaultWarehouseId(db, {
    auth,
    idSucursal: order.id_sucursal,
  });

  const productResult = await db.query(
    `
      select
        p.id_producto,
        p.nombre,
        p.sku,
        p.precio_compra,
        p.precio_venta,
        ss.stock_actual
      from productos p
      inner join stock_sucursal ss
        on ss.id_empresa = p.id_empresa
       and ss.id_producto = p.id_producto
       and ss.id_sucursal = $3
       and ss.id_bodega = $4
      where p.id_empresa = $1
        and p.id_producto = $2
        and p.activo = true
      limit 1
      for update of ss
    `,
    [auth.id_empresa, idProducto, order.id_sucursal, idBodega]
  );

  const product = productResult.rows[0];

  if (!product) {
    throw HttpError.badRequest(
      "El producto indicado no existe o no esta disponible en la sucursal de la orden"
    );
  }

  const stockBefore = Number(product.stock_actual || 0);

  if (stockBefore < cantidad) {
    throw HttpError.badRequest(
      `Stock insuficiente para ${product.nombre}. Disponible: ${stockBefore}`
    );
  }

  const stockAfter = roundQuantity(stockBefore - cantidad);
  const costoUnitario =
    payload?.costo_unitario !== undefined && payload?.costo_unitario !== null
      ? parseMoney(payload.costo_unitario, "costo_unitario")
      : roundMoney(product.precio_compra);
  const precioUnitario =
    payload?.precio_unitario !== undefined && payload?.precio_unitario !== null
      ? parseMoney(payload.precio_unitario, "precio_unitario")
      : roundMoney(product.precio_venta);
  const subtotal = cobraAlCliente ? roundMoney(precioUnitario * cantidad) : 0;

  await db.query(
    `
      insert into ordenes_servicio_productos (
        id_empresa,
        id_orden_servicio,
        id_producto,
        cantidad,
        costo_unitario,
        precio_unitario,
        subtotal,
        cobra_al_cliente,
        observacion,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
    `,
    [
      auth.id_empresa,
      order.id_orden_servicio,
      idProducto,
      cantidad,
      costoUnitario,
      precioUnitario,
      subtotal,
      cobraAlCliente,
      observacion,
      auth.id_usuario,
    ]
  );

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
      auth.id_usuario,
      auth.id_empresa,
      order.id_sucursal,
      idBodega,
      idProducto,
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
      values ($1,$2,$3,$4,$5,'SALIDA','ORDEN_SERVICIO',$6,$7,$8,$9,$10,$5,$5)
    `,
    [
      auth.id_empresa,
      order.id_sucursal,
      idBodega,
      idProducto,
      auth.id_usuario,
      order.id_orden_servicio,
      cantidad,
      stockBefore,
      stockAfter,
      `${referenceLabel}: ${product.nombre}`,
    ]
  );

  await recalculateOrderTotals(db, {
    idEmpresa: auth.id_empresa,
    idOrdenServicio: order.id_orden_servicio,
    actorId: auth.id_usuario,
  });
};

export const listOrders = async ({ auth, scope, query }) => {
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

  if (query?.estado) {
    const estado = normalizeState(query.estado);
    if (!ORDER_STATES.includes(estado)) {
      throw HttpError.badRequest("estado es invalido");
    }

    filters.push(`upper(os.estado) = $${index}`);
    params.push(estado);
    index += 1;
  }

  if (query?.estado_cobro) {
    const estadoCobro = normalizeState(query.estado_cobro);
    if (!CHARGE_STATES.includes(estadoCobro)) {
      throw HttpError.badRequest("estado_cobro es invalido");
    }

    filters.push(`upper(coalesce(os.estado_cobro, 'PENDIENTE')) = $${index}`);
    params.push(estadoCobro);
    index += 1;
  }

  if (query?.id_usuario_asignado) {
    filters.push(`os.id_usuario_asignado = $${index}`);
    params.push(parseInteger(query.id_usuario_asignado, "id_usuario_asignado"));
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(coalesce(os.numero_orden, '') ilike $${index} or coalesce(os.placa, '') ilike $${index} or coalesce(os.nombre_contacto, '') ilike $${index} or coalesce(c.nombre, '') ilike $${index} or coalesce(sc.nombre, '') ilike $${index})`
    );
    params.push(`%${normalizeSearch(query.search)}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 30, 100));
  params.push(limit);

  const result = await pool.query(
    `
      ${getOrderBaseSelect()}
      where ${filters.join(" and ")}
      order by os.fecha_servicio desc, os.id_orden_servicio desc
      limit $${index}
    `,
    params
  );

  return result.rows.map(normalizeOrderRow);
};

export const createOrder = async ({
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
      const serviceCatalog = await ensureCatalogItem(client, {
        auth,
        idServicioCatalogo,
      });

      const orderState =
        body?.estado !== undefined ? normalizeState(body.estado) : "RECIBIDO";

      if (!ORDER_STATES.includes(orderState) || orderState === "ANULADA") {
        throw HttpError.badRequest("estado inicial invalido");
      }

      const idCliente =
        body?.id_cliente !== undefined && body?.id_cliente !== null && body?.id_cliente !== ""
          ? parseInteger(body.id_cliente, "id_cliente", { allowNull: true })
          : null;
      await ensureClient(client, { auth, idCliente });

      const idUsuarioAsignado =
        body?.id_usuario_asignado !== undefined &&
        body?.id_usuario_asignado !== null &&
        body?.id_usuario_asignado !== ""
          ? parseInteger(body.id_usuario_asignado, "id_usuario_asignado", {
              allowNull: true,
            })
          : null;
      await ensureAssignableUser(client, {
        auth,
        scope,
        idUsuarioAsignado,
      });

      const precioServicio =
        body?.precio_servicio !== undefined
          ? parseMoney(body.precio_servicio, "precio_servicio")
          : roundMoney(serviceCatalog.precio_base);
      const fechaServicio = parseTimestamp(body?.fecha_servicio, "fecha_servicio");
      const numeroOrden = await getNextOrderNumber(client, {
        idEmpresa: auth.id_empresa,
        idSucursal: scope.id_sucursal,
        modulo: serviceCatalog.modulo,
        actorId: auth.id_usuario,
      });

      try {
        const insertResult = await client.query(
          `
            insert into ordenes_servicio (
              id_empresa,
              id_sucursal,
              id_servicio_catalogo,
              id_cliente,
              id_usuario,
              id_usuario_asignado,
              modulo,
              numero_orden,
              codigo_publico,
              placa,
              vehiculo_tipo,
              color,
              marca,
              modelo,
              anio,
              kilometraje,
              estado,
              estado_cobro,
              subtotal,
              precio_servicio,
              total,
              nombre_contacto,
              telefono_contacto,
              observaciones,
              fecha_servicio,
              fecha_inicio,
              created_by,
              updated_by
            )
            values (
              $1,$2,$3,$4,$5,$6,$7,$8,
              encode(gen_random_bytes(16), 'hex'),
              $9,$10,$11,$12,$13,$14,$15,$16,'PENDIENTE',$17,$17,$17,$18,$19,$20,coalesce($21::timestamptz, now()),$22,$5,$5
            )
            returning id_orden_servicio
          `,
          [
            auth.id_empresa,
            scope.id_sucursal,
            idServicioCatalogo,
            idCliente,
            auth.id_usuario,
            idUsuarioAsignado,
            serviceCatalog.modulo,
            numeroOrden,
            normalizeSearch(body?.placa) || null,
            normalizeSearch(body?.vehiculo_tipo) || null,
            normalizeSearch(body?.color) || null,
            normalizeSearch(body?.marca) || null,
            normalizeSearch(body?.modelo) || null,
            body?.anio !== undefined && body?.anio !== null && body?.anio !== ""
              ? parseInteger(body.anio, "anio", { min: 1900 })
              : null,
            normalizeSearch(body?.kilometraje) || null,
            orderState,
            precioServicio,
            normalizeSearch(body?.nombre_contacto) || null,
            normalizeSearch(body?.telefono_contacto) || null,
            normalizeSearch(body?.observaciones) || null,
            fechaServicio,
            orderState === "EN_PROCESO" ? new Date().toISOString() : null,
          ]
        );

        const idOrdenServicio = insertResult.rows[0].id_orden_servicio;
        await seedOrderChecklistFromTemplates(client, {
          auth,
          idOrdenServicio,
          idServicioCatalogo,
          actorId: auth.id_usuario,
        });
        const initialProducts = Array.isArray(body?.productos) ? body.productos : [];

        if (initialProducts.length > 0) {
          const orderForProducts = await getOrderByIdInternal(client, {
            auth,
            idOrdenServicio,
            branchIds: buildScopeBranchIds(auth, scope),
            forUpdate: true,
          });

          for (const item of initialProducts) {
            await consumeProductOnOrder(client, {
              auth,
              order: orderForProducts,
              payload: item,
              referenceLabel: numeroOrden,
            });
          }
        } else {
          await recalculateOrderTotals(client, {
            idEmpresa: auth.id_empresa,
            idOrdenServicio,
            actorId: auth.id_usuario,
          });
        }

        const created = await getOrderDetail(client, {
          auth,
          idOrdenServicio,
          branchIds: buildScopeBranchIds(auth, scope),
        });

        await writeAuditEvent(client, {
          auth,
          scope,
          requestMeta,
          modulo: serviceCatalog.modulo,
          entidad: "ORDEN_SERVICIO",
          entidadId: idOrdenServicio,
          accion: "CREATE",
          despues: created.orden,
        });

        ordenesServicioCreadas.inc({
          empresa: String(auth.id_empresa),
          modulo: serviceCatalog.modulo,
        });

        return created;
      } catch (error) {
        mapPgError(error);
      }
    },
    { auth }
  );

export const getOrderById = async ({ auth, idOrdenServicio }) =>
  getOrderDetail(pool, {
    auth,
    idOrdenServicio,
    branchIds: isPrivilegedRole(auth.rol) ? [] : getAssignedBranchIds(auth),
  });

export const updateOrderTracking = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      if (!current) {
        throw HttpError.notFound("Orden de servicio no encontrada");
      }

      assertOrderIsMutable(current, { allowCharged: true });

      const nextState =
        body?.estado !== undefined ? normalizeState(body.estado) : current.estado;

      if (!ORDER_STATES.includes(nextState)) {
        throw HttpError.badRequest("estado es invalido");
      }

      if (current.estado === "ANULADA" && nextState !== "ANULADA") {
        throw HttpError.badRequest("No puedes reabrir una orden anulada");
      }

      if (nextState === "ANULADA") {
        throw HttpError.badRequest(
          "Usa la accion de anulacion avanzada para registrar motivo, reembolso y reversa de stock"
        );
      }

      const idUsuarioAsignado =
        body?.id_usuario_asignado !== undefined
          ? body.id_usuario_asignado === null || body.id_usuario_asignado === ""
            ? null
            : parseInteger(body.id_usuario_asignado, "id_usuario_asignado", {
                allowNull: true,
              })
          : current.id_usuario_asignado;

      if (idUsuarioAsignado) {
        await ensureAssignableUser(client, {
          auth,
          scope,
          idUsuarioAsignado,
        });
      }

      const fechaInicio =
        body?.fecha_inicio !== undefined
          ? parseTimestamp(body.fecha_inicio, "fecha_inicio")
          : current.fecha_inicio || (nextState === "EN_PROCESO" ? new Date().toISOString() : null);
      const fechaFinalizacion =
        body?.fecha_finalizacion !== undefined
          ? parseTimestamp(body.fecha_finalizacion, "fecha_finalizacion")
          : current.fecha_finalizacion ||
            (nextState === "LISTO" ? new Date().toISOString() : null);
      const fechaEntrega =
        body?.fecha_entrega !== undefined
          ? parseTimestamp(body.fecha_entrega, "fecha_entrega")
          : current.fecha_entrega ||
            (nextState === "ENTREGADO" ? new Date().toISOString() : null);
      const nextAgendaState = deriveAgendaStateFromOrderState(
        nextState,
        current.fecha_programada_inicio
      );

      await client.query(
        `
          update ordenes_servicio
          set
            estado = $1,
            id_usuario_asignado = $2,
            observaciones = $3,
            agenda_estado = $4,
            fecha_inicio = coalesce($5::timestamptz, fecha_inicio),
            fecha_finalizacion = coalesce($6::timestamptz, fecha_finalizacion),
            fecha_entrega = coalesce($7::timestamptz, fecha_entrega),
            updated_by = $8
          where id_empresa = $9
            and id_orden_servicio = $10
        `,
        [
          nextState,
          idUsuarioAsignado,
          body?.observaciones !== undefined
            ? normalizeSearch(body.observaciones) || null
            : current.observaciones,
          nextAgendaState,
          fechaInicio,
          fechaFinalizacion,
          fechaEntrega,
          auth.id_usuario,
          auth.id_empresa,
          idOrdenServicio,
        ]
      );

      const updated = await getOrderDetail(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.modulo,
        entidad: "ORDEN_SERVICIO_SEGUIMIENTO",
        entidadId: idOrdenServicio,
        accion: "UPDATE",
        antes: current,
        despues: updated.orden,
      });

      return updated;
    },
    { auth }
  );

export const addProductToOrder = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      if (!current) {
        throw HttpError.notFound("Orden de servicio no encontrada");
      }

      await consumeProductOnOrder(client, {
        auth,
        order: current,
        payload: body,
        referenceLabel: current.numero_orden,
      });

      const updated = await getOrderDetail(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.modulo,
        entidad: "ORDEN_SERVICIO_PRODUCTO",
        entidadId: idOrdenServicio,
        accion: "CREATE",
        antes: {
          total: current.total,
          productos_total: current.productos_total,
        },
        despues: updated.orden,
      });

      return updated;
    },
    { auth }
  );

export const chargeOrder = async ({
  auth,
  scope,
  idOrdenServicio,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const current = await getOrderByIdInternal(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
        forUpdate: true,
      });

      if (!current) {
        throw HttpError.notFound("Orden de servicio no encontrada");
      }

      assertOrderIsMutable(current);

      let metodoPago = normalizeState(body?.metodo_pago);

      // Detectar cobertura por membresia activa del cliente.
      // Si aplica, forzar metodo a CORTESIA y registrar el consumo.
      let membresiaCubre = null;
      if (current.id_cliente && body?.usar_membresia !== false) {
        membresiaCubre = await findActiveCoverage(client, {
          idEmpresa: auth.id_empresa,
          idCliente: current.id_cliente,
          idServicioCatalogo: current.id_servicio_catalogo,
        });
        if (membresiaCubre) {
          metodoPago = "CORTESIA";
        }
      }

      if (!CHARGE_METHODS.includes(metodoPago)) {
        throw HttpError.badRequest(
          "metodo_pago debe ser EFECTIVO, TARJETA, TRANSFERENCIA o CORTESIA"
        );
      }

      const total = roundMoney(current.total);

      if (total <= 0 && metodoPago !== "CORTESIA") {
        throw HttpError.badRequest(
          "La orden no tiene total pendiente para registrar un cobro"
        );
      }

      const montoRecibidoInput =
        body?.monto_recibido !== undefined &&
        body?.monto_recibido !== null &&
        body?.monto_recibido !== ""
          ? parseMoney(body.monto_recibido, "monto_recibido")
          : null;

      const montoRecibido =
        metodoPago === "EFECTIVO"
          ? montoRecibidoInput == null
            ? total
            : montoRecibidoInput
          : metodoPago === "CORTESIA"
            ? 0
            : montoRecibidoInput;

      if (metodoPago === "EFECTIVO" && montoRecibido < total) {
        throw HttpError.badRequest(
          "El monto recibido no cubre el total de la orden"
        );
      }

      const cambio =
        metodoPago === "EFECTIVO"
          ? roundMoney(Math.max(0, montoRecibido - total))
          : 0;

      let idCajaSesion = current.id_caja_sesion ? Number(current.id_caja_sesion) : null;

      if (metodoPago !== "CORTESIA") {
        const cajaSesion = await getCajaSesionActivaForCharge(client, {
          auth,
          scope,
        });

        if (!cajaSesion) {
          throw HttpError.badRequest(
            "Debes abrir una caja en la sucursal activa antes de cobrar servicios"
          );
        }

        idCajaSesion = Number(cajaSesion.id_caja_sesion);
      }

      // Emision opcional de comprobante fiscal (TICKET / FACTURA / CCF)
      // ademas del numero_orden interno (SRV-/CWA-).
      let comprobanteFiscal = null;
      if (
        body?.tipo_comprobante_fiscal !== undefined &&
        body?.tipo_comprobante_fiscal !== null &&
        body?.tipo_comprobante_fiscal !== ""
      ) {
        comprobanteFiscal = await emitirComprobante(client, {
          idEmpresa: auth.id_empresa,
          idSucursal: scope.id_sucursal,
          modulo: "VENTA",
          tipoComprobante: body.tipo_comprobante_fiscal,
          actorId: auth.id_usuario,
        });
      }

      await client.query(
        `
          update ordenes_servicio
          set
            id_caja_sesion = $1,
            estado_cobro = 'COBRADO',
            metodo_pago = $2,
            monto_recibido = $3,
            cambio = $4,
            fecha_cobro = now(),
            tipo_comprobante_fiscal = coalesce($8, tipo_comprobante_fiscal),
            numero_comprobante_fiscal = coalesce($9, numero_comprobante_fiscal),
            id_comprobante_serie_fiscal = coalesce($10, id_comprobante_serie_fiscal),
            updated_by = $5
          where id_empresa = $6
            and id_orden_servicio = $7
        `,
        [
          idCajaSesion,
          metodoPago,
          montoRecibido,
          cambio,
          auth.id_usuario,
          auth.id_empresa,
          idOrdenServicio,
          comprobanteFiscal?.tipo_comprobante || null,
          comprobanteFiscal?.numero_comprobante || null,
          comprobanteFiscal?.id_comprobante_serie || null,
        ]
      );

      if (metodoPago === "EFECTIVO") {
        const referenciaCobro = comprobanteFiscal?.numero_comprobante
          ? `${current.numero_orden} (${comprobanteFiscal.numero_comprobante})`
          : current.numero_orden;

        await client.query(
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
            values ($1,$2,$3,$4,'INGRESO','SERVICIO_EFECTIVO',$5,$6,'ORDEN_SERVICIO',$7,$4,$4)
          `,
          [
            auth.id_empresa,
            idCajaSesion,
            scope.id_sucursal,
            auth.id_usuario,
            total,
            `Cobro orden ${referenciaCobro}`,
            idOrdenServicio,
          ]
        );
      }

      // Si se uso una membresia, registrar el consumo
      if (membresiaCubre) {
        await consumeMembresia(client, {
          idEmpresa: auth.id_empresa,
          idMembresia: membresiaCubre.id_membresia,
          idOrdenServicio,
          idServicioCatalogo: current.id_servicio_catalogo,
          actorId: auth.id_usuario,
          notas: `Cobro orden ${current.numero_orden}`,
        });
      }

      const updated = await getOrderDetail(client, {
        auth,
        idOrdenServicio,
        branchIds: buildScopeBranchIds(auth, scope),
      });

      // Comision para el tecnico asignado (si hay regla aplicable)
      if (updated?.orden?.id_usuario_asignado) {
        try {
          await computeAndPersistCommission(client, {
            idEmpresa: auth.id_empresa,
            ordenServicio: updated.orden,
            actorId: auth.id_usuario,
          });
        } catch (commissionError) {
          // No bloquea el cobro si falla el calculo de comision; queda en log
          // eslint-disable-next-line no-console
          console.warn(
            "[comisiones] no se pudo calcular comision:",
            commissionError.message
          );
        }
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: current.modulo,
        entidad: "ORDEN_SERVICIO_COBRO",
        entidadId: idOrdenServicio,
        accion: "CHARGE",
        antes: {
          estado_cobro: current.estado_cobro,
          metodo_pago: current.metodo_pago,
          total: current.total,
        },
        despues: updated.orden,
      });

      return updated;
    },
    { auth }
  );

// ============================================================
// G6 - CRUD de tipos de vehiculo (servicios_tipos_vehiculo)
// ============================================================

const slugifyVehiculo = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const validateTipoVehiculoModulo = (modulo) => {
  const moduloKey = normalizeModule(modulo);
  if (!OPERATIONAL_MODULES.includes(moduloKey)) {
    throw HttpError.badRequest(
      `modulo invalido. Validos: ${OPERATIONAL_MODULES.join(", ")}`
    );
  }
  return moduloKey;
};

const mapTipoVehiculoRow = (row) => ({
  id_tipo_vehiculo: Number(row.id_tipo_vehiculo),
  id_empresa: Number(row.id_empresa),
  modulo: row.modulo,
  nombre: row.nombre,
  slug: row.slug,
  descripcion: row.descripcion || null,
  icono: row.icono || null,
  orden: Number(row.orden || 0),
  activo: row.activo === true,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listTiposVehiculo = async ({ auth, query }) => {
  const filters = ["t.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (query?.modulo) {
    filters.push(`t.modulo = $${index}`);
    params.push(validateTipoVehiculoModulo(query.modulo));
    index += 1;
  }

  if (query?.activo !== undefined && query.activo !== "") {
    const wantsActive = ["true", "1", "si", "yes"].includes(
      String(query.activo).trim().toLowerCase()
    );
    filters.push(`t.activo = $${index}`);
    params.push(wantsActive);
    index += 1;
  }

  const result = await pool.query(
    `
      select t.*
      from servicios_tipos_vehiculo t
      where ${filters.join(" and ")}
      order by t.modulo asc, t.orden asc, t.nombre asc
    `,
    params
  );

  return result.rows.map(mapTipoVehiculoRow);
};

export const getTipoVehiculoById = async ({ auth, idTipoVehiculo }) => {
  const result = await pool.query(
    `
      select *
      from servicios_tipos_vehiculo
      where id_empresa = $1
        and id_tipo_vehiculo = $2
      limit 1
    `,
    [auth.id_empresa, idTipoVehiculo]
  );

  const row = result.rows[0];
  if (!row) {
    throw HttpError.notFound("Tipo de vehiculo no encontrado");
  }

  return mapTipoVehiculoRow(row);
};

export const createTipoVehiculo = async ({ auth, scope, body, requestMeta }) => {
  const moduloKey = validateTipoVehiculoModulo(body?.modulo);
  const nombre = normalizeSearch(body?.nombre);
  if (!nombre) {
    throw HttpError.badRequest("nombre es requerido");
  }

  const slug = body?.slug ? slugifyVehiculo(body.slug) : slugifyVehiculo(nombre);
  if (!slug) {
    throw HttpError.badRequest("slug invalido");
  }

  const orden = parseInteger(body?.orden ?? 0, "orden", {
    min: 0,
    allowNull: false,
  });
  const activo = normalizeBoolean(body?.activo, true);

  const insertResult = await pool.query(
    `
      insert into servicios_tipos_vehiculo (
        id_empresa,
        modulo,
        nombre,
        slug,
        descripcion,
        icono,
        orden,
        activo,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      on conflict (id_empresa, modulo, slug) do nothing
      returning *
    `,
    [
      auth.id_empresa,
      moduloKey,
      nombre,
      slug,
      normalizeSearch(body?.descripcion) || null,
      normalizeSearch(body?.icono) || null,
      orden,
      activo,
      auth.id_usuario,
    ]
  );

  if (insertResult.rowCount === 0) {
    throw HttpError.conflict(
      `Ya existe un tipo de vehiculo con slug "${slug}" en el modulo ${moduloKey}`
    );
  }

  const created = mapTipoVehiculoRow(insertResult.rows[0]);

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: moduloKey,
    entidad: "TIPO_VEHICULO",
    entidadId: created.id_tipo_vehiculo,
    accion: "CREATE",
    despues: created,
  });

  return created;
};

export const updateTipoVehiculo = async ({
  auth,
  scope,
  idTipoVehiculo,
  body,
  requestMeta,
}) => {
  const before = await getTipoVehiculoById({ auth, idTipoVehiculo });

  const updates = [];
  const params = [];
  let index = 1;

  if (body?.nombre !== undefined) {
    const nombre = normalizeSearch(body.nombre);
    if (!nombre) {
      throw HttpError.badRequest("nombre no puede estar vacio");
    }
    updates.push(`nombre = $${index}`);
    params.push(nombre);
    index += 1;
  }

  if (body?.descripcion !== undefined) {
    updates.push(`descripcion = $${index}`);
    params.push(normalizeSearch(body.descripcion) || null);
    index += 1;
  }

  if (body?.icono !== undefined) {
    updates.push(`icono = $${index}`);
    params.push(normalizeSearch(body.icono) || null);
    index += 1;
  }

  if (body?.orden !== undefined) {
    const orden = parseInteger(body.orden, "orden", {
      min: 0,
      allowNull: false,
    });
    updates.push(`orden = $${index}`);
    params.push(orden);
    index += 1;
  }

  if (body?.activo !== undefined) {
    updates.push(`activo = $${index}`);
    params.push(normalizeBoolean(body.activo, before.activo));
    index += 1;
  }

  if (updates.length === 0) {
    return before;
  }

  updates.push(`updated_by = $${index}`);
  params.push(auth.id_usuario);
  index += 1;

  params.push(auth.id_empresa, idTipoVehiculo);

  await pool.query(
    `
      update servicios_tipos_vehiculo
      set ${updates.join(", ")}
      where id_empresa = $${index}
        and id_tipo_vehiculo = $${index + 1}
    `,
    params
  );

  const after = await getTipoVehiculoById({ auth, idTipoVehiculo });

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: after.modulo,
    entidad: "TIPO_VEHICULO",
    entidadId: idTipoVehiculo,
    accion: "UPDATE",
    antes: before,
    despues: after,
  });

  return after;
};
