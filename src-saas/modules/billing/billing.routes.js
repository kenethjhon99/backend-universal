import express, { Router } from "express";
import { authenticatePermissive } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./billing.controller.js";

const router = Router();

// Webhook Stripe: SIN auth, body raw para verificar firma. Lo montamos primero
// para que express.json() del app.js global no consuma el body.
router.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  controller.handleStripeWebhook
);

// Endpoints autenticados (admin de empresa). IMPORTANTE: permissive porque
// el cliente suspendido necesita PODER pagar para reactivarse. Si usaramos
// `authenticate` estandar, una empresa SUSPENDIDA recibiria 402 y nunca
// podria llegar a la pantalla de pago.
router.use(authenticatePermissive);

router.get(
  "/planes",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.listPlanes
);

router.get(
  "/addons",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.listAddons
);

router.get(
  "/mi-suscripcion",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.getSubscriptionOverview
);

router.post(
  "/checkout-session",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.createCheckoutSession
);

router.post(
  "/addon-checkout-session",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.createAddonCheckoutSession
);

router.get(
  "/eventos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.listEventos
);

export default router;
