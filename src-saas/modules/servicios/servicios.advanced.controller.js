import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./servicios.advanced.service.js";

export const listTechnicians = asyncHandler(async (req, res) => {
  const data = await service.listTechnicians({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const upsertTechnician = asyncHandler(async (req, res) => {
  const data = await service.upsertTechnician({
    auth: req.auth,
    scope: req.scope,
    idUsuario: Number(req.params.idUsuario),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const listChecklistTemplates = asyncHandler(async (req, res) => {
  const data = await service.listChecklistTemplates({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createChecklistTemplate = asyncHandler(async (req, res) => {
  const data = await service.createChecklistTemplate({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const updateChecklistTemplate = asyncHandler(async (req, res) => {
  const data = await service.updateChecklistTemplate({
    auth: req.auth,
    scope: req.scope,
    idChecklistTemplate: Number(req.params.idChecklistTemplate),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const listAgenda = asyncHandler(async (req, res) => {
  const data = await service.listAgenda({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getOrderControlById = asyncHandler(async (req, res) => {
  const data = await service.getOrderControlById({
    auth: req.auth,
    idOrdenServicio: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const scheduleOrder = asyncHandler(async (req, res) => {
  const data = await service.scheduleOrder({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const updateChecklistItem = asyncHandler(async (req, res) => {
  const data = await service.updateChecklistItem({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    idChecklistItem: Number(req.params.idChecklistItem),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const data = await service.cancelOrder({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const refundOrder = asyncHandler(async (req, res) => {
  const data = await service.refundOrder({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const getOperationsReport = asyncHandler(async (req, res) => {
  const data = await service.getServiceOperationsReport({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});
