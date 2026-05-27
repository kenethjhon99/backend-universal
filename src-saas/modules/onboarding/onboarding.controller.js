import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./onboarding.service.js";

export const getPlanesPublicos = asyncHandler(async (_req, res) => {
  const data = await service.getPlanesPublicos();
  res.json({ ok: true, data });
});

export const selfRegister = asyncHandler(async (req, res) => {
  const data = await service.selfRegister({ body: req.body || {} });
  res.status(201).json({ ok: true, ...data });
});

export const getMiSuscripcion = asyncHandler(async (req, res) => {
  const data = await service.getMiSuscripcion({ auth: req.auth });
  res.json({ ok: true, data });
});
