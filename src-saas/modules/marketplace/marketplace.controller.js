import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./marketplace.service.js";

export const list = asyncHandler(async (req, res) => {
  const data = await service.list({ auth: req.auth });
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

export const mapProduct = asyncHandler(async (req, res) => {
  const data = await service.mapProduct({ auth: req.auth, body: req.body });
  res.status(201).json({ ok: true, data });
});

export const syncStockProducto = asyncHandler(async (req, res) => {
  const data = await service.syncStockProducto({
    idEmpresa: req.auth.id_empresa,
    idProducto: Number(req.params.idProducto),
  });
  res.json({ ok: true, data });
});

export const getSyncLog = asyncHandler(async (req, res) => {
  const data = await service.getSyncLog({ auth: req.auth, query: req.query });
  res.json({ ok: true, data });
});
