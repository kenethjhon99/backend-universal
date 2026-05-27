/**
 * Servicio platform: endpoints exclusivos del SUPER_ADMIN para operar el
 * SaaS (no operacion de tenants).
 *
 *  - getPlatformMetrics(): MRR, ARR, total empresas por estado, churn 30d,
 *    trials por vencer, top empresas por uso.
 *  - listSuspended/Trials/etc: listas operativas.
 *  - impersonate(idEmpresa): emite token de sesion como el primer admin de
 *    esa empresa para diagnosticar problemas. AUDITADO.
 */
import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { signAccessToken } from "../../shared/security/jwt.js";
import {
  computeEffectivePermissions,
} from "../../shared/security/permissions.js";
import { invalidateCompanyStatusCache } from "../../middlewares/authenticate.js";
import { invalidatePlanLimitCache } from "../../middlewares/enforce-plan-limits.js";
import {
  getCompanyModuleStates,
  getModuleRowsByCodes,
  normalizeActiveModuleCodes,
} from "../../shared/saas/company-modules.js";

const PLAN_LIMIT_FIELDS = [
  "max_sucursales",
  "max_usuarios",
  "max_ventas_mes",
  "max_productos",
  "max_cajas",
  "max_bodegas",
  "max_storage_mb",
  "max_api_requests_mes",
];

const normalizePlanCode = (value) =>
  String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const normalizeAddonCode = (value) =>
  String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");

const parseNullableInteger = (value, fieldName) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw HttpError.badRequest(`${fieldName} debe ser entero >= 0`);
  }
  return parsed;
};

const parseMoney = (value, fieldName, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw HttpError.badRequest(`${fieldName} es invalido`);
  }
  return Number(parsed.toFixed(2));
};

const normalizePlanPayload = (body, { partial = false } = {}) => {
  const payload = {};

  if (!partial || body?.codigo !== undefined) {
    payload.codigo = normalizePlanCode(body?.codigo);
    if (!payload.codigo) throw HttpError.badRequest("codigo es requerido");
  }
  if (!partial || body?.nombre !== undefined) {
    payload.nombre = String(body?.nombre || "").trim();
    if (!payload.nombre) throw HttpError.badRequest("nombre es requerido");
  }
  if (body?.descripcion !== undefined || !partial) {
    payload.descripcion = String(body?.descripcion || "").trim() || null;
  }
  if (body?.precio_mensual !== undefined || !partial) {
    payload.precio_mensual = parseMoney(body?.precio_mensual, "precio_mensual", 0);
  }
  if (body?.precio_anual !== undefined) {
    payload.precio_anual =
      body.precio_anual === null || body.precio_anual === ""
        ? null
        : parseMoney(body.precio_anual, "precio_anual", 0);
  }
  if (body?.moneda !== undefined || !partial) {
    payload.moneda = String(body?.moneda || "USD").trim().toUpperCase().slice(0, 3);
  }
  if (body?.trial_dias !== undefined || !partial) {
    payload.trial_dias = parseNullableInteger(body?.trial_dias ?? 14, "trial_dias");
  }
  for (const field of PLAN_LIMIT_FIELDS) {
    if (body?.[field] !== undefined) {
      payload[field] = parseNullableInteger(body[field], field);
    }
  }
  if (body?.modulos_incluidos !== undefined || !partial) {
    payload.modulos_incluidos = normalizeActiveModuleCodes(body?.modulos_incluidos || []);
  }
  for (const field of ["activo", "visible_publico", "permite_addons", "requiere_contacto"]) {
    if (body?.[field] !== undefined) payload[field] = body[field] !== false;
  }
  if (body?.orden !== undefined) {
    payload.orden = parseNullableInteger(body.orden, "orden");
  }

  return payload;
};

