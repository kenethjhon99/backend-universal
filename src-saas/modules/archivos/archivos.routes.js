/**
 * Endpoints de archivos. Soporta dos modos de subida:
 *  - POST /     (multipart, file pasa por el API) — para uploads chicos.
 *  - POST /presigned-put (devuelve URL para que el cliente suba a S3 directo)
 *      + POST /:id/confirmar
 */
import { Router } from "express";
import multer from "multer";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { withTenantDb } from "../../middlewares/with-tenant-db.js";
import * as controller from "./archivos.controller.js";

const router = Router();

// Memory storage: archivos chicos (<10MB). Para archivos grandes el cliente
// debe usar el flow de presigned-put (sube directo a S3).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

router.use(authenticate);
router.use(withTenantDb);

const adminRoles = [
  "SUPER_ADMIN",
  "ADMIN_EMPRESA",
  "ENCARGADO_SUCURSAL",
];

router.get(
  "/",
  authorize({ roles: [...adminRoles, "CAJERO"], allowAnyAssignedSucursal: true }),
  controller.listArchivos
);

router.post(
  "/",
  authorize({ roles: adminRoles, allowAnyAssignedSucursal: true }),
  upload.single("file"),
  controller.uploadDirect
);

router.post(
  "/presigned-put",
  authorize({ roles: adminRoles, allowAnyAssignedSucursal: true }),
  controller.preparePresignedPut
);

router.post(
  "/:id/confirmar",
  authorize({ roles: adminRoles, allowAnyAssignedSucursal: true }),
  controller.confirmUpload
);

router.get(
  "/:id/download-url",
  authorize({ roles: [...adminRoles, "CAJERO"], allowAnyAssignedSucursal: true }),
  controller.getDownloadUrl
);

router.delete(
  "/:id",
  authorize({ roles: adminRoles, allowAnyAssignedSucursal: true }),
  controller.deleteArchivo
);

export default router;
