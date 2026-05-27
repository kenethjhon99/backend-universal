import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import { HttpError } from "../../shared/http/http-error.js";
import * as service from "./conciliacion.service.js";

const getCsvText = (req) => {
  if (typeof req.body === "string") return req.body;
  if (req.body?.csv && typeof req.body.csv === "string") return req.body.csv;
  throw HttpError.badRequest(
    'Envia el CSV como text/csv o como { csv: "..." }'
  );
};

export const listCuentas = asyncHandler(async (req, res) => {
  const data = await service.listCuentas({ auth: req.auth });
  res.json({ ok: true, data });
});

export const createCuenta = asyncHandler(async (req, res) => {
  const data = await service.createCuenta({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const importExtracto = asyncHandler(async (req, res) => {
  const data = await service.importExtracto({
    auth: req.auth,
    scope: req.scope,
    idCuenta: Number(req.params.idCuenta),
    csvText: getCsvText(req),
    periodoDesde: req.query?.periodo_desde || req.body?.periodo_desde,
    periodoHasta: req.query?.periodo_hasta || req.body?.periodo_hasta,
    archivoOrigen: req.query?.archivo || req.body?.archivo || null,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const autoMatch = asyncHandler(async (req, res) => {
  const data = await service.autoMatch({
    auth: req.auth,
    scope: req.scope,
    idExtracto: Number(req.params.idExtracto),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const matchManual = asyncHandler(async (req, res) => {
  const data = await service.matchManual({
    auth: req.auth,
    body: req.body,
  });
  res.json({ ok: true, ...data });
});

export const getResumenExtracto = asyncHandler(async (req, res) => {
  const data = await service.getResumenExtracto({
    auth: req.auth,
    idExtracto: Number(req.params.idExtracto),
  });
  res.json({ ok: true, data });
});
