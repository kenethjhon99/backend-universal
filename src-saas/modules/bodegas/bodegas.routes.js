import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./bodegas.controller.js";

const router = Router();
router.use(authenticate);

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.read"),
  controller.listEmpresa
);

router.get(
  "/sucursal/:idSucursal",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.read"),
  controller.listBySucursal
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.manage"),
  enforcePlanLimits("bodega"),
  controller.create
);

router.put(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.manage"),
  controller.update
);

export default router;
