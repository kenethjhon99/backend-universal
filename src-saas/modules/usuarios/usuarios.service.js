import bcrypt from "bcrypt";
import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { revokeAllForUser } from "../../shared/security/refresh-tokens.js";
import { invalidateAuthCache } from "../../middlewares/authenticate.js";
import { HttpError } from "../../shared/http/http-error.js";

const MANAGEABLE_ROLE_CODES = [
  "ADMIN_EMPRESA",
  "GERENTE",
  "ENCARGADO_SUCURSAL",
  "CAJERO",
  "BODEGUERO",
  "COMPRAS",
  "OPERADOR_CARWASH",
  "SUPERVISOR_CARWASH",
];

const PLATFORM_ROLE_CODES = ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"];

const ROLE_RULES = {
  ADMIN_EMPRESA: {
    assignableRoles: MANAGEABLE_ROLE_CODES,
    hideSuperAdmins: true,
    branchRestricted: false,
    branchRestrictedTargetsOnly: false,
  },
  GERENTE: {
    assignableRoles: ["ENCARGADO_SUCURSAL", "CAJERO", "BODEGUERO", "COMPRAS", "OPERADOR_CARWASH"],
    hideSuperAdmins: true,
    branchRestricted: false,
    branchRestrictedTargetsOnly: false,
  },
  ENCARGADO_SUCURSAL: {
    assignableRoles: ["CAJERO"],
    hideSuperAdmins: true,
    branchRestricted: true,
    branchRestrictedTargetsOnly: true,
  },
};

const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeUsername = (value) => String(value || "").trim().toLowerCase();
const normalizeEmail = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
};

const getActorRules = (auth) => {
  const role = normalizeRole(auth?.rol);
  const rules = ROLE_RULES[role];

  if (!rules) {
    throw HttpError.forbidden("Tu rol no puede administrar usuarios");
  }

  return {
    ...rules,
    role,
  };
};

const normalizeRoleCodes = (roleCodes) => {
  const codes = Array.isArray(roleCodes)
    ? roleCodes
        .map((roleCode) => normalizeRole(roleCode))
        .filter(Boolean)
    : [];

  if (codes.length === 0) {
    throw HttpError.badRequest("Debes asignar al menos un rol");
  }

  const uniqueCodes = [...new Set(codes)];
  const invalidCode = uniqueCodes.find(
    (roleCode) => !MANAGEABLE_ROLE_CODES.includes(roleCode)
  );

  if (invalidCode) {
    throw HttpError.badRequest(`Rol no soportado: ${invalidCode}`);
  }

  return uniqueCodes;
};

const normalizeBranchIds = (branchIds) => {
  const ids = Array.isArray(branchIds)
    ? branchIds
        .map((branchId) => Number(branchId))
        .filter((branchId) => Number.isInteger(branchId) && branchId > 0)
    : [];

  if (ids.length === 0) {
    throw HttpError.badRequest("Debes asignar al menos una sucursal");
  }

  return [...new Set(ids)];
};

const mapPgError = (error) => {
  if (error?.code === "23505") {
    if (String(error.constraint || "").includes("username")) {
      throw HttpError.conflict("Ya existe un usuario con ese username en la empresa");
    }

    if (String(error.constraint || "").includes("email")) {
      throw HttpError.conflict("Ya existe un usuario con ese email en la empresa");
    }
  }

  throw error;
};

const getRoleCatalogRows = async (db, roleCodes, { strict = true } = {}) => {
  const result = await db.query(
    `
      select id_rol, codigo, nombre, descripcion
      from roles
      where codigo = any($1::text[])
      order by array_position($1::text[], codigo), codigo asc
    `,
    [roleCodes]
  );

  if (strict && result.rows.length !== roleCodes.length) {
    const foundCodes = new Set(result.rows.map((row) => normalizeRole(row.codigo)));
    const missingCode = roleCodes.find((roleCode) => !foundCodes.has(roleCode));
    throw HttpError.badRequest(`Rol no encontrado: ${missingCode}`);
  }

  return result.rows;
};

