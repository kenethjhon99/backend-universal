import { asyncHandler } from "../../shared/http/async-handler.js";
import {
  REFRESH_COOKIE_NAME,
  getRefreshCookieOptions,
} from "../../shared/security/refresh-tokens.js";
import {
  CSRF_COOKIE,
  generateCsrfToken,
  getCsrfCookieOptions,
} from "../../middlewares/csrf.js";
import { HttpError } from "../../shared/http/http-error.js";
import * as authService from "./auth.service.js";

const getRequestMeta = (req) => ({
  userAgent: req.get("user-agent") || null,
  ip: req.ip || null,
});

const setRefreshCookie = (res, raw) => {
  res.cookie(REFRESH_COOKIE_NAME, raw, getRefreshCookieOptions());
};

const clearRefreshCookie = (res) => {
  const opts = getRefreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
  });
};

// Cookie CSRF (no httpOnly, leida por axios y replicada en X-XSRF-TOKEN).
// Se emite junto al refresh cookie en login/bootstrap/refresh.
const issueCsrfCookie = (res) => {
  const token = generateCsrfToken();
  res.cookie(CSRF_COOKIE, token, getCsrfCookieOptions());
  return token;
};

const clearCsrfCookie = (res) => {
  const opts = getCsrfCookieOptions();
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
  });
};

export const bootstrap = asyncHandler(async (req, res) => {
  const session = await authService.bootstrap(req.body || {});

  const refresh = await authService.issueSessionRefresh({
    idEmpresa: session.empresa.id_empresa,
    idUsuario: session.user.id_usuario,
    ...getRequestMeta(req),
  });
  setRefreshCookie(res, refresh.raw);
  issueCsrfCookie(res);

  res.status(201).json({ ok: true, ...session });
});

export const context = asyncHandler(async (req, res) => {
  const result = await authService.getPublicAuthContext({
    tenantContext: req.tenantContext || null,
  });
  res.json({ ok: true, ...result });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login({
    ...(req.body || {}),
    tenantContext: req.tenantContext || null,
    requestMeta: getRequestMeta(req),
  });

  // MFA enabled: devolver challenge sin emitir cookie de refresh
  if (result.mfa_required || result.company_selection_required) {
    res.json({ ok: true, ...result });
    return;
  }

  const refresh = await authService.issueSessionRefresh({
    idEmpresa: result.empresa.id_empresa,
    idUsuario: result.user.id_usuario,
    ...getRequestMeta(req),
  });
  setRefreshCookie(res, refresh.raw);
  issueCsrfCookie(res);

  res.json({ ok: true, ...result });
});

export const selectCompany = asyncHandler(async (req, res) => {
  const result = await authService.selectCompany({
    challenge_token: req.body?.challenge_token,
    id_empresa: req.body?.id_empresa,
    id_sucursal: req.body?.id_sucursal,
    tenantContext: req.tenantContext || null,
    requestMeta: getRequestMeta(req),
  });

  if (result.mfa_required) {
    res.json({ ok: true, ...result });
    return;
  }

  const refresh = await authService.issueSessionRefresh({
    idEmpresa: result.empresa.id_empresa,
    idUsuario: result.user.id_usuario,
    ...getRequestMeta(req),
  });
  setRefreshCookie(res, refresh.raw);
  issueCsrfCookie(res);

  res.json({ ok: true, ...result });
});

export const verifyMfaLogin = asyncHandler(async (req, res) => {
  const session = await authService.verifyMfaLogin({
    challenge_token: req.body?.challenge_token,
    code: req.body?.code,
    id_sucursal: req.body?.id_sucursal,
    requestMeta: getRequestMeta(req),
  });

  const refresh = await authService.issueSessionRefresh({
    idEmpresa: session.empresa.id_empresa,
    idUsuario: session.user.id_usuario,
    ...getRequestMeta(req),
  });
  setRefreshCookie(res, refresh.raw);
  issueCsrfCookie(res);

  res.json({ ok: true, ...session });
});

export const refresh = asyncHandler(async (req, res) => {
  const rawRefreshToken =
    req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refresh_token || null;

  if (!rawRefreshToken) {
    throw HttpError.unauthorized("Refresh token requerido");
  }

  const { refreshToken: newRefresh, ...session } = await authService.refreshSession({
    rawRefreshToken,
    ...getRequestMeta(req),
  });

  setRefreshCookie(res, newRefresh.raw);
  // Rotamos tambien el CSRF token en cada refresh
  issueCsrfCookie(res);
  res.json({ ok: true, ...session });
});

export const logout = asyncHandler(async (req, res) => {
  const rawRefreshToken =
    req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refresh_token || null;

  await authService.logoutSession({
    rawRefreshToken,
    auth: req.auth || null,
    requestMeta: getRequestMeta(req),
  });
  clearRefreshCookie(res);
  clearCsrfCookie(res);

  res.json({ ok: true });
});

export const requestPasswordReset = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset({
    email: req.body?.email,
    tenantContext: req.tenantContext || null,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, ...result });
});

export const confirmPasswordReset = asyncHandler(async (req, res) => {
  const result = await authService.confirmPasswordReset({
    token: req.body?.token,
    new_password: req.body?.new_password,
    requestMeta: getRequestMeta(req),
  });

  clearRefreshCookie(res);
  clearCsrfCookie(res);
  res.json({ ok: true, ...result });
});

export const sessions = asyncHandler(async (req, res) => {
  const sessionsList = await authService.listSessions({ auth: req.auth });
  res.json({ ok: true, sessions: sessionsList });
});

export const revokeSession = asyncHandler(async (req, res) => {
  const result = await authService.revokeSession({
    auth: req.auth,
    idRefreshToken: req.params.id,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...result });
});

export const logoutAll = asyncHandler(async (req, res) => {
  const result = await authService.logoutAllSessions({
    auth: req.auth,
    requestMeta: getRequestMeta(req),
  });

  clearRefreshCookie(res);
  clearCsrfCookie(res);
  res.json({ ok: true, ...result });
});

export const switchSucursal = asyncHandler(async (req, res) => {
  const session = await authService.switchSucursal({
    auth: req.auth,
    id_sucursal: Number(req.body?.id_sucursal),
  });

  res.json({ ok: true, ...session });
});

export const me = asyncHandler(async (req, res) => {
  const session = await authService.me(req.auth);
  res.json({ ok: true, ...session });
});
