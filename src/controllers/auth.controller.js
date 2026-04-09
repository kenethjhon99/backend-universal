import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import * as Auth from "../models/auth.model.js";
import {
  hashPassword,
  validatePasswordPolicy,
  verifyPasswordWithUpgrade,
} from "../utils/password.js";

const getFechaInicioDefault = (fechaInicio) => {
  if (fechaInicio) return fechaInicio;

  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

const signToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES || "8h",
  });
};

export const register = async (req, res) => {
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

    const ex = await client.query(
      `SELECT 1 FROM "Usuario" WHERE username = $1 LIMIT 1`,
      [username.trim()]
    );

    if (ex.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "username ya existe" });
    }

    const password_hash = await hashPassword(password);

    const rUser = await client.query(
      `INSERT INTO "Usuario" (username, password_hash, nombre, activo, created_by, updated_by)
       VALUES ($1,$2,$3,true,$4,$4)
       RETURNING id_usuario, username, nombre, activo`,
      [
        username.trim(),
        password_hash,
        `${persona.nombre} ${persona.apellido}`.trim(),
        req.user?.id_usuario ?? null,
      ]
    );

    const id_usuario = rUser.rows[0].id_usuario;

    const rPersona = await client.query(
      `INSERT INTO "Persona"
       (dpi_persona, nombre, apellido, fecha_nacimiento, fecha_inicio, direccion_persona, telefono, estado, id_usuario, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING *`,
      [
        persona.dpi_persona ?? null,
        persona.nombre.trim(),
        persona.apellido.trim(),
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
           VALUES ($1,$2,true,$3,$3)
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
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    client.release();
  }
};

export const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username y password son requeridos" });
    }

    const user = await Auth.getUsuarioByUsername(username.trim());
    if (!user) return res.status(401).json({ error: "Credenciales incorrectas" });
    if (!user.activo) return res.status(403).json({ error: "Usuario inactivo" });

    const ok = await verifyPasswordWithUpgrade({
      plainPassword: password,
      storedPasswordHash: user.password_hash,
      onLegacyUpgrade: async (upgradedHash) => {
        await Auth.updateUsuarioPasswordHash(
          user.id_usuario,
          upgradedHash,
          user.id_usuario
        );
      },
    });
    if (!ok) return res.status(401).json({ error: "Credenciales incorrectas" });

    const roles = await Auth.getRolesByUsuario(user.id_usuario);

    const token = signToken({
      id_usuario: user.id_usuario,
      username: user.username,
      roles: roles.map((r) => String(r.nombre_rol).trim().toUpperCase()),
    });

    return res.json({
      ok: true,
      token,
      user: {
        id_usuario: user.id_usuario,
        username: user.username,
        nombre: user.nombre,
        roles,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
