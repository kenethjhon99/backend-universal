import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requireModule } from "../../middlewares/require-module.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./servicios.controller.js";
import * as advancedController from "./servicios.advanced.controller.js";

const router = Router();

router.use(authenticate);
router.use(requireModule("SERVICIOS", "CARWASH"));

router.get(
  "/catalogo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.listCatalog
);

// Historial completo de un vehiculo por placa
router.get(
  "/historial-placa/:placa",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.getHistorialPlaca
);

// ----- G6: tipos de vehiculo -----
router.get(
  "/tipos-vehiculo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.listTiposVehiculo
);

router.get(
  "/tipos-vehiculo/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.getTipoVehiculoById
);

router.post(
  "/tipos-vehiculo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.createTipoVehiculo
);

router.put(
  "/tipos-vehiculo/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.updateTipoVehiculo
);

router.post(
  "/catalogo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.createCatalogItem
);

router.put(
  "/catalogo/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.updateCatalogItem
);

router.get(
  "/ordenes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.listOrders
);

router.post(
  "/ordenes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.createOrder
);

router.get(
  "/ordenes/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  controller.getOrderById
);

router.patch(
  "/ordenes/:id/seguimiento",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.updateOrderTracking
);

router.post(
  "/ordenes/:id/productos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.addProductToOrder
);

router.post(
  "/ordenes/:id/cobro",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  controller.chargeOrder
);

router.get(
  "/control/tecnicos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  advancedController.listTechnicians
);

router.put(
  "/control/tecnicos/:idUsuario",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  advancedController.upsertTechnician
);

router.get(
  "/control/checklists",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  advancedController.listChecklistTemplates
);

router.post(
  "/control/checklists",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  advancedController.createChecklistTemplate
);

router.put(
  "/control/checklists/:idChecklistTemplate",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  advancedController.updateChecklistTemplate
);

router.get(
  "/control/agenda",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  advancedController.listAgenda
);

router.get(
  "/control/ordenes/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.read"),
  advancedController.getOrderControlById
);

router.patch(
  "/control/ordenes/:id/agenda",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  advancedController.scheduleOrder
);

router.patch(
  "/control/ordenes/:id/checklist/:idChecklistItem",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.manage"),
  advancedController.updateChecklistItem
);

router.post(
  "/control/ordenes/:id/anulacion",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.refund"),
  advancedController.cancelOrder
);

router.post(
  "/control/ordenes/:id/reembolso",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.refund"),
  advancedController.refundOrder
);

router.get(
  "/control/reportes",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("services.reports.read"),
  advancedController.getOperationsReport
);

export default router;
