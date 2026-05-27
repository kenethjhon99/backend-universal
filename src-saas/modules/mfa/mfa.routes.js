/**
 * Endpoints de gestion MFA del usuario actual.
 *
 * IMPORTANTE: usamos authenticatePermissive en GET /status para que un usuario
 * con MFA habilitado en empresa SUSPENDIDA pueda consultar su propio estado
 * (igual que /auth/me). Pero enroll/disable/regenerate van con authenticate
 * estandar (empresa debe estar activa).
 */
import { Router } from "express";
import {
  authenticate,
  authenticatePermissive,
} from "../../middlewares/authenticate.js";
import * as controller from "./mfa.controller.js";

const router = Router();

router.get("/status", authenticatePermissive, controller.getStatus);

router.post("/enroll", authenticate, controller.enroll);
router.post("/verify-enroll", authenticate, controller.verifyEnrollment);
router.post("/disable", authenticate, controller.disable);
router.post(
  "/regenerate-backup-codes",
  authenticate,
  controller.regenerateBackupCodes
);

export default router;
