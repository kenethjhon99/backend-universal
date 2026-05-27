import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./compras.service.js";

export const listCompras = asyncHandler(async (req, res) => {
  const data = await service.listCompras({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createCompra = asyncHandler(async (req, res) => {
  const data = await service.createCompra({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const getCompraById = asyncHandler(async (req, res) => {
  const data = await service.getCompraById({
    db: req.db,
    auth: req.auth,
    idCompra: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createCompraDevolucion = asyncHandler(async (req, res) => {
  const data = await service.createCompraDevolucion({
    auth: req.auth,
    scope: req.scope,
    idCompra: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const createCompraCostAdjustment = asyncHandler(async (req, res) => {
  const data = await service.createCompraCostAdjustment({
    auth: req.auth,
    scope: req.scope,
    idCompra: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});