const normalizeAddonPayload = (body, { partial = false } = {}) => {
  const payload = {};
  if (!partial || body?.codigo !== undefined) {
    payload.codigo = normalizeAddonCode(body?.codigo);
    if (!payload.codigo) throw HttpError.badRequest("codigo es requerido");
  }
  if (!partial || body?.nombre !== undefined) {
    payload.nombre = String(body?.nombre || "").trim();
    if (!payload.nombre) throw HttpError.badRequest("nombre es requerido");
  }
  if (body?.descripcion !== undefined || !partial) {
    payload.descripcion = String(body?.descripcion || "").trim() || null;
  }
  if (body?.categoria !== undefined || !partial) {
    payload.categoria = String(body?.categoria || "OPERACION").trim().toUpperCase();
  }
  if (body?.trial_dias !== undefined || !partial) {
    payload.trial_dias = parseNullableInteger(body?.trial_dias ?? 0, "trial_dias");
  }
  if (body?.requiere_plan_minimo !== undefined) {
    payload.requiere_plan_minimo =
      body.requiere_plan_minimo === null || body.requiere_plan_minimo === ""
        ? null
        : normalizePlanCode(body.requiere_plan_minimo);
  }
  for (const field of ["activo", "visible_publico", "permite_trial"]) {
    if (body?.[field] !== undefined) payload[field] = body[field] !== false;
  }
  if (body?.orden !== undefined) {
    payload.orden = parseNullableInteger(body.orden, "orden");
  }
  if (body?.metadata !== undefined) {
    payload.metadata =
      body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  }
  if (body?.modulos !== undefined) {
    payload.modulos = normalizeActiveModuleCodes(body.modulos, { fallback: [] });
  }
  if (body?.precio_mensual !== undefined) {
    payload.precio_mensual = parseMoney(body.precio_mensual, "precio_mensual", 0);
  }
  if (body?.moneda !== undefined) {
    payload.moneda = String(body.moneda || "USD").trim().toUpperCase().slice(0, 3);
  }
  return payload;
};

/**
 * Metricas agregadas para el dashboard.
 *
 * MRR (Monthly Recurring Revenue):
 *   sum(precio_mensual) sobre empresas ACTIVA en planes con precio.
 *   Las TRIAL no cuentan (todavia no pagan). Las CANCELADA/SUSPENDIDA tampoco.
 *
 * Churn 30d: empresas que pasaron de ACTIVA -> CANCELADA en los ultimos 30
 *   dias / empresas ACTIVA al inicio del periodo.
 */
export const getPlatformMetrics = async () => {
  // ---- Resumen por estado ----
  const byEstado = await pool.query(
    `select coalesce(saas_estado, 'SIN_ESTADO') as estado, count(*)::int as n
     from empresas
     group by saas_estado
     order by n desc`
  );

  // ---- MRR / ARR ----
  // `saas_planes` define `precio_mensual`; se reporta como USD por compat
  // con el dashboard actual, usando la moneda del plan como contrato comercial.
  const mrr = await pool.query(
    `select coalesce(sum(p.precio_mensual), 0)::numeric as mrr_usd
     from empresas e
     inner join saas_planes p on p.codigo = e.saas_plan_codigo
     where e.saas_estado = 'ACTIVA'
       and p.precio_mensual > 0`
  );
  const mrrUsd = Number(mrr.rows[0]?.mrr_usd || 0);
  const arrUsd = mrrUsd * 12;

  // ---- Distribucion por plan ----
  const byPlan = await pool.query(
    `select coalesce(e.saas_plan_codigo, 'SIN_PLAN') as plan,
            count(*)::int as empresas,
            sum(case when e.saas_estado = 'ACTIVA' then 1 else 0 end)::int as activas
     from empresas e
     group by e.saas_plan_codigo
     order by empresas desc`
  );

  // ---- Trials por vencer en los proximos 7 dias ----
  const trialsExpiring = await pool.query(
    `select id_empresa, slug, nombre_legal, saas_trial_hasta,
            (saas_trial_hasta - current_date) as dias_restantes
     from empresas
     where saas_estado = 'TRIAL'
       and saas_trial_hasta is not null
       and saas_trial_hasta between current_date and current_date + interval '7 days'
     order by saas_trial_hasta asc
     limit 50`
  );

  // ---- Suspendidas (necesitan accion) ----
  const suspended = await pool.query(
    `select id_empresa, slug, nombre_legal, saas_plan_codigo, updated_at
     from empresas
     where saas_estado in ('SUSPENDIDA', 'CANCELADA')
     order by updated_at desc
     limit 50`
  );

  // ---- Churn ultimos 30 dias ----
  // Cuenta eventos customer.subscription.deleted / TRIAL_EXPIRED en saas_subscription_events
  const churn = await pool.query(
    `select count(*)::int as churn_30d
     from saas_subscription_events
     where tipo_evento in ('customer.subscription.deleted', 'TRIAL_EXPIRED', 'PLAN_CANCELLED')
       and created_at > now() - interval '30 days'`
  );

  // ---- Nuevas empresas ultimos 30 dias ----
  const nuevas = await pool.query(
    `select count(*)::int as nuevas_30d
     from empresas
     where created_at > now() - interval '30 days'`
  );

  // ---- Top 10 empresas por uso (ventas_mes) ----
  const topUso = await pool.query(
    `select e.id_empresa, e.slug, e.nombre_legal, e.saas_plan_codigo,
            u.ventas_mes_count, u.sucursales_count, u.usuarios_count
     from empresas e
     inner join empresa_uso_actual u on u.id_empresa = e.id_empresa
     where e.saas_estado = 'ACTIVA'
     order by u.ventas_mes_count desc nulls last
     limit 10`
  );

  return {
    mrr_usd: Number(mrrUsd.toFixed(2)),
    arr_usd: Number(arrUsd.toFixed(2)),
    empresas_por_estado: byEstado.rows,
    empresas_por_plan: byPlan.rows,
    trials_proximos_vencer: trialsExpiring.rows,
    suspendidas: suspended.rows,
    churn_30d: Number(churn.rows[0]?.churn_30d || 0),
    nuevas_30d: Number(nuevas.rows[0]?.nuevas_30d || 0),
    top_uso: topUso.rows,
  };
};

