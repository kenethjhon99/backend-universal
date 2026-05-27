import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import { validate } from "../../shared/validation/validate.js";
import {
  ventaCreateSchema,
  ventaReversionSchema,
} from "../../shared/validation/common-schemas.js";
import * as controller from "./ventas.controller.js";

const router = Router();

router.use(authenticate);
router.use(withTenantDb);
router.use(requireModule("POS"));

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.listVentas
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.manage"),
  enforcePlanLimits("venta"),
  validate({ body: ventaCreateSchema }),
  controller.createVenta
);

router.get(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.getVentaById
);

router.post(
  "/:id/reversiones",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.refund"),
  validate({ body: ventaReversionSchema }),
  controller.createVentaReversion
);

export default router;
