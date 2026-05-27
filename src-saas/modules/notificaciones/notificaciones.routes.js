import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./notificaciones.controller.js";

const router = Router();

router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  })
);

router.get("/canales", controller.listCanales);
router.post("/canales", controller.createCanal);
router.post("/canales/:id/test", controller.sendTest);
router.get("/eventos", controller.listEventos);

export default router;
