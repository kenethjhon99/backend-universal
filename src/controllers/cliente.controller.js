import * as Cliente from "../models/cliente.model.js";

const normalizeClientePayload = (body = {}) => ({
  nit: String(body.nit || "").trim() || null,
  nombre: String(body.nombre || "").trim(),
  telefono: String(body.telefono || "").trim() || null,
  correo: String(body.correo || "").trim() || null,
  direccion: String(body.direccion || "").trim() || null,
});

export const listarClientes = async (req, res) => {
  try {
    const clientes = await Cliente.getClientes({
      incluirInactivos: String(req.query?.incluirInactivos || "").toLowerCase() === "true",
    });

    res.json({ ok: true, data: clientes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const crearCliente = async (req, res) => {
  try {
    const payload = normalizeClientePayload(req.body);

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (await Cliente.existsClienteByNit(payload.nit)) {
      return res.status(409).json({ error: "Ya existe un cliente con ese NIT" });
    }

    const cliente = await Cliente.createCliente({
      ...payload,
      actorId: req.user?.id_usuario ?? null,
    });
    res.status(201).json({ ok: true, cliente });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Registro duplicado en clientes" });
    }

    res.status(500).json({ error: error.message });
  }
};

export const actualizarCliente = async (req, res) => {
  try {
    const id_cliente = Number(req.params.id);
    const payload = normalizeClientePayload(req.body);

    if (!Number.isInteger(id_cliente) || id_cliente <= 0) {
      return res.status(400).json({ error: "id_cliente invalido" });
    }

    if (!payload.nombre) {
      return res.status(400).json({ error: "nombre es requerido" });
    }

    if (await Cliente.existsClienteByNit(payload.nit, id_cliente)) {
      return res.status(409).json({ error: "Ya existe un cliente con ese NIT" });
    }

    const cliente = await Cliente.updateCliente(
      id_cliente,
      payload,
      req.user?.id_usuario ?? null
    );

    if (!cliente) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    res.json({ ok: true, cliente });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Registro duplicado en clientes" });
    }

    res.status(500).json({ error: error.message });
  }
};

export const eliminarCliente = async (req, res) => {
  try {
    const id_cliente = Number(req.params.id);

    if (!Number.isInteger(id_cliente) || id_cliente <= 0) {
      return res.status(400).json({ error: "id_cliente invalido" });
    }

    const cliente = await Cliente.desactivarCliente(
      id_cliente,
      req.user?.id_usuario ?? null
    );

    if (!cliente) {
      return res.status(404).json({ error: "Cliente no encontrado o ya inactivo" });
    }

    res.json({ ok: true, cliente });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
