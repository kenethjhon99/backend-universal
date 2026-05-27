import { HttpError } from "../http/http-error.js";

export const DEFAULT_BRANDING = {
  nombre_comercial: process.env.SAAS_BRAND_NAME || "Sistema Universal POS",
  nombre_legal: null,
  slogan:
    process.env.SAAS_BRAND_SLOGAN ||
    "El sistema se adapta a tu negocio, no tu negocio al sistema.",
  logo_principal_url: process.env.SAAS_BRAND_LOGO_URL || null,
  logo_secundario_url: null,
  logo_dark_url: null,
  favicon_url: process.env.SAAS_BRAND_FAVICON_URL || null,
  color_primario: process.env.SAAS_BRAND_PRIMARY || "#2563eb",
  color_secundario: process.env.SAAS_BRAND_SECONDARY || "#0f172a",
  color_acento: process.env.SAAS_BRAND_ACCENT || "#16a34a",
  modo_oscuro: false,
  login: {
    hero_image_url: process.env.SAAS_BRAND_HERO_IMAGE_URL || null,
    beneficios: [],
  },
  dashboard: {},
  nav: {},
  documentos: {},
  email: {},
  pwa: {},
};

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const URL_MAX_LENGTH = 2048;

const URL_FIELDS = [
  "logo_principal_url",
  "logo_secundario_url",
  "logo_dark_url",
  "favicon_url",
];

const JSON_FIELDS = [
  "login",
  "dashboard",
  "nav",
  "documentos",
  "email",
  "pwa",
];

const pickString = (value, maxLength) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const normalizeUrl = (value) => {
  const text = pickString(value, URL_MAX_LENGTH);
  if (!text) return null;
  if (text.startsWith("/") || text.startsWith("https://")) return text;
  throw HttpError.badRequest(
    "Las URLs de branding deben ser HTTPS o rutas relativas publicas"
  );
};

const normalizeColor = (value, fallback) => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (!HEX_COLOR_RE.test(text)) {
    throw HttpError.badRequest("Los colores de branding deben usar formato #RRGGBB");
  }
  return text.toLowerCase();
};

const normalizeJson = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
};

export const normalizeBranding = (branding = {}, fallback = DEFAULT_BRANDING) => {
  const safe = branding && typeof branding === "object" ? branding : {};
  const login =
    safe.login && typeof safe.login === "object"
      ? safe.login
      : {
          hero_image_url: safe.hero_image_url || null,
          beneficios: safe.beneficios || [],
        };

  return {
    ...fallback,
    ...safe,
    logo_url:
      safe.logo_url ||
      safe.logo_principal_url ||
      fallback.logo_principal_url ||
      null,
    hero_image_url:
      safe.hero_image_url || login?.hero_image_url || fallback.login?.hero_image_url || null,
    login: {
      ...(fallback.login || {}),
      ...normalizeJson(login),
    },
    dashboard: normalizeJson(safe.dashboard || fallback.dashboard),
    nav: normalizeJson(safe.nav || fallback.nav),
    documentos: normalizeJson(safe.documentos || fallback.documentos),
    email: normalizeJson(safe.email || fallback.email),
    pwa: normalizeJson(safe.pwa || fallback.pwa),
  };
};

export const normalizeBrandingInput = (body = {}) => {
  const normalized = {
    nombre_comercial: pickString(body.nombre_comercial, 160),
    slogan: pickString(body.slogan, 240),
    color_primario: normalizeColor(
      body.color_primario,
      DEFAULT_BRANDING.color_primario
    ),
    color_secundario: normalizeColor(
      body.color_secundario,
      DEFAULT_BRANDING.color_secundario
    ),
    color_acento: normalizeColor(body.color_acento, DEFAULT_BRANDING.color_acento),
    modo_oscuro: body.modo_oscuro === true,
    login_config: normalizeJson(body.login || body.login_config),
    dashboard_config: normalizeJson(body.dashboard || body.dashboard_config),
    nav_config: normalizeJson(body.nav || body.nav_config),
    documento_config: normalizeJson(body.documentos || body.documento_config),
    email_config: normalizeJson(body.email || body.email_config),
    pwa_config: normalizeJson(body.pwa || body.pwa_config),
  };

  for (const field of URL_FIELDS) {
    normalized[field] = normalizeUrl(body[field] || null);
  }

  return normalized;
};

export const getCompanyBranding = async (db, idEmpresa) => {
  try {
    const result = await db.query(`select app.branding_empresa($1::bigint) as branding`, [
      idEmpresa,
    ]);
    return normalizeBranding(result.rows[0]?.branding || {});
  } catch (error) {
    if (error?.code === "42883" || /branding_empresa/i.test(error?.message || "")) {
      return normalizeBranding({});
    }
    throw error;
  }
};

export const upsertCompanyBranding = async (
  db,
  { idEmpresa, actorId = null, body }
) => {
  const input = normalizeBrandingInput(body);
  const result = await db.query(
    `
      insert into empresa_branding (
        id_empresa, nombre_comercial, slogan,
        logo_principal_url, logo_secundario_url, logo_dark_url, favicon_url,
        color_primario, color_secundario, color_acento, modo_oscuro,
        login_config, dashboard_config, nav_config,
        documento_config, email_config, pwa_config,
        created_by, updated_by
      )
      values (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12::jsonb, $13::jsonb, $14::jsonb,
        $15::jsonb, $16::jsonb, $17::jsonb,
        $18, $18
      )
      on conflict (id_empresa) do update set
        nombre_comercial = excluded.nombre_comercial,
        slogan = excluded.slogan,
        logo_principal_url = excluded.logo_principal_url,
        logo_secundario_url = excluded.logo_secundario_url,
        logo_dark_url = excluded.logo_dark_url,
        favicon_url = excluded.favicon_url,
        color_primario = excluded.color_primario,
        color_secundario = excluded.color_secundario,
        color_acento = excluded.color_acento,
        modo_oscuro = excluded.modo_oscuro,
        login_config = excluded.login_config,
        dashboard_config = excluded.dashboard_config,
        nav_config = excluded.nav_config,
        documento_config = excluded.documento_config,
        email_config = excluded.email_config,
        pwa_config = excluded.pwa_config,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      idEmpresa,
      input.nombre_comercial,
      input.slogan,
      input.logo_principal_url,
      input.logo_secundario_url,
      input.logo_dark_url,
      input.favicon_url,
      input.color_primario,
      input.color_secundario,
      input.color_acento,
      input.modo_oscuro,
      JSON.stringify(input.login_config),
      JSON.stringify(input.dashboard_config),
      JSON.stringify(input.nav_config),
      JSON.stringify(input.documento_config),
      JSON.stringify(input.email_config),
      JSON.stringify(input.pwa_config),
      actorId,
    ]
  );

  const row = result.rows[0];
  return normalizeBranding({
    nombre_comercial: row.nombre_comercial,
    slogan: row.slogan,
    logo_principal_url: row.logo_principal_url,
    logo_secundario_url: row.logo_secundario_url,
    logo_dark_url: row.logo_dark_url,
    favicon_url: row.favicon_url,
    color_primario: row.color_primario,
    color_secundario: row.color_secundario,
    color_acento: row.color_acento,
    modo_oscuro: row.modo_oscuro,
    login: row.login_config,
    dashboard: row.dashboard_config,
    nav: row.nav_config,
    documentos: row.documento_config,
    email: row.email_config,
    pwa: row.pwa_config,
  });
};
