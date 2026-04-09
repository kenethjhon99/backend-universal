import * as R from "../models/reporte.model.js";

const toChart = (rows = [], labelKey, valueKey) =>
  rows.map((row) => ({
    label: row[labelKey],
    value: Number(row[valueKey] || 0),
  }));

const getDefaultRange = () => {
  const localNow = new Date();
  const end = localNow.toISOString().slice(0, 10);
  const startDate = new Date(localNow);
  startDate.setDate(startDate.getDate() - 6);
  const start = startDate.toISOString().slice(0, 10);
  return { desde: start, hasta: end };
};

export const auditoriaCatalogo = async (req, res) => {
  try {
    const data = await R.auditoriaCatalogo({
      entidad: req.query.entidad,
      estado: req.query.estado,
      q: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const reporteGeneral = async (req, res) => {
  try {
    const defaultRange = getDefaultRange();
    const desde = req.query.desde || defaultRange.desde;
    const hasta = req.query.hasta || defaultRange.hasta;

    const data = await R.reporteGeneral({
      desde,
      hasta,
      id_sucursal: req.query.id_sucursal ?? 1,
    });

    res.json({
      ok: true,
      ...data,
      chart_data: {
        ventas_por_dia: toChart(data.ventas_por_dia, "fecha", "total_ventas"),
        compras_por_fecha: toChart(data.compras_por_fecha, "fecha", "total_compras"),
        utilidad_por_dia: toChart(data.utilidad_por_dia, "fecha", "utilidad_estimada"),
        ventas_de_producto: toChart(data.ventas_de_producto, "producto_nombre", "total_ventas"),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const corteVentas = async (req, res) => {
  try {
    const { desde, hasta, id_sucursal, id_usuario } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({ error: "desde y hasta son obligatorios (YYYY-MM-DD)" });
    }

    const data = await R.corteVentas({
      desde,
      hasta,
      id_sucursal: id_sucursal ?? 1,
      id_usuario: id_usuario ?? null
    });

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const corteVentasDetallado = async (req, res) => {
  try {
    const { desde, hasta, id_sucursal, id_usuario, page, limit, top } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({ error: "desde y hasta son obligatorios (YYYY-MM-DD)" });
    }

    const data = await R.corteVentasDetallado({
      desde,
      hasta,
      id_sucursal: id_sucursal ?? 1,
      id_usuario: id_usuario ?? null,
      page,
      limit,
      top,
    });

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const corteVentasDetalladoPro = async (req, res) => {
  try {
    const { desde, hasta, id_sucursal, id_usuario, page, limit, top } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({ error: "desde y hasta son obligatorios (YYYY-MM-DD)" });
    }

    const data = await R.corteVentasDetalladoPro({
      desde,
      hasta,
      id_sucursal: id_sucursal ?? 1,
      id_usuario: id_usuario ?? null,
      page,
      limit,
      top,
    });

    const chart_data = {
      metodo_pago: toChart(data.por_metodo_pago, "metodo_pago", "total_neto"),
      tipo_venta: toChart(data.por_tipo_venta, "tipo_venta", "total_neto"),
      top_total: toChart(data.top_productos_por_total, "producto_nombre", "total_neto"),
      top_cantidad: toChart(data.top_productos_por_cantidad, "producto_nombre", "cantidad_vendida_neta"),
    };
    
    res.json({ ok: true, ...data, chart_data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

