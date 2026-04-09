import { Router } from "express";
import {
  crearUsuario,
  listarUsuarios,
  editarUsuario,
  desactivarUsuario,
  activarUsuario,
  asignarRol,
  quitarRol,
} from "../controllers/usuario.controller.js";

import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.get("/", auth, requireRole("SUPER_ADMIN", "LECTURA"), listarUsuarios);
router.post("/", auth, requireRole("SUPER_ADMIN"), crearUsuario);
router.post("/:id", auth, requireRole("SUPER_ADMIN"), editarUsuario);

// soft delete
router.post("/:id/desactivar", auth, requireRole("SUPER_ADMIN"), desactivarUsuario);
router.post("/:id/activar", auth, requireRole("SUPER_ADMIN"), activarUsuario);

// roles
router.post("/:id/roles", auth, requireRole("SUPER_ADMIN"), asignarRol);
router.patch("/:id/roles/:id_rol/desactivar", auth, requireRole("SUPER_ADMIN"), quitarRol);
router.delete("/:id/roles/:id_rol", auth, requireRole("SUPER_ADMIN"), quitarRol);



export default router;
