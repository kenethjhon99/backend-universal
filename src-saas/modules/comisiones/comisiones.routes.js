import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import * as controller from "./comisiones.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("SERVICIOS", "CARWASH"));

router.get(
  "/reglas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.listReglas
);

router.post(
  "/reglas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.createRegla
);

router.get(
  "/reporte",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.reports.read"),
  controller.reportByTecnico
);

router.patch(
  "/:id/pagar",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.markPaid
);

export default router;
