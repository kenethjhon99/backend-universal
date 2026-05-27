import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./comisiones.service.js";

export const listReglas = asyncHandler(async (req, res) => {
  const data = await service.listReglas({ auth: req.auth });
  res.json({ ok: true, data });
});

export const createRegla = asyncHandler(async (req, res) => {
  const data = await service.createRegla({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const reportByTecnico = asyncHandler(async (req, res) => {
  const data = await service.reportByTecnico({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const markPaid = asyncHandler(async (req, res) => {
  const data = await service.markPaid({
    auth: req.auth,
    scope: req.scope,
    idComision: Number(req.params.id),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});
