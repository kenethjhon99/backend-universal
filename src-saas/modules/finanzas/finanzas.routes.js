import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requireModule } from "../../middlewares/require-module.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./finanzas.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("FINANZAS"));

router.get(
  "/overview",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.getOverview
);

router.get(
  "/cxc",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listCuentasPorCobrar
);

router.get(
  "/cxc/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.getCuentaPorCobrarById
);

router.post(
  "/cxc/:id/cobros",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.createCobroCuentaPorCobrar
);

router.get(
  "/cxp",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listCuentasPorPagar
);

router.get(
  "/cxp/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.getCuentaPorPagarById
);

router.post(
  "/cxp/:id/pagos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.createPagoCuentaPorPagar
);

router.get(
  "/notas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listNotasFormales
);

router.post(
  "/notas",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.manage"),
  controller.createNotaFormal
);

router.get(
  "/cierres",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.read"),
  controller.listCierresPeriodo
);

router.post(
  "/cierres",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("finance.close"),
  controller.createCierrePeriodo
);

export default router;
