import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./stock.service.js";

export const listStock = asyncHandler(async (req, res) => {
  const data = await service.listStock({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const listMovimientos = asyncHandler(async (req, res) => {
  const data = await service.listMovimientos({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const updateStockConfig = asyncHandler(async (req, res) => {
  const data = await service.updateStockConfig({
    auth: req.auth,
    scope: req.scope,
    idProducto: Number(req.params.idProducto),
    body: req.body,
  });

  res.json({ ok: true, data });
});

export const createMovimientoManual = asyncHandler(async (req, res) => {
  const data = await service.createMovimientoManual({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
  });

  res.status(201).json({ ok: true, ...data });
});

export const ajustarStock = asyncHandler(async (req, res) => {
  const data = await service.ajustarStock({
    auth: req.auth,
    scope: req.scope,
    idProducto: Number(req.params.idProducto),
    body: req.body,
  });

  res.json({ ok: true, ...data });
});
