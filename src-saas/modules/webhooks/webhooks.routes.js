import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./webhooks.controller.js";

const router = Router();
router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  })
);

router.get("/endpoints", controller.listEndpoints);
router.post("/endpoints", controller.createEndpoint);
router.post("/endpoints/:id/rotate-secret", controller.rotateSecret);
router.post("/endpoints/:id/deactivate", controller.deactivateEndpoint);
router.get("/eventos", controller.listEventos);
router.post("/procesar-pendientes", controller.procesarPendientes);

export default router;
