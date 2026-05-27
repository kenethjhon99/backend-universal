import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import { HttpError } from "../../shared/http/http-error.js";
import * as service from "./platform.service.js";

export const getMetrics = asyncHandler(async (_req, res) => {
  const data = await service.getPlatformMetrics();
  res.json({ ok: true, ...data });
});

export const listPlanes = asyncHandler(async (_req, res) => {
  const data = await service.listPlanes();
  res.json({ ok: true, data });
});

export const createPlan = asyncHandler(async (req, res) => {
  const data = await service.createPlan({
    auth: req.auth,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const updatePlan = asyncHandler(async (req, res) => {
  const data = await service.updatePlan({
    auth: req.auth,
    codigo: req.params.codigo,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const changeEmpresaPlan = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.changeEmpresaPlan({
    auth: req.auth,
    idEmpresa,
    planCodigo: req.body?.plan_codigo,
    estado: req.body?.estado,
    motivo: req.body?.motivo,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const setEmpresaModulo = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.setEmpresaModulo({
    auth: req.auth,
    idEmpresa,
    codigoModulo: req.params.codigoModulo,
    activo: req.body?.activo,
    config: req.body?.config,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const listAddons = asyncHandler(async (_req, res) => {
  const data = await service.listAddons();
  res.json({ ok: true, data });
});

export const createAddon = asyncHandler(async (req, res) => {
  const data = await service.createAddon({
    auth: req.auth,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const updateAddon = asyncHandler(async (req, res) => {
  const data = await service.updateAddon({
    auth: req.auth,
    codigo: req.params.codigo,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const setPlanAddon = asyncHandler(async (req, res) => {
  const data = await service.setPlanAddon({
    auth: req.auth,
    planCodigo: req.params.codigo,
    addonCodigo: req.params.addonCodigo,
    incluido: req.body?.incluido,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const setEmpresaAddon = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.setEmpresaAddon({
    auth: req.auth,
    idEmpresa,
    addonCodigo: req.params.addonCodigo,
    estado: req.body?.estado,
    trialHasta: req.body?.trial_hasta,
    vigenteHasta: req.body?.vigente_hasta,
    limites: req.body?.limites,
    metadata: req.body?.metadata,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const suspend = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.suspendEmpresa({
    auth: req.auth,
    idEmpresa,
    motivo: String(req.body?.motivo || "manual").trim() || "manual",
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const reactivate = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.reactivateEmpresa({
    auth: req.auth,
    idEmpresa,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const impersonate = asyncHandler(async (req, res) => {
  const idEmpresa = Number(req.params.idEmpresa);
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido");
  }
  const data = await service.impersonate({
    auth: req.auth,
    idEmpresa,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});
