import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./servicios.service.js";
import { getHistorialPorPlaca } from "./historial-placa.js";

export const getHistorialPlaca = asyncHandler(async (req, res) => {
  const data = await getHistorialPorPlaca({
    auth: req.auth,
    placa: req.params.placa,
  });
  res.json({ ok: true, data });
});

export const listCatalog = asyncHandler(async (req, res) => {
  const data = await service.listCatalog({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createCatalogItem = asyncHandler(async (req, res) => {
  const data = await service.createCatalogItem({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const updateCatalogItem = asyncHandler(async (req, res) => {
  const data = await service.updateCatalogItem({
    auth: req.auth,
    scope: req.scope,
    idServicioCatalogo: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const listOrders = asyncHandler(async (req, res) => {
  const data = await service.listOrders({
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const createOrder = asyncHandler(async (req, res) => {
  const data = await service.createOrder({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const getOrderById = asyncHandler(async (req, res) => {
  const data = await service.getOrderById({
    auth: req.auth,
    idOrdenServicio: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const updateOrderTracking = asyncHandler(async (req, res) => {
  const data = await service.updateOrderTracking({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const addProductToOrder = asyncHandler(async (req, res) => {
  const data = await service.addProductToOrder({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const chargeOrder = asyncHandler(async (req, res) => {
  const data = await service.chargeOrder({
    auth: req.auth,
    scope: req.scope,
    idOrdenServicio: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

// ----- G6: tipos de vehiculo -----

export const listTiposVehiculo = asyncHandler(async (req, res) => {
  const data = await service.listTiposVehiculo({
    auth: req.auth,
    query: req.query,
  });
  res.json({ ok: true, data });
});

export const getTipoVehiculoById = asyncHandler(async (req, res) => {
  const data = await service.getTipoVehiculoById({
    auth: req.auth,
    idTipoVehiculo: Number(req.params.id),
  });
  res.json({ ok: true, data });
});

export const createTipoVehiculo = asyncHandler(async (req, res) => {
  const data = await service.createTipoVehiculo({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const updateTipoVehiculo = asyncHandler(async (req, res) => {
  const data = await service.updateTipoVehiculo({
    auth: req.auth,
    scope: req.scope,
    idTipoVehiculo: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});
