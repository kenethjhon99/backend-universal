import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import * as controller from "./roles.controller.js";

const router = Router();
router.use(authenticate);
// withTenantDb activa RLS por transaccion: expone req.db con
// app.current_empresa_id seteado. Los services del modulo usan req.db,
// no pool directo.
router.use(withTenantDb);

// Catalogo de permisos disponibles: cualquier admin puede leerlo para armar
// formularios de creacion de roles.
router.get(
  "/catalogo-permisos",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  controller.getCatalogoPermisos
);

router.get(
  "/",
  authorize({
    roles: ["ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("users.read"),
  controller.listRolesDisponibles
);

router.post(
  "/",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("roles.manage"),
  controller.createRolCustom
);

router.put(
  "/:id",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("roles.manage"),
  controller.updateRolCustom
);

router.delete(
  "/:id",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("roles.manage"),
  controller.deleteRolCustom
);

export default router;
