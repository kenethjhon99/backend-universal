import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./webhooks.service.js";

export const listEndpoints = asyncHandler(async (req, res) => {
  const data = await service.listEndpoints({ auth: req.auth });
  res.json({ ok: true, data });
});

export const createEndpoint = asyncHandler(async (req, res) => {
  const data = await service.createEndpoint({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const rotateSecret = asyncHandler(async (req, res) => {
  const data = await service.rotateSecret({
    auth: req.auth,
    idEndpoint: Number(req.params.id),
  });
  res.json({ ok: true, data });
});

export const deactivateEndpoint = asyncHandler(async (req, res) => {
  const data = await service.deactivateEndpoint({
    auth: req.auth,
    idEndpoint: Number(req.params.id),
  });
  res.json({ ok: true, ...data });
});

export const listEventos = asyncHandler(async (req, res) => {
  const data = await service.listEventos({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const procesarPendientes = asyncHandler(async (_req, res) => {
  const data = await service.processPendingDeliveries(50);
  res.json({ ok: true, data });
});
