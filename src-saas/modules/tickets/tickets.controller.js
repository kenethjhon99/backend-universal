import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./tickets.service.js";

export const list = asyncHandler(async (req, res) => {
  const data = await service.list({ auth: req.auth, query: req.query });
  res.json({ ok: true, data });
});

export const getById = asyncHandler(async (req, res) => {
  const data = await service.getById({
    auth: req.auth,
    idTicket: Number(req.params.id),
  });
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

export const addMessage = asyncHandler(async (req, res) => {
  const data = await service.addMessage({
    auth: req.auth,
    idTicket: Number(req.params.id),
    body: req.body,
  });
  res.status(201).json({ ok: true, data });
});

export const assign = asyncHandler(async (req, res) => {
  const data = await service.assign({
    auth: req.auth,
    idTicket: Number(req.params.id),
    idUsuarioAsignado: req.body?.id_asignado ? Number(req.body.id_asignado) : null,
  });
  res.json({ ok: true, data });
});

export const getStats = asyncHandler(async (req, res) => {
  const data = await service.getStats({ auth: req.auth });
  res.json({ ok: true, data });
});
