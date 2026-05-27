import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));
const round4 = (n) => Number(Number(n || 0).toFixed(4));

/**
 * Resuelve la regla mas especifica aplicable para una orden:
 *   - prioridad ASC (menor numero gana)
 *   - regla por tecnico especifico vence a regla generica
 *   - regla por modulo especifico vence a regla generica
 *   - solo activa y vigente en la fecha de la orden
 */
const findApplicableRule = async (
  client,
  { idEmpresa, idUsuarioTecnico, modulo, fecha }
) => {
  const result = await client.query(
    `
      select *
      from comisiones_reglas
      where id_empresa = $1
        and activa = true
        and (vigente_desde is null or vigente_desde <= $4::date)
        and (vigente_hasta is null or vigente_hasta >= $4::date)
        and (id_usuario_tecnico is null or id_usuario_tecnico = $2)
        and (modulo is null or modulo = $3)
      order by
        case when id_usuario_tecnico is not null then 0 else 1 end,
        case when modulo is not null then 0 else 1 end,
        prioridad asc,
        id_regla desc
      limit 1
    `,
    [idEmpresa, idUsuarioTecnico, String(modulo || "").toUpperCase(), fecha]
  );

  return result.rows[0] || null;
};

/**
 * Calcula y persiste la comision para una orden cobrada.
 * Idempotente: si ya existe comision para (orden, tecnico), no crea duplicado.
 *
 * Devuelve la comision creada o null si no hay regla aplicable o no hay tecnico.
 */
export const computeAndPersistCommission = async (
  client,
  { idEmpresa, ordenServicio, idUsuarioTecnico = null, actorId = null }
) => {
  if (!ordenServicio) return null;

  const tecnicoId =
    idUsuarioTecnico ||
    ordenServicio.id_usuario_asignado ||
    null;

  if (!tecnicoId) return null;

  // Idempotencia
  const existing = await client.query(
    `
      select id_comision
      from comisiones_ordenes
      where id_empresa = $1
        and id_orden_servicio = $2
        and id_usuario_tecnico = $3
      limit 1
    `,
    [idEmpresa, ordenServicio.id_orden_servicio, tecnicoId]
  );

  if (existing.rows[0]) return null;

  const fechaOperacion = (
    ordenServicio.fecha_cobro ||
    ordenServicio.fecha_servicio ||
    new Date()
  );
  const fechaIso =
    fechaOperacion instanceof Date
      ? fechaOperacion.toISOString().slice(0, 10)
      : new Date(fechaOperacion).toISOString().slice(0, 10);

  const rule = await findApplicableRule(client, {
    idEmpresa,
    idUsuarioTecnico: tecnicoId,
    modulo: ordenServicio.modulo,
    fecha: fechaIso,
  });

  if (!rule) return null;

  const baseMonto =
    String(rule.base_calculo || "TOTAL").toUpperCase() === "PRECIO_SERVICIO"
      ? Number(ordenServicio.precio_servicio || 0)
      : Number(ordenServicio.total || 0);

  let monto = 0;
  let porcentajeAplicado = null;

  if (String(rule.tipo).toUpperCase() === "PORCENTAJE") {
    porcentajeAplicado = round4(rule.valor);
    monto = round2((baseMonto * porcentajeAplicado) / 100);
  } else {
    // FIJO
    monto = round2(rule.valor);
  }

  if (monto <= 0) return null;

  const insert = await client.query(
    `
      insert into comisiones_ordenes (
        id_empresa, id_orden_servicio, id_usuario_tecnico, id_regla,
        monto_base, porcentaje_aplicado, monto_comision,
        estado, created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'GENERADA', $8, $8)
      returning *
    `,
    [
      idEmpresa,
      ordenServicio.id_orden_servicio,
      tecnicoId,
      rule.id_regla,
      round2(baseMonto),
      porcentajeAplicado,
      monto,
      actorId,
    ]
  );

  return insert.rows[0];
};

/**
 * Lista las reglas configuradas.
 */
export const listReglas = async ({ auth }) => {
  const result = await pool.query(
    `
      select r.*, u.username as tecnico_username
      from comisiones_reglas r
      left join usuarios u
        on u.id_empresa = r.id_empresa and u.id_usuario = r.id_usuario_tecnico
      where r.id_empresa = $1
      order by r.activa desc, r.prioridad asc, r.created_at desc
    `,
    [auth.id_empresa]
  );
  return result.rows;
};

