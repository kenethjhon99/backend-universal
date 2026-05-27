import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./comprobantes.service.js";

export const getCatalog = asyncHandler(async (_req, res) => {
  const data = service.getCatalog();
  res.json({ ok: true, data });
});

export const listSeries = asyncHandler(async (req, res) => {
  const data = await service.listSeries({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getSerieById = asyncHandler(async (req, res) => {
  const data = await service.getSerieById({
    auth: req.auth,
    idComprobanteSerie: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createSerie = asyncHandler(async (req, res) => {
  const data = await service.createSerie({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const updateSerie = asyncHandler(async (req, res) => {
  const data = await service.updateSerie({
    auth: req.auth,
    scope: req.scope,
    idComprobanteSerie: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});