const getBranchRows = async (db, { idEmpresa, branchIds }) => {
  const result = await db.query(
    `
      select id_sucursal, codigo, nombre, activa
      from sucursales
      where id_empresa = $1
        and id_sucursal = any($2::bigint[])
        and activa = true
      order by nombre asc
    `,
    [idEmpresa, branchIds]
  );

  if (result.rows.length !== branchIds.length) {
    const foundIds = new Set(result.rows.map((row) => Number(row.id_sucursal)));
    const missingId = branchIds.find((branchId) => !foundIds.has(branchId));
    throw HttpError.badRequest(
      `La sucursal ${missingId} no existe o no esta activa en la empresa`
    );
  }

  return result.rows;
};

const getUserBaseSelect = () => `
  select
    u.id_usuario,
    u.id_empresa,
    u.username,
    u.email,
    u.nombre,
    u.apellido,
    u.activo,
    u.id_sucursal_default,
    u.ultimo_login_at,
    u.created_at,
    u.updated_at,
    (
      select coalesce(
        json_agg(
          json_build_object(
            'id_rol', r.id_rol,
            'codigo', r.codigo,
            'nombre', r.nombre,
            'descripcion', r.descripcion
          )
          order by r.codigo asc
        ),
        '[]'::json
      )
      from usuarios_roles ur
      inner join roles r
        on r.id_rol = ur.id_rol
      where ur.id_empresa = u.id_empresa
        and ur.id_usuario = u.id_usuario
    ) as roles,
    (
      select coalesce(
        json_agg(
          json_build_object(
            'id_sucursal', s.id_sucursal,
            'codigo', s.codigo,
            'nombre', s.nombre,
            'es_predeterminada', us.es_predeterminada
          )
          order by us.es_predeterminada desc, s.nombre asc
        ),
        '[]'::json
      )
      from usuarios_sucursales us
      inner join sucursales s
        on s.id_empresa = us.id_empresa
       and s.id_sucursal = us.id_sucursal
      where us.id_empresa = u.id_empresa
        and us.id_usuario = u.id_usuario
    ) as sucursales,
    (
      select json_build_object(
        'id_sucursal', s.id_sucursal,
        'codigo', s.codigo,
        'nombre', s.nombre
      )
      from sucursales s
      where s.id_empresa = u.id_empresa
        and s.id_sucursal = u.id_sucursal_default
      limit 1
    ) as sucursal_default
  from usuarios u
`;

const hasTargetRole = (targetUser, roleCode) =>
  (Array.isArray(targetUser?.roles) ? targetUser.roles : []).some(
    (role) => normalizeRole(role.codigo) === normalizeRole(roleCode)
  );

const getTargetBranchIds = (targetUser) =>
  (Array.isArray(targetUser?.sucursales) ? targetUser.sucursales : []).map(
    (branch) => Number(branch.id_sucursal)
  );

const assertRoleCodesAllowed = (auth, roleCodes) => {
  const rules = getActorRules(auth);
  const forbiddenRole = roleCodes.find(
    (roleCode) => !rules.assignableRoles.includes(roleCode)
  );

  if (forbiddenRole) {
    throw HttpError.forbidden(
      `Tu rol no puede asignar el rol ${forbiddenRole}`
    );
  }
};

const assertBranchIdsAllowed = (auth, branchIds) => {
  const rules = getActorRules(auth);

  if (!rules.branchRestricted) {
    return;
  }

  const allowedBranchIds = new Set((auth.sucursales || []).map(Number));
  const forbiddenBranch = branchIds.find((branchId) => !allowedBranchIds.has(branchId));

  if (forbiddenBranch) {
    throw HttpError.forbidden(
      `No puedes asignar la sucursal ${forbiddenBranch}`
    );
  }
};

