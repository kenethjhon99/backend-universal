const normalizeJson = (value) => {
  if (value === undefined) return null;
  return value === null ? null : JSON.stringify(value);
};

const withImpersonationMeta = (auth, value) => {
  if (!auth?.impersonation && !auth?.impersonated_by) return value;
  const base = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { valor: value ?? null };
  return {
    ...base,
    _impersonation: {
      active: true,
      impersonated_by: auth?.impersonated_by || null,
    },
  };
};

export const writeAuditEvent = async (
  db,
  {
    auth,
    scope = null,
    requestMeta = null,
    modulo,
    entidad,
    entidadId,
    accion,
    antes = null,
    despues = null,
  }
) => {
  await db.query(
    `
      insert into auditoria_eventos (
        id_empresa,
        id_sucursal,
        id_usuario,
        modulo,
        entidad,
        entidad_id,
        accion,
        datos_antes,
        datos_despues,
        ip,
        user_agent
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
    `,
    [
      auth?.id_empresa || null,
      scope?.id_sucursal || auth?.id_sucursal || null,
      auth?.id_usuario || null,
      String(modulo || "").trim().toUpperCase(),
      String(entidad || "").trim().toUpperCase(),
      Number(entidadId) || 0,
      String(accion || "").trim().toUpperCase(),
      normalizeJson(withImpersonationMeta(auth, antes)),
      normalizeJson(withImpersonationMeta(auth, despues)),
      requestMeta?.ip || null,
      requestMeta?.userAgent || null,
    ]
  );
};
