/**
 * Endpoints exclusivos del SuperAdmin SaaS para operar el SaaS.
 *
 * Todos requieren rol SUPER_ADMIN/SUPER_ADMIN_SAAS. La impersonacion queda registrada en
 * auditoria con motivo y target.
 */
import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as controller from "./platform.controller.js";

const router = Router();

router.use(authenticate);
router.use(
  authorize({
    roles: ["SUPER_ADMIN", "SUPER_ADMIN_SAAS"],
    allowAnyAssignedSucursal: true,
  })
);

router.get("/metrics", controller.getMetrics);
router.get("/planes", controller.listPlanes);
router.post("/planes", controller.createPlan);
router.put("/planes/:codigo", controller.updatePlan);
router.post("/planes/:codigo/addons/:addonCodigo", controller.setPlanAddon);
router.get("/addons", controller.listAddons);
router.post("/addons", controller.createAddon);
router.put("/addons/:codigo", controller.updateAddon);
router.post("/empresas/:idEmpresa/plan", controller.changeEmpresaPlan);
router.post("/empresas/:idEmpresa/modulos/:codigoModulo", controller.setEmpresaModulo);
router.post("/empresas/:idEmpresa/addons/:addonCodigo", controller.setEmpresaAddon);
router.post("/empresas/:idEmpresa/suspend", controller.suspend);
router.post("/empresas/:idEmpresa/reactivate", controller.reactivate);
router.post("/empresas/:idEmpresa/impersonate", controller.impersonate);

export default router;
