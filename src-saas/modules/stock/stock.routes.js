import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import { validate } from "../../shared/validation/validate.js";
import { ajusteStockSchema } from "../../shared/validation/common-schemas.js";
import * as controller from "./stock.controller.js";

const router = Router();

router.use(authenticate);
router.use(withTenantDb);
router.use(requireModule("INVENTARIO", "POS", "COMPRAS"));

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.read"),
  controller.listStock
);

router.get(
  "/movimientos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.read"),
  controller.listMovimientos
);

router.put(
  "/:idProducto/configuracion",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.manage"),
  controller.updateStockConfig
);

// G7 - Ajuste directo de existencia (alias del legacy PUT /stock/:id_producto)
router.put(
  "/:idProducto/ajuste",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.manage"),
  validate({ body: ajusteStockSchema }),
  controller.ajustarStock
);

router.post(
  "/movimientos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("inventory.manage"),
  controller.createMovimientoManual
);

export default router;
