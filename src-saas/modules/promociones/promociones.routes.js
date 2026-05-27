import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./promociones.controller.js";

const router = Router();

router.use(authenticate);

router.get(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.list
);

router.post(
  "/",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.manage"),
  controller.create
);

// Preview: dado un carrito y opcionalmente un cupon, calcula el descuento
// que se aplicaria SIN crear la venta. Util para que el cajero le diga al
// cliente "te quedan tantos quetzales menos".
router.post(
  "/preview-venta",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.previewVenta
);

// Generacion masiva de cupones (campanas)
router.post(
  "/cupones/bulk",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.manage"),
  controller.generateBulkCupones
);

// QR payload de un cupon especifico (para imprimir en flyer / mostrar al cliente)
router.get(
  "/:id/qr",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.getCuponQrUrl
);

export default router;
