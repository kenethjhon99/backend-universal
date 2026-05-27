import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middlewares/authenticate.js";
import * as controller from "./onboarding.controller.js";

const router = Router();

// Endpoints publicos (sin auth) con rate limit estricto
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones de registro. Intenta luego." },
});

router.get("/planes", controller.getPlanesPublicos);

router.post("/registro", publicLimiter, controller.selfRegister);

// Privado: estado de la suscripcion
router.get("/mi-suscripcion", authenticate, controller.getMiSuscripcion);

export default router;
