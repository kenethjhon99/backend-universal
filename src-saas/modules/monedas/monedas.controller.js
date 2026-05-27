import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./monedas.service.js";

export const listMonedas = asyncHandler(async (_req, res) => {
  const data = await service.listMonedas();
  res.json({ ok: true, data });
});

export const getMonedaBase = asyncHandler(async (req, res) => {
  const codigo = await service.getMonedaBase({ idEmpresa: req.auth.id_empresa });
  res.json({ ok: true, data: { moneda_base: codigo } });
});

export const listTiposCambio = asyncHandler(async (req, res) => {
  const data = await service.listTiposCambio({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const getTasaVigente = asyncHandler(async (req, res) => {
  const tasa = await service.getTasaVigente({
    idEmpresa: req.auth.id_empresa,
    monedaOrigen: req.query?.moneda,
    fecha: req.query?.fecha,
  });
  res.json({ ok: true, data: { tasa } });
});

export const createTipoCambio = asyncHandler(async (req, res) => {
  const data = await service.createTipoCambio({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});
