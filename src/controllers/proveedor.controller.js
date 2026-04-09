import * as Proveedor from "../models/proveedor.model.js";

export const listarProveedores = async (req, res) => {
  try {
    const proveedores = await Proveedor.getProveedores({
      incluirInactivos: String(req.query?.incluirInactivos || "").toLowerCase() === "true",
    });
    res.json({ ok: true, data: proveedores });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const crearProveedor = async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || "").trim();
    const nit = String(req.body?.nit || "").trim();
    const telefono = String(req.body?.telefono || "").trim() || null;
    const correo = String(req.body?.correo || "").trim() || null;
    const direccion = String(req.body?.direccion || "").trim() || null;

    if (!nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!nit) {
      return res.status(400).json({ error: "nit es requerido" });
    }

    const nitExiste = await Proveedor.existsProveedorByNit(nit);
    if (nitExiste) {
      return res.status(409).json({ error: "Ya existe un proveedor con ese NIT" });
    }

    const proveedor = await Proveedor.createProveedor({
      nombre,
      nit,
      telefono,
      correo,
      direccion,
      actorId: req.user?.id_usuario ?? null,
    });

    res.status(201).json({ ok: true, proveedor });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un proveedor con ese NIT" });
    }

    res.status(500).json({ error: error.message });
  }
};

export const actualizarProveedor = async (req, res) => {
  try {
    const id_proveedor = Number(req.params.id);
    const nombre = String(req.body?.nombre || "").trim();
    const nit = String(req.body?.nit || "").trim();
    const telefono = String(req.body?.telefono || "").trim() || null;
    const correo = String(req.body?.correo || "").trim() || null;
    const direccion = String(req.body?.direccion || "").trim() || null;

    if (!Number.isInteger(id_proveedor) || id_proveedor <= 0) {
      return res.status(400).json({ error: "id_proveedor invalido" });
    }

    if (!nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (!nit) {
      return res.status(400).json({ error: "nit es requerido" });
    }

    const nitExiste = await Proveedor.existsProveedorByNit(nit, id_proveedor);
    if (nitExiste) {
      return res.status(409).json({ error: "Ya existe un proveedor con ese NIT" });
    }

    const proveedor = await Proveedor.updateProveedor(id_proveedor, {
      nombre,
      nit,
      telefono,
      correo,
      direccion,
    }, req.user?.id_usuario ?? null);

    if (!proveedor) {
      return res.status(404).json({ error: "Proveedor no encontrado" });
    }

    res.json({ ok: true, proveedor });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Ya existe un proveedor con ese NIT" });
    }

    res.status(500).json({ error: error.message });
  }
};

export const eliminarProveedor = async (req, res) => {
  try {
    const id_proveedor = Number(req.params.id);

    if (!Number.isInteger(id_proveedor) || id_proveedor <= 0) {
      return res.status(400).json({ error: "id_proveedor invalido" });
    }

    const proveedor = await Proveedor.desactivarProveedor(
      id_proveedor,
      req.user?.id_usuario ?? null
    );

    if (!proveedor) {
      return res.status(404).json({ error: "Proveedor no encontrado o ya inactivo" });
    }

    res.json({ ok: true, proveedor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
