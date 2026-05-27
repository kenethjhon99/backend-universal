import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import * as controller from "./clientes.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("POS", "SERVICIOS", "CARWASH"));

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.read"),
  controller.listClientes
);

router.get(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.read"),
  controller.getClienteById
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.createCliente
);

router.put(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.updateCliente
);

router.delete(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.deactivateCliente
);

// G8 - PATCH /:id/estado coherente
router.patch(
  "/:id/estado",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.setClienteEstado
);

export default router;
