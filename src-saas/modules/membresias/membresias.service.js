import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));
const normalizeText = (v) => String(v || "").trim() || null;
const normalizeUpper = (v) => normalizeText(v)?.toUpperCase() ?? null;

// ============================================================
// CRUD de planes
// ============================================================

export const listPlanes = async ({ auth, query }) => {
  const filters = ["p.id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.modulo) {
    filters.push(`p.modulo = $${i}`);
    params.push(normalizeUpper(query.modulo));
    i += 1;
  }
  if (query?.activo !== undefined && query.activo !== "") {
    filters.push(`p.activo = $${i}`);
    params.push(["true", "1", "si", "yes"].includes(String(query.activo).toLowerCase()));
    i += 1;
  }

  const planes = await pool.query(
    `
      select p.*
      from membresias_planes p
      where ${filters.join(" and ")}
      order by p.modulo asc, p.nombre asc
    `,
    params
  );

  if (planes.rows.length === 0) return [];

  const planIds = planes.rows.map((p) => Number(p.id_plan));
  const servicios = await pool.query(
    `
      select ps.id_plan, ps.id_servicio_catalogo, ps.usos_max_por_ciclo,
             sc.nombre as servicio_nombre
      from membresias_planes_servicios ps
      inner join servicios_catalogo sc
        on sc.id_empresa = ps.id_empresa
       and sc.id_servicio_catalogo = ps.id_servicio_catalogo
      where ps.id_empresa = $1 and ps.id_plan = any($2::bigint[])
    `,
    [auth.id_empresa, planIds]
  );

  const serviciosByPlan = servicios.rows.reduce((acc, row) => {
    const key = Number(row.id_plan);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  return planes.rows.map((p) => ({
    ...p,
    precio: round2(p.precio),
    servicios: serviciosByPlan[Number(p.id_plan)] || [],
  }));
};

export const createPlan = async ({ auth, scope, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const modulo = normalizeUpper(body?.modulo);
      if (!["CARWASH", "SERVICIOS"].includes(modulo)) {
        throw HttpError.badRequest("modulo debe ser CARWASH o SERVICIOS");
      }
      const nombre = normalizeText(body?.nombre);
      if (!nombre) throw HttpError.badRequest("nombre es requerido");
      const precio = Number(body?.precio);
      if (!Number.isFinite(precio) || precio < 0) {
        throw HttpError.badRequest("precio debe ser >= 0");
      }
      const duracionDias = Number(body?.duracion_dias) || 30;
      if (duracionDias <= 0) {
        throw HttpError.badRequest("duracion_dias debe ser > 0");
      }

      const ins = await client.query(
        `
          insert into membresias_planes (
            id_empresa, modulo, nombre, descripcion, precio, moneda,
            duracion_dias, renovacion_automatica, activo,
            usos_max_por_ciclo, created_by, updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
          returning *
        `,
        [
          auth.id_empresa,
          modulo,
          nombre,
          normalizeText(body?.descripcion),
          round2(precio),
          normalizeUpper(body?.moneda),
          duracionDias,
          body?.renovacion_automatica === true,
          body?.activo !== false,
          body?.usos_max_por_ciclo
            ? Math.max(1, Number(body.usos_max_por_ciclo))
            : null,
          auth.id_usuario,
        ]
      );

      const plan = ins.rows[0];

      // Servicios cubiertos
      const servicios = Array.isArray(body?.servicios) ? body.servicios : [];
      for (const item of servicios) {
        const idServicio = Number(item?.id_servicio_catalogo);
        if (!Number.isInteger(idServicio) || idServicio <= 0) continue;
        await client.query(
          `
            insert into membresias_planes_servicios (
              id_empresa, id_plan, id_servicio_catalogo, usos_max_por_ciclo
            )
            values ($1,$2,$3,$4)
            on conflict (id_empresa, id_plan, id_servicio_catalogo) do nothing
          `,
          [
            auth.id_empresa,
            plan.id_plan,
            idServicio,
            item?.usos_max_por_ciclo
              ? Math.max(1, Number(item.usos_max_por_ciclo))
              : null,
          ]
        );
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "MEMBRESIAS",
        entidad: "PLAN",
        entidadId: plan.id_plan,
        accion: "CREATE",
        despues: plan,
      });

      return plan;
    },
    { auth }
  );

// ============================================================
// Suscripciones (membresias_clientes)
// ============================================================

export const subscribeCliente = async ({
  auth,
  scope,
  body,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const idPlan = Number(body?.id_plan);
      const idCliente = Number(body?.id_cliente);
      if (!Number.isInteger(idPlan) || !Number.isInteger(idCliente)) {
        throw HttpError.badRequest("id_plan e id_cliente son requeridos");
      }

      const planResult = await client.query(
        `
          select * from membresias_planes
          where id_empresa = $1 and id_plan = $2 and activo = true
          limit 1
        `,
        [auth.id_empresa, idPlan]
      );
      const plan = planResult.rows[0];
      if (!plan) throw HttpError.badRequest("Plan no encontrado o inactivo");

      const clienteResult = await client.query(
        `select id_cliente from clientes where id_empresa=$1 and id_cliente=$2 and activo=true`,
        [auth.id_empresa, idCliente]
      );
      if (clienteResult.rowCount === 0) {
        throw HttpError.badRequest("Cliente no encontrado o inactivo");
      }

      const fechaInicio = body?.fecha_inicio || new Date().toISOString().slice(0, 10);
      const vencResult = await client.query(
        `select ($1::date + ($2 || ' days')::interval)::date as venc`,
        [fechaInicio, plan.duracion_dias]
      );

      const insert = await client.query(
        `
          insert into membresias_clientes (
            id_empresa, id_plan, id_cliente, fecha_inicio, fecha_vencimiento,
            precio_pagado, moneda, id_venta_origen, renovacion_automatica,
            created_by, updated_by
          )
          values ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$10)
          returning *
        `,
        [
          auth.id_empresa,
          idPlan,
          idCliente,
          fechaInicio,
          vencResult.rows[0].venc,
          round2(body?.precio_pagado ?? plan.precio),
          plan.moneda || null,
          body?.id_venta_origen || null,
          body?.renovacion_automatica === true || plan.renovacion_automatica,
          auth.id_usuario,
        ]
      );

      const membresia = insert.rows[0];

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "MEMBRESIAS",
        entidad: "MEMBRESIA",
        entidadId: membresia.id_membresia,
        accion: "SUBSCRIBE",
        despues: membresia,
      });

      return membresia;
    },
    { auth }
  );

