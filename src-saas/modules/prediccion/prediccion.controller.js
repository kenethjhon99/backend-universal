import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./prediccion.service.js";

export const listForecastProductos = asyncHandler(async (req, res) => {
  const data = await service.listForecastProductos({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const getForecastProducto = asyncHandler(async (req, res) => {
  const data = await service.getForecastProducto({
    auth: req.auth,
    idProducto: Number(req.params.idProducto),
    query: req.query,
  });
  res.json({ ok: true, data });
});
