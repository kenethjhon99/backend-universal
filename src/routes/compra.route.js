import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  crearCompra,
  listarCompras,
  getCompra,
  anularCompra,
  anularDetalleCompra,
} from "../controllers/compra.controller.js";

const router = Router();

// Crear compra (ADMIN o BODEGA si luego creas ese rol)
router.post("/", auth, requireRole("ADMIN"), crearCompra);

// Listar compras pro
router.get("/", auth, requireRole("ADMIN", "LECTURA"), listarCompras);

// Ver compra completa
router.get("/:id", auth, requireRole("ADMIN", "LECTURA"), getCompra);

// Anular compra completa
router.patch("/:id/anular", auth, requireRole("ADMIN"), anularCompra);

// Anulación parcial por detalle
router.patch("/:id_compra/detalles/:id_detalle/anular", auth, requireRole("ADMIN"), anularDetalleCompra);

export default router;
