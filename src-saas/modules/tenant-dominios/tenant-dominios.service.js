import crypto from "node:crypto";
import { pool } from "../../config/db.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { invalidateTenantHostCache } from "../../middlewares/resolve-tenant-host.js";
import { normalizeBranding } from "../../shared/branding/branding.js";

const validateHostname = (hostname) => {
  if (!hostname) throw HttpError.badRequest("hostname requerido");
  const normalized = String(hostname).trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,150}$/.test(normalized) || !normalized.includes(".")) {
    throw HttpError.badRequest("hostname invalido");
  }
  return normalized;
};

const normalizeDomainType = (value) => {
  const normalized = String(value || "DOMINIO_PROPIO").trim().toUpperCase();
  if (!["SUBDOMINIO", "DOMINIO_PROPIO"].includes(normalized)) {
    throw HttpError.badRequest("tipo de dominio invalido");
  }
  return normalized;
};

export const listMine = async ({ auth }) => {
  const r = await pool.query(
    `select
       id_dominio, hostname, tipo, es_primario, verificado, dns_estado,
       ssl_estado, ssl_provider, ssl_expires_at, ssl_error, last_checked_at,
       white_label_activo, api_privada_activa, branding, created_at
     from tenant_dominios
     where id_empresa = $1
     order by es_primario desc, created_at asc`,
    [auth.id_empresa]
  );
  return r.rows;
};

export const create = async ({ auth, scope, body, requestMeta }) => {
  const hostname = validateHostname(body?.hostname);
  const tipo = normalizeDomainType(body?.tipo);
  const verificationToken = crypto.randomBytes(16).toString("hex");

  const r = await pool.query(
    `
      insert into tenant_dominios (
        id_empresa, hostname, tipo, es_primario, verification_token, branding,
        white_label_activo, api_privada_activa,
        created_by, updated_by
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)
      returning *
    `,
    [
      auth.id_empresa,
      hostname,
      tipo,
      body?.es_primario === true,
      verificationToken,
      JSON.stringify(body?.branding || {}),
      body?.white_label_activo !== false,
      body?.api_privada_activa === true,
      auth.id_usuario,
    ]
  );

  invalidateTenantHostCache(hostname);

  await writeAuditEvent(pool, {
    auth, scope, requestMeta,
    modulo: "TENANT_DOMINIOS", entidad: "DOMINIO",
    entidadId: r.rows[0].id_dominio, accion: "CREATE",
    despues: r.rows[0],
  });

  return {
    ...r.rows[0],
    instrucciones_verificacion: {
      tipo_dns: "TXT",
      nombre: `_saas-verify.${hostname}`,
      valor: verificationToken,
      mensaje:
        "Agrega este registro TXT en tu DNS, espera propagación (5-30 min), y llama al endpoint de verificación.",
    },
  };
};

/**
 * Verifica el dominio buscando el registro TXT _saas-verify.{hostname} con
 * el verification_token.
 */
export const verifyDomain = async ({ auth, scope, idDominio, requestMeta }) => {
  const r = await pool.query(
    `select * from tenant_dominios where id_empresa = $1 and id_dominio = $2`,
    [auth.id_empresa, idDominio]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Dominio no encontrado");
  const dom = r.rows[0];
  if (dom.verificado) return { ok: true, ya_verificado: true };

  const dns = await import("node:dns/promises");
  let records = [];
  try {
    records = await dns.resolveTxt(`_saas-verify.${dom.hostname}`);
  } catch (err) {
    throw HttpError.badRequest(
      `No se encontro el registro TXT en _saas-verify.${dom.hostname}: ${err.message}`
    );
  }

  // resolveTxt devuelve arrays de strings; aplanamos
  const valores = records.map((arr) => arr.join("")).map((s) => s.trim());

  if (!valores.includes(dom.verification_token)) {
    throw HttpError.badRequest(
      `El TXT no coincide con el token esperado. Valores encontrados: ${valores.join(", ")}`
    );
  }

  await pool.query(
    `update tenant_dominios
        set verificado = true,
            dns_estado = 'VERIFICADO',
            last_checked_at = now()
      where id_dominio = $1`,
    [idDominio]
  );

  invalidateTenantHostCache(dom.hostname);

  await writeAuditEvent(pool, {
    auth, scope, requestMeta,
    modulo: "TENANT_DOMINIOS", entidad: "DOMINIO",
    entidadId: idDominio, accion: "VERIFY",
  });

  return { ok: true, hostname: dom.hostname };
};

export const updateDomainSettings = async ({
  auth,
  scope,
  idDominio,
  body,
  requestMeta,
}) => {
  const current = await pool.query(
    `select * from tenant_dominios where id_empresa = $1 and id_dominio = $2`,
    [auth.id_empresa, idDominio]
  );
  if (current.rowCount === 0) throw HttpError.notFound("Dominio no encontrado");

  const result = await pool.query(
    `
      update tenant_dominios
         set tipo = $1,
             es_primario = $2,
             white_label_activo = $3,
             api_privada_activa = $4,
             updated_by = $5
       where id_empresa = $6
         and id_dominio = $7
       returning *
    `,
    [
      normalizeDomainType(body?.tipo || current.rows[0].tipo),
      body?.es_primario === undefined
        ? current.rows[0].es_primario
        : body.es_primario === true,
      body?.white_label_activo === undefined
        ? current.rows[0].white_label_activo
        : body.white_label_activo !== false,
      body?.api_privada_activa === undefined
        ? current.rows[0].api_privada_activa
        : body.api_privada_activa === true,
      auth.id_usuario,
      auth.id_empresa,
      idDominio,
    ]
  );

  invalidateTenantHostCache(current.rows[0].hostname);

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "TENANT_DOMINIOS",
    entidad: "DOMINIO",
    entidadId: idDominio,
    accion: "UPDATE_SETTINGS",
    antes: current.rows[0],
    despues: result.rows[0],
  });

  return result.rows[0];
};

export const updateBranding = async ({ auth, idDominio, body }) => {
  const r = await pool.query(
    `update tenant_dominios
       set branding = $1::jsonb, updated_by = $2
     where id_empresa = $3 and id_dominio = $4
     returning hostname, branding`,
    [
      JSON.stringify(body?.branding || {}),
      auth.id_usuario,
      auth.id_empresa,
      idDominio,
    ]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Dominio no encontrado");
  invalidateTenantHostCache(r.rows[0].hostname);
  return r.rows[0];
};

/**
 * Endpoint público: devuelve el branding actual del tenant resuelto por host.
 * Es público porque la pantalla de login lo necesita ANTES de autenticarse.
 */
export const getPublicBranding = async ({ req }) => {
  if (!req.tenantContext) {
    return { tenant: null, branding: null };
  }
  return {
    tenant: {
      id_empresa: req.tenantContext.id_empresa,
      hostname: req.tenantContext.hostname,
    },
    branding: normalizeBranding(req.tenantContext.branding || {}),
  };
};
