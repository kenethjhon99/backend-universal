import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requireModule } from "../../middlewares/require-module.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./reportes.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("REPORTES"));

router.get(
  "/general",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.getGeneralReport
);

router.get(
  "/corte",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.getCorteVentas
);

router.get(
  "/corte-detallado-pro",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.getCorteVentasDetalladoPro
);

// Comparador de precios entre sucursales (cadena multi-tienda)
router.get(
  "/comparador-precios",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("reports.read"),
  controller.comparadorPrecios
);

export default router;
