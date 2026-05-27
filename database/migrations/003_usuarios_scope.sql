create unique index if not exists uq_usuarios_sucursales_predeterminada
  on usuarios_sucursales (id_empresa, id_usuario)
  where es_predeterminada = true;

create index if not exists idx_usuarios_empresa_activo_username
  on usuarios (id_empresa, activo, username);

create index if not exists idx_usuarios_roles_empresa_usuario
  on usuarios_roles (id_empresa, id_usuario);

create index if not exists idx_usuarios_sucursales_empresa_usuario
  on usuarios_sucursales (id_empresa, id_usuario);
