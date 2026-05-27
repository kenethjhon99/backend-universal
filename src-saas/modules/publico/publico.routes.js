import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as controller from "./publico.controller.js";

const router = Router();

// Rate limit estricto: este endpoint es publico y sin auth, asi que lo
// limitamos a 30 req/min por IP por codigo para evitar enumeracion.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones" },
});

// NO authenticate, NO authorize: es publico por design (URL es la auth).
router.get("/ordenes/:codigo", publicLimiter, controller.getOrdenPublica);

export default router;
