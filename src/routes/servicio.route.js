import { Router } from "express";
import { auth } from "../middlewares/auth.js";
import { requireRole } from "../middlewares/requireRole.js";
import {
  actualizarTipoVehiculoReparacion,
  actualizarTipoVehiculoAutolavado,
  actualizarServicioReparacion,
  actualizarServicioAutolavado,
  asignarTecnicoOrdenAutolavado,
  asignarTecnicoOrdenReparacion,
  actualizarEstadoOrdenReparacion,
  actualizarEstadoOrdenAutolavado,
  agregarProductoOrdenReparacion,
  cobrarOrdenReparacion,
  cobrarServicioReparacion,
  cobrarServicioAutolavado,
  crearOrdenReparacion,
  crearServicioReparacion,
  crearServicioAutolavado,
  crearTipoVehiculoReparacion,
  crearTipoVehiculoAutolavado,
  listarCatalogoReparacion,
  listarCatalogoAutolavado,
  listarOrdenesReparacion,
  listarOrdenesAutolavado,
  listarTecnicosAsignables,
} from "../controllers/servicio.controller.js";

const router = Router();

router.get(
  "/tecnicos",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarTecnicosAsignables
);

router.get(
  "/autolavado/catalogo",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarCatalogoAutolavado
);
router.post(
  "/autolavado/vehiculos",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  crearTipoVehiculoAutolavado
);
router.put(
  "/autolavado/vehiculos/:id",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  actualizarTipoVehiculoAutolavado
);
router.post(
  "/autolavado/catalogo",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  crearServicioAutolavado
);
router.put(
  "/autolavado/catalogo/:id",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  actualizarServicioAutolavado
);
router.post(
  "/autolavado/cobros",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  cobrarServicioAutolavado
);
router.get(
  "/autolavado/ordenes",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarOrdenesAutolavado
);
router.patch(
  "/autolavado/ordenes/:id/estado",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  actualizarEstadoOrdenAutolavado
);
router.patch(
  "/autolavado/ordenes/:id/tecnico",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  asignarTecnicoOrdenAutolavado
);
router.get(
  "/reparacion/catalogo",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarCatalogoReparacion
);
router.post(
  "/reparacion/vehiculos",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  crearTipoVehiculoReparacion
);
router.put(
  "/reparacion/vehiculos/:id",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  actualizarTipoVehiculoReparacion
);
router.post(
  "/reparacion/catalogo",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  crearServicioReparacion
);
router.put(
  "/reparacion/catalogo/:id",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "ENCARGADO_SERVICIOS"),
  actualizarServicioReparacion
);
router.post(
  "/reparacion/cobros",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  cobrarServicioReparacion
);
router.post(
  "/reparacion/ordenes",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  crearOrdenReparacion
);
router.get(
  "/reparacion/ordenes",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS", "LECTURA"),
  listarOrdenesReparacion
);
router.post(
  "/reparacion/ordenes/:id/cobro",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  cobrarOrdenReparacion
);
router.post(
  "/reparacion/ordenes/:id/productos",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  agregarProductoOrdenReparacion
);
router.patch(
  "/reparacion/ordenes/:id/estado",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  actualizarEstadoOrdenReparacion
);
router.patch(
  "/reparacion/ordenes/:id/tecnico",
  auth,
  requireRole("SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"),
  asignarTecnicoOrdenReparacion
);

export default router;
