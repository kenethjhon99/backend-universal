import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./dashboards.service.js";

export const getWidgetCatalog = asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: service.getWidgetCatalog() });
});

export const listMine = asyncHandler(async (req, res) => {
  const data = await service.listMine({ auth: req.auth });
  res.json({ ok: true, data });
});

export const getDefault = asyncHandler(async (req, res) => {
  const data = await service.getDefault({ auth: req.auth });
  res.json({ ok: true, data });
});

export const create = asyncHandler(async (req, res) => {
  const data = await service.create({ auth: req.auth, body: req.body });
  res.status(201).json({ ok: true, data });
});

export const update = asyncHandler(async (req, res) => {
  const data = await service.update({
    auth: req.auth,
    idDashboard: Number(req.params.id),
    body: req.body,
  });
  res.json({ ok: true, data });
});

export const remove = asyncHandler(async (req, res) => {
  const data = await service.remove({
    auth: req.auth,
    idDashboard: Number(req.params.id),
  });
  res.json({ ok: true, ...data });
});
