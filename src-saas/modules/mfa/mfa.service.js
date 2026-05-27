/**
 * Servicio MFA TOTP.
 *
 * Flow:
 *   1) POST /mfa/enroll (auth) → genera secret + backup codes. Devuelve URI
 *      otpauth y backup codes en CLARO (una sola vez). habilitado=false.
 *   2) Usuario escanea QR en su app (Google Auth, Authy, 1Password).
 *   3) POST /mfa/verify-enroll (auth) con el primer codigo → marca habilitado=true.
 *   4) Proximos logins: tras password OK, si habilitado=true → challenge token,
 *      cliente envia POST /auth/mfa/verify-login con el codigo.
 *   5) POST /mfa/disable (auth + password actual) → borra el registro.
 */
import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import {
  buildOtpAuthUri,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  verifyTotpCode,
} from "../../shared/security/mfa.js";
import bcrypt from "bcrypt";

const getMfaRow = async (idUsuario) => {
  const r = await pool.query(
    `select * from usuarios_mfa where id_usuario = $1 limit 1`,
    [idUsuario]
  );
  return r.rows[0] || null;
};

/**
 * Estado del MFA del usuario actual (para mostrar UI: enrollar / desactivar).
 */
export const getStatus = async ({ auth }) => {
  const row = await getMfaRow(auth.id_usuario);
  if (!row) return { habilitado: false, enrolado: false };
  return {
    habilitado: row.habilitado === true,
    enrolado: true,
    metodo: row.metodo,
    backup_codes_restantes: Array.isArray(row.backup_codes_hash)
      ? row.backup_codes_hash.length
      : 0,
    habilitado_en: row.habilitado_en,
    ultimo_uso_at: row.ultimo_uso_at,
  };
};

/**
 * Inicia el enrollment. Genera un secret nuevo (incluso si ya habia uno
 * anterior, lo reemplaza siempre que NO este habilitado todavia).
 *
 * Si ya tiene MFA habilitado, requiere desactivar primero (no permitir
 * "actualizar" el secret sin reautenticar).
 */
export const enroll = async ({ auth, scope, requestMeta }) => {
  const existing = await getMfaRow(auth.id_usuario);
  if (existing && existing.habilitado) {
    throw HttpError.conflict(
      "Ya tienes MFA habilitado. Desactivalo primero si quieres re-enrollar."
    );
  }

  const secret = generateTotpSecret();
  const enc = encryptSecret(secret);
  const { plaintext: backupCodes, hashed: backupHashes } =
    await generateBackupCodes();

  if (existing) {
    await pool.query(
      `update usuarios_mfa
        set secret_encrypted = $1,
            secret_iv = $2,
            secret_auth_tag = $3,
            backup_codes_hash = $4,
            habilitado = false,
            habilitado_en = null,
            ultimo_uso_at = null
        where id_usuario = $5`,
      [
        enc.secret_encrypted,
        enc.secret_iv,
        enc.secret_auth_tag,
        backupHashes,
        auth.id_usuario,
      ]
    );
  } else {
    await pool.query(
      `insert into usuarios_mfa (
         id_usuario, id_empresa,
         secret_encrypted, secret_iv, secret_auth_tag,
         backup_codes_hash, habilitado
       ) values ($1, $2, $3, $4, $5, $6, false)`,
      [
        auth.id_usuario,
        auth.id_empresa,
        enc.secret_encrypted,
        enc.secret_iv,
        enc.secret_auth_tag,
        backupHashes,
      ]
    );
  }

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "MFA",
    entidadId: auth.id_usuario,
    accion: "ENROLL_START",
  });

  const accountLabel = auth.empresa?.slug
    ? `${auth.empresa.slug}:${auth.id_usuario}`
    : String(auth.id_usuario);

  return {
    otpauth_uri: buildOtpAuthUri({ secret, accountLabel }),
    // El secret en texto plano se envia SOLO al cliente para mostrarlo bajo
    // el QR (algunos users no escanean, lo escriben). No se guarda en clear.
    secret,
    backup_codes: backupCodes,
    instrucciones:
      "Escanea el QR con tu app authenticator (Google Authenticator / Authy / 1Password) y luego ingresa el primer codigo para activar.",
  };
};

/**
 * Confirma el enrollment validando que el usuario escaneo bien el QR.
 */