export const listPlanes = async () => {
  const result = await pool.query(
    `
      select
        codigo, nombre, descripcion, precio_mensual, precio_anual, moneda,
        trial_dias,
        max_sucursales, max_usuarios, max_ventas_mes, max_productos,
        max_cajas, max_bodegas, max_storage_mb, max_api_requests_mes,
        modulos_incluidos, permite_addons, requiere_contacto,
        activo, visible_publico, orden, created_at, updated_at
      from saas_planes
      order by orden asc, precio_mensual asc, codigo asc
    `
  );
  return result.rows.map((row) => ({
    ...row,
    precio_mensual: Number(row.precio_mensual || 0),
    precio_anual:
      row.precio_anual === null || row.precio_anual === undefined
        ? null
        : Number(row.precio_anual),
  }));
};

export const createPlan = async ({ auth, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const payload = normalizePlanPayload(body);
      await getModuleRowsByCodes(client, payload.modulos_incluidos);

      const result = await client.query(
        `
          insert into saas_planes (
            codigo, nombre, descripcion, precio_mensual, precio_anual, moneda,
            trial_dias,
            max_sucursales, max_usuarios, max_ventas_mes, max_productos,
            max_cajas, max_bodegas, max_storage_mb, max_api_requests_mes,
            modulos_incluidos, permite_addons, requiere_contacto,
            activo, visible_publico, orden
          )
          values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
            $16::jsonb,$17,$18,$19,$20,$21
          )
          returning *
        `,
        [
          payload.codigo,
          payload.nombre,
          payload.descripcion,
          payload.precio_mensual,
          payload.precio_anual ?? null,
          payload.moneda,
          payload.trial_dias,
          payload.max_sucursales ?? null,
          payload.max_usuarios ?? null,
          payload.max_ventas_mes ?? null,
          payload.max_productos ?? null,
          payload.max_cajas ?? null,
          payload.max_bodegas ?? null,
          payload.max_storage_mb ?? null,
          payload.max_api_requests_mes ?? null,
          JSON.stringify(payload.modulos_incluidos),
          payload.permite_addons !== false,
          payload.requiere_contacto === true,
          payload.activo !== false,
          payload.visible_publico !== false,
          payload.orden ?? 0,
        ]
      ).catch((error) => {
        if (error?.code === "23505") {
          throw HttpError.conflict("Ya existe un plan con ese codigo");
        }
        throw error;
      });

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "SAAS_PLAN",
        entidadId: 0,
        accion: "CREATE",
        despues: result.rows[0],
      });

      return result.rows[0];
    },
    { auth }
  );

export const updatePlan = async ({ auth, codigo, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const planCode = normalizePlanCode(codigo);
      const current = await client.query(
        `select * from saas_planes where codigo = $1 limit 1`,
        [planCode]
      );
      if (current.rowCount === 0) throw HttpError.notFound("Plan no encontrado");

      const payload = normalizePlanPayload(body, { partial: true });
      if (payload.modulos_incluidos) {
        await getModuleRowsByCodes(client, payload.modulos_incluidos);
      }

      const fields = [];
      const values = [];
      let index = 1;
      for (const [key, value] of Object.entries(payload)) {
        if (key === "codigo") continue;
        fields.push(`${key} = $${index}${key === "modulos_incluidos" ? "::jsonb" : ""}`);
        values.push(key === "modulos_incluidos" ? JSON.stringify(value) : value);
        index += 1;
      }
      if (fields.length === 0) throw HttpError.badRequest("Nada que actualizar");
      values.push(planCode);

      const result = await client.query(
        `
          update saas_planes
          set ${fields.join(", ")}
          where codigo = $${index}
          returning *
        `,
        values
      );

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "SAAS_PLAN",
        entidadId: 0,
        accion: "UPDATE",
        antes: current.rows[0],
        despues: result.rows[0],
      });

      return result.rows[0];
    },
    { auth }
  );

