import { Router } from "express";
import {
  authenticate,
  authenticatePermissive,
} from "../../middlewares/authenticate.js";
import { csrfGuard } from "../../middlewares/csrf.js";
import * as controller from "./auth.controller.js";

const router = Router();

// /bootstrap y /login: validan password, no usan cookie de refresh. No CSRF.
router.post("/bootstrap", controller.bootstrap);
router.get("/context", controller.context);
router.post("/login", controller.login);
router.post("/select-company", controller.selectCompany);
router.post("/password-reset/request", controller.requestPasswordReset);
router.post("/password-reset/confirm", controller.confirmPasswordReset);

// /mfa/verify-login: paso 2 del login en 2 pasos. Canjea challenge_token +
// codigo TOTP/backup por session completa. NO requiere auth previo (el
// challenge_token funciona como autorizacion temporal de 5min).
router.post("/mfa/verify-login", controller.verifyMfaLogin);

// /refresh y /logout: dependen del cookie httpOnly de refresh. CSRF defensa
// en capas (SameSite=Strict + Origin/Referer + double-submit XSRF token).
router.post("/refresh", csrfGuard, controller.refresh);
router.post("/logout", csrfGuard, controller.logout);

// /me: permissive. Necesario que el frontend pueda leer su sesion incluso
// si la empresa esta suspendida (asi puede mostrar la pantalla de upgrade).
router.get("/me", authenticatePermissive, controller.me);
router.get("/sessions", authenticate, controller.sessions);
router.delete("/sessions/:id", authenticate, csrfGuard, controller.revokeSession);
router.post("/logout-all", authenticate, csrfGuard, controller.logoutAll);

// /switch-sucursal: estandar. Empresa suspendida no puede cambiar sucursal.
router.post("/switch-sucursal", authenticate, controller.switchSucursal);

export default router;
