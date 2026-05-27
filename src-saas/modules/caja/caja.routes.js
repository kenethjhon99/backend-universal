import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import { requireModule } from "../../middlewares/require-module.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import { validate } from "../../shared/validation/validate.js";
import {
  cajaAperturaSchema,
  cajaCierreSchema,
  cajaMovimientoSchema,
  validarPendienteSchema,
} from "../../shared/validation/common-schemas.js";
import * as controller from "./caja.controller.js";

const router = Router();

router.use(authenticate);
router.use(withTenantDb);
router.use(requireModule("POS"));

router.get(
  "/sesion-activa",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.read"),
  controller.getCajaSesionActiva
);

router.get(
  "/sesiones",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.read"),
  controller.listCajaSesiones
);

router.post(
  "/apertura",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.manage"),
  enforcePlanLimits("caja"),
  validate({ body: cajaAperturaSchema }),
  controller.openCaja
);

router.get(
  "/:id/resumen",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.read"),
  controller.getCajaResumen
);

router.post(
  "/:id/movimientos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.manage"),
  validate({ body: cajaMovimientoSchema }),
  controller.createCajaMovimiento
);

router.post(
  "/:id/cierre",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.manage"),
  validate({ body: cajaCierreSchema }),
  controller.closeCaja
);

// Validacion uno-por-uno antes de cerrar caja.
router.post(
  "/:id/pendientes/no-cobro/validar",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.manage"),
  validate({ body: validarPendienteSchema }),
  controller.validateNoCobroPendiente
);

router.post(
  "/:id/pendientes/movimientos/:idMovimiento/validar",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("cash.manage"),
  validate({ body: validarPendienteSchema }),
  controller.validateCajaMovimientoPendiente
);

export default router;
