import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./membresias.service.js";

export const listPlanes = asyncHandler(async (req, res) => {
  const data = await service.listPlanes({ auth: req.auth, query: req.query });
  res.json({ ok: true, data });
});

export const createPlan = asyncHandler(async (req, res) => {
  const data = await service.createPlan({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const subscribeCliente = asyncHandler(async (req, res) => {
  const data = await service.subscribeCliente({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const listMembresiasCliente = asyncHandler(async (req, res) => {
  const data = await service.listMembresiasCliente({
    auth: req.auth,
    idCliente: Number(req.params.idCliente),
  });
  res.json({ ok: true, data });
});

export const expireOldMemberships = asyncHandler(async (_req, res) => {
  const data = await service.expireOldMemberships();
  res.json({ ok: true, data });
});
