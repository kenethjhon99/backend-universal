import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./comprobantes.controller.js";

const router = Router();

router.use(authenticate);

/**
 * Catalogo de tipos de comprobante por modulo (estatico).
 * No depende de la empresa: sirve para que el frontend muestre las opciones disponibles.
 */
router.get(
  "/tipos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("comprobantes.read"),
  controller.getCatalog
);

/**
 * Lista series de comprobante de la empresa actual.
 * Filtros: ?modulo, ?tipo_comprobante, ?id_sucursal, ?activo
 */
router.get(
  "/series",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("comprobantes.read"),
  controller.listSeries
);

router.get(
  "/series/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("comprobantes.read"),
  controller.getSerieById
);

router.post(
  "/series",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("comprobantes.manage"),
  controller.createSerie
);

router.put(
  "/series/:id",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("comprobantes.manage"),
  controller.updateSerie
);

export default router;
