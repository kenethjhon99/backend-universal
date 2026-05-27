import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { enforcePlanLimits } from "../../middlewares/enforce-plan-limits.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./usuarios.controller.js";

const router = Router();

router.use(authenticate);
router.use(
  authorize({
    roles: ["ADMIN_EMPRESA", "GERENTE", "ENCARGADO_SUCURSAL"],
    allowAnyAssignedSucursal: true,
  })
);

router.get(
  "/catalogo/roles",
  requirePermission("users.read"),
  controller.listAssignableRoles
);
router.get("/", requirePermission("users.read"), controller.listUsuarios);
router.get("/:id", requirePermission("users.read"), controller.getUsuarioById);
router.post(
  "/",
  requirePermission("users.create"),
  enforcePlanLimits("usuario"),
  controller.createUsuario
);
router.put("/:id", requirePermission("users.update"), controller.updateUsuario);
router.patch(
  "/:id/estado",
  requirePermission("users.status"),
  controller.updateUsuarioEstado
);

export default router;
