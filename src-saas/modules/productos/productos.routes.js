import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import { validate } from "../../shared/validation/validate.js";
import {
  productoCreateSchema,
  productoUpdateSchema,
  setEstadoSchema,
} from "../../shared/validation/common-schemas.js";
import * as controller from "./productos.controller.js";

const router = Router();

router.use(authenticate);
router.use(withTenantDb);

router.get(
  "/",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.read"),
  controller.listProductos
);

router.get(
  "/codigo-barras/generar",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  controller.generateCodigoBarras
);

router.get(
  "/:id",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.read"),
  controller.getProductoById
);

router.post(
  "/",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  enforcePlanLimits("producto"),
  validate({ body: productoCreateSchema }),
  controller.createProducto
);

router.put(
  "/:id",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  validate({ body: productoUpdateSchema }),
  controller.updateProducto
);

// G8 - PATCH /:id/estado coherente (activar / desactivar)
router.patch(
  "/:id/estado",
  requireModule("POS", "INVENTARIO"),
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("catalogs.manage"),
  validate({ body: setEstadoSchema }),
  controller.setProductoEstado
);

export default router;
