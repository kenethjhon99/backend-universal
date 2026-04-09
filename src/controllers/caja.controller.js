import * as Caja from "../models/caja.model.js";
import { authorizeAdminCredentials } from "../utils/adminAuthorization.js";

const isAdmin = (req) => {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  return roles.some((role) => {
    const normalizedRole = String(role).trim().toUpperCase();
    return normalizedRole === "ADMIN" || normalizedRole === "SUPER_ADMIN";
  });
};

const canAccessSession = (req, sesion) => {
  if (!sesion) return false;
  return isAdmin(req) || Number(sesion.id_usuario) === Number(req.user.id_usuario);
};

export const getSesionActiva = async (req, res) => {
  try {
    const sesion = await Caja.getCajaSesionActiva(req.user.id_usuario);
    if (!sesion) {
      return res.json({ ok: true, sesion: null });
    }

    const data = await Caja.getCajaResumen(sesion.id_caja_sesion);
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const abrirCaja = async (req, res) => {
  try {
    const sesion = await Caja.abrirCaja({
      id_usuario: req.user.id_usuario,
      id_sucursal: Number(req.body?.id_sucursal || 1),
      monto_apertura: req.body?.monto_apertura,
      observaciones_apertura: req.body?.observaciones_apertura,
    });

    const data = await Caja.getCajaResumen(sesion.id_caja_sesion);
    res.status(201).json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const registrarMovimiento = async (req, res) => {
  try {
    const { id_sesion } = req.params;
    if (!/^\d+$/.test(id_sesion)) {
      return res.status(400).json({ error: "ID de sesion invalido" });
    }

    const sesion = await Caja.getCajaSesionById(Number(id_sesion));
    if (!canAccessSession(req, sesion)) {
      return res.status(403).json({ error: "No autorizado para operar esta caja" });
    }

    const movimiento = await Caja.registrarMovimientoCaja({
      id_caja_sesion: Number(id_sesion),
      id_usuario: req.user.id_usuario,
      tipo: req.body?.tipo,
      categoria: req.body?.categoria,
      monto: req.body?.monto,
      descripcion: req.body?.descripcion,
      autorizado_por_admin_id: null,
      autorizacion_admin_nota: null,
    });

    const data = await Caja.getCajaResumen(Number(id_sesion));
    res.status(201).json({ ok: true, movimiento, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const cerrarCaja = async (req, res) => {
  try {
    const { id_sesion } = req.params;
    if (!/^\d+$/.test(id_sesion)) {
      return res.status(400).json({ error: "ID de sesion invalido" });
    }

    const sesion = await Caja.getCajaSesionById(Number(id_sesion));
    if (!canAccessSession(req, sesion)) {
      return res.status(403).json({ error: "No autorizado para cerrar esta caja" });
    }

    const resumenActual = await Caja.getCajaResumen(Number(id_sesion));
    let adminAuthorization = null;
    const montoReportado = Number(req.body?.monto_cierre_reportado);
    const diferenciaCierre = Number.isFinite(montoReportado)
      ? Number((montoReportado - Number(resumenActual?.resumen?.cierre_calculado || 0)).toFixed(2))
      : 0;
    const requiereValidacionNoCobro =
      Number(resumenActual?.resumen?.no_cobrados_pendientes_count || 0) > 0;
    const requiereValidacionMovimientos =
      Number(resumenActual?.resumen?.movimientos_pendientes_validacion_count || 0) > 0;
    const requiereValidacionDiferencia = Number(diferenciaCierre) !== 0;

    if (requiereValidacionNoCobro || requiereValidacionMovimientos) {
      return res.status(400).json({
        error:
          "Debes validar individualmente los registros no cobrados y movimientos pendientes antes de cerrar la caja",
      });
    }

    if (requiereValidacionDiferencia) {
      adminAuthorization = await authorizeAdminCredentials({
        username: req.body?.admin_username,
        password: req.body?.admin_password,
        actorId: req.user?.id_usuario ?? null,
      });
    }

    await Caja.cerrarCaja({
      id_caja_sesion: Number(id_sesion),
      id_usuario: req.user.id_usuario,
      monto_cierre_reportado: req.body?.monto_cierre_reportado,
      observaciones_cierre: req.body?.observaciones_cierre,
      validacion_no_cobro_admin_id: null,
      validacion_no_cobro_nota: null,
      validacion_movimientos_admin_id: null,
      validacion_movimientos_nota: null,
      validacion_diferencia_admin_id:
        requiereValidacionDiferencia ? adminAuthorization?.id_usuario ?? null : null,
      validacion_diferencia_nota:
        requiereValidacionDiferencia
          ? String(req.body?.validacion_diferencia_nota || "").trim() || null
          : null,
    });

    const data = await Caja.getCajaResumen(Number(id_sesion));
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const validarNoCobroPendiente = async (req, res) => {
  try {
    const { id_sesion } = req.params;
    if (!/^\d+$/.test(id_sesion)) {
      return res.status(400).json({ error: "ID de sesion invalido" });
    }

    const sesion = await Caja.getCajaSesionById(Number(id_sesion));
    if (!canAccessSession(req, sesion)) {
      return res.status(403).json({ error: "No autorizado para operar esta caja" });
    }

    const adminAuthorization = await authorizeAdminCredentials({
      username: req.body?.admin_username,
      password: req.body?.admin_password,
      actorId: req.user?.id_usuario ?? null,
    });

    await Caja.validarNoCobroPendienteCaja({
      id_caja_sesion: Number(id_sesion),
      modulo: req.body?.modulo,
      referencia: req.body?.referencia,
      admin_id: adminAuthorization.id_usuario,
      nota: String(req.body?.nota || "").trim() || null,
    });

    const data = await Caja.getCajaResumen(Number(id_sesion));
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const validarMovimientoPendiente = async (req, res) => {
  try {
    const { id_sesion, id_movimiento } = req.params;
    if (!/^\d+$/.test(id_sesion) || !/^\d+$/.test(id_movimiento)) {
      return res.status(400).json({ error: "ID invalido" });
    }

    const sesion = await Caja.getCajaSesionById(Number(id_sesion));
    if (!canAccessSession(req, sesion)) {
      return res.status(403).json({ error: "No autorizado para operar esta caja" });
    }

    const adminAuthorization = await authorizeAdminCredentials({
      username: req.body?.admin_username,
      password: req.body?.admin_password,
      actorId: req.user?.id_usuario ?? null,
    });

    await Caja.validarMovimientoPendienteCaja({
      id_caja_sesion: Number(id_sesion),
      id_caja_movimiento: Number(id_movimiento),
      admin_id: adminAuthorization.id_usuario,
      nota: String(req.body?.nota || "").trim() || null,
    });

    const data = await Caja.getCajaResumen(Number(id_sesion));
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const getResumenCaja = async (req, res) => {
  try {
    const { id_sesion } = req.params;
    if (!/^\d+$/.test(id_sesion)) {
      return res.status(400).json({ error: "ID de sesion invalido" });
    }

    const data = await Caja.getCajaResumen(Number(id_sesion));
    if (!canAccessSession(req, data.sesion)) {
      return res.status(403).json({ error: "No autorizado para ver esta caja" });
    }

    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const listarSesiones = async (req, res) => {
  try {
    const data = await Caja.listarSesionesCaja({
      id_usuario: isAdmin(req) ? req.query.id_usuario ?? null : req.user.id_usuario,
      estado: req.query.estado,
      q: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });

    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
