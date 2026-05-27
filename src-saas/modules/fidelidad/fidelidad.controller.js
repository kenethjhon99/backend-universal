import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./fidelidad.service.js";

export const getConfig = asyncHandler(async (req, res) => {
  const data = await service.getConfig({ auth: req.auth });
  res.json({ ok: true, data });
});

export const upsertConfig = asyncHandler(async (req, res) => {
  const data = await service.upsertConfig({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const getSaldoCliente = asyncHandler(async (req, res) => {
  const data = await service.getSaldoCliente({
    auth: req.auth,
    idCliente: Number(req.params.idCliente),
  });
  res.json({ ok: true, data });
});

export const listMovimientosCliente = asyncHandler(async (req, res) => {
  const data = await service.listMovimientosCliente({
    auth: req.auth,
    idCliente: Number(req.params.idCliente),
    limit: Number(req.query?.limit) || 50,
  });
  res.json({ ok: true, data });
});

export const expirar = asyncHandler(async (_req, res) => {
  const data = await service.expirarVigentes();
  res.json({ ok: true, data });
});
