import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  crearVenta,
  anularDetalleVenta,
  anularVentaCompleta,
  getVenta,
  listarComprobantesVenta,
  listarVentas,
  getVentaCompleta,
} from "../controllers/venta.controller.js";

const router = Router();

router.post("/", auth, requireRole("ADMIN", "CAJERO", "ENCARGADO_SERVICIOS"), crearVenta);

router.get(
  "/comprobantes/catalogo",
  auth,
  requireRole("ADMIN", "CAJERO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarComprobantesVenta
);

router.post(
  "/:id_venta/detalles/:id_detalle/anular",
  auth,
  requireRole("ADMIN"),
  anularDetalleVenta
);

router.post(
  "/:id_venta/anular",
  auth,
  requireRole("ADMIN"),
  anularVentaCompleta
);

router.get("/:id", auth, requireRole("ADMIN", "CAJERO", "ENCARGADO_SERVICIOS", "LECTURA"), getVenta);

router.get("/", auth, requireRole("ADMIN", "CAJERO", "ENCARGADO_SERVICIOS", "LECTURA"), listarVentas);

router.get("/:id/completa", auth, requireRole("ADMIN", "CAJERO", "ENCARGADO_SERVICIOS", "LECTURA"), getVentaCompleta);

export default router;
