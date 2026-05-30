import bcrypt from "bcrypt";
import { HttpError } from "../http/http-error.js";
import {
  DEFAULT_MODULE_CODES,
  getModuleRowsByCodes,
  normalizeActiveModuleCodes,
} from "./company-modules.js";

const ensurePassword = (password) => {
  if (typeof password !== "string" || password.trim().length < 8) {
    throw HttpError.badRequest(
      "La password debe tener al menos 8 caracteres"
    );
  }
};

const getRoleIds = async (client, roleCodes) => {
  const result = await client.query(
    `
      select id_rol, codigo
      from roles
      where codigo = any($1::text[])
    `,
    [roleCodes]
  );

  if (result.rowCount !== roleCodes.length) {
    throw HttpError.badRequest(
      "No se encontraron todos los roles requeridos para inicializar la empresa"
    );
  }

  return result.rows;
};

export const createCompanyWithAdmin = async (
  client,
  {
    empresa,
    sucursalPrincipal,
    adminUsuario = null,
    actorId = null,
    adminRoleCodes = ["ADMIN_EMPRESA"],
    moduleCodes = DEFAULT_MODULE_CODES,
  }
) => {
  const slug = String(empresa?.slug || "").trim().toLowerCase();
  const nombreLegal = String(empresa?.nombre_legal || "").trim();
  const nombreComercial =
    String(empresa?.nombre_comercial || "").trim() || nombreLegal;
  const sucursalNombre = String(sucursalPrincipal?.nombre || "").trim();
  const sucursalCodigo = String(
    sucursalPrincipal?.codigo || "CENTRAL"
  ).trim();

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw HttpError.badRequest(
      "empresa.slug es requerido y solo puede contener letras, numeros y guiones"
    );
  }

  if (!nombreLegal) {
    throw HttpError.badRequest("empresa.nombre_legal es requerido");
  }

  if (!sucursalNombre) {
    throw HttpError.badRequest("sucursalPrincipal.nombre es requerido");
  }

  const companyResult = await client.query(
    `
      insert into empresas (
        slug,
        nombre_legal,
        nombre_comercial,
        nit,
        email,
        telefono,
        timezone,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
      returning *
    `,
    [
      slug,
      nombreLegal,
      nombreComercial,
      empresa?.nit || null,
      empresa?.email || null,
      empresa?.telefono || null,
      empresa?.timezone || "America/Guatemala",
      actorId,
    ]
  );

  const company = companyResult.rows[0];
  await client.query("select set_config($1, $2, true)", [
    "app.current_empresa_id",
    String(company.id_empresa),
  ]);

  const normalizedModuleCodes = normalizeActiveModuleCodes(moduleCodes, {
    fallback: DEFAULT_MODULE_CODES,
  });
  const moduleRows = await getModuleRowsByCodes(client, normalizedModuleCodes);

  for (const moduleRow of moduleRows) {
    await client.query(
      `
        insert into empresas_modulos (
          id_empresa,
          id_modulo,
          activo,
          config,
          created_by,
          updated_by
        )
        values ($1,$2,true,$3::jsonb,$4,$4)
      `,
      [
        company.id_empresa,
        moduleRow.id_modulo,
        JSON.stringify({}),
        actorId,
      ]
    );
  }

  const branchResult = await client.query(
    `
      insert into sucursales (
        id_empresa,
        codigo,
        nombre,
        direccion,
        telefono,
        es_principal,
        activa,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,true,true,$6,$6)
      returning *
    `,
    [
      company.id_empresa,
      sucursalCodigo,
      sucursalNombre,
      sucursalPrincipal?.direccion || null,
      sucursalPrincipal?.telefono || null,
      actorId,
    ]
  );

  const branch = branchResult.rows[0];
  const warehouseResult = await client.query(
    `
      insert into bodegas (
        id_empresa,
        id_sucursal,
        codigo,
        nombre,
        es_principal,
        activa,
        created_by,
        updated_by
      )
      values ($1,$2,'PRINCIPAL','Bodega principal',true,true,$3,$3)
      on conflict (id_empresa, id_sucursal, codigo)
      do update set
        es_principal = true,
        activa = true,
        updated_by = excluded.updated_by,
        updated_at = now()
      returning id_bodega
    `,
    [company.id_empresa, branch.id_sucursal, actorId]
  );
  const idBodegaPrincipal = warehouseResult.rows[0].id_bodega;

  await client.query(
    `
      insert into stock_sucursal (
        id_empresa,
        id_sucursal,
        id_bodega,
        id_producto,
        stock_actual,
        stock_minimo,
        created_by,
        updated_by
      )
      select
        p.id_empresa,
        $2,
        $3,
        p.id_producto,
        0,
        0,
        $4,
        $4
      from productos p
      where p.id_empresa = $1
        and p.activo = true
      on conflict (id_empresa, id_sucursal, id_bodega, id_producto)
      do nothing
    `,
    [company.id_empresa, branch.id_sucursal, idBodegaPrincipal, actorId]
  );

  let admin = null;

  if (adminUsuario) {
    ensurePassword(adminUsuario.password);

    const username = String(adminUsuario.username || "").trim().toLowerCase();
    const nombre = String(adminUsuario.nombre || "").trim();
    const apellido = String(adminUsuario.apellido || "").trim();

    if (!username || !nombre || !apellido) {
      throw HttpError.badRequest(
        "adminUsuario.username, adminUsuario.nombre y adminUsuario.apellido son requeridos"
      );
    }

    const passwordHash = await bcrypt.hash(adminUsuario.password, 10);
    const userResult = await client.query(
      `
        insert into usuarios (
          id_empresa,
          username,
          email,
          password_hash,
          nombre,
          apellido,
          id_sucursal_default,
          activo,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,true,$8,$8)
        returning id_usuario, id_empresa, username, email, nombre, apellido, id_sucursal_default, activo
      `,
      [
        company.id_empresa,
        username,
        adminUsuario.email || null,
        passwordHash,
        nombre,
        apellido,
        branch.id_sucursal,
        actorId,
      ]
    );

    admin = userResult.rows[0];

    await client.query(
      `
        insert into usuarios_sucursales (
          id_empresa,
          id_usuario,
          id_sucursal,
          es_predeterminada,
          created_by,
          updated_by
        )
        values ($1,$2,$3,true,$4,$4)
      `,
      [company.id_empresa, admin.id_usuario, branch.id_sucursal, actorId]
    );

    const roleRows = await getRoleIds(client, adminRoleCodes);

    for (const role of roleRows) {
      await client.query(
        `
          insert into usuarios_roles (
            id_empresa,
            id_usuario,
            id_rol,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$4)
        `,
        [company.id_empresa, admin.id_usuario, role.id_rol, actorId]
      );
    }

    // Auto-crear canal EMAIL al admin si tiene email registrado. Suscrito a
    // los eventos criticos de billing + alertas operativas. La empresa puede
    // luego editarlo o agregar mas canales (whatsapp/telegram).
    if (admin?.email) {
      const billingEvents = [
        "BILLING_TRIAL_EXPIRING",
        "BILLING_PAYMENT_FAILED",
        "BILLING_SUSPENDED",
        "BILLING_CANCELLED",
        "BILLING_REACTIVATED",
        "PLAN_LIMIT_WARNING",
        "STOCK_BAJO",
        "CAJA_SIN_CERRAR",
      ];
      await client.query(
        `
          insert into notificaciones_canales (
            id_empresa, tipo, nombre, config, activo, eventos, destinatarios,
            created_by, updated_by
          )
          values ($1, 'EMAIL', $2, $3::jsonb, true, $4::jsonb, $5::jsonb, $6, $6)
        `,
        [
          company.id_empresa,
          "Email admin (auto)",
          JSON.stringify({ provider: "log" }), // provider=log para dev; cambiar a sendgrid en prod
          JSON.stringify(billingEvents),
          JSON.stringify([admin.email]),
          actorId,
        ]
      );
    }
  }

  return {
    empresa: company,
    sucursalPrincipal: branch,
    adminUsuario: admin,
    modulosActivos: moduleRows.map((row) => row.codigo),
  };
};
