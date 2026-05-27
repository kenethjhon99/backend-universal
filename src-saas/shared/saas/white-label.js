import crypto from "node:crypto";
import { HttpError } from "../http/http-error.js";

const WL_LEVELS = new Set(["NONE", "DOMAIN", "DEDICATED_LOGICAL", "DEDICATED_DB"]);
const WL_STATES = new Set(["INACTIVO", "SOLICITADO", "ACTIVO", "SUSPENDIDO"]);
const DB_STATES = new Set(["NO_APLICA", "SOLICITADA", "PROVISIONANDO", "ACTIVA", "ERROR"]);
const API_SCOPES = new Set([
  "read:catalogs",
  "read:sales",
  "write:sales",
  "read:inventory",
  "write:inventory",
  "read:customers",
  "write:customers",
  "read:carwash",
  "write:carwash",
]);

const HOST_RE = /^[a-z0-9.-]{3,150}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeHost = (value, field) => {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (!HOST_RE.test(text) || !text.includes(".")) {
    throw HttpError.badRequest(`${field} invalido`);
  }
  return text;
};

const normalizeJson = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeEnum = (value, allowed, fallback, field) => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!allowed.has(normalized)) throw HttpError.badRequest(`${field} invalido`);
  return normalized;
};

export const normalizeWhiteLabelInput = (body = {}) => {
  const emailFrom = String(body.email_from || "").trim().toLowerCase();
  if (emailFrom && !EMAIL_RE.test(emailFrom)) {
    throw HttpError.badRequest("email_from invalido");
  }

  return {
    nivel: normalizeEnum(body.nivel, WL_LEVELS, "NONE", "nivel"),
    estado: normalizeEnum(body.estado, WL_STATES, "INACTIVO", "estado"),
    dominio_principal: normalizeHost(body.dominio_principal, "dominio_principal"),
    subdominio: normalizeHost(body.subdominio, "subdominio"),
    ssl_gestionado: body.ssl_gestionado !== false,
    correo_dominio: normalizeHost(body.correo_dominio, "correo_dominio"),
    email_from: emailFrom || null,
    api_privada_activa: body.api_privada_activa === true,
    api_base_path: String(body.api_base_path || "/api/private")
      .trim()
      .replace(/\/+$/, "") || "/api/private",
    dedicated_db_estado: normalizeEnum(
      body.dedicated_db_estado,
      DB_STATES,
      "NO_APLICA",
      "dedicated_db_estado"
    ),
    dedicated_db_ref: String(body.dedicated_db_ref || "").trim() || null,
    recursos_config: normalizeJson(body.recursos_config),
    backup_config: normalizeJson(body.backup_config),
    sla_config: normalizeJson(body.sla_config),
    metadata: normalizeJson(body.metadata),
  };
};

export const normalizeWhiteLabel = (row = {}) => ({
  nivel: row.nivel || "NONE",
  estado: row.estado || "INACTIVO",
  dominio_principal: row.dominio_principal || null,
  subdominio: row.subdominio || null,
  ssl_gestionado: row.ssl_gestionado !== false,
  correo_dominio: row.correo_dominio || null,
  email_from: row.email_from || null,
  api_privada_activa: row.api_privada_activa === true,
  api_base_path: row.api_base_path || "/api/private",
  dedicated_db_estado: row.dedicated_db_estado || "NO_APLICA",
  dedicated_db_ref: row.dedicated_db_ref || null,
  recursos_config: normalizeJson(row.recursos_config),
  backup_config: normalizeJson(row.backup_config),
  sla_config: normalizeJson(row.sla_config),
  metadata: normalizeJson(row.metadata),
});

export const getCompanyWhiteLabel = async (db, idEmpresa) => {
  try {
    const result = await db.query(`select app.white_label_empresa($1::bigint) as white_label`, [
      idEmpresa,
    ]);
    return normalizeWhiteLabel(result?.rows?.[0]?.white_label || {});
  } catch (error) {
    if (error?.code === "42883" || /white_label_empresa/i.test(error?.message || "")) {
      return normalizeWhiteLabel({});
    }
    throw error;
  }
};

export const upsertCompanyWhiteLabel = async (
  db,
  { idEmpresa, actorId = null, body }
) => {
  const input = normalizeWhiteLabelInput(body);
  const result = await db.query(
    `
      insert into empresa_white_label_config (
        id_empresa, nivel, estado, dominio_principal, subdominio,
        ssl_gestionado, correo_dominio, email_from, api_privada_activa,
        api_base_path, recursos_config, dedicated_db_estado, dedicated_db_ref,
        backup_config, sla_config, metadata, created_by, updated_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,
        $14::jsonb,$15::jsonb,$16::jsonb,$17,$17
      )
      on conflict (id_empresa) do update set
        nivel = excluded.nivel,
        estado = excluded.estado,
        dominio_principal = excluded.dominio_principal,
        subdominio = excluded.subdominio,
        ssl_gestionado = excluded.ssl_gestionado,
        correo_dominio = excluded.correo_dominio,
        email_from = excluded.email_from,
        api_privada_activa = excluded.api_privada_activa,
        api_base_path = excluded.api_base_path,
        recursos_config = excluded.recursos_config,
        dedicated_db_estado = excluded.dedicated_db_estado,
        dedicated_db_ref = excluded.dedicated_db_ref,
        backup_config = excluded.backup_config,
        sla_config = excluded.sla_config,
        metadata = excluded.metadata,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      idEmpresa,
      input.nivel,
      input.estado,
      input.dominio_principal,
      input.subdominio,
      input.ssl_gestionado,
      input.correo_dominio,
      input.email_from,
      input.api_privada_activa,
      input.api_base_path,
      JSON.stringify(input.recursos_config),
      input.dedicated_db_estado,
      input.dedicated_db_ref,
      JSON.stringify(input.backup_config),
      JSON.stringify(input.sla_config),
      JSON.stringify(input.metadata),
      actorId,
    ]
  );
  return normalizeWhiteLabel(result.rows[0]);
};

export const normalizeApiScopes = (scopes = []) => {
  const normalized = [
    ...new Set(
      (Array.isArray(scopes) ? scopes : [])
        .map((scope) => String(scope || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  for (const scope of normalized) {
    if (!API_SCOPES.has(scope)) {
      throw HttpError.badRequest(`Scope API no permitido: ${scope}`);
    }
  }
  return normalized;
};

export const createApiKeyMaterial = () => {
  const raw = `sk_live_${crypto.randomBytes(24).toString("base64url")}`;
  return {
    raw,
    prefix: raw.slice(0, 16),
    hash: crypto.createHash("sha256").update(raw).digest("hex"),
  };
};

export const getAllowedApiScopes = () => [...API_SCOPES];
