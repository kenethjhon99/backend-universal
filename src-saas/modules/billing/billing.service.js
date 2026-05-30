import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { logger } from "../../shared/logging/logger.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { invalidateCompanyStatusCache } from "../../middlewares/authenticate.js";
import { invalidatePlanLimitCache } from "../../middlewares/enforce-plan-limits.js";
import { notify } from "../notificaciones/notificaciones.service.js";

/**
 * Helper: dispara notificacion de billing sin que un fallo de envio rompa
 * el procesamiento del webhook. Logea pero no relanza.
 */
const safeNotify = async (idEmpresa, tipoEvento, payload) => {
  try {
    await notify({ idEmpresa, tipoEvento, payload });
  } catch (err) {
    logger.warn(
      { err: err.message, idEmpresa, tipoEvento },
      "fallo notify (no critico, webhook continua)"
    );
  }
};

const auditBillingEvent = async ({
  idEmpresa,
  auth = null,
  requestMeta = null,
  accion,
  entidad = "BILLING",
  entidadId = 0,
  despues = null,
}) => {
  try {
    await writeAuditEvent(pool, {
      auth: auth || {
        id_empresa: idEmpresa || null,
        id_usuario: null,
      },
      requestMeta,
      modulo: "BILLING",
      entidad,
      entidadId,
      accion,
      despues,
    });
  } catch (error) {
    logger.warn(
      { err: error.message, idEmpresa, accion },
      "billing audit event failed"
    );
  }
};

const getEmpresaInfo = async (idEmpresa) => {
  const r = await pool.query(
    `select nombre_legal, slug, saas_plan_codigo from empresas where id_empresa = $1`,
    [idEmpresa]
  );
  return r.rows[0] || null;
};

const LIMIT_FIELDS = [
  ["sucursales", "sucursales_count", "max_sucursales"],
  ["usuarios", "usuarios_count", "max_usuarios"],
  ["productos", "productos_count", "max_productos"],
  ["cajas", "cajas_count", "max_cajas"],
  ["bodegas", "bodegas_count", "max_bodegas"],
  ["ventas_mes", "ventas_mes_count", "max_ventas_mes"],
  ["storage_mb", "storage_mb_count", "max_storage_mb"],
  ["api_requests_mes", "api_requests_mes_count", "max_api_requests_mes"],
];

const toNumberOrNull = (value) =>
  value === null || value === undefined ? null : Number(value);

const buildUsageLimits = (row) =>
  LIMIT_FIELDS.map(([recurso, currentField, maxField]) => {
    const current = Number(row?.[currentField] || 0);
    const max = toNumberOrNull(row?.[maxField]);
    const ratio = max && max > 0 ? current / max : null;
    const percent = ratio == null ? null : Math.round(ratio * 100);
    const estado =
      ratio == null
        ? "SIN_LIMITE"
        : ratio >= 1
          ? "BLOQUEADO"
          : ratio >= 0.9
            ? "CRITICO"
            : ratio >= 0.8
              ? "ADVERTENCIA"
              : "OK";

    return { recurso, current, max, percent, estado };
  });

