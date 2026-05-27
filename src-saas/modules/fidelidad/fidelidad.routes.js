import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./fidelidad.controller.js";

const router = Router();
router.use(authenticate);

router.get(
  "/config",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.getConfig
);

router.put(
  "/config",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.manage"),
  controller.upsertConfig
);

router.get(
  "/clientes/:idCliente/saldo",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.getSaldoCliente
);

router.get(
  "/clientes/:idCliente/movimientos",
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA", "ENCARGADO_SUCURSAL", "CAJERO"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("sales.read"),
  controller.listMovimientosCliente
);

router.post(
  "/expirar-vencidos",
  authorize({ roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"] }),
  requirePermission("sales.manage"),
  controller.expirar
);

export default router;