export const changeEmpresaPlan = async ({
  auth,
  idEmpresa,
  planCodigo,
  estado = "ACTIVA",
  motivo = null,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const normalizedPlan = normalizePlanCode(planCodigo);
      const target = await client.query(
        `select id_empresa, slug, nombre_legal, saas_plan_codigo, saas_estado
         from empresas where id_empresa = $1 limit 1`,
        [idEmpresa]
      );
      if (target.rowCount === 0) throw HttpError.notFound("Empresa no encontrada");

      const plan = await client.query(
        `select codigo, modulos_incluidos from saas_planes where codigo = $1 and activo = true`,
        [normalizedPlan]
      );
      if (plan.rowCount === 0) throw HttpError.badRequest("Plan no disponible");

      const nextEstado = String(estado || "ACTIVA").trim().toUpperCase();
      if (!["TRIAL", "ACTIVA", "SUSPENDIDA", "CANCELADA"].includes(nextEstado)) {
        throw HttpError.badRequest("estado SaaS invalido");
      }

      const result = await client.query(
        `
          update empresas
          set saas_plan_codigo = $1,
              saas_estado = $2,
              saas_trial_hasta = case when $2 = 'TRIAL' then coalesce(saas_trial_hasta, current_date + interval '14 days') else null end
          where id_empresa = $3
          returning id_empresa, slug, nombre_legal, saas_plan_codigo, saas_estado
        `,
        [normalizedPlan, nextEstado, idEmpresa]
      );

      await client.query(
        `
          insert into saas_subscription_events (id_empresa, tipo_evento, plan_codigo, metadata, created_by)
          values ($1, 'ADMIN_PLAN_CHANGED', $2, $3::jsonb, $4)
        `,
        [
          idEmpresa,
          normalizedPlan,
          JSON.stringify({
            from_plan: target.rows[0].saas_plan_codigo,
            from_estado: target.rows[0].saas_estado,
            to_estado: nextEstado,
            motivo,
          }),
          auth.id_usuario,
        ]
      );

      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "EMPRESA_PLAN",
        entidadId: idEmpresa,
        accion: "CHANGE_PLAN",
        antes: target.rows[0],
        despues: result.rows[0],
      });

      return result.rows[0];
    },
    { auth }
  );

export const setEmpresaModulo = async ({
  auth,
  idEmpresa,
  codigoModulo,
  activo,
  config = {},
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const moduleCode = String(codigoModulo || "").trim().toUpperCase();
      const moduleRows = await getModuleRowsByCodes(client, [moduleCode]);
      const moduleRow = moduleRows[0];
      const empresa = await client.query(
        `select id_empresa, slug, nombre_legal from empresas where id_empresa = $1 limit 1`,
        [idEmpresa]
      );
      if (empresa.rowCount === 0) throw HttpError.notFound("Empresa no encontrada");

      const before = await getCompanyModuleStates(client, idEmpresa);
      await client.query(
        `
          insert into empresas_modulos (
            id_empresa, id_modulo, activo, config, created_by, updated_by
          )
          values ($1,$2,$3,$4::jsonb,$5,$5)
          on conflict (id_empresa, id_modulo)
          do update
          set activo = excluded.activo,
              config = excluded.config,
              updated_at = now(),
              updated_by = excluded.updated_by
        `,
        [
          idEmpresa,
          moduleRow.id_modulo,
          activo !== false,
          JSON.stringify(config && typeof config === "object" ? config : {}),
          auth.id_usuario,
        ]
      );
      const after = await getCompanyModuleStates(client, idEmpresa);

      await client.query(
        `
          insert into saas_subscription_events (id_empresa, tipo_evento, metadata, created_by)
          values ($1, 'ADMIN_MODULE_CHANGED', $2::jsonb, $3)
        `,
        [
          idEmpresa,
          JSON.stringify({ modulo: moduleCode, activo: activo !== false }),
          auth.id_usuario,
        ]
      );

      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "EMPRESA_MODULO",
        entidadId: idEmpresa,
        accion: activo !== false ? "ENABLE_MODULE" : "DISABLE_MODULE",
        antes: before,
        despues: after,
      });

      return after;
    },
    { auth }
  );

