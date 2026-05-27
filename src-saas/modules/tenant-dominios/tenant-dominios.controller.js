import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./tenant-dominios.service.js";

export const listMine = asyncHandler(async (req, res) => {
  const data = await service.listMine({ auth: req.auth });
  res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
  const data = await service.create({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const verifyDomain = asyncHandler(async (req, res) => {
  const data = await service.verifyDomain({
    auth: req.auth,
    scope: req.scope,
    idDominio: Number(req.params.id),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const updateBranding = asyncHandler(async (req, res) => {
  const data = await service.updateBranding({
    auth: req.auth,
    idDominio: Number(req.params.id),
    body: req.body,
  });
  res.json({ ok: true, data });
});

export const updateDomainSettings = asyncHandler(async (req, res) => {
  const data = await service.updateDomainSettings({
    auth: req.auth,
    scope: req.scope,
    idDominio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const getPublicBranding = asyncHandler(async (req, res) => {
  const data = await service.getPublicBranding({ req });
  res.json({ ok: true, data });
});
