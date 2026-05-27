import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { requirePermission } from "../../middlewares/require-permission.js";
import * as controller from "./empresas.controller.js";

const router = Router();

router.use(authenticate);

router.get(
  "/catalogo/modulos",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.modules.catalog.read"),
  controller.listModuleCatalog
);
router.get("/me", requirePermission("company.read"), controller.getMyEmpresa);
router.get(
  "/me/branding",
  requirePermission("company.branding.read"),
  controller.getMyBranding
);
router.put(
  "/me/branding",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.branding.update"),
  controller.updateMyBranding
);
router.get(
  "/me/white-label",
  requirePermission("company.white_label.read"),
  controller.getMyWhiteLabel
);
router.put(
  "/me/white-label",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.white_label.update"),
  controller.updateMyWhiteLabel
);
router.post(
  "/me/api-keys",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.api_keys.manage"),
  controller.createMyApiKey
);
router.post(
  "/me/api-keys/:idApiKey/revoke",
  authorize({
    roles: ["ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.api_keys.manage"),
  controller.revokeMyApiKey
);
router.get("/", requirePermission("company.read"), controller.listEmpresas);
router.get(
  "/:id/branding",
  requirePermission("company.branding.read"),
  controller.getEmpresaBranding
);
router.put(
  "/:id/branding",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.branding.update"),
  controller.updateEmpresaBranding
);
router.get(
  "/:id/white-label",
  requirePermission("company.white_label.read"),
  controller.getEmpresaWhiteLabel
);
router.put(
  "/:id/white-label",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS", "ADMIN_EMPRESA"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.white_label.update"),
  controller.updateEmpresaWhiteLabel
);
router.get(
  "/:id/modulos",
  requirePermission("company.modules.read"),
  controller.getEmpresaModules
);
router.put(
  "/:id/modulos",
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"],
    allowAnyAssignedSucursal: true,
  }),
  requirePermission("company.modules.update"),
  controller.updateEmpresaModules
);
router.get("/:id", requirePermission("company.read"), controller.getEmpresaById);
router.post(
  "/",
  authorize({ roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"] }),
  requirePermission("company.create"),
  controller.createEmpresa
);

export default router;
