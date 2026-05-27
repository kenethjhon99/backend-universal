import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./tenant-dominios.controller.js";

const router = Router();

// Endpoint público (sin auth): branding actual basado en el Host header.
// Usado por la pantalla de login ANTES de autenticar.
router.get("/branding-publico", controller.getPublicBranding);

// Resto de endpoints requieren admin de empresa
router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  })
);

router.get("/", controller.listMine);
router.post("/", controller.create);
router.post("/:id/verificar", controller.verifyDomain);
router.put("/:id", controller.updateDomainSettings);
router.put("/:id/branding", controller.updateBranding);

export default router;
