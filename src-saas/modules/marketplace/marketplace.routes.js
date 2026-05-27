import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./marketplace.controller.js";

const router = Router();
router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  })
);

router.get("/integraciones", controller.list);
router.post("/integraciones", controller.create);
router.post("/mappings", controller.mapProduct);
router.post("/sync/productos/:idProducto/stock", controller.syncStockProducto);
router.get("/sync/log", controller.getSyncLog);

export default router;
