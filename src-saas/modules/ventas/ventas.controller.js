import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./ventas.service.js";

export const listVentas = asyncHandler(async (req, res) => {
  const data = await service.listVentas({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createVenta = asyncHandler(async (req, res) => {
  const data = await service.createVenta({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const getVentaById = asyncHandler(async (req, res) => {
  const data = await service.getVentaById({
    db: req.db,
    auth: req.auth,
    idVenta: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createVentaReversion = asyncHandler(async (req, res) => {
  const data = await service.createVentaReversion({
    auth: req.auth,
    scope: req.scope,
    idVenta: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});
