import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./billing.service.js";

const getRequestMeta = (req) => ({
  userAgent: req.get("user-agent") || null,
  ip: req.ip || null,
});

export const createCheckoutSession = asyncHandler(async (req, res) => {
  const data = await service.createCheckoutSession({
    auth: req.auth,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const createAddonCheckoutSession = asyncHandler(async (req, res) => {
  const data = await service.createAddonCheckoutSession({
    auth: req.auth,
    body: req.body || {},
    requestMeta: getRequestMeta(req),
  });
  res.json({ ok: true, ...data });
});

export const listPlanes = asyncHandler(async (req, res) => {
  const data = await service.listPlanes({
    publico: req.query?.publico !== "false",
  });
  res.json({ ok: true, data });
});

export const listAddons = asyncHandler(async (req, res) => {
  const data = await service.listAddons({
    publico: req.query?.publico !== "false",
  });
  res.json({ ok: true, data });
});

export const getSubscriptionOverview = asyncHandler(async (req, res) => {
  const data = await service.getSubscriptionOverview({ auth: req.auth });
  res.json({ ok: true, data });
});

export const handleStripeWebhook = asyncHandler(async (req, res) => {
  // req.body tiene que ser raw para verificar la firma
  const signature = req.headers["stripe-signature"];
  const data = await service.handleStripeWebhook({
    rawBody: req.body,
    signature,
    requestMeta: getRequestMeta(req),
  });
  res.json(data);
});

export const listEventos = asyncHandler(async (req, res) => {
  const data = await service.listEventos({ auth: req.auth });
  res.json({ ok: true, data });
});
