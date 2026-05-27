import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./finanzas.service.js";

export const getOverview = asyncHandler(async (req, res) => {
  const data = await service.getOverview({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const listCuentasPorCobrar = asyncHandler(async (req, res) => {
  const data = await service.listCuentasPorCobrar({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getCuentaPorCobrarById = asyncHandler(async (req, res) => {
  const data = await service.getCuentaPorCobrarById({
    auth: req.auth,
    scope: req.scope,
    idCuentaPorCobrar: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createCobroCuentaPorCobrar = asyncHandler(async (req, res) => {
  const data = await service.createCobroCuentaPorCobrar({
    auth: req.auth,
    scope: req.scope,
    idCuentaPorCobrar: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const listCuentasPorPagar = asyncHandler(async (req, res) => {
  const data = await service.listCuentasPorPagar({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getCuentaPorPagarById = asyncHandler(async (req, res) => {
  const data = await service.getCuentaPorPagarById({
    auth: req.auth,
    scope: req.scope,
    idCuentaPorPagar: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createPagoCuentaPorPagar = asyncHandler(async (req, res) => {
  const data = await service.createPagoCuentaPorPagar({
    auth: req.auth,
    scope: req.scope,
    idCuentaPorPagar: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const listNotasFormales = asyncHandler(async (req, res) => {
  const data = await service.listNotasFormales({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createNotaFormal = asyncHandler(async (req, res) => {
  const data = await service.createNotaFormal({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const listCierresPeriodo = asyncHandler(async (req, res) => {
  const data = await service.listCierresPeriodo({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createCierrePeriodo = asyncHandler(async (req, res) => {
  const data = await service.createCierrePeriodo({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});
