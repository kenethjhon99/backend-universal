import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./fe.service.js";

export const certifyVenta = asyncHandler(async (req, res) => {
  const data = await service.certifyVenta({
    auth: req.auth,
    idVenta: Number(req.params.idVenta),
  });
  res.json({ ok: true, ...data });
});

export const cancelVenta = asyncHandler(async (req, res) => {
  const data = await service.cancelVenta({
    auth: req.auth,
    idVenta: Number(req.params.idVenta),
    motivo: req.body?.motivo,
  });
  res.json({ ok: true, ...data });
});

export const certifyNotaCredito = asyncHandler(async (req, res) => {
  const data = await service.certifyNotaCredito({
    auth: req.auth,
    idVentaReversion: Number(req.params.idReversion),
  });
  res.json({ ok: true, ...data });
});
