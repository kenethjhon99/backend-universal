import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import * as controller from "./compras.controller.js";

const router = Router();

router.use(authenticate);
router.use(withTenantDb);
router.use(requireModule("COMPRAS", "INVENTARIO"));

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("purchases.read"),
  controller.listCompras
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("purchases.manage"),
  controller.createCompra
);

router.get(
  "/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("purchases.read"),
  controller.getCompraById
);

router.post(
  "/:id/devoluciones",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("purchases.manage"),
  controller.createCompraDevolucion
);

router.post(
  "/:id/ajustes-costo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("purchases.adjust"),
  controller.createCompraCostAdjustment
);

export default router;
