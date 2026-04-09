import { Router } from "express";
import {
  listarProductos,
  crearProducto,
  actualizarProducto,
  eliminarProducto,
  generarCodigoBarrasProducto,
} from "../controllers/producto.controller.js";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.get("/", auth, listarProductos);
router.get(
  "/codigo-barras/generar",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  generarCodigoBarrasProducto
);
router.post("/", auth, requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"), crearProducto);
router.put("/:id", auth, requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"), actualizarProducto);
router.patch("/:id/desactivar", auth, requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"), eliminarProducto);
router.delete("/:id", auth, requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"), eliminarProducto);
export default router;
