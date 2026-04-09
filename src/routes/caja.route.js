import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  abrirCaja,
  cerrarCaja,
  getResumenCaja,
  getSesionActiva,
  listarSesiones,
  registrarMovimiento,
  validarMovimientoPendiente,
  validarNoCobroPendiente,
} from "../controllers/caja.controller.js";

const router = Router();

router.get("/sesion-activa", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"), getSesionActiva);
router.get("/sesiones", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"), listarSesiones);
router.get("/:id_sesion/resumen", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"), getResumenCaja);
router.post("/apertura", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"), abrirCaja);
router.post("/:id_sesion/movimientos", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"), registrarMovimiento);
router.post("/:id_sesion/pendientes/no-cobro/validar", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"), validarNoCobroPendiente);
router.post("/:id_sesion/pendientes/movimientos/:id_movimiento/validar", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"), validarMovimientoPendiente);
router.post("/:id_sesion/cierre", auth, requireRole("ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"), cerrarCaja);

export default router;
