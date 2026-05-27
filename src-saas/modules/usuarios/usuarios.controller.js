import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./usuarios.service.js";

export const listAssignableRoles = asyncHandler(async (req, res) => {
  const data = await service.listAssignableRoles({
    auth: req.auth,
  });

  res.json({ ok: true, data });
});

export const listUsuarios = asyncHandler(async (req, res) => {
  const data = await service.listUsuarios({
    auth: req.auth,
    query: req.query,
  });

  res.json({ ok: true, data });
});

export const getUsuarioById = asyncHandler(async (req, res) => {
  const data = await service.getUsuarioById({
    auth: req.auth,
    idUsuario: Number(req.params.id),
  });

  res.json({ ok: true, data });
});

export const createUsuario = asyncHandler(async (req, res) => {
  const data = await service.createUsuario({
    auth: req.auth,
    body: req.body,
    scope: req.scope,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});

export const updateUsuario = asyncHandler(async (req, res) => {
  const data = await service.updateUsuario({
    auth: req.auth,
    idUsuario: Number(req.params.id),
    body: req.body,
    scope: req.scope,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});

export const updateUsuarioEstado = asyncHandler(async (req, res) => {
  const data = await service.updateUsuarioEstado({
    auth: req.auth,
    idUsuario: Number(req.params.id),
    activo: req.body?.activo === true,
    scope: req.scope,
    requestMeta: getRequestMeta(req),
  });

  res.json({ ok: true, data });
});