const assertTargetVisible = (auth, targetUser) => {
  const rules = getActorRules(auth);

  if (!targetUser) {
    throw HttpError.notFound("Usuario no encontrado");
  }

  if (Number(targetUser.id_empresa) !== Number(auth.id_empresa)) {
    throw HttpError.forbidden("No puedes consultar usuarios de otra empresa");
  }

  if (
    rules.hideSuperAdmins &&
    PLATFORM_ROLE_CODES.some((roleCode) => hasTargetRole(targetUser, roleCode))
  ) {
    throw HttpError.forbidden("No puedes administrar usuarios de plataforma SaaS");
  }

  if (rules.branchRestrictedTargetsOnly) {
    const allowedBranchIds = new Set((auth.sucursales || []).map(Number));
    const targetBranches = getTargetBranchIds(targetUser);
    const outsideScope = targetBranches.some(
      (branchId) => !allowedBranchIds.has(branchId)
    );

    if (outsideScope) {
      throw HttpError.forbidden(
        "No puedes administrar usuarios fuera de tus sucursales"
      );
    }

    if (!hasTargetRole(targetUser, "CAJERO")) {
      throw HttpError.forbidden(
        "Solo puedes administrar usuarios con rol CAJERO"
      );
    }
  }
};

const getUsuarioByIdInternal = async (db, { idEmpresa, idUsuario }) => {
  const result = await db.query(
    `
      ${getUserBaseSelect()}
      where u.id_empresa = $1
        and u.id_usuario = $2
      limit 1
    `,
    [idEmpresa, idUsuario]
  );

  return result.rows[0] || null;
};

const syncUserRoles = async (db, { idEmpresa, idUsuario, roleRows, actorId }) => {
  await db.query(
    `
      delete from usuarios_roles
      where id_empresa = $1
        and id_usuario = $2
    `,
    [idEmpresa, idUsuario]
  );

  for (const roleRow of roleRows) {
    await db.query(
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
      [idEmpresa, idUsuario, roleRow.id_rol, actorId]
    );
  }

  // Cambio de roles asignados al usuario → invalidar sus tokens existentes
  // para que el proximo request reciba 401 y deba re-loguearse (los nuevos
  // permisos solo viajan en el JWT en login).
  await db.query(
    `update usuarios set token_valid_from = now() where id_usuario = $1`,
    [idUsuario]
  );
  invalidateAuthCache(Number(idUsuario));
};

const syncUserBranches = async (
  db,
  { idEmpresa, idUsuario, branchRows, idSucursalDefault, actorId }
) => {
  await db.query(
    `
      delete from usuarios_sucursales
      where id_empresa = $1
        and id_usuario = $2
    `,
    [idEmpresa, idUsuario]
  );

  for (const branchRow of branchRows) {
    await db.query(
      `
        insert into usuarios_sucursales (
          id_empresa,
          id_usuario,
          id_sucursal,
          es_predeterminada,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$5)
      `,
      [
        idEmpresa,
        idUsuario,
        branchRow.id_sucursal,
        Number(branchRow.id_sucursal) === Number(idSucursalDefault),
        actorId,
      ]
    );
  }
};

const resolveSecurityAssignments = async (db, { auth, payload }) => {
  const roleCodes = normalizeRoleCodes(payload.role_codes);
  const branchIds = normalizeBranchIds(payload.branch_ids);
  const idSucursalDefault = Number(payload.id_sucursal_default);

  if (!Number.isInteger(idSucursalDefault) || idSucursalDefault <= 0) {
    throw HttpError.badRequest("id_sucursal_default es requerido");
  }

  if (!branchIds.includes(idSucursalDefault)) {
    throw HttpError.badRequest(
      "La sucursal por defecto debe estar dentro de las sucursales asignadas"
    );
  }

  assertRoleCodesAllowed(auth, roleCodes);
  assertBranchIdsAllowed(auth, branchIds);

  const [roleRows, branchRows] = await Promise.all([
    getRoleCatalogRows(db, roleCodes),
    getBranchRows(db, {
      idEmpresa: auth.id_empresa,
      branchIds,
    }),
  ]);

  return {
    roleRows,
    branchRows,
    idSucursalDefault,
  };
};

