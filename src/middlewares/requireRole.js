export const requireRole = (...rolesPermitidos) => {
  const permitidos = rolesPermitidos.map(r => String(r).toUpperCase());

  return (req, res, next) => {
    
    const rolesToken = req.user?.roles;
    const roles = (req.user?.roles || []).map(r => String(r).trim().toUpperCase());

    const ok = permitidos.some(r => roles.includes(r));
    if (!ok) {
      return res.status(403).json({
        error: "No autorizado",
        detalle: { roles_en_token: rolesToken ?? null, permitidos }
      });
    }
    next();
  };
};
