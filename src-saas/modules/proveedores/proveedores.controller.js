import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./proveedores.service.js";

export const listProveedores = asyncHandler(async (req, res) => {
  const data = await service.listProveedores({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getProveedorById = asyncHandler(async (req, res) => {
  const data = await service.getProveedorById({
    auth: req.auth,
    idProveedor: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createProveedor = asyncHandler(async (req, res) => {
  const data = await service.createProveedor({
    auth: req.auth,
    body: req.body,
  });

  res.status(201).json({ ok: true, data });
});

export const updateProveedor = asyncHandler(async (req, res) => {
  const data = await service.updateProveedor({
    auth: req.auth,
    idProveedor: Number(req.params.id),
    body: req.body,
  });

  res.json({ ok: true, data });
});

export const deactivateProveedor = asyncHandler(async (req, res) => {
  const data = await service.deactivateProveedor({
    auth: req.auth,
    idProveedor: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const setProveedorEstado = asyncHandler(async (req, res) => {
  const data = await service.setProveedorEstado({
    auth: req.auth,
    idProveedor: Number(req.params.id),
    activo:
      req.body?.activo === true || String(req.body?.activo) === "true"
        ? true
        : req.body?.activo === false || String(req.body?.activo) === "false"
          ? false
          : null,
  });

  res.json({ ok: true, data });
});
