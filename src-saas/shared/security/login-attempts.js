import { HttpError } from "../http/http-error.js";

const LOGIN_ATTEMPT_WINDOW_MINUTES = Number(
  process.env.LOGIN_ATTEMPT_WINDOW_MINUTES || 15
);
const LOGIN_LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);
const LOGIN_MAX_FAILED_ATTEMPTS = Number(
  process.env.LOGIN_MAX_FAILED_ATTEMPTS || 5
);

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const toInterval = (minutes) => `${Math.max(1, Number(minutes) || 1)} minutes`;

export const getLoginLockStatus = async (
  db,
  { email, idEmpresa = null, idUsuario = null }
) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail && !idUsuario) {
    return { locked: false };
  }

  const params = [
    normalizedEmail,
    idEmpresa ? Number(idEmpresa) : null,
    idUsuario ? Number(idUsuario) : null,
    toInterval(LOGIN_ATTEMPT_WINDOW_MINUTES),
  ];

  const result = await db.query(
    `
      select count(*)::int as total, max(created_at) as last_attempt_at
      from login_intentos_fallidos
      where created_at >= now() - $4::interval
        and (
          ($3::bigint is not null and id_usuario = $3::bigint)
          or ($1::text <> '' and lower(email) = $1::text)
        )
        and ($2::bigint is null or id_empresa is null or id_empresa = $2::bigint)
    `,
    params
  );

  const total = Number(result.rows[0]?.total || 0);
  const lastAttemptAt = result.rows[0]?.last_attempt_at
    ? new Date(result.rows[0].last_attempt_at)
    : null;

  if (total < LOGIN_MAX_FAILED_ATTEMPTS || !lastAttemptAt) {
    return { locked: false, failedAttempts: total };
  }

  const lockedUntil = new Date(
    lastAttemptAt.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000
  );

  if (lockedUntil.getTime() <= Date.now()) {
    return { locked: false, failedAttempts: total };
  }

  return {
    locked: true,
    failedAttempts: total,
    lockedUntil: lockedUntil.toISOString(),
  };
};

export const assertLoginNotLocked = async (db, options) => {
  const status = await getLoginLockStatus(db, options);
  if (!status.locked) return status;

  throw HttpError.tooManyRequests(
    "Demasiados intentos fallidos. Intenta nuevamente mas tarde.",
    { locked_until: status.lockedUntil }
  );
};

export const recordLoginFailure = async (
  db,
  { email, idEmpresa = null, idUsuario = null, ip = null, userAgent = null, motivo }
) => {
  const normalizedEmail = normalizeEmail(email) || "unknown";
  await db.query(
    `
      insert into login_intentos_fallidos (
        id_empresa, id_usuario, email, ip, user_agent, motivo
      )
      values ($1, $2, $3, $4, $5, $6)
    `,
    [
      idEmpresa ? Number(idEmpresa) : null,
      idUsuario ? Number(idUsuario) : null,
      normalizedEmail,
      ip,
      userAgent,
      motivo || "invalid_credentials",
    ]
  );
};

export const clearLoginFailures = async (
  db,
  { email, idEmpresa = null, idUsuario = null }
) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail && !idUsuario) return;

  await db.query(
    `
      delete from login_intentos_fallidos
      where (
          ($3::bigint is not null and id_usuario = $3::bigint)
          or ($1::text <> '' and lower(email) = $1::text)
        )
        and ($2::bigint is null or id_empresa is null or id_empresa = $2::bigint)
    `,
    [
      normalizedEmail,
      idEmpresa ? Number(idEmpresa) : null,
      idUsuario ? Number(idUsuario) : null,
    ]
  );
};

