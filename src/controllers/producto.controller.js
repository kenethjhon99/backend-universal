import * as Producto from "../models/productos.model.js";
import * as Stock from "../models/stock.model.js";
import { validateProductoUpdate } from "../validators/producto.validator.js";

const getNormalizedRoles = (req) =>
  (Array.isArray(req.user?.roles) ? req.user.roles : [])
    .map((role) => String(role).trim().toUpperCase())
    .filter(Boolean);

const isAdminProductManager = (req) =>
  getNormalizedRoles(req).some((role) => ["SUPER_ADMIN", "ADMIN"].includes(role));

const isServiciosProductManager = (req) =>
  getNormalizedRoles(req).includes("ENCARGADO_SERVICIOS");

const canAccessScope = (req, scope) => {
  const roles = getNormalizedRoles(req);
  const normalizedScope = String(scope || "GENERAL").trim().toUpperCase();

  if (normalizedScope === "SERVICIOS") {
    return roles.some((role) =>
      ["SUPER_ADMIN", "ADMIN", "CAJERO", "MECANICO", "ENCARGADO_SERVICIOS"].includes(role)
    );
  }

  if (normalizedScope === "ALL") {
    return roles.some((role) => ["SUPER_ADMIN", "ADMIN"].includes(role));
  }

  return roles.some((role) => ["SUPER_ADMIN", "ADMIN", "CAJERO"].includes(role));
};

export const listarProductos = async (req, res) => {
  try {
    const scope = String(req.query?.scope || "GENERAL").trim().toUpperCase();
    if (!canAccessScope(req, scope)) {
      return res.status(403).json({ error: "No autorizado para consultar este catalogo" });
    }

    const productos = await Producto.getProductos({ scope });
    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const generarCodigoBarrasProducto = async (_req, res) => {
  try {
    const codigo_barras = await Producto.generateUniqueCodigoBarras();
    res.json({ codigo_barras });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const crearProducto = async (req, res) => {
  try {
    const {
      codigo_barras,
      nombre,
      descripcion,
      precio_compra,
      precio_venta,
      modulo_origen,
      existencia_inicial,
      stock_minimo,
      ubicacion
    } = req.body;

    const requestedScope = String(modulo_origen || "GENERAL").trim().toUpperCase();

    if (isServiciosProductManager(req) && !isAdminProductManager(req) && requestedScope !== "SERVICIOS") {
      return res.status(403).json({
        error: "Este rol solo puede crear productos del catalogo Tienda",
      });
    }

    const creado = await Producto.createProductoConStock({
      codigo_barras,
      nombre,
      descripcion,
      precio_compra,
      precio_venta,
      modulo_origen: requestedScope,
      existencia_inicial: Number(existencia_inicial || 0),
      stock_minimo: Number(stock_minimo || 0),
      ubicacion: ubicacion ?? null,
      id_bodega: 1,
      id_usuario: req.user?.id_usuario ?? null,
    });

    res.status(201).json(creado);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Duplicado (por ejemplo codigo_barras)" });
    }
    res.status(500).json({ error: error.message });
  }
};

export const actualizarProducto = async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: "id inválido" });
    }

    const productoActual = await Producto.getProductoById(Number(id));
    if (!productoActual) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    if (
      isServiciosProductManager(req) &&
      !isAdminProductManager(req) &&
      String(productoActual.modulo_origen || "GENERAL").trim().toUpperCase() !== "SERVICIOS"
    ) {
      return res.status(403).json({
        error: "Este rol solo puede editar productos del catalogo Tienda",
      });
    }

    const {
      existencia_inicial,
      stock_minimo,
      ubicacion,
      ...datosProducto
    } = req.body;

    if (datosProducto.modulo_origen !== undefined) {
      datosProducto.modulo_origen = String(datosProducto.modulo_origen || "GENERAL")
        .trim()
        .toUpperCase();
    }

    if (isServiciosProductManager(req) && !isAdminProductManager(req)) {
      if (
        datosProducto.modulo_origen !== undefined &&
        datosProducto.modulo_origen !== "SERVICIOS"
      ) {
        return res.status(403).json({
          error: "Este rol solo puede mantener productos como Tienda",
        });
      }

      datosProducto.modulo_origen = "SERVICIOS";
    }

    if (
      existencia_inicial !== undefined &&
      (!Number.isInteger(Number(existencia_inicial)) || Number(existencia_inicial) < 0)
    ) {
      return res.status(400).json({ error: "existencia_inicial debe ser entero >= 0" });
    }

    if (
      stock_minimo !== undefined &&
      (!Number.isInteger(Number(stock_minimo)) || Number(stock_minimo) < 0)
    ) {
      return res.status(400).json({ error: "stock_minimo debe ser entero >= 0" });
    }

    if (
      ubicacion !== undefined &&
      ubicacion !== null &&
      typeof ubicacion !== "string"
    ) {
      return res.status(400).json({ error: "ubicacion debe ser string o null" });
    }

    const v = validateProductoUpdate(datosProducto);
    if (!v.ok) {
      return res.status(400).json({ error: "Validación", details: v.errors });
    }

    if (v.data.codigo_barras) {
      const existe = await Producto.existsCodigoBarras(v.data.codigo_barras, id);
      if (existe) {
        return res.status(409).json({ error: "codigo_barras ya existe" });
      }
    }

    let actualizado = null;

    if (Object.keys(v.data).length > 0) {
      actualizado = await Producto.updateProducto(
        id,
        v.data,
        req.user?.id_usuario ?? null
      );

      if (!actualizado) {
        return res.status(404).json({ error: "Producto no encontrado" });
      }
    }

    const stockActual = await Stock.getStockByProducto(Number(id), 1);
    if (!stockActual) {
      return res.status(404).json({ error: "No existe registro de stock para este producto" });
    }

    if (existencia_inicial !== undefined) {
      await Stock.crearMovimientoStock({
        id_producto: Number(id),
        id_bodega: 1,
        tipo: "AJUSTE",
        motivo: "Ajuste manual desde edición de producto",
        nueva_existencia: Number(existencia_inicial),
        id_usuario: req.user?.id_usuario ?? null,
      });
    }

    if (stock_minimo !== undefined || ubicacion !== undefined) {
      await Stock.updateDatosStock({
        id_producto: Number(id),
        id_bodega: 1,
        stock_minimo: stock_minimo !== undefined ? Number(stock_minimo) : undefined,
        ubicacion: ubicacion !== undefined ? ubicacion : undefined,
      });
    }

    const productoCompleto = await Producto.getProductoById(Number(id));

    res.json(productoCompleto || actualizado);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Duplicado: ya existe ese codigo_barras" });
    }
    res.status(500).json({ error: error.message });
  }
};

export const eliminarProducto = async (req, res) => {
  try {
    const { id } = req.params;
    const productoActual = await Producto.getProductoById(Number(id));

    if (!productoActual) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    if (
      isServiciosProductManager(req) &&
      !isAdminProductManager(req) &&
      String(productoActual.modulo_origen || "GENERAL").trim().toUpperCase() !== "SERVICIOS"
    ) {
      return res.status(403).json({
        error: "Este rol solo puede desactivar productos del catalogo Tienda",
      });
    }

    const eliminado = await Producto.deleteProducto(
      id,
      req.user?.id_usuario ?? null
    );
    if (!eliminado) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    res.json(eliminado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
