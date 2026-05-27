import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import * as controller from "./membresias.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("CARWASH", "SERVICIOS"));

router.get(
  "/planes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.listPlanes
);

router.post(
  "/planes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.createPlan
);

router.post(
  "/suscripciones",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.subscribeCliente
);

router.get(
  "/clientes/:idCliente",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.listMembresiasCliente
);

router.post(
  "/expirar-vencidas",
  authorize({ roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"] }),
  requirePermission("services.manage"),
  controller.expireOldMemberships
);

export default router;
