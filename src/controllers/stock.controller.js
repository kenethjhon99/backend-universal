import * as Stock from "../models/stock.model.js";

export const listarStock = async (req, res) => {
  try {
    const { q, solo_bajo_minimo } = req.query;
    const stock = await Stock.getStock({
      id_bodega: 1,
      q: q ? String(q).trim() : "",
      solo_bajo_minimo:
        solo_bajo_minimo === "true" ||
        solo_bajo_minimo === "1" ||
        solo_bajo_minimo === true,
    });
    res.json(stock);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const ajustarStock = async (req, res) => {
  try {
    const { id_producto } = req.params;
    const { existencia } = req.body;

    // Validar id_producto
    if (!/^\d+$/.test(id_producto)) {
      return res.status(400).json({ error: "id_producto inválido" });
    }

    // Validar existencia
    const ex = Number(existencia);
    if (!Number.isInteger(ex) || ex < 0) {
      return res.status(400).json({ error: "existencia debe ser entero >= 0" });
    }

    // Verificar que exista el stock (para bodega 1)
    const actual = await Stock.getStockByProducto(id_producto, 1);
    if (!actual) {
      return res.status(404).json({ error: "No existe registro de stock para este producto en bodega 1" });
    }

    // Actualizar
    const actualizado = await Stock.setExistencia(id_producto, ex, 1);

    res.json({
      ok: true,
      mensaje: "Stock actualizado",
      antes: actual.existencia,
      despues: actualizado.existencia,
      data: actualizado
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const crearMovimiento = async (req, res) => {
  try {
    const { id_producto, tipo, motivo, cantidad, nueva_existencia } = req.body;

    if (!Number.isInteger(Number(id_producto))) {
      return res.status(400).json({ error: "id_producto inválido" });
    }

    const payload = {
      id_producto: Number(id_producto),
      id_bodega: 1,
      tipo,
      motivo: motivo ?? null,
      cantidad: cantidad !== undefined ? Number(cantidad) : undefined,
      nueva_existencia: nueva_existencia !== undefined ? Number(nueva_existencia) : null,
      id_usuario: req.user.id_usuario, // cuando tengas login, aquí va el usuario del token
    };

    const result = await Stock.crearMovimientoStock(payload);
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const listarMovimientos = async (req, res) => {
  try {
    const { id_producto, limit, tipo, desde, hasta, q } = req.query;

    const data = await Stock.getMovimientosStock({
      id_producto: id_producto ? Number(id_producto) : null,
      id_bodega: 1,
      tipo: tipo ? String(tipo).trim().toUpperCase() : null,
      desde: desde ? String(desde).trim() : null,
      hasta: hasta ? String(hasta).trim() : null,
      q: q ? String(q).trim() : "",
      limit: limit ? Number(limit) : 50,
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
