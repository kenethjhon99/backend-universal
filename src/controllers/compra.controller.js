import * as Compra from "../models/compra.model.js";

export const crearCompra = async (req, res) => {
  try {
    const {
      tipo_documento,
      no_documento,
      id_proveedor,
      id_sucursal,
      id_bodega,
      fecha_compra,
      observaciones,
      items
    } = req.body;

    if (!id_proveedor) return res.status(400).json({ error: "id_proveedor es requerido" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items es requerido" });

    const compra = await Compra.crearCompra({
      tipo_documento,
      no_documento,
      fecha_compra,
      observaciones,
      id_usuario: req.user.id_usuario,
      id_proveedor: Number(id_proveedor),
      id_sucursal: Number(id_sucursal || 1),
      id_bodega: Number(id_bodega || 1),
      items
    });

    res.status(201).json({ ok: true, compra });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

export const listarCompras = async (req, res) => {
  try {
    const result = await Compra.listarCompras({
      desde: req.query.desde,
      hasta: req.query.hasta,
      estado: req.query.estado,
      no_documento: req.query.no_documento,
      proveedor: req.query.proveedor,
      id_usuario: req.query.id_usuario,
      id_proveedor: req.query.id_proveedor,
      id_sucursal: req.query.id_sucursal,
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getCompra = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });

    const data = await Compra.getCompraCompleta(Number(id));
    if (!data) return res.status(404).json({ error: "Compra no encontrada" });

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const anularCompra = async (req, res) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;

    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id inválido" });

    const result = await Compra.anularCompra({
      id_compra: Number(id),
      motivo,
      id_usuario: req.user.id_usuario,
      id_bodega: 1,
    });

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

export const anularDetalleCompra = async (req, res) => {
  try {
    const { id_compra, id_detalle } = req.params;
    const { cantidad, motivo } = req.body;

    if (!/^\d+$/.test(id_compra) || !/^\d+$/.test(id_detalle)) {
      return res.status(400).json({ error: "IDs inválidos" });
    }

    const result = await Compra.anularDetalleCompra({
      id_compra: Number(id_compra),
      id_detalle: Number(id_detalle),
      cantidad: Number(cantidad),
      motivo,
      id_usuario: req.user.id_usuario,
      id_bodega: 1,
    });

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
