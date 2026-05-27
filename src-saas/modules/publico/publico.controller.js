import { asyncHandler } from "../../shared/http/async-handler.js";
import * as service from "./publico.service.js";

export const getOrdenPublica = asyncHandler(async (req, res) => {
  const data = await service.getOrdenPublica({
    codigoPublico: req.params.codigo,
  });
  // Cache corto en CDN: 30s. La info cambia segun avanza el servicio.
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.json({ ok: true, data });
});
