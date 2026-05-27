import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes.js";
import archivosRoutes from "../modules/archivos/archivos.routes.js";
import auditoriaRoutes from "../modules/auditoria/auditoria.routes.js";
import billingRoutes from "../modules/billing/billing.routes.js";
import bodegasRoutes from "../modules/bodegas/bodegas.routes.js";
import cajaRoutes from "../modules/caja/caja.routes.js";
import clientesRoutes from "../modules/clientes/clientes.routes.js";
import comisionesRoutes from "../modules/comisiones/comisiones.routes.js";
import conciliacionRoutes from "../modules/conciliacion/conciliacion.routes.js";
import comprobantesRoutes from "../modules/comprobantes/comprobantes.routes.js";
import comprasRoutes from "../modules/compras/compras.routes.js";
import dashboardsRoutes from "../modules/dashboards/dashboards.routes.js";
import empresasRoutes from "../modules/empresas/empresas.routes.js";
import feRoutes from "../modules/facturacion-electronica/fe.routes.js";
import fidelidadRoutes from "../modules/fidelidad/fidelidad.routes.js";
import finanzasRoutes from "../modules/finanzas/finanzas.routes.js";
import importadorRoutes from "../modules/importador/importador.routes.js";
import marketplaceRoutes from "../modules/marketplace/marketplace.routes.js";
import membresiasRoutes from "../modules/membresias/membresias.routes.js";
import mfaRoutes from "../modules/mfa/mfa.routes.js";
import monedasRoutes from "../modules/monedas/monedas.routes.js";
import notificacionesRoutes from "../modules/notificaciones/notificaciones.routes.js";
import platformRoutes from "../modules/platform/platform.routes.js";
import onboardingRoutes from "../modules/onboarding/onboarding.routes.js";
import prediccionRoutes from "../modules/prediccion/prediccion.routes.js";
import productosRoutes from "../modules/productos/productos.routes.js";
import promocionesRoutes from "../modules/promociones/promociones.routes.js";
import proveedoresRoutes from "../modules/proveedores/proveedores.routes.js";
import publicoRoutes from "../modules/publico/publico.routes.js";
import reportesRoutes from "../modules/reportes/reportes.routes.js";
import rolesRoutes from "../modules/roles/roles.routes.js";
import serviciosRoutes from "../modules/servicios/servicios.routes.js";
import stockRoutes from "../modules/stock/stock.routes.js";
import sucursalesRoutes from "../modules/sucursales/sucursales.routes.js";
import tenantDominiosRoutes from "../modules/tenant-dominios/tenant-dominios.routes.js";
import ticketsRoutes from "../modules/tickets/tickets.routes.js";
import usuariosRoutes from "../modules/usuarios/usuarios.routes.js";
import ventasRoutes from "../modules/ventas/ventas.routes.js";
import webhooksRoutes from "../modules/webhooks/webhooks.routes.js";

const router = Router();

// El chequeo de empresa activa/suspendida se hace DENTRO de authenticate.js
// (excepto para rutas que usan authenticatePermissive, como /billing).
// Aqui solo organizamos el mount por path. Las rutas exentas (que no usan
// authenticate o usan permissive) son: /auth, /billing, /publico, /webhooks.

router.use("/auth", authRoutes);
router.use("/billing", billingRoutes);
router.use("/publico", publicoRoutes);
router.use("/webhooks", webhooksRoutes);

router.use("/archivos", archivosRoutes);
router.use("/auditoria", auditoriaRoutes);
router.use("/empresas", empresasRoutes);
router.use("/sucursales", sucursalesRoutes);
router.use("/usuarios", usuariosRoutes);
router.use("/finanzas", finanzasRoutes);
router.use("/clientes", clientesRoutes);
router.use("/proveedores", proveedoresRoutes);
router.use("/productos", productosRoutes);
router.use("/stock", stockRoutes);
router.use("/ventas", ventasRoutes);
router.use("/compras", comprasRoutes);
router.use("/caja", cajaRoutes);
router.use("/comprobantes", comprobantesRoutes);
router.use("/comisiones", comisionesRoutes);
router.use("/membresias", membresiasRoutes);
router.use("/mfa", mfaRoutes);
router.use("/importador", importadorRoutes);
router.use("/servicios", serviciosRoutes);
router.use("/reportes", reportesRoutes);
router.use("/monedas", monedasRoutes);
router.use("/notificaciones", notificacionesRoutes);
router.use("/platform", platformRoutes);
router.use("/onboarding", onboardingRoutes);
router.use("/fe", feRoutes);
router.use("/promociones", promocionesRoutes);
router.use("/fidelidad", fidelidadRoutes);
router.use("/conciliacion", conciliacionRoutes);
router.use("/prediccion", prediccionRoutes);
router.use("/tickets", ticketsRoutes);
router.use("/marketplace", marketplaceRoutes);
router.use("/dashboards", dashboardsRoutes);
router.use("/tenant-dominios", tenantDominiosRoutes);
router.use("/bodegas", bodegasRoutes);
router.use("/roles", rolesRoutes);

export default router;
