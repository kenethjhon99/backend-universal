import express, { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./conciliacion.controller.js";

const router = Router();
router.use(authenticate);
router.use(express.text({ type: "text/csv", limit: "10mb" }));
router.use(express.json({ limit: "10mb" }));

router.get(
  "/cuentas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listCuentas
);

router.post(
  "/cuentas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.createCuenta
);

router.post(
  "/cuentas/:idCuenta/extractos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.importExtracto
);

router.post(
  "/extractos/:idExtracto/auto-match",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.autoMatch
);

router.post(
  "/matches",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.matchManual
);

router.get(
  "/extractos/:idExtracto/resumen",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.getResumenExtracto
);

export default router;
