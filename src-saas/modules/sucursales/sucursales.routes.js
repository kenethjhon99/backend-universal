import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./sucursales.controller.js";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("branches.read"),
  controller.listSucursales
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("branches.create"),
  enforcePlanLimits("sucursal"),
  controller.createSucursal
);

export default router;
