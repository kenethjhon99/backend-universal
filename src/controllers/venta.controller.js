import * as Venta from "../models/venta.model.js";
import { getCajaSesionActiva } from "../models/caja.model.js";
import { addLocalDates } from "../utils/datetime.js";

export const anularDetalleVenta = async (req, res) => {
  try {
    const { id_venta, id_detalle } = req.params;
    const { cantidad, motivo } = req.body;

    if (!/^\d+$/.test(id_venta) || !/^\d+$/.test(id_detalle)) {
      return res.status(400).json({ error: "IDs inválidos" });
    }

    const result = await Venta.anularDetalle({
      id_venta: Number(id_venta),
      id_detalle: Number(id_detalle),
      cantidad: Number(cantidad),
      motivo,
      id_usuario: req.user.id_usuario,
      id_bodega: 1
    });

    res.json(result);
    addLocalDates(result, ["fecha", "anulada_en"]);

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const anularVentaCompleta = async (req, res) => {
  try {
    const { id_venta } = req.params;
    const motivo = String(req.body?.motivo || "").trim();

    if (!/^\d+$/.test(id_venta)) {
      return res.status(400).json({ error: "ID invalido" });
    }

    if (!motivo) {
      return res.status(400).json({ error: "motivo es requerido" });
    }

    const venta = await Venta.anularVentaCompleta({
      id_venta: Number(id_venta),
      motivo,
      id_usuario: req.user.id_usuario,
      id_bodega: 1,
    });

    res.json({ ok: true, venta });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const crearVenta = async (req, res) => {
  try {
    const {
      items,
      tipo_venta,
      metodo_pago,
      id_sucursal,
      id_cliente,
      tipo_comprobante,
      monto_recibido,
      no_cobrar,
      no_cobrado_motivo,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items es requerido" });
    }

    const sesionCaja = await getCajaSesionActiva(req.user.id_usuario);
    if (!sesionCaja) {
      return res.status(400).json({
        error: "Debes abrir una caja antes de registrar ventas",
      });
    }

    if (Boolean(no_cobrar)) {
      const motivoNoCobro = String(no_cobrado_motivo || "").trim();
      if (!motivoNoCobro) {
        return res.status(400).json({ error: "Debes indicar el motivo del no cobro" });
      }
    }

    const venta = await Venta.crearVenta({
      id_usuario: req.user.id_usuario,
      id_sucursal: Number(id_sucursal || 1),
      id_caja_sesion: Number(sesionCaja.id_caja_sesion),
      id_cliente: id_cliente ? Number(id_cliente) : null,
      tipo_venta,
      metodo_pago,
      tipo_comprobante,
      monto_recibido,
      no_cobrar: Boolean(no_cobrar),
      no_cobrado_motivo: String(no_cobrado_motivo || "").trim() || null,
      no_cobrado_autorizado_por: null,
      items,
      id_bodega: 1
    });

    res.status(201).json({ ok: true, venta });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const getVenta = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });

    const venta = await Venta.getVentaById(Number(id));
    if (!venta) return res.status(404).json({ error: "Venta no encontrada" });

    const detalles = await Venta.getDetallesByVenta(Number(id));

    res.json({ ok: true, venta, detalles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const listarVentas = async (req, res) => {
  try {
    const result = await Venta.listarVentas({
      desde: req.query.desde,        // "2026-02-23" o "2026-02-23T00:00:00-06:00"
      hasta: req.query.hasta,        // "2026-02-23"
      estado: req.query.estado,      // COMPLETADA / ANULADA
      id_usuario: req.query.id_usuario,
      tipo_venta: req.query.tipo_venta,   // CONTADO / CREDITO etc
      metodo_pago: req.query.metodo_pago, // EFECTIVO / TARJETA etc
      id_sucursal: req.query.id_sucursal,
      q: req.query.q,                // búsqueda rápida
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const listarComprobantesVenta = async (_req, res) => {
  try {
    const data = await Venta.listarComprobantesVenta();
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const getVentaCompleta = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });

    const data = await Venta.getVentaCompleta(Number(id));
    if (!data) return res.status(404).json({ error: "Venta no encontrada" });

    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
