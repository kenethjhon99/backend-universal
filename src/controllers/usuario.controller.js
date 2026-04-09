import { pool } from "../config/db.js";
import * as U from "../models/usuario.admin.model.js";
import {
  hashPassword,
  validatePasswordPolicy,
} from "../utils/password.js";

const getFechaInicioDefault = (fechaInicio) => {
  if (fechaInicio) return fechaInicio;

  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

export const crearUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, password, roles = [], persona } = req.body;

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "username requerido" });
    }

    validatePasswordPolicy(password);

    if (!persona || typeof persona !== "object") {
      return res.status(400).json({ error: "persona es requerida" });
    }

    if (!persona.nombre || !persona.apellido) {
      return res.status(400).json({ error: "persona.nombre y persona.apellido son requeridos" });
    }

    await client.query("BEGIN");

    const existingUser = await client.query(
      `SELECT 1 FROM "Usuario" WHERE username = $1 LIMIT 1`,
      [username.trim()]
    );

    if (existingUser.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "username ya existe" });
    }

    const password_hash = await hashPassword(password);

    const rUser = await client.query(
      `INSERT INTO "Usuario" (username, password_hash, nombre, activo, created_by, updated_by)
       VALUES ($1, $2, $3, true, $4, $4)
       RETURNING id_usuario, username, nombre, activo`,
      [
        username.trim(),
        password_hash,
        `${String(persona.nombre || "").trim()} ${String(persona.apellido || "").trim()}`.trim(),
        req.user?.id_usuario ?? null,
      ]
    );

    const id_usuario = rUser.rows[0].id_usuario;

    const rPersona = await client.query(
      `INSERT INTO "Persona"
       (dpi_persona, nombre, apellido, fecha_nacimiento, fecha_inicio, direccion_persona, telefono, estado, id_usuario, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        persona.dpi_persona ?? null,
        String(persona.nombre || "").trim(),
        String(persona.apellido || "").trim(),
        persona.fecha_nacimiento ?? null,
        getFechaInicioDefault(persona.fecha_inicio),
        persona.direccion_persona ?? null,
        persona.telefono ?? null,
        persona.estado ?? true,
        id_usuario,
        req.user?.id_usuario ?? null,
      ]
    );

    if (Array.isArray(roles)) {
      for (const id_rol of roles) {
        if (!Number.isInteger(Number(id_rol))) continue;

        await client.query(
          `INSERT INTO "Detalle_usuario" (id_usuario, id_rol, activo, created_by, updated_by)
           VALUES ($1, $2, true, $3, $3)
           ON CONFLICT DO NOTHING`,
          [id_usuario, Number(id_rol), req.user?.id_usuario ?? null]
        );
      }
    }

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      usuario: rUser.rows[0],
      persona: rPersona.rows[0],
      roles_asignados: roles,
    });
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.code === "23505") {
      return res.status(409).json({ error: "username ya existe" });
    }

    res.status(e.statusCode || 500).json({ error: e.message });
  } finally {
    client.release();
  }
};

export const listarUsuarios = async (req, res) => {
  try {
    const data = await U.listarUsuarios();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const editarUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id invalido" });

    const { username, nombre, password, persona } = req.body;

    const u = await U.actualizarUsuarioBasico(
      Number(id),
      {
        username: username ? String(username).trim() : null,
        nombre: nombre ? String(nombre).trim() : null,
      },
      req.user?.id_usuario ?? null
    );

    if (!u) return res.status(404).json({ error: "Usuario no encontrado" });

    if (password !== undefined && password !== null && String(password).trim() !== "") {
      validatePasswordPolicy(password);
      const passwordHash = await hashPassword(password);
      await U.actualizarPasswordHashUsuario(
        Number(id),
        passwordHash,
        req.user?.id_usuario ?? null
      );
    }

    let p = null;
    if (persona && typeof persona === "object") {
      const allowed = [
        "dpi_persona",
        "nombre",
        "apellido",
        "fecha_nacimiento",
        "direccion_persona",
        "telefono",
        "estado",
      ];
      const data = {};
      for (const k of allowed) {
        if (persona[k] !== undefined) data[k] = persona[k];
      }
      p = await U.actualizarPersona(Number(id), data, req.user?.id_usuario ?? null);
    }

    res.json({ ok: true, usuario: u, persona: p });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "username ya existe" });
    res.status(e.statusCode || 500).json({ error: e.message });
  }
};

export const desactivarUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id invalido" });

    const r = await U.setActivoUsuario(Number(id), false, req.user?.id_usuario ?? null);
    if (!r) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({ ok: true, usuario: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const activarUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id invalido" });

    const r = await U.setActivoUsuario(Number(id), true, req.user?.id_usuario ?? null);
    if (!r) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({ ok: true, usuario: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const asignarRol = async (req, res) => {
  try {
    const { id } = req.params;
    const { id_rol } = req.body;

    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id invalido" });
    if (!/^\d+$/.test(String(id_rol))) return res.status(400).json({ error: "id_rol invalido" });

    const u = await U.getUsuarioById(Number(id));
    if (!u) return res.status(404).json({ error: "Usuario no encontrado" });

    const r = await U.asignarRol(Number(id), Number(id_rol), req.user?.id_usuario ?? null);
    res.json({ ok: true, asignado: !!r, detalle: r ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const quitarRol = async (req, res) => {
  try {
    const { id, id_rol } = req.params;

    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "id invalido" });
    if (!/^\d+$/.test(id_rol)) return res.status(400).json({ error: "id_rol invalido" });

    const r = await U.quitarRol(Number(id), Number(id_rol), req.user?.id_usuario ?? null);
    if (!r) return res.status(404).json({ error: "Ese rol no estaba asignado" });

    res.json({ ok: true, detalle: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