export const listAddons = async () => {
  const result = await pool.query(
    `
      select
        a.codigo,
        a.nombre,
        a.descripcion,
        a.categoria,
        a.activo,
        a.visible_publico,
        a.trial_dias,
        a.requiere_plan_minimo,
        a.permite_trial,
        a.orden,
        a.metadata,
        coalesce(
          json_agg(
            distinct jsonb_build_object(
              'id_addon_price', ap.id_addon_price,
              'moneda', ap.moneda,
              'intervalo', ap.intervalo,
              'precio', ap.precio,
              'activo', ap.activo,
              'provider', ap.provider,
              'provider_price_id', ap.provider_price_id
            )
          ) filter (where ap.id_addon_price is not null),
          '[]'::json
        ) as precios,
        coalesce(
          json_agg(
            distinct jsonb_build_object(
              'codigo', m.codigo,
              'nombre', m.nombre,
              'activo', am.activo
            )
          ) filter (where m.id_modulo is not null),
          '[]'::json
        ) as modulos,
        coalesce(
          json_agg(
            distinct jsonb_build_object(
              'plan_codigo', pa.plan_codigo,
              'incluido', pa.incluido
            )
          ) filter (where pa.plan_codigo is not null),
          '[]'::json
        ) as planes_incluidos
      from saas_addons a
      left join saas_addon_prices ap on ap.addon_codigo = a.codigo
      left join saas_addon_modules am on am.addon_codigo = a.codigo
      left join modulos m on m.id_modulo = am.id_modulo
      left join saas_plan_addons pa on pa.addon_codigo = a.codigo
      group by a.codigo
      order by a.orden asc, a.codigo asc
    `
  );
  return result.rows;
};

const syncAddonModules = async (client, { addonCodigo, moduleCodes }) => {
  if (!Array.isArray(moduleCodes)) return;
  const moduleRows = await getModuleRowsByCodes(client, moduleCodes);
  await client.query(`delete from saas_addon_modules where addon_codigo = $1`, [
    addonCodigo,
  ]);
  for (const moduleRow of moduleRows) {
    await client.query(
      `
        insert into saas_addon_modules (addon_codigo, id_modulo, activo)
        values ($1,$2,true)
        on conflict (addon_codigo, id_modulo)
        do update set activo = true
      `,
      [addonCodigo, moduleRow.id_modulo]
    );
  }
};

const upsertAddonMonthlyPrice = async (
  client,
  { addonCodigo, precioMensual, moneda = "USD" }
) => {
  if (precioMensual === undefined) return;
  await client.query(
    `
      update saas_addon_prices
      set activo = false
      where addon_codigo = $1 and intervalo = 'MONTH' and moneda = $2
    `,
    [addonCodigo, moneda]
  );
  await client.query(
    `
      insert into saas_addon_prices (addon_codigo, moneda, intervalo, precio, activo)
      values ($1,$2,'MONTH',$3,true)
    `,
    [addonCodigo, moneda, precioMensual]
  );
};

export const createAddon = async ({ auth, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const payload = normalizeAddonPayload(body);
      if (payload.requiere_plan_minimo) {
        const plan = await client.query(
          `select 1 from saas_planes where codigo = $1 limit 1`,
          [payload.requiere_plan_minimo]
        );
        if (plan.rowCount === 0) throw HttpError.badRequest("Plan minimo no existe");
      }
      const result = await client.query(
        `
          insert into saas_addons (
            codigo, nombre, descripcion, categoria, activo, visible_publico,
            trial_dias, requiere_plan_minimo, permite_trial, orden, metadata
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          returning *
        `,
        [
          payload.codigo,
          payload.nombre,
          payload.descripcion,
          payload.categoria,
          payload.activo !== false,
          payload.visible_publico !== false,
          payload.trial_dias,
          payload.requiere_plan_minimo || null,
          payload.permite_trial !== false,
          payload.orden ?? 0,
          JSON.stringify(payload.metadata || {}),
        ]
      ).catch((error) => {
        if (error?.code === "23505") throw HttpError.conflict("Ya existe el add-on");
        throw error;
      });

      await syncAddonModules(client, {
        addonCodigo: payload.codigo,
        moduleCodes: payload.modulos || [],
      });
      await upsertAddonMonthlyPrice(client, {
        addonCodigo: payload.codigo,
        precioMensual: payload.precio_mensual,
        moneda: payload.moneda || "USD",
      });

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "SAAS_ADDON",
        entidadId: 0,
        accion: "CREATE",
        despues: result.rows[0],
      });
      return result.rows[0];
    },
    { auth }
  );

