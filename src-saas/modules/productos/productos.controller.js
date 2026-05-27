import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./productos.service.js";

export const listProductos = asyncHandler(async (req, res) => {
  const data = await service.listProductos({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getProductoById = asyncHandler(async (req, res) => {
  const data = await service.getProductoById({
    db: req.db,
    auth: req.auth,
    idProducto: Number(req.params.id),
    idSucursal: req.scope.id_sucursal,
  });

  res.json({ ok: true, data });
});

export const createProducto = asyncHandler(async (req, res) => {
  const data = await service.createProducto({
    auth: req.auth,
    body: req.body,
  });

  res.status(201).json({ ok: true, data });
});

export const updateProducto = asyncHandler(async (req, res) => {
  const data = await service.updateProducto({
    auth: req.auth,
    idProducto: Number(req.params.id),
    idSucursal: req.scope.id_sucursal,
    body: req.body,
  });

  res.json({ ok: true, data });
});

export const generateCodigoBarras = asyncHandler(async (req, res) => {
  const data = await service.generateUniqueCodigoBarras({
    db: req.db,
    idEmpresa: req.auth.id_empresa,
  });

  res.json({ ok: true, data });
});

export const setProductoEstado = asyncHandler(async (req, res) => {
  const data = await service.setProductoEstado({
    db: req.db,
    auth: req.auth,
    idProducto: Number(req.params.id),
    idSucursal: req.scope.id_sucursal,
    activo:
      req.body?.activo === true || String(req.body?.activo) === "true"
        ? true
        : req.body?.activo === false || String(req.body?.activo) === "false"
          ? false
          : null,
  });

  res.json({ ok: true, data });
});