export const listAssignableRoles = async ({ auth }) => {
  const rules = getActorRules(auth);
  return getRoleCatalogRows(pool, rules.assignableRoles, { strict: false });
};

export const listUsuarios = async ({ auth, query }) => {
  const rules = getActorRules(auth);
  const filters = ["u.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (rules.hideSuperAdmins) {
    filters.push(
      `not exists (
        select 1
        from usuarios_roles urx
        inner join roles rx
          on rx.id_rol = urx.id_rol
        where urx.id_empresa = u.id_empresa
          and urx.id_usuario = u.id_usuario
          and upper(rx.codigo) = any($${index}::text[])
      )`
    );
    params.push(PLATFORM_ROLE_CODES);
    index += 1;
  }

  if (rules.branchRestrictedTargetsOnly) {
    filters.push(
      `exists (
        select 1
        from usuarios_sucursales usx
        where usx.id_empresa = u.id_empresa
          and usx.id_usuario = u.id_usuario
          and usx.id_sucursal = any($${index}::bigint[])
      )`
    );
    params.push((auth.sucursales || []).map(Number));
    index += 1;

    filters.push(
      `exists (
        select 1
        from usuarios_roles urx
        inner join roles rx
          on rx.id_rol = urx.id_rol
        where urx.id_empresa = u.id_empresa
          and urx.id_usuario = u.id_usuario
          and upper(rx.codigo) = 'CAJERO'
      )`
    );
  }

  if (query?.activo === "true" || query?.activo === "false") {
    filters.push(`u.activo = $${index}`);
    params.push(query.activo === "true");
    index += 1;
  }

  if (query?.id_sucursal) {
    const branchId = Number(query.id_sucursal);
    if (!Number.isInteger(branchId) || branchId <= 0) {
      throw HttpError.badRequest("id_sucursal invalido");
    }

    assertBranchIdsAllowed(auth, [branchId]);
    filters.push(
      `exists (
        select 1
        from usuarios_sucursales usf
        where usf.id_empresa = u.id_empresa
          and usf.id_usuario = u.id_usuario
          and usf.id_sucursal = $${index}
      )`
    );
    params.push(branchId);
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(u.username ilike $${index} or coalesce(u.nombre, '') ilike $${index} or coalesce(u.apellido, '') ilike $${index} or coalesce(u.email, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 50, 100));
  params.push(limit);

  const result = await pool.query(
    `
      ${getUserBaseSelect()}
      where ${filters.join(" and ")}
      order by u.activo desc, u.nombre asc, u.apellido asc, u.username asc
      limit $${index}
    `,
    params
  );

  return result.rows;
};

export const getUsuarioById = async ({ auth, idUsuario }) => {
  const user = await getUsuarioByIdInternal(pool, {
    idEmpresa: auth.id_empresa,
    idUsuario,
  });

  assertTargetVisible(auth, user);
  return user;
};

export const createUsuario = async ({ auth, body, scope, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const username = normalizeUsername(body?.username);
      const email = normalizeEmail(body?.email);
      const nombre = String(body?.nombre || "").trim();
      const apellido = String(body?.apellido || "").trim();
      const password = String(body?.password || "");

      if (!username || !nombre || !apellido || !password) {
        throw HttpError.badRequest(
          "username, nombre, apellido y password son requeridos"
        );
      }

      if (password.length < 8) {
        throw HttpError.badRequest(
          "El password debe tener al menos 8 caracteres"
        );
      }

      const assignments = await resolveSecurityAssignments(client, {
        auth,
        payload: body,
      });

      const passwordHash = await bcrypt.hash(password, 10);

      try {
        const insertResult = await client.query(
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
            returning id_usuario
          `,
          [
            auth.id_empresa,
            username,
            email,
            passwordHash,
            nombre,
            apellido,
            assignments.idSucursalDefault,
            auth.id_usuario,
          ]
        );

        const idUsuario = insertResult.rows[0].id_usuario;

        await syncUserRoles(client, {
          idEmpresa: auth.id_empresa,
          idUsuario,
          roleRows: assignments.roleRows,
          actorId: auth.id_usuario,
        });

        await syncUserBranches(client, {
          idEmpresa: auth.id_empresa,
          idUsuario,
          branchRows: assignments.branchRows,
          idSucursalDefault: assignments.idSucursalDefault,
          actorId: auth.id_usuario,
        });

        const createdUser = await getUsuarioByIdInternal(client, {
          idEmpresa: auth.id_empresa,
          idUsuario,
        });

        await writeAuditEvent(client, {
          auth,
          scope,
          requestMeta,
          modulo: "USUARIOS",
          entidad: "USUARIO",
          entidadId: idUsuario,
          accion: "CREATE",
          despues: {
            id_usuario: createdUser.id_usuario,
            username: createdUser.username,
            email: createdUser.email,
            nombre: createdUser.nombre,
            apellido: createdUser.apellido,
            activo: createdUser.activo,
            roles: createdUser.roles,
            sucursales: createdUser.sucursales,
            sucursal_default: createdUser.sucursal_default,
          },
        });

        return createdUser;
      } catch (error) {
        mapPgError(error);
      }
    },
    { auth }
  );

export const updateUsuario = async ({
  auth,
  idUsuario,
  body,
  scope,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const currentUser = await getUsuarioByIdInternal(client, {
        idEmpresa: auth.id_empresa,
        idUsuario,
      });

      assertTargetVisible(auth, currentUser);

      const isSelf = Number(idUsuario) === Number(auth.id_usuario);
      const wantsSecurityChanges =
        body?.role_codes !== undefined ||
        body?.branch_ids !== undefined ||
        body?.id_sucursal_default !== undefined;

      if (isSelf && wantsSecurityChanges) {
        throw HttpError.badRequest(
          "No puedes modificar tus propios roles o sucursales desde este modulo"
        );
      }

      const username =
        body?.username !== undefined
          ? normalizeUsername(body.username)
          : currentUser.username;
      const email =
        body?.email !== undefined ? normalizeEmail(body.email) : currentUser.email;
      const nombre =
        body?.nombre !== undefined ? String(body.nombre || "").trim() : currentUser.nombre;
      const apellido =
        body?.apellido !== undefined
          ? String(body.apellido || "").trim()
          : currentUser.apellido;
      const password = String(body?.password || "");

      if (!username || !nombre || !apellido) {
        throw HttpError.badRequest("username, nombre y apellido son requeridos");
      }

      if (password && password.length < 8) {
        throw HttpError.badRequest(
          "El password debe tener al menos 8 caracteres"
        );
      }

      let assignments = null;
      if (wantsSecurityChanges) {
        assignments = await resolveSecurityAssignments(client, {
          auth,
          payload: {
            role_codes:
              body?.role_codes !== undefined
                ? body.role_codes
                : (currentUser.roles || []).map((role) => role.codigo),
            branch_ids:
              body?.branch_ids !== undefined
                ? body.branch_ids
                : getTargetBranchIds(currentUser),
            id_sucursal_default:
              body?.id_sucursal_default !== undefined
                ? body.id_sucursal_default
                : currentUser.id_sucursal_default,
          },
        });
      }

      const passwordHash = password ? await bcrypt.hash(password, 10) : null;

      try {
        await client.query(
          `
            update usuarios
            set
              username = $1,
              email = $2,
              password_hash = coalesce($3, password_hash),
              nombre = $4,
              apellido = $5,
              id_sucursal_default = coalesce($6, id_sucursal_default),
              token_valid_from = case when $3::text is not null then now() else token_valid_from end,
              updated_by = $7
            where id_empresa = $8
              and id_usuario = $9
          `,
          [
            username,
            email,
            passwordHash,
            nombre,
            apellido,
            assignments?.idSucursalDefault || null,
            auth.id_usuario,
            auth.id_empresa,
            idUsuario,
          ]
        );
      } catch (error) {
        mapPgError(error);
      }

      if (assignments) {
        await syncUserRoles(client, {
          idEmpresa: auth.id_empresa,
          idUsuario,
          roleRows: assignments.roleRows,
          actorId: auth.id_usuario,
        });

        await syncUserBranches(client, {
          idEmpresa: auth.id_empresa,
          idUsuario,
          branchRows: assignments.branchRows,
          idSucursalDefault: assignments.idSucursalDefault,
          actorId: auth.id_usuario,
        });
      }

      // Si cambio la password, revocar todas las sesiones del usuario.
      if (passwordHash) {
        await revokeAllForUser({
          idEmpresa: Number(auth.id_empresa),
          idUsuario: Number(idUsuario),
        });
        invalidateAuthCache(Number(idUsuario));
      }

      const updatedUser = await getUsuarioByIdInternal(client, {
        idEmpresa: auth.id_empresa,
        idUsuario,
      });

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "USUARIOS",
        entidad: "USUARIO",
        entidadId: idUsuario,
        accion: "UPDATE",
        antes: {
          id_usuario: currentUser.id_usuario,
          username: currentUser.username,
          email: currentUser.email,
          nombre: currentUser.nombre,
          apellido: currentUser.apellido,
          activo: currentUser.activo,
          roles: currentUser.roles,
          sucursales: currentUser.sucursales,
          sucursal_default: currentUser.sucursal_default,
        },
        despues: {
          id_usuario: updatedUser.id_usuario,
          username: updatedUser.username,
          email: updatedUser.email,
          nombre: updatedUser.nombre,
          apellido: updatedUser.apellido,
          activo: updatedUser.activo,
          roles: updatedUser.roles,
          sucursales: updatedUser.sucursales,
          sucursal_default: updatedUser.sucursal_default,
        },
      });

      return updatedUser;
    },
    { auth }
  );

export const updateUsuarioEstado = async ({
  auth,
  idUsuario,
  activo,
  scope,
  requestMeta,
}) =>
  runInTransaction(
    async (client) => {
      const targetUser = await getUsuarioByIdInternal(client, {
        idEmpresa: auth.id_empresa,
        idUsuario,
      });

      assertTargetVisible(auth, targetUser);

      if (Number(idUsuario) === Number(auth.id_usuario) && activo === false) {
        throw HttpError.badRequest("No puedes desactivar tu propio usuario");
      }

      await client.query(
        `
          update usuarios
          set activo = $1,
              token_valid_from = case when $1 = false then now() else token_valid_from end,
              updated_by = $2
          where id_empresa = $3
            and id_usuario = $4
        `,
        [activo === true, auth.id_usuario, auth.id_empresa, idUsuario]
      );

      const updatedUser = await getUsuarioByIdInternal(client, {
        idEmpresa: auth.id_empresa,
        idUsuario,
      });

      // Si se desactivo, revocar refresh tokens y limpiar cache de auth.
      if (activo === false) {
        await revokeAllForUser({
          idEmpresa: Number(auth.id_empresa),
          idUsuario: Number(idUsuario),
        });
        invalidateAuthCache(Number(idUsuario));
      }

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "USUARIOS",
        entidad: "USUARIO_ESTADO",
        entidadId: idUsuario,
        accion: activo === true ? "ACTIVATE" : "DEACTIVATE",
        antes: {
          activo: targetUser.activo,
          username: targetUser.username,
        },
        despues: {
          activo: updatedUser.activo,
          username: updatedUser.username,
        },
      });

      return updatedUser;
    },
    { auth }
  );