export const updateAddon = async ({ auth, codigo, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const addonCodigo = normalizeAddonCode(codigo);
      const current = await client.query(
        `select * from saas_addons where codigo = $1 limit 1`,
        [addonCodigo]
      );
      if (current.rowCount === 0) throw HttpError.notFound("Add-on no encontrado");
      const payload = normalizeAddonPayload(body, { partial: true });
      if (payload.requiere_plan_minimo) {
        const plan = await client.query(
          `select 1 from saas_planes where codigo = $1 limit 1`,
          [payload.requiere_plan_minimo]
        );
        if (plan.rowCount === 0) throw HttpError.badRequest("Plan minimo no existe");
      }

      const fields = [];
      const values = [];
      let index = 1;
      for (const [key, value] of Object.entries(payload)) {
        if (["codigo", "modulos", "precio_mensual", "moneda"].includes(key)) continue;
        fields.push(`${key} = $${index}${key === "metadata" ? "::jsonb" : ""}`);
        values.push(key === "metadata" ? JSON.stringify(value) : value);
        index += 1;
      }
      let updated = current.rows[0];
      if (fields.length > 0) {
        values.push(addonCodigo);
        const result = await client.query(
          `
            update saas_addons
            set ${fields.join(", ")}
            where codigo = $${index}
            returning *
          `,
          values
        );
        updated = result.rows[0];
      }
      await syncAddonModules(client, {
        addonCodigo,
        moduleCodes: payload.modulos,
      });
      await upsertAddonMonthlyPrice(client, {
        addonCodigo,
        precioMensual: payload.precio_mensual,
        moneda: payload.moneda || "USD",
      });

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "SAAS_ADDON",
        entidadId: 0,
        accion: "UPDATE",
        antes: current.rows[0],
        despues: updated,
      });
      return updated;
    },
    { auth }
  );

export const setPlanAddon = async ({
  auth,
  planCodigo,
  addonCodigo,
  incluido = true,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const planCode = normalizePlanCode(planCodigo);
      const addonCode = normalizeAddonCode(addonCodigo);
      const plan = await client.query(
        `select 1 from saas_planes where codigo = $1 limit 1`,
        [planCode]
      );
      const addon = await client.query(
        `select 1 from saas_addons where codigo = $1 limit 1`,
        [addonCode]
      );
      if (plan.rowCount === 0) throw HttpError.notFound("Plan no encontrado");
      if (addon.rowCount === 0) throw HttpError.notFound("Add-on no encontrado");
      await client.query(
        `
          insert into saas_plan_addons (plan_codigo, addon_codigo, incluido)
          values ($1,$2,$3)
          on conflict (plan_codigo, addon_codigo)
          do update set incluido = excluded.incluido
        `,
        [planCode, addonCode, incluido !== false]
      );
      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "SAAS_PLAN_ADDON",
        entidadId: 0,
        accion: incluido !== false ? "INCLUDE_ADDON" : "EXCLUDE_ADDON",
        despues: { plan_codigo: planCode, addon_codigo: addonCode, incluido: incluido !== false },
      });
      return { plan_codigo: planCode, addon_codigo: addonCode, incluido: incluido !== false };
    },
    { auth }
  );

