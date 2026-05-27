import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import {
  DEFAULT_MODULE_CODES,
  getCompanyModuleStates,
  getModuleCatalog,
  normalizeModuleAssignments,
  syncCompanyModules,
} from "../../shared/saas/company-modules.js";
import { createCompanyWithAdmin } from "../../shared/saas/company-bootstrap.js";
import {
  getCompanyBranding,
  upsertCompanyBranding,
} from "../../shared/branding/branding.js";
import { invalidateTenantHostCache } from "../../middlewares/resolve-tenant-host.js";
import {
  createApiKeyMaterial,
  getAllowedApiScopes,
  getCompanyWhiteLabel,
  normalizeApiScopes,
  upsertCompanyWhiteLabel,
} from "../../shared/saas/white-label.js";

const isSuperAdmin = (auth) =>
  ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"].includes(
    String(auth?.rol || "").toUpperCase()
  );

const assertCompanyAccess = ({ auth, idEmpresa }) => {
  if (!isSuperAdmin(auth) && Number(auth.id_empresa) !== Number(idEmpresa)) {
    throw HttpError.forbidden("No puedes consultar otra empresa");
  }
};

const ensureCompanyExists = async (db, idEmpresa) => {
  const result = await db.query(
    `
      select id_empresa, slug, nombre_legal, estado
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

export const createEmpresa = async ({ auth, scope, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const createdCompany = await createCompanyWithAdmin(client, {
        empresa: body?.empresa,
        sucursalPrincipal: body?.sucursalPrincipal,
        adminUsuario: body?.adminUsuario || null,
        actorId: auth.id_usuario,
        adminRoleCodes: ["ADMIN_EMPRESA"],
        moduleCodes:
          body?.modulos === undefined ? DEFAULT_MODULE_CODES : body?.modulos,
      });

      const moduleStates = await getCompanyModuleStates(
        client,
        createdCompany.empresa.id_empresa
      );

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "EMPRESAS",
        entidad: "EMPRESA",
        entidadId: createdCompany.empresa.id_empresa,
        accion: "CREATE",
        despues: {
          empresa: {
            id_empresa: createdCompany.empresa.id_empresa,
            slug: createdCompany.empresa.slug,
            nombre_legal: createdCompany.empresa.nombre_legal,
          },
          sucursal_principal: {
            id_sucursal: createdCompany.sucursalPrincipal?.id_sucursal,
            codigo: createdCompany.sucursalPrincipal?.codigo,
            nombre: createdCompany.sucursalPrincipal?.nombre,
          },
          admin_usuario: createdCompany.adminUsuario
            ? {
                id_usuario: createdCompany.adminUsuario.id_usuario,
                username: createdCompany.adminUsuario.username,
              }
            : null,
          modulos: moduleStates,
        },
      });

      return {
        ...createdCompany,
        modulos: moduleStates,
      };
    },
    { auth }
  );

export const listEmpresas = async ({ auth }) => {
  if (!isSuperAdmin(auth)) {
    const result = await pool.query(
      `
        select *
        from empresas
        where id_empresa = $1
      `,
      [auth.id_empresa]
    );

    return result.rows;
  }

  const result = await pool.query(
    `
      select
        e.*,
        (
          select count(*)::int
          from sucursales s
          where s.id_empresa = e.id_empresa
        ) as total_sucursales,
        (
          select count(*)::int
          from usuarios u
          where u.id_empresa = e.id_empresa
        ) as total_usuarios,
        coalesce(
          array(
            select m.codigo
            from empresas_modulos em
            inner join modulos m
              on m.id_modulo = em.id_modulo
            where em.id_empresa = e.id_empresa
              and em.activo = true
            order by m.codigo asc
          ),
          '{}'::text[]
        ) as modulos_activos
      from empresas e
      order by e.nombre_legal asc
    `
  );

  return result.rows;
};

export const getEmpresaById = async ({ auth, idEmpresa }) => {
  assertCompanyAccess({ auth, idEmpresa });

  const result = await pool.query(
    `
      select
        e.*,
        (
          select count(*)::int
          from sucursales s
          where s.id_empresa = e.id_empresa
        ) as total_sucursales,
        (
          select count(*)::int
          from usuarios u
          where u.id_empresa = e.id_empresa
        ) as total_usuarios
      from empresas e
      where e.id_empresa = $1
      limit 1
    `,
    [idEmpresa]
  );

  const company = result.rows[0];

  if (!company) {
    throw HttpError.notFound("Empresa no encontrada");
  }

  return {
    ...company,
    modulos: await getCompanyModuleStates(pool, idEmpresa),
  };
};

export const getMyEmpresa = async ({ auth }) =>
  getEmpresaById({
    auth,
    idEmpresa: auth.id_empresa,
  });

export const getEmpresaBranding = async ({ auth, idEmpresa }) => {
  assertCompanyAccess({ auth, idEmpresa });
  await ensureCompanyExists(pool, idEmpresa);
  return getCompanyBranding(pool, idEmpresa);
};

export const updateEmpresaBranding = async ({
  auth,
  scope,
  idEmpresa,
  body,
  requestMeta,
}) => {
  assertCompanyAccess({ auth, idEmpresa });

  return runInTransaction(
    async (client) => {
      const company = await ensureCompanyExists(client, idEmpresa);
      const before = await getCompanyBranding(client, idEmpresa);
      const branding = await upsertCompanyBranding(client, {
        idEmpresa,
        actorId: auth.id_usuario,
        body,
      });

      invalidateTenantHostCache();

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "EMPRESAS",
        entidad: "EMPRESA_BRANDING",
        entidadId: idEmpresa,
        accion: "UPDATE",
        antes: before,
        despues: branding,
      });

      return {
        empresa: company,
        branding,
      };
    },
    { auth }
  );
};

export const getEmpresaWhiteLabel = async ({ auth, idEmpresa }) => {
  assertCompanyAccess({ auth, idEmpresa });
  await ensureCompanyExists(pool, idEmpresa);
  const [whiteLabel, domains, apiKeys] = await Promise.all([
    getCompanyWhiteLabel(pool, idEmpresa),
    pool.query(
      `
        select
          id_dominio, hostname, tipo, es_primario, verificado, dns_estado,
          ssl_estado, ssl_provider, ssl_expires_at, ssl_error, last_checked_at,
          white_label_activo, api_privada_activa, created_at
        from tenant_dominios
        where id_empresa = $1
        order by es_primario desc, created_at asc
      `,
      [idEmpresa]
    ),
    pool.query(
      `
        select id_api_key, nombre, key_prefix, scopes, estado, last_used_at,
               expires_at, created_at, revoked_at
        from empresa_api_keys
        where id_empresa = $1
        order by created_at desc
      `,
      [idEmpresa]
    ),
  ]);

  return {
    white_label: whiteLabel,
    dominios: domains.rows,
    api_keys: apiKeys.rows,
    api_scopes_disponibles: getAllowedApiScopes(),
  };
};

export const updateEmpresaWhiteLabel = async ({
  auth,
  scope,
  idEmpresa,
  body,
  requestMeta,
}) => {
  assertCompanyAccess({ auth, idEmpresa });

  return runInTransaction(
    async (client) => {
      const company = await ensureCompanyExists(client, idEmpresa);
      const before = await getCompanyWhiteLabel(client, idEmpresa);
      const whiteLabel = await upsertCompanyWhiteLabel(client, {
        idEmpresa,
        actorId: auth.id_usuario,
        body,
      });

      invalidateTenantHostCache();

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "EMPRESAS",
        entidad: "WHITE_LABEL",
        entidadId: idEmpresa,
        accion: "UPDATE",
        antes: before,
        despues: whiteLabel,
      });

      return {
        empresa: company,
        white_label: whiteLabel,
      };
    },
    { auth }
  );
};

export const createEmpresaApiKey = async ({
  auth,
  scope,
  idEmpresa,
  body,
  requestMeta,
}) => {
  assertCompanyAccess({ auth, idEmpresa });
  const name = String(body?.nombre || "").trim().slice(0, 120);
  if (!name) throw HttpError.badRequest("nombre es requerido");
  const scopes = normalizeApiScopes(body?.scopes || []);
  const { raw, prefix, hash } = createApiKeyMaterial();

  return runInTransaction(
    async (client) => {
      await ensureCompanyExists(client, idEmpresa);
      const whiteLabel = await getCompanyWhiteLabel(client, idEmpresa);
      if (whiteLabel.api_privada_activa !== true) {
        throw HttpError.conflict("La API privada no esta activa para esta empresa");
      }

      const result = await client.query(
        `
          insert into empresa_api_keys (
            id_empresa, nombre, key_prefix, key_hash, scopes, expires_at, created_by
          )
          values ($1,$2,$3,$4,$5::text[],$6::timestamptz,$7)
          returning id_api_key, nombre, key_prefix, scopes, estado,
                    last_used_at, expires_at, created_at
        `,
        [
          idEmpresa,
          name,
          prefix,
          hash,
          scopes,
          body?.expires_at || null,
          auth.id_usuario,
        ]
      );

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "EMPRESAS",
        entidad: "API_KEY",
        entidadId: result.rows[0].id_api_key,
        accion: "CREATE",
        despues: {
          ...result.rows[0],
          raw_visible_once: true,
        },
      });

      return {
        ...result.rows[0],
        token: raw,
      };
    },
    { auth }
  );
};

export const revokeEmpresaApiKey = async ({
  auth,
  scope,
  idEmpresa,
  idApiKey,
  requestMeta,
}) => {
  assertCompanyAccess({ auth, idEmpresa });
  const result = await pool.query(
    `
      update empresa_api_keys
         set estado = 'REVOCADA',
             revoked_at = coalesce(revoked_at, now()),
             revoked_by = $1
       where id_empresa = $2
         and id_api_key = $3
         and estado <> 'REVOCADA'
       returning id_api_key, nombre, key_prefix, scopes, estado, revoked_at
    `,
    [auth.id_usuario, idEmpresa, idApiKey]
  );
  if (result.rowCount === 0) throw HttpError.notFound("Clave API no encontrada");

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "EMPRESAS",
    entidad: "API_KEY",
    entidadId: idApiKey,
    accion: "REVOKE",
    despues: result.rows[0],
  });

  return result.rows[0];
};

export const listModuleCatalog = async ({ auth }) => {
  if (!isSuperAdmin(auth)) {
    throw HttpError.forbidden(
      "Solo el SUPER_ADMIN puede consultar el catalogo global de modulos"
    );
  }

  return getModuleCatalog(pool);
};

export const getEmpresaModules = async ({ auth, idEmpresa }) => {
  assertCompanyAccess({ auth, idEmpresa });
  await ensureCompanyExists(pool, idEmpresa);
  return getCompanyModuleStates(pool, idEmpresa);
};

export const updateEmpresaModules = async ({
  auth,
  scope,
  idEmpresa,
  body,
  requestMeta,
}) => {
  if (!isSuperAdmin(auth)) {
    throw HttpError.forbidden(
      "Solo el SUPER_ADMIN puede habilitar o deshabilitar modulos"
    );
  }

  const moduleAssignments = normalizeModuleAssignments(body?.modulos || []);

  return runInTransaction(
    async (client) => {
      const company = await ensureCompanyExists(client, idEmpresa);
      const beforeModules = await getCompanyModuleStates(client, idEmpresa);
      const modulos = await syncCompanyModules(client, {
        idEmpresa,
        moduleAssignments,
        actorId: auth.id_usuario,
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "EMPRESAS",
        entidad: "EMPRESA_MODULOS",
        entidadId: idEmpresa,
        accion: "UPDATE",
        antes: beforeModules,
        despues: modulos,
      });

      return {
        empresa: company,
        modulos,
      };
    },
    { auth }
  );
};
