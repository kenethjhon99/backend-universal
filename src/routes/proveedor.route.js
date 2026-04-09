import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  listarProveedores,
  crearProveedor,
  actualizarProveedor,
  eliminarProveedor,
} from "../controllers/proveedor.controller.js";

const router = Router();

router.get("/", auth, requireRole("ADMIN", "LECTURA"), listarProveedores);
router.post("/", auth, requireRole("ADMIN"), crearProveedor);
router.put("/:id", auth, requireRole("ADMIN"), actualizarProveedor);
router.patch("/:id/desactivar", auth, requireRole("ADMIN"), eliminarProveedor);

export default router;
