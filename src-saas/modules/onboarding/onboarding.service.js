import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { createCompanyWithAdmin } from "../../shared/saas/company-bootstrap.js";
import { signAccessToken } from "../../shared/security/jwt.js";
import { getPermissionsForRole } from "../../shared/security/permissions.js";

const slugify = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80);

const isValidEmail = (e) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

/**
 * Lista los planes SaaS disponibles publicamente (catalogo comercial).
 */
export const getPlanesPublicos = async () => {
  const result = await pool.query(
    `
      select codigo, nombre, descripcion, precio_mensual, precio_anual, moneda,
             trial_dias, max_sucursales, max_usuarios, modulos_incluidos
      from saas_planes
      where activo = true and visible_publico = true
      order by orden asc, precio_mensual asc
    `
  );
  return result.rows;
};

/**
 * Self-service: registra una empresa nueva con su admin desde una landing
 * publica. Crea trial automatico segun el plan elegido.
 *
 * No requiere autenticacion. Rate limited en routes.
 */
export const selfRegister = async ({ body }) => {
  const empresaNombre = String(body?.empresa?.nombre_legal || body?.empresa_nombre || "").trim();
  const adminEmail = String(body?.admin?.email || body?.email || "").trim().toLowerCase();
  const adminPassword = String(body?.admin?.password || body?.password || "");
  const adminNombre = String(body?.admin?.nombre || "").trim();
  const adminApellido = String(body?.admin?.apellido || "").trim();
  const planCodigo = String(body?.plan_codigo || "STARTER").toUpperCase();

  if (!empresaNombre) {
    throw HttpError.badRequest("Nombre de empresa requerido");
  }
  if (!isValidEmail(adminEmail)) {
    throw HttpError.badRequest("Email invalido");
  }
  if (!adminPassword || adminPassword.length < 8) {
    throw HttpError.badRequest("Password debe tener al menos 8 caracteres");
  }
  if (!adminNombre || !adminApellido) {
    throw HttpError.badRequest("Nombre y apellido del admin son requeridos");
  }

  // Plan
  const planResult = await pool.query(
    `select * from saas_planes where codigo = $1 and activo = true`,
    [planCodigo]
  );
  const plan = planResult.rows[0];
  if (!plan) {
    throw HttpError.badRequest(`Plan ${planCodigo} no disponible`);
  }

  // Slug unico
  let slug = slugify(empresaNombre);
  let suffix = 0;
  while (true) {
    const { rowCount } = await pool.query(
      `select 1 from empresas where slug = $1 limit 1`,
      [slug]
    );
    if (rowCount === 0) break;
    suffix += 1;
    slug = `${slugify(empresaNombre)}-${suffix}`;
    if (suffix > 50) {
      throw HttpError.badRequest("No se pudo generar un slug unico");
    }
  }

  // Username sugerido para el admin (de email)
  const username = adminEmail.split("@")[0].toLowerCase();

  return runInTransaction(
    async (client) => {
      // Reusa el bootstrap helper que crea empresa + admin + roles + sucursal
      const result = await createCompanyWithAdmin(client, {
        empresa: {
          slug,
          nombre_legal: empresaNombre,
          nombre_comercial: empresaNombre,
          email: adminEmail,
          timezone: body?.empresa?.timezone || "America/Guatemala",
        },
        sucursalPrincipal: {
          codigo: "CENTRAL",
          nombre: "Sucursal Central",
        },
        adminUsuario: {
          username,
          email: adminEmail,
          password: adminPassword,
          nombre: adminNombre,
          apellido: adminApellido,
        },
        modulos: plan.modulos_incluidos || [],
      });

      // Setear plan + trial
      const trialHasta = new Date();
      trialHasta.setDate(trialHasta.getDate() + (plan.trial_dias || 0));

      await client.query(
        `
          update empresas
          set saas_plan_codigo = $1,
              saas_estado = case when $2 > 0 then 'TRIAL' else 'ACTIVA' end,
              saas_trial_hasta = case when $2 > 0 then $3::date else null end,
              saas_billing_email = $4
          where id_empresa = $5
        `,
        [
          plan.codigo,
          plan.trial_dias || 0,
          trialHasta.toISOString().slice(0, 10),
          adminEmail,
          result.empresa.id_empresa,
        ]
      );

      await client.query(
        `
          insert into saas_subscription_events (id_empresa, tipo_evento, plan_codigo, metadata)
          values ($1, 'TRIAL_STARTED', $2, $3::jsonb)
        `,
        [
          result.empresa.id_empresa,
          plan.codigo,
          JSON.stringify({
            trial_dias: plan.trial_dias,
            registered_via: "self-service",
          }),
        ]
      );

      // Emitir token para que el usuario quede logueado al instante
      const rol = result.usuario.rol || "ADMIN_EMPRESA";
      const token = signAccessToken({
        id_usuario: result.usuario.id_usuario,
        id_empresa: result.empresa.id_empresa,
        id_sucursal: result.sucursal.id_sucursal,
        rol,
        sucursales: [result.sucursal.id_sucursal],
        modulos: plan.modulos_incluidos || [],
        permisos: getPermissionsForRole(rol),
        empresa: { slug, nombre_legal: empresaNombre },
      });

      return {
        token,
        empresa: result.empresa,
        sucursal: result.sucursal,
        usuario: result.usuario,
        plan: {
          codigo: plan.codigo,
          nombre: plan.nombre,
          trial_hasta: trialHasta.toISOString().slice(0, 10),
          trial_dias: plan.trial_dias,
        },
      };
    },
    { auth: { id_empresa: null, id_usuario: null, rol: "SUPER_ADMIN" } }
  );
};

/**
 * Devuelve el estado de la suscripcion SaaS de la empresa actual.
 */
export const getMiSuscripcion = async ({ auth }) => {
  const result = await pool.query(
    `
      select e.id_empresa, e.slug, e.nombre_legal,
             e.saas_plan_codigo, e.saas_estado, e.saas_trial_hasta,
             e.saas_renovacion_hasta, e.saas_billing_email,
             p.nombre as plan_nombre, p.precio_mensual, p.moneda,
             p.modulos_incluidos
      from empresas e
      left join saas_planes p on p.codigo = e.saas_plan_codigo
      where e.id_empresa = $1
    `,
    [auth.id_empresa]
  );

  const row = result.rows[0];
  if (!row) throw HttpError.notFound("Empresa no encontrada");

  const today = new Date().toISOString().slice(0, 10);
  const enTrial = row.saas_estado === "TRIAL";
  const trialVencido = enTrial && row.saas_trial_hasta && row.saas_trial_hasta < today;

  return {
    ...row,
    en_trial: enTrial,
    trial_vencido: trialVencido,
    dias_restantes_trial:
      enTrial && row.saas_trial_hasta
        ? Math.max(
            0,
            Math.ceil(
              (new Date(row.saas_trial_hasta).getTime() - Date.now()) /
                (24 * 3600 * 1000)
            )
          )
        : null,
  };
};
