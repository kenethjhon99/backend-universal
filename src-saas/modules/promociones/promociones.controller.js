import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./promociones.service.js";
import * as cupones from "./cupones-masivos.js";

export const generateBulkCupones = asyncHandler(async (req, res) => {
  const data = await cupones.generateBulk({ auth: req.auth, body: req.body });
  res.status(201).json({ ok: true, data });
});

export const getCuponQrUrl = asyncHandler(async (req, res) => {
  const data = await cupones.getCuponQrUrl({
    auth: req.auth,
    idPromocion: Number(req.params.id),
    frontendOrigin: req.query?.frontend_origin || null,
  });
  res.json({ ok: true, data });
});

export const list = asyncHandler(async (req, res) => {
  const data = await service.list({ auth: req.auth, query: req.query });
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

export const previewVenta = asyncHandler(async (req, res) => {
  const data = await service.resolveActivePromotions({
    idEmpresa: req.auth.id_empresa,
    items: req.body?.items || [],
    idCliente: req.body?.id_cliente || null,
    cupon: req.body?.cupon || null,
  });
  res.json({ ok: true, data });
});
