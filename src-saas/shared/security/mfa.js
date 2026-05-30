/**
 * Utilidades MFA TOTP:
 *  - encrypt/decrypt del secret TOTP at-rest con AES-256-GCM.
 *  - generacion de secret base32 (otplib).
 *  - verificacion de codigos TOTP (window=1 = +/- 30s tolerancia).
 *  - generacion de backup codes (8 codigos hex format XXXX-XXXX).
 *  - challenge JWT para el flow de login en 2 pasos.
 */
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { authenticator } from "otplib";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

// ============================================================
// Encriptacion AES-256-GCM
// ============================================================
const ALGO = "aes-256-gcm";

const getEncryptionKey = () => {
  const raw = process.env.MFA_ENCRYPTION_KEY || "";
  if (!raw || raw.length < 64) {
    throw new Error(
      "MFA_ENCRYPTION_KEY no configurada o invalida (min 64 hex chars = 32 bytes)"
    );
  }
  // 64 hex chars = 32 bytes
  return Buffer.from(raw.slice(0, 64), "hex");
};

export const encryptSecret = (plaintext) => {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96 bits para GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    secret_encrypted: enc.toString("base64"),
    secret_iv: iv.toString("base64"),
    secret_auth_tag: authTag.toString("base64"),
  };
};

export const decryptSecret = ({ secret_encrypted, secret_iv, secret_auth_tag }) => {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(secret_iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(secret_auth_tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(secret_encrypted, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
};

// ============================================================
// TOTP (otplib)
// ============================================================

// Configurar otplib: ventana de tolerancia +/- 1 step (30s antes/despues)
authenticator.options = {
  window: 1,
  digits: 6,
  step: 30,
};

export const generateTotpSecret = () => authenticator.generateSecret();

/**
 * Devuelve el URI otpauth:// para que el frontend genere el QR.
 * Issuer es la marca del SaaS (configurable via env).
 */
export const buildOtpAuthUri = ({ secret, accountLabel }) => {
  const issuer = process.env.MFA_ISSUER || "TradeNova";
  return authenticator.keyuri(accountLabel, issuer, secret);
};

export const verifyTotpCode = (secret, code) => {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, secret);
  } catch {
    return false;
  }
};

// ============================================================
// Backup codes
// ============================================================
const BACKUP_CODES_COUNT = 8;

const formatBackupCode = (raw) => {
  // 8 hex chars -> "XXXX-XXXX"
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`.toUpperCase();
};

/**
 * Genera 8 backup codes en CLARO + sus hashes bcrypt para guardar.
 * Devuelve `{ plaintext: ["AB12-CD34", ...], hashed: ["$2b$10$...", ...] }`.
 * Los plaintext se muestran al usuario UNA SOLA VEZ.
 */
export const generateBackupCodes = async () => {
  const plaintext = [];
  const hashed = [];
  for (let i = 0; i < BACKUP_CODES_COUNT; i += 1) {
    const code = formatBackupCode(crypto.randomBytes(4).toString("hex"));
    plaintext.push(code);
    hashed.push(await bcrypt.hash(code, 10));
  }
  return { plaintext, hashed };
};

/**
 * Verifica si un codigo en claro coincide con algun hash en el array.
 * Si coincide, devuelve el INDEX (para que el caller lo elimine del array).
 * Si no, devuelve -1.
 *
 * Importante: bcrypt.compare es expensive (intencional). Solo se usa cuando
 * el codigo TOTP fallo y el usuario intenta con backup.
 */
export const findBackupCodeIndex = async (codeRaw, hashedArray) => {
  const code = String(codeRaw || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) return -1;
  for (let i = 0; i < hashedArray.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(code, hashedArray[i])) return i;
  }
  return -1;
};

// ============================================================
// Challenge JWT (login en 2 pasos)
// ============================================================
const CHALLENGE_EXP = process.env.MFA_CHALLENGE_EXPIRES || "5m";

const getChallengeSecret = () => {
  const raw = process.env.MFA_CHALLENGE_SECRET || env.jwtSecret;
  // Si no hay secret dedicado, usamos el JWT_SECRET con un suffix para separar.
  // Esto es defensa en profundidad: aunque alguien tuviera un access token,
  // no puede falsificar un challenge token y viceversa porque los firmamos
  // con un sub-secret derivado.
  return crypto
    .createHmac("sha256", raw)
    .update("mfa-challenge")
    .digest("hex");
};

/**
 * Emite un challenge token tras login con password OK pero MFA pendiente.
 * El frontend lo guarda en memoria (no localStorage) y lo manda en
 * POST /auth/mfa/verify-login.
 */
export const issueMfaChallenge = ({ idUsuario, idEmpresa }) => {
  return jwt.sign(
    {
      purpose: "mfa-challenge",
      id_usuario: idUsuario,
      id_empresa: idEmpresa,
    },
    getChallengeSecret(),
    { expiresIn: CHALLENGE_EXP }
  );
};

export const verifyMfaChallenge = (token) => {
  try {
    const payload = jwt.verify(token, getChallengeSecret());
    if (payload.purpose !== "mfa-challenge") return null;
    return {
      idUsuario: Number(payload.id_usuario),
      idEmpresa: Number(payload.id_empresa),
    };
  } catch {
    return null;
  }
};

// ============================================================
// Anti-bruteforce: throttle por usuario.
// 5 intentos fallidos en 10 minutos = bloqueo durante 15 minutos.
// ============================================================
const MAX_FAILED_ATTEMPTS = 5;
const FAIL_WINDOW_MIN = 10;
const LOCK_DURATION_MIN = 15;

export const isLocked = async (pool, idUsuario) => {
  const r = await pool.query(
    `select count(*)::int as n
     from mfa_intentos_fallidos
     where id_usuario = $1
       and created_at > now() - ($2 || ' minutes')::interval`,
    [idUsuario, FAIL_WINDOW_MIN]
  );
  const n = Number(r.rows[0]?.n || 0);
  if (n < MAX_FAILED_ATTEMPTS) return { locked: false, attempts: n };

  // Si ya hay 5+ fallos en la ventana, ver si pasaron 15min desde el ultimo
  const last = await pool.query(
    `select created_at from mfa_intentos_fallidos
     where id_usuario = $1
     order by created_at desc limit 1`,
    [idUsuario]
  );
  const lastTs = last.rows[0]?.created_at;
  if (!lastTs) return { locked: false, attempts: n };
  const lockedUntil = new Date(
    new Date(lastTs).getTime() + LOCK_DURATION_MIN * 60_000
  );
  return {
    locked: lockedUntil.getTime() > Date.now(),
    attempts: n,
    lockedUntil,
  };
};

export const recordFailedAttempt = async (pool, idUsuario, motivo, meta = {}) => {
  await pool.query(
    `insert into mfa_intentos_fallidos (id_usuario, ip, user_agent, motivo)
     values ($1, $2, $3, $4)`,
    [idUsuario, meta.ip || null, meta.userAgent || null, motivo]
  );
};

export const clearFailedAttempts = async (pool, idUsuario) => {
  await pool.query(
    `delete from mfa_intentos_fallidos where id_usuario = $1`,
    [idUsuario]
  );
};
