import bcrypt from "bcrypt";
import { HttpError } from "../http/http-error.js";

const PRIVILEGED_ROLES = new Set(["ADMIN_EMPRESA"]);
const ADMIN_AUTHORIZER_ROLES = ["ADMIN_EMPRESA"];

const normalizeRole = (value) => String(value || "").trim().toUpperCase();

export const isPrivilegedRole = (role) =>
  PRIVILEGED_ROLES.has(normalizeRole(role));

/**
 * Verifica las credenciales de un administrador de empresa (ADMIN_EMPRESA)
 * que autoriza una operacion sensible.
 *
 * Reglas:
 *   - Si quien ejecuta YA es admin, se acepta sin pedir password
 *     (el usuario actual es el autorizador).
 *   - Si no, se exige `admin_username` y `admin_password` en el body, los
 *     valida con bcrypt contra la BD y, si OK, retorna el id del admin.
 *   - Si `requireAlways = false`, devolver `{authorizedBy: null}` si no
 *     vienen credenciales (operacion queda como "pendiente de validar").
 *
 * @param {pg.PoolClient | pg.Pool} db - cliente o pool de Postgres.
 * @param {object} params
 * @param {object} params.auth - sesion del usuario actual.
 * @param {object} params.body - body de la request (busca admin_username, admin_password y noteField).
 * @param {boolean} [params.requireAlways=true] - si false, no falla cuando no hay credenciales.
 * @param {string} [params.noteField="autorizacion_admin_nota"] - nombre del campo de nota en body.
 * @returns {Promise<{ authorizedBy: number | null, note: string | null }>}
 */
export const verifyAdminAuthorization = async (
  db,
  {
    auth,
    body,
    requireAlways = true,
    noteField = "autorizacion_admin_nota",
  } = {}
) => {
  if (isPrivilegedRole(auth?.rol)) {
    return {
      authorizedBy: Number(auth.id_usuario),
      note: String(body?.[noteField] || "").trim() || null,
    };
  }

  const username = String(body?.admin_username || "").trim().toLowerCase();
  const password = String(body?.admin_password || "");

  if (!username || !password) {
    if (!requireAlways) {
      return { authorizedBy: null, note: null };
    }
    throw HttpError.badRequest(
      "Esta operacion requiere autorizacion de un administrador (admin_username + admin_password)"
    );
  }

  const adminResult = await db.query(
    `
      select distinct on (u.id_usuario)
        u.id_usuario,
        u.password_hash
      from usuarios u
      inner join usuarios_roles ur
        on ur.id_empresa = u.id_empresa
       and ur.id_usuario = u.id_usuario
      inner join roles r
        on r.id_rol = ur.id_rol
      where u.id_empresa = $1
        and lower(u.username) = $2
        and u.activo = true
        and upper(r.codigo) = any($3::text[])
      order by u.id_usuario
      limit 1
    `,
    [auth.id_empresa, username, ADMIN_AUTHORIZER_ROLES]
  );

  const admin = adminResult.rows[0];

  if (!admin) {
    throw HttpError.forbidden(
      "No se encontro un administrador valido con ese username"
    );
  }

  const passwordOk = await bcrypt.compare(password, admin.password_hash);

  if (!passwordOk) {
    throw HttpError.forbidden("Credenciales administrativas invalidas");
  }

  return {
    authorizedBy: Number(admin.id_usuario),
    note: String(body?.[noteField] || "").trim() || null,
  };
};
