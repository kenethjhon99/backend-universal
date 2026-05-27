/**
 * Definicion centralizada de los endpoints documentados en OpenAPI.
 * Se importan los schemas zod ya existentes para no duplicar.
 *
 * Este archivo se ejecuta una sola vez al arrancar (lo importa app.js).
 */
import { z } from "zod";
import { registerPath } from "./registry.js";
import {
  ventaCreateSchema,
  ventaReversionSchema,
  cajaAperturaSchema,
  cajaCierreSchema,
  cajaMovimientoSchema,
  validarPendienteSchema,
  productoCreateSchema,
  productoUpdateSchema,
  setEstadoSchema,
  ajusteStockSchema,
  tipoVehiculoSchema,
} from "../validation/common-schemas.js";

const okResponse = (description = "OK") => ({ description });
const errorResponses = {
  400: { description: "Validacion fallida" },
  401: { description: "No autenticado" },
  403: { description: "Sin permisos" },
  404: { description: "No encontrado" },
  500: { description: "Error interno" },
};

// ============================================================
// Auth
// ============================================================

const loginSchema = z.object({
  email: z.string().email().optional(),
  empresa_slug: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
  id_sucursal: z.number().int().positive().optional(),
});

const selectCompanySchema = z.object({
  challenge_token: z.string().min(1),
  id_empresa: z.number().int().positive(),
  id_sucursal: z.number().int().positive().optional(),
});

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  new_password: z.string().min(8),
});

