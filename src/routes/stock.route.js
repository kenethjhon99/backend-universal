import { Router } from "express";
import { listarStock, ajustarStock, crearMovimiento, listarMovimientos } from "../controllers/stock.controller.js";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";

const router = Router();

router.get("/", auth, requireRole("SUPER_ADMIN", "ADMIN", "LECTURA"), listarStock);
router.put("/:id_producto", auth, requireRole("SUPER_ADMIN", "ADMIN"), ajustarStock);
router.post("/movimientos", auth, requireRole("SUPER_ADMIN", "ADMIN"), crearMovimiento);
router.get("/movimientos", auth, requireRole("SUPER_ADMIN", "ADMIN", "LECTURA"), listarMovimientos);
export default router;