export const listPlanes = async ({ publico = false } = {}) => {
  const filters = ["activo = true"];
  if (publico) filters.push("visible_publico = true");

  const result = await pool.query(
    `
      select
        codigo,
        nombre,
        descripcion,
        precio_mensual,
        precio_anual,
        moneda,
        trial_dias,
        max_sucursales,
        max_usuarios,
        max_ventas_mes,
        max_productos,
        max_cajas,
        max_bodegas,
        max_storage_mb,
        max_api_requests_mes,
        modulos_incluidos,
        permite_addons,
        requiere_contacto,
        visible_publico,
        orden
      from saas_planes
      where ${filters.join(" and ")}
      order by orden asc, precio_mensual asc
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

export const listAddons = async ({ publico = false } = {}) => {
  const filters = ["a.activo = true"];
  if (publico) filters.push("a.visible_publico = true");

  const result = await pool.query(
    `
      select
        a.codigo,
        a.nombre,
        a.descripcion,
        a.categoria,
        a.trial_dias,
        a.requiere_plan_minimo,
        a.permite_trial,
        a.metadata,
        coalesce(
          json_agg(
            jsonb_build_object(
              'moneda', ap.moneda,
              'intervalo', ap.intervalo,
              'precio', ap.precio,
              'provider', ap.provider,
              'provider_price_id', ap.provider_price_id
            )
            order by ap.intervalo asc, ap.precio asc
          ) filter (where ap.id_addon_price is not null and ap.activo = true),
          '[]'::json
        ) as precios,
        coalesce(
          json_agg(
            distinct jsonb_build_object('codigo', m.codigo, 'nombre', m.nombre)
          ) filter (where m.id_modulo is not null),
          '[]'::json
        ) as modulos
      from saas_addons a
      left join saas_addon_prices ap on ap.addon_codigo = a.codigo
      left join saas_addon_modules am
        on am.addon_codigo = a.codigo
       and am.activo = true
      left join modulos m on m.id_modulo = am.id_modulo
      where ${filters.join(" and ")}
      group by a.codigo
      order by a.orden asc, a.codigo asc
    `
  );
  return result.rows;
};

export const getSubscriptionOverview = async ({ auth }) => {
  const result = await pool.query(
    `
      select
        e.id_empresa,
        e.slug,
        e.nombre_legal,
        e.saas_plan_codigo,
        e.saas_estado,
        e.saas_trial_hasta,
        e.saas_renovacion_hasta,
        e.saas_billing_email,
        e.billing_provider,
        e.billing_subscription_id,
        p.nombre as plan_nombre,
        p.descripcion as plan_descripcion,
        p.precio_mensual,
        p.precio_anual,
        p.moneda,
        p.trial_dias,
        p.max_sucursales,
        p.max_usuarios,
        p.max_ventas_mes,
        p.max_productos,
        p.max_cajas,
        p.max_bodegas,
        p.max_storage_mb,
        p.max_api_requests_mes,
        p.modulos_incluidos,
        p.permite_addons,
        p.requiere_contacto,
        coalesce(u.sucursales_count, 0) as sucursales_count,
        coalesce(u.usuarios_count, 0) as usuarios_count,
        coalesce(u.bodegas_count, 0) as bodegas_count,
        coalesce(u.ventas_mes_count, 0) as ventas_mes_count,
        coalesce(u.productos_count, 0) as productos_count,
        coalesce(u.cajas_count, 0) as cajas_count,
        ceil(coalesce(u.storage_bytes, 0)::numeric / 1048576)::int as storage_mb_count,
        coalesce(u.api_requests_mes_count, 0) as api_requests_mes_count,
        array(select unnest(app.modulos_efectivos(e.id_empresa))) as modulos_efectivos,
        array(select unnest(app.addons_efectivos(e.id_empresa))) as addons_efectivos
      from empresas e
      left join saas_planes p on p.codigo = e.saas_plan_codigo
      left join empresa_uso_actual u on u.id_empresa = e.id_empresa
      where e.id_empresa = $1
      limit 1
    `,
    [auth.id_empresa]
  );

  const row = result.rows[0];
  if (!row) throw HttpError.notFound("Empresa no encontrada");

  const today = new Date().toISOString().slice(0, 10);
  const enTrial = row.saas_estado === "TRIAL";
  const trialVencido = enTrial && row.saas_trial_hasta && row.saas_trial_hasta < today;
  const limites = buildUsageLimits(row);

  const addonsResult = await pool.query(
    `
      select
        ea.addon_codigo,
        a.nombre,
        a.descripcion,
        a.categoria,
        ea.estado,
        ea.origen,
        ea.trial_hasta,
        ea.vigente_desde,
        ea.vigente_hasta,
        ea.renovacion_hasta,
        ea.cantidad,
        ea.limites
      from empresa_addons ea
      inner join saas_addons a on a.codigo = ea.addon_codigo
      where ea.id_empresa = $1
      order by a.orden asc, a.codigo asc
    `,
    [auth.id_empresa]
  );

  return {
    empresa: {
      id_empresa: Number(row.id_empresa),
      slug: row.slug,
      nombre_legal: row.nombre_legal,
    },
    suscripcion: {
      estado: row.saas_estado,
      plan_codigo: row.saas_plan_codigo,
      trial_hasta: row.saas_trial_hasta,
      renovacion_hasta: row.saas_renovacion_hasta,
      billing_email: row.saas_billing_email,
      billing_provider: row.billing_provider,
      billing_subscription_id: row.billing_subscription_id,
      en_trial: enTrial,
      trial_vencido: trialVencido,
    },
    plan: row.saas_plan_codigo
      ? {
          codigo: row.saas_plan_codigo,
          nombre: row.plan_nombre,
          descripcion: row.plan_descripcion,
          precio_mensual: Number(row.precio_mensual || 0),
          precio_anual:
            row.precio_anual === null || row.precio_anual === undefined
              ? null
              : Number(row.precio_anual),
          moneda: row.moneda,
          modulos_incluidos: row.modulos_incluidos || [],
          permite_addons: row.permite_addons !== false,
          requiere_contacto: row.requiere_contacto === true,
        }
      : null,
    limites,
    alertas_limite: limites.filter((item) =>
      ["ADVERTENCIA", "CRITICO", "BLOQUEADO"].includes(item.estado)
    ),
    modulos_efectivos: row.modulos_efectivos || [],
    addons_efectivos: row.addons_efectivos || [],
    addons_contratados: addonsResult.rows,
  };
};

let stripeInstance = null;

/**
 * Stripe-import perezoso para no requerirlo si la app no usa billing.
 */
const getStripe = async () => {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw HttpError.serviceUnavailable(
      "Billing no esta configurado: STRIPE_SECRET_KEY no esta seteada",
      { feature: "billing", missing_env: "STRIPE_SECRET_KEY" }
    );
  }
  if (stripeInstance) return stripeInstance;
  const Stripe = (await import("stripe")).default;
  stripeInstance = new Stripe(secret, { apiVersion: "2024-09-30.acacia" });
  return stripeInstance;
};

/**
 * Devuelve el secret del webhook de Stripe, o lanza 503 si falta.
 * Llamado desde handleStripeWebhook para no aceptar firmas no verificables.
 */
export const getStripeWebhookSecret = () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw HttpError.serviceUnavailable(
      "Billing webhook no esta configurado: STRIPE_WEBHOOK_SECRET no esta seteada",
      { feature: "billing.webhook", missing_env: "STRIPE_WEBHOOK_SECRET" }
    );
  }
  return secret;
};

/**
 * Crea (o reusa) un customer de Stripe para la empresa actual.
 */
const ensureStripeCustomer = async (auth) => {
  const result = await pool.query(
    `select id_empresa, slug, nombre_legal, saas_billing_email,
            billing_provider, billing_customer_id
     from empresas where id_empresa = $1`,
    [auth.id_empresa]
  );
  const empresa = result.rows[0];
  if (!empresa) throw HttpError.notFound("Empresa no encontrada");

  if (empresa.billing_provider === "stripe" && empresa.billing_customer_id) {
    return empresa.billing_customer_id;
  }

  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: empresa.saas_billing_email || undefined,
    name: empresa.nombre_legal,
    metadata: {
      id_empresa: String(empresa.id_empresa),
      slug: empresa.slug,
    },
  });

  await pool.query(
    `update empresas
       set billing_provider = 'stripe',
           billing_customer_id = $1
     where id_empresa = $2`,
    [customer.id, auth.id_empresa]
  );

  return customer.id;
};

/**
 * Crea una sesion de Checkout (Stripe Hosted) para que la empresa pague el
 * upgrade de su plan SaaS. Devuelve la URL a la que el frontend redirige.
 */
export const createCheckoutSession = async ({ auth, body, requestMeta = null }) => {
  const planCodigo = String(body?.plan_codigo || "").toUpperCase();
  if (!planCodigo) {
    throw HttpError.badRequest("plan_codigo es requerido");
  }
  const planResult = await pool.query(
    `select * from saas_planes where codigo = $1 and activo = true`,
    [planCodigo]
  );
  const plan = planResult.rows[0];
  if (!plan) throw HttpError.badRequest(`Plan ${planCodigo} no disponible`);
  if (Number(plan.precio_mensual) <= 0) {
    throw HttpError.badRequest("Este plan no requiere pago");
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(auth);

  const successUrl =
    body?.success_url ||
    process.env.STRIPE_SUCCESS_URL ||
    "https://example.com/billing/success";
  const cancelUrl =
    body?.cancel_url ||
    process.env.STRIPE_CANCEL_URL ||
    "https://example.com/billing/cancel";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [
      {
        price_data: {
          currency: String(plan.moneda || "USD").toLowerCase(),
          product_data: {
            name: `TradeNova - ${plan.nombre}`,
            description: plan.descripcion || undefined,
          },
          unit_amount: Math.round(Number(plan.precio_mensual) * 100),
          recurring: { interval: "month" },
        },
        quantity: 1,
      },
    ],
    metadata: {
      id_empresa: String(auth.id_empresa),
      plan_codigo: plan.codigo,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await auditBillingEvent({
    idEmpresa: auth.id_empresa,
    auth,
    requestMeta,
    accion: "CHECKOUT_SESSION_CREATED",
    entidad: "CHECKOUT_SESSION",
    despues: {
      plan_codigo: plan.codigo,
      stripe_session_id: session.id,
    },
  });

  return { url: session.url, session_id: session.id };
};

export const createAddonCheckoutSession = async ({
  auth,
  body,
  requestMeta = null,
}) => {
  const addonCodigo = String(body?.addon_codigo || "").trim().toUpperCase();
  if (!addonCodigo) {
    throw HttpError.badRequest("addon_codigo es requerido");
  }

  const addonResult = await pool.query(
    `
      select
        a.codigo,
        a.nombre,
        a.descripcion,
        a.requiere_plan_minimo,
        p.id_addon_price,
        p.moneda,
        p.intervalo,
        p.precio,
        p.provider_price_id,
        sp.permite_addons
      from saas_addons a
      inner join saas_addon_prices p
        on p.addon_codigo = a.codigo
       and p.activo = true
       and p.intervalo = 'MONTH'
      inner join empresas e on e.id_empresa = $2
      left join saas_planes sp on sp.codigo = e.saas_plan_codigo
      where a.codigo = $1
        and a.activo = true
      order by p.precio asc
      limit 1
    `,
    [addonCodigo, auth.id_empresa]
  );
  const addon = addonResult.rows[0];
  if (!addon) throw HttpError.badRequest(`Add-on ${addonCodigo} no disponible`);
  if (addon.permite_addons === false) {
    throw HttpError.paymentRequired("Tu plan actual no permite contratar add-ons", {
      reason: "plan_addons_not_allowed",
      addon: addonCodigo,
    });
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(auth);
  const successUrl =
    body?.success_url ||
    process.env.STRIPE_SUCCESS_URL ||
    "https://example.com/billing/success";
  const cancelUrl =
    body?.cancel_url ||
    process.env.STRIPE_CANCEL_URL ||
    "https://example.com/billing/cancel";

  const lineItem = addon.provider_price_id
    ? { price: addon.provider_price_id, quantity: 1 }
    : {
        price_data: {
          currency: String(addon.moneda || "USD").toLowerCase(),
          product_data: {
            name: `TradeNova Add-on - ${addon.nombre}`,
            description: addon.descripcion || undefined,
          },
          unit_amount: Math.round(Number(addon.precio) * 100),
          recurring: { interval: "month" },
        },
        quantity: 1,
      };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [lineItem],
    metadata: {
      id_empresa: String(auth.id_empresa),
      addon_codigo: addon.codigo,
      billing_kind: "addon",
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await auditBillingEvent({
    idEmpresa: auth.id_empresa,
    auth,
    requestMeta,
    accion: "ADDON_CHECKOUT_SESSION_CREATED",
    entidad: "CHECKOUT_SESSION",
    despues: {
      addon_codigo: addon.codigo,
      stripe_session_id: session.id,
    },
  });

  return { url: session.url, session_id: session.id };
};

/**
 * Procesa un evento webhook de Stripe. Verifica firma, registra en
 * billing_events (idempotencia por event_id), y aplica el efecto en la
 * empresa correspondiente (activar plan, suspender, etc.).
 */
export const handleStripeWebhook = async ({ rawBody, signature, requestMeta = null }) => {
  const stripe = await getStripe();
  const webhookSecret = getStripeWebhookSecret();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw HttpError.badRequest(`Webhook signature invalido: ${err.message}`);
  }

  // Resolver id_empresa desde metadata o customer
  let idEmpresa = null;
  const metadataEmpresa = event.data?.object?.metadata?.id_empresa;
  if (metadataEmpresa) {
    idEmpresa = Number(metadataEmpresa);
  } else if (event.data?.object?.customer) {
    const result = await pool.query(
      `select id_empresa from empresas where billing_customer_id = $1 limit 1`,
      [event.data.object.customer]
    );
    if (result.rows[0]) idEmpresa = Number(result.rows[0].id_empresa);
  }

  // Idempotencia: insert con unique (provider, event_id)
  const insert = await pool.query(
    `
      insert into billing_events (id_empresa, provider, event_id, event_type, payload)
      values ($1, 'stripe', $2, $3, $4::jsonb)
      on conflict (provider, event_id) do nothing
      returning id_event
    `,
    [idEmpresa, event.id, event.type, JSON.stringify(event)]
  );

  if (insert.rowCount === 0) {
    logger.info({ eventId: event.id }, "stripe webhook duplicado, ignorado");
    return { ok: true, duplicated: true };
  }

  // Procesar segun tipo
  let resultado = "no-op";

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const planCodigo = session.metadata?.plan_codigo;
    const addonCodigo = session.metadata?.addon_codigo;
    if (idEmpresa && addonCodigo && session.subscription) {
      await pool.query(
        `
          insert into empresa_addons (
            id_empresa,
            addon_codigo,
            estado,
            origen,
            billing_provider,
            billing_subscription_item_id,
            billing_price_id,
            created_by,
            updated_by
          )
          values ($1,$2,'ACTIVO','CHECKOUT','stripe',$3,$4,null,null)
          on conflict (id_empresa, addon_codigo)
          do update
          set estado = 'ACTIVO',
              origen = 'CHECKOUT',
              billing_provider = 'stripe',
              billing_subscription_item_id = excluded.billing_subscription_item_id,
              billing_price_id = excluded.billing_price_id
        `,
        [
          idEmpresa,
          addonCodigo,
          session.subscription,
          session.metadata?.price_id || null,
        ]
      );
      await pool.query(
        `
          insert into empresa_addon_events (
            id_empresa, addon_codigo, tipo_evento, estado_nuevo, metadata
          )
          values ($1,$2,'ADDON_ACTIVATED','ACTIVO',$3::jsonb)
        `,
        [
          idEmpresa,
          addonCodigo,
          JSON.stringify({ stripe_session: session.id, subscription: session.subscription }),
        ]
      );
      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);
      resultado = "addon-activated";
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "ADDON_ACTIVATED",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: {
          event_id: event.id,
          addon_codigo: addonCodigo,
          subscription_id: session.subscription,
        },
      });
    } else if (idEmpresa && planCodigo && session.subscription) {
      await pool.query(
        `
          update empresas
            set saas_plan_codigo = $1,
                saas_estado = 'ACTIVA',
                saas_trial_hasta = null,
                billing_subscription_id = $2
          where id_empresa = $3
        `,
        [planCodigo, session.subscription, idEmpresa]
      );

      await pool.query(
        `
          insert into saas_subscription_events (id_empresa, tipo_evento, plan_codigo, metadata)
          values ($1, 'PLAN_ACTIVATED', $2, $3::jsonb)
        `,
        [idEmpresa, planCodigo, JSON.stringify({ stripe_session: session.id })]
      );
      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      const empresa = await getEmpresaInfo(idEmpresa);
      await safeNotify(idEmpresa, "BILLING_REACTIVATED", {
        empresa: empresa?.nombre_legal || empresa?.slug,
        plan: planCodigo,
      });

      resultado = "plan-activated";
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "PLAN_ACTIVATED",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: {
          event_id: event.id,
          plan_codigo: planCodigo,
          subscription_id: session.subscription,
        },
      });
    }
  } else if (event.type === "invoice.paid") {
    if (idEmpresa) {
      await pool.query(
        `update empresas set saas_estado = 'ACTIVA' where id_empresa = $1`,
        [idEmpresa]
      );
      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      const empresa = await getEmpresaInfo(idEmpresa);
      await safeNotify(idEmpresa, "BILLING_REACTIVATED", {
        empresa: empresa?.nombre_legal || empresa?.slug,
        plan: empresa?.saas_plan_codigo,
      });

      resultado = "invoice-paid";
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "INVOICE_PAID",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: { event_id: event.id },
      });
    }
  } else if (event.type === "invoice.payment_failed") {
    // Primer aviso pero NO suspende todavia. Stripe reintenta varias veces;
    // si todos los reintentos fallan, llega customer.subscription.deleted.
    // Aqui solo notificamos al cliente para que actualice metodo de pago.
    if (idEmpresa) {
      const empresa = await getEmpresaInfo(idEmpresa);
      await safeNotify(idEmpresa, "BILLING_PAYMENT_FAILED", {
        empresa: empresa?.nombre_legal || empresa?.slug,
        plan: empresa?.saas_plan_codigo,
      });
      resultado = "payment-failed-notified";
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "PAYMENT_FAILED",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: { event_id: event.id },
      });
    }
  } else if (event.type === "customer.subscription.deleted") {
    // Stripe agoto los reintentos o el cliente cancelo: ahora SI suspendemos.
    if (idEmpresa) {
      await pool.query(
        `update empresas set saas_estado = 'CANCELADA' where id_empresa = $1`,
        [idEmpresa]
      );
      await pool.query(
        `
          insert into saas_subscription_events (id_empresa, tipo_evento, metadata)
          values ($1, $2, $3::jsonb)
        `,
        [idEmpresa, event.type, JSON.stringify({ stripe_event: event.id })]
      );
      invalidateCompanyStatusCache(idEmpresa);
      invalidatePlanLimitCache(idEmpresa);

      const empresa = await getEmpresaInfo(idEmpresa);
      await safeNotify(idEmpresa, "BILLING_CANCELLED", {
        empresa: empresa?.nombre_legal || empresa?.slug,
      });

      resultado = "cancelled";
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "SUBSCRIPTION_CANCELLED",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: { event_id: event.id },
      });
    }
  } else if (event.type === "customer.subscription.updated") {
    // Reactivacion manual desde Stripe dashboard, cambios de plan, etc.
    if (idEmpresa) {
      const sub = event.data.object;
      const stripeStatus = String(sub.status || "").toLowerCase();
      let nuevoEstado = null;
      if (["active", "trialing"].includes(stripeStatus)) nuevoEstado = "ACTIVA";
      else if (stripeStatus === "past_due") nuevoEstado = "SUSPENDIDA";
      else if (["canceled", "incomplete_expired"].includes(stripeStatus))
        nuevoEstado = "CANCELADA";

      if (nuevoEstado) {
        await pool.query(
          `update empresas set saas_estado = $1 where id_empresa = $2`,
          [nuevoEstado, idEmpresa]
        );
        invalidateCompanyStatusCache(idEmpresa);
        invalidatePlanLimitCache(idEmpresa);

        if (nuevoEstado === "SUSPENDIDA") {
          const empresa = await getEmpresaInfo(idEmpresa);
          await safeNotify(idEmpresa, "BILLING_SUSPENDED", {
            empresa: empresa?.nombre_legal || empresa?.slug,
            motivo: "pago vencido",
          });
        }
      }
      resultado = `sub-updated:${stripeStatus}`;
      await auditBillingEvent({
        idEmpresa,
        requestMeta,
        accion: "SUBSCRIPTION_UPDATED",
        entidad: "STRIPE_WEBHOOK",
        entidadId: insert.rows[0]?.id_event,
        despues: {
          event_id: event.id,
          stripe_status: stripeStatus,
          saas_estado: nuevoEstado,
        },
      });
    }
  }

  await pool.query(
    `
      update billing_events
        set procesado_en = now(),
            procesamiento_resultado = $1
      where provider = 'stripe' and event_id = $2
    `,
    [resultado, event.id]
  );

  return { ok: true, processed: true, resultado };
};

/**
 * Devuelve los ultimos eventos de billing de la empresa (para debugging).
 */
export const listEventos = async ({ auth }) => {
  const result = await pool.query(
    `
      select id_event, provider, event_id, event_type, procesado_en,
             procesamiento_resultado, created_at
      from billing_events
      where id_empresa = $1
      order by created_at desc
      limit 50
    `,
    [auth.id_empresa]
  );
  return result.rows;
};
