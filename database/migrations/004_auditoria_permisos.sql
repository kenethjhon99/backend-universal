create index if not exists idx_auditoria_eventos_empresa_fecha
  on auditoria_eventos (id_empresa, created_at desc);

create index if not exists idx_auditoria_eventos_empresa_modulo
  on auditoria_eventos (id_empresa, modulo, created_at desc);

create index if not exists idx_auditoria_eventos_empresa_usuario
  on auditoria_eventos (id_empresa, id_usuario, created_at desc);

create index if not exists idx_auditoria_eventos_empresa_entidad
  on auditoria_eventos (id_empresa, entidad, entidad_id, created_at desc);
