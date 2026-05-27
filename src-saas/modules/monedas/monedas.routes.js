import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./monedas.controller.js";

const router = Router();

router.use(authenticate);

// Catalogo global de monedas (no requiere permiso especial)
router.get("/catalogo", controller.listMonedas);

// Moneda base de la empresa actual
router.get(
  "/empresa/base",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  controller.getMonedaBase
);

// Tipos de cambio
router.get(
  "/tipos-cambio",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listTiposCambio
);

router.get(
  "/tipos-cambio/vigente",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  controller.getTasaVigente
);

router.post(
  "/tipos-cambio",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.createTipoCambio
);

export default router;
