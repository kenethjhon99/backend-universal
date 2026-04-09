import * as Auth from "../models/auth.model.js";
import { verifyPasswordWithUpgrade } from "./password.js";

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

const normalizeRoleName = (roleName) =>
  String(roleName || "")
    .trim()
    .toUpperCase();

export const isAdminRole = (roleName) => ADMIN_ROLES.has(normalizeRoleName(roleName));

export const authorizeAdminCredentials = async ({
  username,
  password,
  actorId = null,
}) => {
  const normalizedUsername = String(username || "").trim();
  const plainPassword = String(password || "");

  if (!normalizedUsername || !plainPassword) {
    const error = new Error("Debes ingresar el usuario y la password de un administrador");
    error.statusCode = 400;
    throw error;
  }

  const user = await Auth.getUsuarioByUsername(normalizedUsername);
  if (!user || !user.activo) {
    const error = new Error("Credenciales de administrador incorrectas");
    error.statusCode = 401;
    throw error;
  }

  const passwordOk = await verifyPasswordWithUpgrade({
    plainPassword,
    storedPasswordHash: user.password_hash,
    onLegacyUpgrade: async (upgradedHash) => {
      await Auth.updateUsuarioPasswordHash(
        user.id_usuario,
        upgradedHash,
        actorId ?? user.id_usuario
      );
    },
  });

  if (!passwordOk) {
    const error = new Error("Credenciales de administrador incorrectas");
    error.statusCode = 401;
    throw error;
  }

  const roles = await Auth.getRolesByUsuario(user.id_usuario);
  const normalizedRoles = roles.map((role) => normalizeRoleName(role.nombre_rol));

  if (!normalizedRoles.some(isAdminRole)) {
    const error = new Error("La autorizacion debe ser realizada por un usuario con rol admin");
    error.statusCode = 403;
    throw error;
  }

  return {
    id_usuario: user.id_usuario,
    username: user.username,
    nombre: user.nombre,
    roles: normalizedRoles,
  };
};
