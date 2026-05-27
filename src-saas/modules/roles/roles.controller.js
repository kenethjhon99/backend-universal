import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./roles.service.js";

export const getCatalogoPermisos = asyncHandler(async (req, res) => {
  const data = await service.getCatalogoPermisos({ db: req.db });
  res.json({ ok: true, data });
});

export const listRolesDisponibles = asyncHandler(async (req, res) => {
  const data = await service.listRolesDisponibles({
    db: req.db,
    auth: req.auth,
  });
  res.json({ ok: true, data });
});

export const createRolCustom = asyncHandler(async (req, res) => {
  const data = await service.createRolCustom({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.status(201).json({ ok: true, data });
});

export const updateRolCustom = asyncHandler(async (req, res) => {
  const data = await service.updateRolCustom({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    idRol: Number(req.params.id),
    body: req.body,
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, data });
});

export const deleteRolCustom = asyncHandler(async (req, res) => {
  const data = await service.deleteRolCustom({
    db: req.db,
    auth: req.auth,
    scope: req.scope,
    idRol: Number(req.params.id),
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});
