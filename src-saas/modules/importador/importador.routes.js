import express, { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./importador.controller.js";

const router = Router();

router.use(authenticate);

// Aceptar text/csv hasta 10MB en este sub-router
router.use(express.text({ type: "text/csv", limit: "10mb" }));
router.use(express.json({ limit: "10mb" }));

router.post(
  "/productos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.importProductos
);

router.post(
  "/clientes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.importClientes
);

export default router;
