import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./reportes.service.js";
import { comparePrices } from "./comparador-precios.js";

export const comparadorPrecios = asyncHandler(async (req, res) => {
  const data = await comparePrices({ auth: req.auth, query: req.query });
  res.json({ ok: true, data });
});

export const getGeneralReport = asyncHandler(async (req, res) => {
  const data = await service.getGeneralReport({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getCorteVentas = asyncHandler(async (req, res) => {
  const data = await service.getCorteVentas({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getCorteVentasDetalladoPro = asyncHandler(async (req, res) => {
  const data = await service.getCorteVentasDetalladoPro({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});
