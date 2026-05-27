import { asyncHandler } from "../../shared/http/async-handler.js";
import { getRequestMeta } from "../../shared/http/request-meta.js";
import * as service from "./sucursales.service.js";

export const listSucursales = asyncHandler(async (req, res) => {
  const data = await service.listSucursales({ auth: req.auth });
  res.json({ ok: true, data });
});

export const createSucursal = asyncHandler(async (req, res) => {
  const data = await service.createSucursal({
    auth: req.auth,
    scope: req.scope,
    body: req.body,
    requestMeta: getRequestMeta(req),
  });

  res.status(201).json({ ok: true, data });
});
