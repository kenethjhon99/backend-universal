import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./empresas.service.js";

export const createEmpresa = asyncHandler(async (req, res) => {
  const data = await service.createEmpresa({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, ...data });
});

export const listEmpresas = asyncHandler(async (req, res) => {
  const data = await service.listEmpresas({ auth: req.auth });
  res.json({ ok: true, data });
});

export const getEmpresaById = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaById({
    auth: req.auth,
    idEmpresa: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const getMyEmpresa = asyncHandler(async (req, res) => {
  const data = await service.getMyEmpresa({ auth: req.auth });
  res.json({ ok: true, data });
});

export const getMyBranding = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaBranding({
    auth: req.auth,
    idEmpresa: req.auth.id_empresa,
  });
  res.json({ ok: true, data });
});

export const updateMyBranding = asyncHandler(async (req, res) => {
  const data = await service.updateEmpresaBranding({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: req.auth.id_empresa,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const getMyWhiteLabel = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaWhiteLabel({
    auth: req.auth,
    idEmpresa: req.auth.id_empresa,
  });
  res.json({ ok: true, data });
});

export const updateMyWhiteLabel = asyncHandler(async (req, res) => {
  const data = await service.updateEmpresaWhiteLabel({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: req.auth.id_empresa,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const createMyApiKey = asyncHandler(async (req, res) => {
  const data = await service.createEmpresaApiKey({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: req.auth.id_empresa,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const revokeMyApiKey = asyncHandler(async (req, res) => {
  const data = await service.revokeEmpresaApiKey({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: req.auth.id_empresa,
    idApiKey: Number(req.params.idApiKey),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const listModuleCatalog = asyncHandler(async (req, res) => {
  const data = await service.listModuleCatalog({ auth: req.auth });
  res.json({ ok: true, data });
});

export const getEmpresaModules = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaModules({
    auth: req.auth,
    idEmpresa: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const updateEmpresaModules = asyncHandler(async (req, res) => {
  const data = await service.updateEmpresaModules({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, ...data });
});

export const getEmpresaBranding = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaBranding({
    auth: req.auth,
    idEmpresa: Number(req.params.id),
  });
  res.json({ ok: true, data });
});

export const updateEmpresaBranding = asyncHandler(async (req, res) => {
  const data = await service.updateEmpresaBranding({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, ...data });
});

export const getEmpresaWhiteLabel = asyncHandler(async (req, res) => {
  const data = await service.getEmpresaWhiteLabel({
    auth: req.auth,
    idEmpresa: Number(req.params.id),
  });
  res.json({ ok: true, data });
});

export const updateEmpresaWhiteLabel = asyncHandler(async (req, res) => {
  const data = await service.updateEmpresaWhiteLabel({
    auth: req.auth,
    scope: req.scope,
    idEmpresa: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});