registerPath({
  method: "get",
  path: "/auth/context",
  summary: "Contexto publico de acceso",
  description:
    "Devuelve branding y modo de acceso resuelto por dominio antes de autenticar.",
  tags: ["Auth"],
  security: [],
  responses: { 200: okResponse("Contexto publico"), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/login",
  summary: "Login",
  description:
    "Login por correo y password. Si el usuario pertenece a varias empresas devuelve un challenge de seleccion; mantiene compatibilidad temporal con empresa_slug + username.",
  tags: ["Auth"],
  security: [],
  body: loginSchema,
  responses: { 200: okResponse("Sesion iniciada"), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/select-company",
  summary: "Seleccionar empresa",
  description:
    "Canjea el challenge de usuario multiempresa por una sesion o por un challenge MFA.",
  tags: ["Auth"],
  security: [],
  body: selectCompanySchema,
  responses: { 200: okResponse("Empresa seleccionada"), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/password-reset/request",
  summary: "Solicitar recuperacion de password",
  description:
    "Solicita recuperacion sin revelar si el correo existe. El envio real depende del proveedor de correo configurado.",
  tags: ["Auth"],
  security: [],
  body: passwordResetRequestSchema,
  responses: { 200: okResponse("Solicitud recibida"), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/password-reset/confirm",
  summary: "Confirmar recuperacion de password",
  description:
    "Actualiza password con token valido, revoca sesiones activas e invalida access tokens anteriores.",
  tags: ["Auth"],
  security: [],
  body: passwordResetConfirmSchema,
  responses: { 200: okResponse("Password actualizado"), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/refresh",
  summary: "Refresh access token",
  description:
    "Lee la cookie httpOnly `saas_rt`, rota el refresh y emite un nuevo access token.",
  tags: ["Auth"],
  security: [{ cookieAuth: [] }],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/logout",
  summary: "Logout",
  description: "Revoca el refresh token actual y limpia la cookie.",
  tags: ["Auth"],
  security: [{ cookieAuth: [] }],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/auth/sessions",
  summary: "Sesiones activas",
  description: "Lista refresh tokens activos del usuario autenticado.",
  tags: ["Auth"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "delete",
  path: "/auth/sessions/{id}",
  summary: "Revocar una sesion",
  description: "Revoca una sesion activa del usuario autenticado.",
  tags: ["Auth"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/logout-all",
  summary: "Cerrar sesion en todos los dispositivos",
  description:
    "Revoca todos los refresh tokens del usuario e invalida access tokens ya emitidos.",
  tags: ["Auth"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/auth/me",
  summary: "Sesion actual",
  tags: ["Auth"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/auth/switch-sucursal",
  summary: "Cambiar sucursal activa",
  tags: ["Auth"],
  body: z.object({ id_sucursal: z.number().int().positive() }),
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Ventas
// ============================================================

registerPath({
  method: "get",
  path: "/ventas",
  summary: "Listar ventas",
  tags: ["Ventas"],
  query: z.object({
    estado: z.string().optional(),
    metodo_pago: z.string().optional(),
    tipo_venta: z.string().optional(),
    estado_reversion: z.string().optional(),
    desde: z.string().optional(),
    hasta: z.string().optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/ventas",
  summary: "Crear venta",
  description:
    "Crea una venta CONTADO o CREDITO. Si `no_cobrar=true` requiere `no_cobrado_motivo` y `admin_username`+`admin_password`.",
  tags: ["Ventas"],
  body: ventaCreateSchema,
  responses: { 201: okResponse("Venta creada"), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/ventas/:id",
  summary: "Detalle de venta",
  tags: ["Ventas"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/ventas/:id/reversiones",
  summary: "Crear reversion (devolucion o nota credito)",
  description:
    "Soporta reversion parcial enviando `items[]` con cantidades especificas. Multiples reversiones acumulan hasta TOTAL.",
  tags: ["Ventas"],
  body: ventaReversionSchema,
  responses: { 201: okResponse(), ...errorResponses },
});

// ============================================================
// Caja
// ============================================================

registerPath({
  method: "get",
  path: "/caja/sesion-activa",
  summary: "Caja activa del usuario en la sucursal",
  tags: ["Caja"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/caja/sesiones",
  summary: "Historial de sesiones de caja",
  tags: ["Caja"],
  query: z.object({
    estado: z.enum(["ABIERTA", "CERRADA"]).optional(),
    desde: z.string().optional(),
    hasta: z.string().optional(),
    search: z.string().optional(),
  }),
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/caja/apertura",
  summary: "Abrir caja",
  tags: ["Caja"],
  body: cajaAperturaSchema,
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/caja/:id/resumen",
  summary: "Resumen de sesion (con pendientes)",
  tags: ["Caja"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/caja/:id/movimientos",
  summary: "Registrar movimiento manual",
  description:
    "Si llega `admin_username`+`admin_password` queda pre-autorizado. Si no, queda pendiente y bloquea el cierre.",
  tags: ["Caja"],
  body: cajaMovimientoSchema,
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/caja/:id/cierre",
  summary: "Cerrar caja",
  description:
    "Rechaza si hay no-cobrados o movimientos manuales sin validar. Si hay diferencia, exige admin auth.",
  tags: ["Caja"],
  body: cajaCierreSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/caja/:id/pendientes/no-cobro/validar",
  summary: "Validar venta NO_COBRADO con admin auth",
  tags: ["Caja"],
  body: validarPendienteSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/caja/:id/pendientes/movimientos/:idMovimiento/validar",
  summary: "Validar movimiento manual con admin auth",
  tags: ["Caja"],
  body: validarPendienteSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Productos
// ============================================================

registerPath({
  method: "get",
  path: "/productos",
  summary: "Listar productos",
  tags: ["Productos"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/productos/codigo-barras/generar",
  summary: "Generar codigo de barras EAN-13 unico",
  tags: ["Productos"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/productos",
  summary: "Crear producto",
  tags: ["Productos"],
  body: productoCreateSchema,
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "put",
  path: "/productos/:id",
  summary: "Actualizar producto",
  tags: ["Productos"],
  body: productoUpdateSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "patch",
  path: "/productos/:id/estado",
  summary: "Activar / desactivar producto",
  tags: ["Productos"],
  body: setEstadoSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Stock
// ============================================================

registerPath({
  method: "get",
  path: "/stock",
  summary: "Stock por sucursal",
  tags: ["Stock"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/stock/movimientos",
  summary: "Historial de movimientos de inventario",
  tags: ["Stock"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/stock/movimientos",
  summary: "Movimiento manual (ENTRADA / SALIDA / AJUSTE)",
  tags: ["Stock"],
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "put",
  path: "/stock/:idProducto/ajuste",
  summary: "Ajuste directo de existencia",
  tags: ["Stock"],
  body: ajusteStockSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Reportes
// ============================================================

registerPath({
  method: "get",
  path: "/reportes/general",
  summary: "Reporte general (resumen + ventas/compras por dia + stock bajo)",
  tags: ["Reportes"],
  query: z.object({
    desde: z.string().optional(),
    hasta: z.string().optional(),
    vista: z.enum(["EMPRESA", "SUCURSAL"]).optional(),
    id_sucursal: z.coerce.number().int().positive().optional(),
    top: z.coerce.number().int().min(3).max(25).optional(),
  }),
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/reportes/corte",
  summary: "Corte de ventas (resumen + por usuario)",
  tags: ["Reportes"],
  query: z.object({
    desde: z.string(),
    hasta: z.string(),
    vista: z.enum(["EMPRESA", "SUCURSAL"]).optional(),
    id_sucursal: z.coerce.number().int().positive().optional(),
    id_usuario: z.coerce.number().int().positive().optional(),
  }),
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/reportes/corte-detallado-pro",
  summary: "Corte detallado: pies, top productos, ventas paginadas",
  tags: ["Reportes"],
  query: z.object({
    desde: z.string(),
    hasta: z.string(),
    vista: z.enum(["EMPRESA", "SUCURSAL"]).optional(),
    id_sucursal: z.coerce.number().int().positive().optional(),
    id_usuario: z.coerce.number().int().positive().optional(),
    top: z.coerce.number().int().min(3).max(50).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  }),
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Comprobantes (G1)
// ============================================================

registerPath({
  method: "get",
  path: "/comprobantes/tipos",
  summary: "Catalogo estatico de tipos de comprobante por modulo",
  tags: ["Comprobantes"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/comprobantes/series",
  summary: "Series de comprobante (filtros: modulo, sucursal, activo)",
  tags: ["Comprobantes"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/comprobantes/series",
  summary: "Crear nueva serie",
  tags: ["Comprobantes"],
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "put",
  path: "/comprobantes/series/:id",
  summary: "Actualizar serie (nombre, activo, correlativo)",
  tags: ["Comprobantes"],
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Servicios (G6)
// ============================================================

registerPath({
  method: "get",
  path: "/servicios/tipos-vehiculo",
  summary: "Tipos de vehiculo por empresa",
  tags: ["Servicios"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "post",
  path: "/servicios/tipos-vehiculo",
  summary: "Crear tipo de vehiculo",
  tags: ["Servicios"],
  body: tipoVehiculoSchema,
  responses: { 201: okResponse(), ...errorResponses },
});

registerPath({
  method: "put",
  path: "/servicios/tipos-vehiculo/:id",
  summary: "Actualizar tipo de vehiculo",
  tags: ["Servicios"],
  body: tipoVehiculoSchema.partial(),
  responses: { 200: okResponse(), ...errorResponses },
});

// ============================================================
// Clientes / Proveedores
// ============================================================

registerPath({
  method: "get",
  path: "/clientes",
  summary: "Listar clientes",
  tags: ["Clientes"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "patch",
  path: "/clientes/:id/estado",
  summary: "Activar / desactivar cliente",
  tags: ["Clientes"],
  body: setEstadoSchema,
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "get",
  path: "/proveedores",
  summary: "Listar proveedores",
  tags: ["Proveedores"],
  responses: { 200: okResponse(), ...errorResponses },
});

registerPath({
  method: "patch",
  path: "/proveedores/:id/estado",
  summary: "Activar / desactivar proveedor",
  tags: ["Proveedores"],
  body: setEstadoSchema,
  responses: { 200: okResponse(), ...errorResponses },
});
