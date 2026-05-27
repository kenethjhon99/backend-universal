import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./auditoria.controller.js";

const router = Router();

router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  })
);
router.use(requirePermission("audit.read"));

router.get("/", controller.listAuditoriaEventos);
router.get("/eventos/:id/diff", controller.getEventoDiff);
router.get("/entidades/:entidad/:entidadId/historial", controller.getEntityHistory);

export default router;