export const listMembresiasCliente = async ({ auth, idCliente }) => {
  const result = await pool.query(
    `
      select m.*, p.nombre as plan_nombre, p.modulo
      from membresias_clientes m
      inner join membresias_planes p
        on p.id_empresa = m.id_empresa and p.id_plan = m.id_plan
      where m.id_empresa = $1 and m.id_cliente = $2
      order by m.fecha_vencimiento desc
    `,
    [auth.id_empresa, idCliente]
  );
  return result.rows.map((row) => ({ ...row, precio_pagado: round2(row.precio_pagado) }));
};

// ============================================================
// Lookup de membresia activa para una orden
// ============================================================

/**
 * Devuelve la membresia activa del cliente que cubre `id_servicio_catalogo`,
 * respetando los limites de usos por ciclo. null si no hay cobertura.
 *
 * Usa transaction client para que el caller pueda hacer FOR UPDATE.
 */
export const findActiveCoverage = async (
  client,
  { idEmpresa, idCliente, idServicioCatalogo }
) => {
  if (!idCliente) return null;

  const result = await client.query(
    `
      select
        m.id_membresia,
        m.id_plan,
        m.fecha_vencimiento,
        p.usos_max_por_ciclo as plan_max,
        ps.usos_max_por_ciclo as servicio_max
      from membresias_clientes m
      inner join membresias_planes p
        on p.id_empresa = m.id_empresa and p.id_plan = m.id_plan
      inner join membresias_planes_servicios ps
        on ps.id_empresa = m.id_empresa
       and ps.id_plan = m.id_plan
       and ps.id_servicio_catalogo = $3
      where m.id_empresa = $1
        and m.id_cliente = $2
        and m.estado = 'ACTIVA'
        and m.fecha_vencimiento >= current_date
      order by m.fecha_vencimiento asc
      limit 1
      for update of m
    `,
    [idEmpresa, idCliente, idServicioCatalogo]
  );

  const row = result.rows[0];
  if (!row) return null;

  // Verificar limites de uso (en el ciclo actual = desde fecha_inicio)
  const usosResult = await client.query(
    `
      select
        count(*)::int as total,
        count(*) filter (where c.id_servicio_catalogo = $3)::int as por_servicio
      from membresias_consumos c
      where c.id_empresa = $1
        and c.id_membresia = $2
    `,
    [idEmpresa, row.id_membresia, idServicioCatalogo]
  );

  const usos = usosResult.rows[0];

  if (
    row.servicio_max != null &&
    Number(usos.por_servicio) >= Number(row.servicio_max)
  ) {
    return null; // Limite por servicio agotado
  }
  if (row.plan_max != null && Number(usos.total) >= Number(row.plan_max)) {
    return null; // Limite global agotado
  }

  return {
    id_membresia: Number(row.id_membresia),
    id_plan: Number(row.id_plan),
    fecha_vencimiento: row.fecha_vencimiento,
    usos_actuales: Number(usos.total),
    usos_servicio: Number(usos.por_servicio),
    limite_servicio: row.servicio_max,
    limite_plan: row.plan_max,
  };
};

/**
 * Registra un consumo de membresia para una orden. Idempotente por orden.
 */
export const consumeMembresia = async (
  client,
  { idEmpresa, idMembresia, idOrdenServicio, idServicioCatalogo, actorId, notas = null }
) => {
  const result = await client.query(
    `
      insert into membresias_consumos (
        id_empresa, id_membresia, id_orden_servicio, id_servicio_catalogo,
        notas, created_by, updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$6)
      on conflict (id_empresa, id_orden_servicio) do nothing
      returning *
    `,
    [
      idEmpresa,
      idMembresia,
      idOrdenServicio,
      idServicioCatalogo,
      notas,
      actorId,
    ]
  );
  return result.rows[0] || null;
};

/**
 * Marca como VENCIDA todas las membresias cuya fecha_vencimiento ya paso.
 * Diseñada para correrse en cron o al inicio del dia.
 */
export const expireOldMemberships = async () => {
  const result = await pool.query(
    `
      update membresias_clientes
      set estado = 'VENCIDA'
      where estado = 'ACTIVA'
        and fecha_vencimiento < current_date
      returning id_membresia
    `
  );
  return { expired: result.rowCount || 0 };
};
