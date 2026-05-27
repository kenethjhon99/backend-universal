import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import * as controller from "./dashboards.controller.js";

const router = Router();
router.use(authenticate);

// Cualquier usuario autenticado puede gestionar SUS dashboards
router.get("/widgets/catalog", controller.getWidgetCatalog);
router.get("/", controller.listMine);
router.get("/default", controller.getDefault);
router.post("/", controller.create);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);

export default router;
