import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./mfa.service.js";

export const getStatus = asyncHandler(async (req, res) => {
  const data = await service.getStatus({ auth: req.auth });
  res.json({ ok: true, ...data });
});

export const enroll = asyncHandler(async (req, res) => {
  const data = await service.enroll({
    auth: req.auth,
    scope: req.scope,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const verifyEnrollment = asyncHandler(async (req, res) => {
  const data = await service.verifyEnrollment({
    auth: req.auth,
    scope: req.scope,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const disable = asyncHandler(async (req, res) => {
  const data = await service.disable({
    auth: req.auth,
    scope: req.scope,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const regenerateBackupCodes = asyncHandler(async (req, res) => {
  const data = await service.regenerateBackupCodes({
    auth: req.auth,
    scope: req.scope,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});
