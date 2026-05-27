import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./bodegas.service.js";

export const listEmpresa = asyncHandler(async (req, res) => {
  const data = await service.listEmpresa({ auth: req.auth });
  res.json({ ok: true, data });
});

export const listBySucursal = asyncHandler(async (req, res) => {
  const data = await service.listBySucursal({
    auth: req.auth,
    idSucursal: Number(req.params.idSucursal),
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

export const update = asyncHandler(async (req, res) => {
  const data = await service.update({
    auth: req.auth,
    idBodega: Number(req.params.id),
    body: req.body,
  });
  res.json({ ok: true, data });
});