export const setEmpresaAddon = async ({
  auth,
  idEmpresa,
  addonCodigo,
  estado = "ACTIVO",
  trialHasta = null,
  vigenteHasta = null,
  limites = {},
  metadata = {},
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const addonCode = normalizeAddonCode(addonCodigo);
      const nextEstado = String(estado || "ACTIVO").trim().toUpperCase();
      if (!["TRIAL", "ACTIVO", "VENCIDO", "SUSPENDIDO", "CANCELADO"].includes(nextEstado)) {
        throw HttpError.badRequest("estado de add-on invalido");
      }
      const empresa = await client.query(
        `select id_empresa from empresas where id_empresa = $1 limit 1`,
        [idEmpresa]
      );
      const addon = await client.query(
        `select codigo, trial_dias from saas_addons where codigo = $1 and activo = true limit 1`,
        [addonCode]
      );
      const before = await client.query(
        `select * from empresa_addons where id_empresa = $1 and addon_codigo = $2 limit 1`,
        [idEmpresa, addonCode]
      );
      if (empresa.rowCount === 0) throw HttpError.notFound("Empresa no encontrada");
      if (addon.rowCount === 0) throw HttpError.notFound("Add-on no disponible");

      const computedTrialHasta =
        nextEstado === "TRIAL" && !trialHasta
          ? new Date(Date.now() + Number(addon.rows[0].trial_dias || 0) * 86400000)
              .toISOString()
              .slice(0, 10)
          : trialHasta;

      const result = await client.query(
        `
          insert into empresa_addons (
            id_empresa, addon_codigo, estado, origen, trial_hasta,
            vigente_hasta, limites, metadata, created_by, updated_by
          )
          values ($1,$2,$3,'MANUAL',$4::date,$5::date,$6::jsonb,$7::jsonb,$8,$8)
          on conflict (id_empresa, addon_codigo)
          do update
          set estado = excluded.estado,
              origen = 'MANUAL',
              trial_hasta = excluded.trial_hasta,
              vigente_hasta = excluded.vigente_hasta,
              limites = excluded.limites,
              metadata = excluded.metadata,
              updated_by = excluded.updated_by
          returning *
        `,
        [
          idEmpresa,
          addonCode,
          nextEstado,
          computedTrialHasta || null,
          vigenteHasta || null,
          JSON.stringify(limites && typeof limites === "object" ? limites : {}),
          JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}),
          auth.id_usuario,
        ]
      );

      await client.query(
        `
          insert into empresa_addon_events (
            id_empresa, addon_codigo, tipo_evento, estado_anterior,
            estado_nuevo, metadata, created_by
          )
          values ($1,$2,'ADMIN_ADDON_CHANGED',$3,$4,$5::jsonb,$6)
        `,
        [
          idEmpresa,
          addonCode,
          before.rows[0]?.estado || null,
          nextEstado,
          JSON.stringify({ trial_hasta: computedTrialHasta || null, vigente_hasta: vigenteHasta || null }),
          auth.id_usuario,
        ]
      );

      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      await writeAuditEvent(client, {
        auth,
        requestMeta,
        modulo: "PLATAFORMA",
        entidad: "EMPRESA_ADDON",
        entidadId: idEmpresa,
        accion: "SET_ADDON",
        antes: before.rows[0] || null,
        despues: result.rows[0],
      });
      return result.rows[0];
    },
    { auth }
  );

/**
 * Suspender manualmente una empresa (admin override sobre Stripe).
 */
