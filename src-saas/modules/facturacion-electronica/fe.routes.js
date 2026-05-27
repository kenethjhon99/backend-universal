import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./fe.controller.js";

const router = Router();

router.use(authenticate);

router.post(
  "/ventas/:idVenta/certificar",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.manage"),
  controller.certifyVenta
);

router.post(
  "/ventas/:idVenta/anular",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.refund"),
  controller.cancelVenta
);

router.post(
  "/notas-credito/:idReversion/certificar",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.refund"),
  controller.certifyNotaCredito
);

export default router;
