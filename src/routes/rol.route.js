import { Router } from "express";
import { listarRoles } from "../controllers/rol.controller.js";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();
router.get("/", auth, requireRole("SUPER_ADMIN", "LECTURA"), listarRoles);

export default router;
