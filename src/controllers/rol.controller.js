import * as Rol from "../models/rol.model.js";

export const listarRoles = async (req, res) => {
  try {
    const roles = await Rol.getRoles();
    res.json(roles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
