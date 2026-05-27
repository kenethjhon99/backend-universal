import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./caja.service.js";

export const getCajaSesionActiva = asyncHandler(async (req, res) => {
  const data = await service.getCajaSesionActiva({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
  });

  res.json({ ok: true, data });
});

export const listCajaSesiones = asyncHandler(async (req, res) => {
  const data = await service.listCajaSesiones({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const openCaja = asyncHandler(async (req, res) => {
  const data = await service.openCaja({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
  });

  res.status(201).json({ ok: true, data });
});

export const createCajaMovimiento = asyncHandler(async (req, res) => {
  const data = await service.createCajaMovimiento({
    auth: req.auth,
    scope: req.scope,
    idCajaSesion: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const closeCaja = asyncHandler(async (req, res) => {
  const data = await service.closeCaja({
    auth: req.auth,
    idCajaSesion: Number(req.params.id),
    body: req.body,
  });

  res.json({ ok: true, data });
});

export const getCajaResumen = asyncHandler(async (req, res) => {
  const data = await service.getCajaResumen({
    db: req.db,
    auth: req.auth,
    idCajaSesion: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const validateCajaMovimientoPendiente = asyncHandler(
  async (req, res) => {
    const data = await service.validateCajaMovimientoPendiente({
      auth: req.auth,
      scope: req.scope,
      idCajaSesion: Number(req.params.id),
      idCajaMovimiento: Number(req.params.idMovimiento),
      body: req.body,
      requestMeta: getRequestMeta(req),
    });

    res.json({ ok: true, data });
  }
);

export const validateNoCobroPendiente = asyncHandler(async (req, res) => {
  const data = await service.validateNoCobroPendiente({
    auth: req.auth,
    scope: req.scope,
    idCajaSesion: Number(req.params.id),
    idVenta: Number(req.body?.id_venta),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});