export const createRegla = async ({ auth, scope, body, requestMeta }) => {
  const tipo = String(body?.tipo || "").toUpperCase();
  if (!["PORCENTAJE", "FIJO"].includes(tipo)) {
    throw HttpError.badRequest("tipo debe ser PORCENTAJE o FIJO");
  }
  const valor = Number(body?.valor);
  if (!Number.isFinite(valor) || valor < 0) {
    throw HttpError.badRequest("valor debe ser >= 0");
  }
  if (tipo === "PORCENTAJE" && valor > 100) {
    throw HttpError.badRequest("PORCENTAJE no puede exceder 100");
  }

  const baseCalculo = String(body?.base_calculo || "TOTAL").toUpperCase();
  if (!["TOTAL", "PRECIO_SERVICIO"].includes(baseCalculo)) {
    throw HttpError.badRequest(
      "base_calculo debe ser TOTAL o PRECIO_SERVICIO"
    );
  }

  const modulo = body?.modulo
    ? String(body.modulo).toUpperCase()
    : null;
  if (modulo && !["CARWASH", "SERVICIOS"].includes(modulo)) {
    throw HttpError.badRequest("modulo debe ser CARWASH, SERVICIOS o null");
  }

  const result = await pool.query(
    `
      insert into comisiones_reglas (
        id_empresa, id_usuario_tecnico, modulo, tipo, valor,
        base_calculo, prioridad, activa, vigente_desde, vigente_hasta,
        created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $11)
      returning *
    `,
    [
      auth.id_empresa,
      body?.id_usuario_tecnico ? Number(body.id_usuario_tecnico) : null,
      modulo,
      tipo,
      round4(valor),
      baseCalculo,
      Number.isInteger(Number(body?.prioridad)) ? Number(body.prioridad) : 100,
      body?.activa === false ? false : true,
      body?.vigente_desde || null,
      body?.vigente_hasta || null,
      auth.id_usuario,
    ]
  );

  const created = result.rows[0];

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "COMISIONES",
    entidad: "REGLA",
    entidadId: created.id_regla,
    accion: "CREATE",
    despues: created,
  });

  return created;
};

/**
 * Reporte de comisiones por tecnico en un rango.
 */
export const reportByTecnico = async ({ auth, query }) => {
  const filters = ["c.id_empresa = $1"];
  const params = [auth.id_empresa];
  let i = 2;

  if (query?.desde) {
    filters.push(`c.fecha_generacion::date >= $${i}::date`);
    params.push(query.desde);
    i += 1;
  }
  if (query?.hasta) {
    filters.push(`c.fecha_generacion::date <= $${i}::date`);
    params.push(query.hasta);
    i += 1;
  }
  if (query?.id_usuario_tecnico) {
    filters.push(`c.id_usuario_tecnico = $${i}`);
    params.push(Number(query.id_usuario_tecnico));
    i += 1;
  }
  if (query?.estado) {
    filters.push(`c.estado = $${i}`);
    params.push(String(query.estado).toUpperCase());
    i += 1;
  }

  const result = await pool.query(
    `
      select
        c.id_usuario_tecnico,
        u.username,
        concat(u.nombre, ' ', u.apellido) as nombre,
        count(*)::int as ordenes,
        coalesce(sum(c.monto_base), 0) as base_total,
        coalesce(sum(c.monto_comision), 0) as comision_total,
        coalesce(sum(c.monto_comision) filter (where c.estado = 'PAGADA'), 0) as pagada_total,
        coalesce(sum(c.monto_comision) filter (where c.estado = 'GENERADA'), 0) as pendiente_total
      from comisiones_ordenes c
      inner join usuarios u
        on u.id_empresa = c.id_empresa and u.id_usuario = c.id_usuario_tecnico
      where ${filters.join(" and ")}
      group by c.id_usuario_tecnico, u.username, u.nombre, u.apellido
      order by comision_total desc
    `,
    params
  );

  return result.rows.map((row) => ({
    ...row,
    base_total: round2(row.base_total),
    comision_total: round2(row.comision_total),
    pagada_total: round2(row.pagada_total),
    pendiente_total: round2(row.pendiente_total),
  }));
};

export const markPaid = async ({
  auth,
  scope,
  idComision,
  requestMeta,
}) => {
  const result = await pool.query(
    `
      update comisiones_ordenes
      set estado = 'PAGADA',
          pagada_en = now(),
          pagada_por = $1,
          updated_by = $1
      where id_empresa = $2
        and id_comision = $3
        and estado = 'GENERADA'
      returning *
    `,
    [auth.id_usuario, auth.id_empresa, idComision]
  );

  if (result.rowCount === 0) {
    throw HttpError.badRequest("Comision no encontrada o ya pagada");
  }

  const updated = result.rows[0];
  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "COMISIONES",
    entidad: "COMISION",
    entidadId: idComision,
    accion: "PAY",
    despues: updated,
  });

  return updated;
};