export const verifyEnrollment = async ({ auth, scope, body, requestMeta }) => {
  const row = await getMfaRow(auth.id_usuario);
  if (!row) {
    throw HttpError.badRequest("No hay un enrollment iniciado");
  }
  if (row.habilitado) {
    throw HttpError.conflict("MFA ya esta habilitado");
  }

  const code = String(body?.code || "").trim();
  const secret = decryptSecret(row);
  if (!verifyTotpCode(secret, code)) {
    throw HttpError.unauthorized("Codigo invalido");
  }

  await pool.query(
    `update usuarios_mfa
      set habilitado = true,
          habilitado_en = now(),
          ultimo_uso_at = now()
      where id_usuario = $1`,
    [auth.id_usuario]
  );

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "MFA",
    entidadId: auth.id_usuario,
    accion: "ENROLL_CONFIRM",
  });

  return { habilitado: true };
};

/**
 * Desactiva MFA. Requiere password actual para confirmar.
 */
export const disable = async ({ auth, scope, body, requestMeta }) => {
  const row = await getMfaRow(auth.id_usuario);
  if (!row) {
    throw HttpError.notFound("MFA no enrolado");
  }

  // Confirmar password
  const u = await pool.query(
    `select password_hash from usuarios where id_usuario = $1 and activo = true`,
    [auth.id_usuario]
  );
  if (u.rowCount === 0) throw HttpError.unauthorized();
  const passwordOk = await bcrypt.compare(
    String(body?.password || ""),
    u.rows[0].password_hash
  );
  if (!passwordOk) throw HttpError.unauthorized("Password incorrecta");

  await pool.query(`delete from usuarios_mfa where id_usuario = $1`, [
    auth.id_usuario,
  ]);

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "MFA",
    entidadId: auth.id_usuario,
    accion: "DISABLE",
  });

  return { habilitado: false };
};

/**
 * Regenera los backup codes. Invalida los anteriores.
 */
export const regenerateBackupCodes = async ({ auth, scope, requestMeta }) => {
  const row = await getMfaRow(auth.id_usuario);
  if (!row || !row.habilitado) {
    throw HttpError.badRequest("MFA no habilitado");
  }

  const { plaintext, hashed } = await generateBackupCodes();
  await pool.query(
    `update usuarios_mfa set backup_codes_hash = $1 where id_usuario = $2`,
    [hashed, auth.id_usuario]
  );

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "USUARIOS",
    entidad: "MFA",
    entidadId: auth.id_usuario,
    accion: "REGENERATE_BACKUP_CODES",
  });

  return { backup_codes: plaintext };
};

// ============================================================
// Login flow (consumido desde auth.service)
// ============================================================

/**
 * Devuelve true si el usuario tiene MFA HABILITADO (no solo enrolado).
 * Lo consume auth.service.login para decidir si emite challenge o session
 * completa.
 */
export const userHasMfaEnabled = async (idUsuario) => {
  const r = await pool.query(
    `select habilitado from usuarios_mfa where id_usuario = $1 limit 1`,
    [idUsuario]
  );
  return r.rows[0]?.habilitado === true;
};

/**
 * Verifica un codigo TOTP o un backup code para el login en 2 pasos.
 * Devuelve true/false. Si fue backup, lo consume (lo borra del array).
 */
export const verifyCodeForLogin = async (idUsuario, code) => {
  const row = await getMfaRow(idUsuario);
  if (!row || !row.habilitado) return false;

  const cleanCode = String(code || "").replace(/\s+/g, "");

  // TOTP primero (cheap)
  const secret = decryptSecret(row);
  if (verifyTotpCode(secret, cleanCode)) {
    await pool.query(
      `update usuarios_mfa set ultimo_uso_at = now() where id_usuario = $1`,
      [idUsuario]
    );
    return { ok: true, method: "TOTP" };
  }

  // Backup code (expensive: bcrypt sobre cada hash)
  const { findBackupCodeIndex } = await import(
    "../../shared/security/mfa.js"
  );
  const idx = await findBackupCodeIndex(cleanCode, row.backup_codes_hash || []);
  if (idx >= 0) {
    const newCodes = [...row.backup_codes_hash];
    newCodes.splice(idx, 1); // consumir
    await pool.query(
      `update usuarios_mfa
        set backup_codes_hash = $1, ultimo_uso_at = now()
        where id_usuario = $2`,
      [newCodes, idUsuario]
    );
    return { ok: true, method: "BACKUP_CODE", backup_codes_restantes: newCodes.length };
  }

  return { ok: false };
};
