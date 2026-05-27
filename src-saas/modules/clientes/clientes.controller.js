import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./clientes.service.js";

export const listClientes = asyncHandler(async (req, res) => {
  const data = await service.listClientes({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getClienteById = asyncHandler(async (req, res) => {
  const data = await service.getClienteById({
    auth: req.auth,
    idCliente: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createCliente = asyncHandler(async (req, res) => {
  const data = await service.createCliente({
    auth: req.auth,
    body: req.body,
  });

  res.status(201).json({ ok: true, data });
});

export const updateCliente = asyncHandler(async (req, res) => {
  const data = await service.updateCliente({
    auth: req.auth,
    idCliente: Number(req.params.id),
    body: req.body,
  });

  res.json({ ok: true, data });
});

export const deactivateCliente = asyncHandler(async (req, res) => {
  const data = await service.deactivateCliente({
    auth: req.auth,
    idCliente: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const setClienteEstado = asyncHandler(async (req, res) => {
  const data = await service.setClienteEstado({
    auth: req.auth,
    idCliente: Number(req.params.id),
    activo:
      req.body?.activo === true || String(req.body?.activo) === "true"
        ? true
        : req.body?.activo === false || String(req.body?.activo) === "false"
          ? false
          : null,
  });

  res.json({ ok: true, data });
});
