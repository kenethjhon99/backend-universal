import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./notificaciones.service.js";

export const listCanales = asyncHandler(async (req, res) => {
  const data = await service.listCanales({ auth: req.auth });
  res.json({ ok: true, data });
});

export const createCanal = asyncHandler(async (req, res) => {
  const data = await service.createCanal({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const listEventos = asyncHandler(async (req, res) => {
  const data = await service.listEventos({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const sendTest = asyncHandler(async (req, res) => {
  const data = await service.sendTest({
    auth: req.auth,
    idCanal: Number(req.params.id),
  });
  res.json({ ok: true, ...data });
});
