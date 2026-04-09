import { addLocalDates } from "../utils/datetime.js";

export const formatDates = (fields = ["fecha", "anulada_en", "created_at", "updated_at"]) => {
  return (req, res, next) => {
    const oldJson = res.json.bind(res);

    res.json = (body) => {
      // intenta formatear venta/detalles/items si existen
      try {
        if (body?.venta) body.venta = addLocalDates(body.venta, fields);
        if (body?.ventas) body.ventas = addLocalDates(body.ventas, fields);
        if (body?.detalle) body.detalle = addLocalDates(body.detalle, fields);
        if (body?.detalles) body.detalles = addLocalDates(body.detalles, fields);
        if (body?.movimientos) body.movimientos = addLocalDates(body.movimientos, fields);
      } catch {}
      return oldJson(body);
    };

    next();
  };
};