import express from "express";
import cors from "cors";
import { pool } from "./config/db.js";
import productoRouter from "./routes/producto.route.js";
import stockRouter from "./routes/stock.route.js";
import authRouter from "./routes/auth.route.js";
import rolRouter from "./routes/rol.route.js";
import usuarioRouter from "./routes/usuario.route.js";
import { auth } from "./middlewares/auth.js";
import ventaRouter from "./routes/venta.route.js";
import { formatDates } from "./middlewares/formatDates.js";
import reporteRouter from "./routes/reporte.route.js";
import compraRouter from "./routes/compra.route.js";
import proveedorRouter from "./routes/proveedor.route.js";
import clienteRouter from "./routes/cliente.route.js";
import cajaRouter from "./routes/caja.route.js";
import servicioRouter from "./routes/servicio.route.js";

const parseAllowedOrigins = () => {
  const envOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set(["http://localhost:5173", ...envOrigins]);
};

const isAllowedVercelPreview = (origin) => {
  if (process.env.CORS_ALLOW_VERCEL_PREVIEWS !== "true") return false;

  try {
    const { hostname } = new URL(origin);
    return hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
};

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      const allowedOrigins = parseAllowedOrigins();

      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(origin) || isAllowedVercelPreview(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(formatDates(["fecha", "anulada_en"]));
app.use("/api/productos", productoRouter);
app.use("/api/stock", stockRouter);
app.use("/api/auth", authRouter);
app.use("/api/roles", rolRouter);
app.use("/api/usuarios", usuarioRouter);
app.use("/api/ventas", ventaRouter);
app.use("/api/reportes", reporteRouter);
app.use("/api/compras", compraRouter);
app.use("/api/proveedores", proveedorRouter);
app.use("/api/clientes", clienteRouter);
app.use("/api/caja", cajaRouter);
app.use("/api/servicios", servicioRouter);

app.get("/api/health", async (req, res) => {
  const r = await pool.query("SELECT NOW() AS ahora");
  res.json({ ok: true, dbTime: r.rows[0].ahora });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export default app;