export const suspendEmpresa = async ({ auth, idEmpresa, motivo, requestMeta }) => {
  const r = await pool.query(
    `update empresas set saas_estado = 'SUSPENDIDA'
     where id_empresa = $1
     returning slug, nombre_legal`,
    [idEmpresa]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Empresa no encontrada");

  await pool.query(
    `insert into saas_subscription_events (id_empresa, tipo_evento, metadata)
     values ($1, 'ADMIN_SUSPEND', $2::jsonb)`,
    [idEmpresa, JSON.stringify({ motivo, by: auth.id_usuario })]
  );

  await writeAuditEvent(pool, {
    auth,
    requestMeta,
    modulo: "PLATAFORMA",
    entidad: "EMPRESA",
    entidadId: idEmpresa,
    accion: "SUSPEND",
    despues: { motivo },
  });

  return r.rows[0];
};

export const reactivateEmpresa = async ({ auth, idEmpresa, requestMeta }) => {
  const r = await pool.query(
    `update empresas set saas_estado = 'ACTIVA'
     where id_empresa = $1
     returning slug, nombre_legal`,
    [idEmpresa]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Empresa no encontrada");

  await pool.query(
    `insert into saas_subscription_events (id_empresa, tipo_evento, metadata)
     values ($1, 'ADMIN_REACTIVATE', $2::jsonb)`,
    [idEmpresa, JSON.stringify({ by: auth.id_usuario })]
  );

  await writeAuditEvent(pool, {
    auth,
    requestMeta,
    modulo: "PLATAFORMA",
    entidad: "EMPRESA",
    entidadId: idEmpresa,
    accion: "REACTIVATE",
  });

  return r.rows[0];
};

/**
 * Impersonacion: emite un access token como el ADMIN_EMPRESA de la empresa
 * indicada. AUDITADO. La duracion es CORTA (30min) para limitar el riesgo.
 *
 * El JWT lleva `impersonated_by: <super_admin_id>` para que el sistema
 * marque cada accion como hecha en impersonacion (todavia no usado en el
 * resto del codigo — siguiente milestone).
 */
export const impersonate = async ({ auth, idEmpresa, requestMeta }) => {
  // 1) Encontrar un usuario admin activo de la empresa target
  const adminQuery = await pool.query(
    `select u.id_usuario, u.id_empresa, u.id_sucursal_default, u.username,
            u.email, u.nombre, u.apellido,
            e.slug as empresa_slug, e.nombre_legal
     from usuarios u
     inner join empresas e on e.id_empresa = u.id_empresa
     inner join usuarios_roles ur on ur.id_usuario = u.id_usuario
     inner join roles r on r.id_rol = ur.id_rol
     where u.id_empresa = $1
       and u.activo = true
       and r.codigo in ('ADMIN_EMPRESA', 'SUPER_ADMIN')
     order by u.id_usuario asc
     limit 1`,
    [idEmpresa]
  );

  if (adminQuery.rowCount === 0) {
    throw HttpError.notFound(
      "La empresa no tiene un admin activo para impersonar"
    );
  }
  const targetUser = adminQuery.rows[0];

  // 2) Resolver sucursales asignadas + modulos efectivos + permisos
  const sucResult = await pool.query(
    `select s.id_sucursal
     from usuarios_sucursales us
     inner join sucursales s on s.id_sucursal = us.id_sucursal
                            and s.id_empresa = us.id_empresa
     where us.id_empresa = $1 and us.id_usuario = $2 and s.activa = true
     order by us.es_predeterminada desc, s.id_sucursal asc`,
    [idEmpresa, targetUser.id_usuario]
  );
  const sucursalesIds = sucResult.rows.map((r) => Number(r.id_sucursal));
  const activeSucursal =
    sucursalesIds[0] || Number(targetUser.id_sucursal_default) || null;

  if (!activeSucursal) {
    throw HttpError.conflict(
      "El admin de la empresa no tiene sucursales asignadas"
    );
  }

  const modulosResult = await pool.query(
    `select unnest(app.modulos_efectivos($1)) as codigo`,
    [idEmpresa]
  );
  const modulos = modulosResult.rows.map((r) => r.codigo).filter(Boolean);

  const rolesResult = await pool.query(
    `select r.id_rol, r.codigo, r.nombre, r.es_sistema, r.permisos
     from usuarios_roles ur
     inner join roles r on r.id_rol = ur.id_rol
     where ur.id_empresa = $1 and ur.id_usuario = $2`,
    [idEmpresa, targetUser.id_usuario]
  );
  const rolPrimary = "ADMIN_EMPRESA"; // forzamos para no escalar a SUPER_ADMIN ajeno
  const permisos = computeEffectivePermissions({
    rol: rolPrimary,
    roles: rolesResult.rows,
  });

  // 3) Emitir token con expiry corto + marca de impersonacion
  const tokenPayload = {
    id_usuario: Number(targetUser.id_usuario),
    id_empresa: Number(targetUser.id_empresa),
    id_sucursal: Number(activeSucursal),
    rol: rolPrimary,
    sucursales: sucursalesIds,
    modulos,
    permisos,
    empresa: {
      slug: targetUser.empresa_slug,
      nombre_legal: targetUser.nombre_legal,
    },
    impersonated_by: Number(auth.id_usuario),
    impersonation: true,
  };

  // Sobreescribimos el JWT expires con 30min para limitar duracion
  const token = signAccessToken(tokenPayload, { expiresIn: "30m" });

  // 4) Auditoria — accion criticamente registrada
  await writeAuditEvent(pool, {
    auth,
    requestMeta,
    modulo: "PLATAFORMA",
    entidad: "IMPERSONATION",
    entidadId: idEmpresa,
    accion: "START",
    despues: {
      target_usuario: targetUser.id_usuario,
      target_empresa: idEmpresa,
      target_username: targetUser.username,
      expires_in: "30m",
    },
  });

  return {
    token,
    impersonation: true,
    target: {
      id_empresa: Number(targetUser.id_empresa),
      slug: targetUser.empresa_slug,
      nombre_legal: targetUser.nombre_legal,
      id_usuario: Number(targetUser.id_usuario),
      username: targetUser.username,
    },
    expires_in: "30m",
  };
};
