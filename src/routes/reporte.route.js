import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  auditoriaCatalogo,
  reporteGeneral,
  corteVentas,
  corteVentasDetallado,
  corteVentasDetalladoPro,
} from "../controllers/reporte.controller.js";

const router = Router();

router.get("/auditoria", auth, requireRole("SUPER_ADMIN", "ADMIN", "LECTURA"), auditoriaCatalogo);
router.get("/general", auth, requireRole("SUPER_ADMIN", "ADMIN", "LECTURA"), reporteGeneral);
router.get("/corte", auth, requireRole("ADMIN"), corteVentas);
router.get("/corte-detallado", auth, requireRole("ADMIN"), corteVentasDetallado);
router.get("/corte-detallado-pro", auth, requireRole("ADMIN"), corteVentasDetalladoPro);
    
export default router;
