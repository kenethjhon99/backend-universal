import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import * as controller from "./prediccion.controller.js";

const router = Router();
router.use(authenticate);
router.use(requireModule("INVENTARIO", "REPORTES"));

router.get(
  "/productos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.listForecastProductos
);

router.get(
  "/productos/:idProducto",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.getForecastProducto
);

export default router;
