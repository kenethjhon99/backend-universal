import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  actualizarCliente,
  crearCliente,
  eliminarCliente,
  listarClientes,
} from "../controllers/cliente.controller.js";

const router = Router();

router.get("/", auth, requireRole("ADMIN", "CAJERO", "LECTURA"), listarClientes);
router.post("/", auth, requireRole("ADMIN", "CAJERO"), crearCliente);
router.put("/:id", auth, requireRole("ADMIN"), actualizarCliente);
router.patch("/:id/desactivar", auth, requireRole("ADMIN"), eliminarCliente);

export default router;
