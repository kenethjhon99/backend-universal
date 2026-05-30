import crypto from "node:crypto";
import { pool } from "../../config/db.js";
import { HttpError } from "../http/http-error.js";
import { logger } from "../logging/logger.js";

const REFRESH_BYTES = 48; // 48 bytes -> 96 hex chars; suficiente entropia
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 30);

const hashRefreshToken = (raw) =>
  crypto.createHash("sha256").update(raw).digest("hex");

const generateRefreshTokenRaw = () =>
  crypto.randomBytes(REFRESH_BYTES).toString("hex");

const buildExpiresAt = () => {
  const date = new Date();
  date.setDate(date.getDate() + REFRESH_TTL_DAYS);
  return date;
};

/**
 * Emite un refresh token nuevo y lo guarda hasheado.
 * Devuelve el token en CLARO (debe enviarse al cliente y luego se olvida).
 */
export const issueRefreshToken = async ({
  idEmpresa,
  idUsuario,
  userAgent = null,
  ip = null,
  replacedById = null,
  deviceLabel = null,
}) => {
  const raw = generateRefreshTokenRaw();
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = buildExpiresAt();

  const result = await pool.query(
    `
      insert into refresh_tokens (
        id_empresa, id_usuario, token_hash, expires_at,
        replaced_by_id, user_agent, ip, last_used_at, last_ip,
        last_user_agent, device_label
      )
      values ($1, $2, $3, $4, $5, $6, $7, now(), $7, $6, $8)
      returning id_refresh_token, expires_at
    `,
    [
      idEmpresa,
      idUsuario,
      tokenHash,
      expiresAt,
      replacedById,
      userAgent,
      ip,
      deviceLabel,
    ]
  );

  return {
    raw,
    id: Number(result.rows[0].id_refresh_token),
    expiresAt: result.rows[0].expires_at,
  };
};

/**
 * Verifica un refresh token recibido del cliente:
 *   - busca por hash
 *   - si esta revocado, revoca TODOS los del usuario (deteccion de reuso)
 *   - si esta expirado, devuelve null
 *
 * Si todo OK, lo marca como revoked y emite uno nuevo (rotacion).
 *
 * @returns {Promise<{ idEmpresa, idUsuario, refreshToken }>} o lanza 401.
 */
export const rotateRefreshToken = async ({ rawToken, userAgent, ip }) => {
  if (!rawToken) {
    throw HttpError.unauthorized("Refresh token requerido");
  }

  const tokenHash = hashRefreshToken(rawToken);

  const result = await pool.query(
    `
      select *
      from refresh_tokens
      where token_hash = $1
      limit 1
    `,
    [tokenHash]
  );

  const row = result.rows[0];

  if (!row) {
    throw HttpError.unauthorized("Refresh token invalido");
  }

  if (row.revoked_at) {
    // REUSO de token revocado = posible robo. Revocar todos los del usuario.
    logger.warn(
      {
        idUsuario: row.id_usuario,
        idEmpresa: row.id_empresa,
        ip,
      },
      "refresh token reuse detected, revoking all tokens for user"
    );

    await pool.query(
      `
        update refresh_tokens
        set revoked_at = coalesce(revoked_at, now()),
            revoked_reason = coalesce(revoked_reason, 'reuse_detected')
        where id_empresa = $1
          and id_usuario = $2
          and revoked_at is null
      `,
      [row.id_empresa, row.id_usuario]
    );

    throw HttpError.unauthorized("Token revocado. Inicia sesion nuevamente.");
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw HttpError.unauthorized("Refresh token expirado");
  }

  // Rotacion: revoke + emit nuevo
  const fresh = await issueRefreshToken({
    idEmpresa: Number(row.id_empresa),
    idUsuario: Number(row.id_usuario),
    userAgent,
    ip,
  });

  await pool.query(
    `
      update refresh_tokens
      set revoked_at = now(),
          replaced_by_id = $1,
          revoked_reason = 'rotated',
          last_used_at = now(),
          last_ip = $3,
          last_user_agent = $4
      where id_refresh_token = $2
    `,
    [fresh.id, row.id_refresh_token, ip, userAgent]
  );

  return {
    idEmpresa: Number(row.id_empresa),
    idUsuario: Number(row.id_usuario),
    refreshToken: fresh,
  };
};

/**
 * Revoca un refresh token especifico (logout).
 */
export const revokeRefreshToken = async (rawToken, reason = "logout") => {
  if (!rawToken) return;
  const tokenHash = hashRefreshToken(rawToken);
  await pool.query(
    `
      update refresh_tokens
      set revoked_at = coalesce(revoked_at, now()),
          revoked_reason = coalesce(revoked_reason, $2)
      where token_hash = $1
        and revoked_at is null
    `,
    [tokenHash, reason]
  );
};

/**
 * Revoca TODOS los refresh tokens activos de un usuario.
 * Util en cambio de password, desactivacion, sospecha de intrusion.
 */
export const revokeAllForUser = async ({
  idEmpresa,
  idUsuario,
  reason = "global_logout",
}) => {
  await pool.query(
    `
      update refresh_tokens
      set revoked_at = coalesce(revoked_at, now()),
          revoked_reason = coalesce(revoked_reason, $3)
      where id_empresa = $1
        and id_usuario = $2
        and revoked_at is null
    `,
    [idEmpresa, idUsuario, reason]
  );
};

export const listActiveRefreshTokens = async ({ idEmpresa, idUsuario }) => {
  const result = await pool.query(
    `
      select
        id_refresh_token,
        created_at,
        updated_at,
        expires_at,
        last_used_at,
        coalesce(last_ip, ip) as ip,
        coalesce(last_user_agent, user_agent) as user_agent,
        device_label
      from refresh_tokens
      where id_empresa = $1
        and id_usuario = $2
        and revoked_at is null
        and expires_at > now()
      order by coalesce(last_used_at, created_at) desc
    `,
    [idEmpresa, idUsuario]
  );

  return result.rows.map((row) => ({
    id_refresh_token: Number(row.id_refresh_token),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    ip: row.ip,
    user_agent: row.user_agent,
    device_label: row.device_label,
  }));
};

export const revokeRefreshTokenById = async ({
  idEmpresa,
  idUsuario,
  idRefreshToken,
  reason = "session_revoked",
}) => {
  const result = await pool.query(
    `
      update refresh_tokens
      set revoked_at = coalesce(revoked_at, now()),
          revoked_reason = coalesce(revoked_reason, $4)
      where id_empresa = $1
        and id_usuario = $2
        and id_refresh_token = $3
        and revoked_at is null
      returning id_refresh_token
    `,
    [idEmpresa, idUsuario, idRefreshToken, reason]
  );

  return result.rowCount > 0;
};

export const getRefreshCookieOptions = () => {
  const isDev = String(process.env.NODE_ENV).toLowerCase() !== "production";
  const configuredSameSite = String(
    process.env.COOKIE_SAMESITE || (isDev ? "lax" : "strict")
  )
    .trim()
    .toLowerCase();
  const sameSite = ["strict", "lax", "none"].includes(configuredSameSite)
    ? configuredSameSite
    : isDev
      ? "lax"
      : "strict";
  const domain = String(process.env.COOKIE_DOMAIN || "").trim();

  return {
    httpOnly: true,
    secure: !isDev || sameSite === "none",
    sameSite,
    ...(domain ? { domain } : {}),
    path: "/api/saas/auth",
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
};

export const REFRESH_COOKIE_NAME = "saas_rt";
