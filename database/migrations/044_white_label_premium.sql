-- 044_white_label_premium.sql
-- White Label Premium: dominios propios, SSL gestionado, correo corporativo,
-- API privada y ruta futura a base dedicada.

alter table tenant_dominios
  add column if not exists tipo varchar(20) not null default 'DOMINIO_PROPIO',
  add column if not exists dns_estado varchar(20) not null default 'PENDIENTE',
  add column if not exists ssl_provider varchar(40),
  add column if not exists ssl_expires_at timestamptz,
  add column if not exists ssl_error text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists white_label_activo boolean not null default true,
  add column if not exists api_privada_activa boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenant_dominios_tipo_check'
  ) then
    alter table tenant_dominios
      add constraint tenant_dominios_tipo_check
      check (tipo in ('SUBDOMINIO', 'DOMINIO_PROPIO'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'tenant_dominios_dns_estado_check'
  ) then
    alter table tenant_dominios
      add constraint tenant_dominios_dns_estado_check
      check (dns_estado in ('PENDIENTE', 'VERIFICADO', 'ERROR'));
  end if;
end $$;

create table if not exists empresa_white_label_config (
  id_empresa bigint primary key references empresas(id_empresa) on delete cascade,
  nivel varchar(30) not null default 'NONE'
    check (nivel in ('NONE', 'DOMAIN', 'DEDICATED_LOGICAL', 'DEDICATED_DB')),
  estado varchar(20) not null default 'INACTIVO'
    check (estado in ('INACTIVO', 'SOLICITADO', 'ACTIVO', 'SUSPENDIDO')),
  dominio_principal varchar(150),
  subdominio varchar(150),
  ssl_gestionado boolean not null default true,
  correo_dominio varchar(150),
  email_from varchar(180),
  api_privada_activa boolean not null default false,
  api_base_path varchar(120) not null default '/api/private',
  recursos_config jsonb not null default '{}'::jsonb,
  dedicated_db_estado varchar(20) not null default 'NO_APLICA'
    check (dedicated_db_estado in ('NO_APLICA', 'SOLICITADA', 'PROVISIONANDO', 'ACTIVA', 'ERROR')),
  dedicated_db_ref text,
  backup_config jsonb not null default '{}'::jsonb,
  sla_config jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint
);

create table if not exists empresa_api_keys (
  id_api_key bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa) on delete cascade,
  nombre varchar(120) not null,
  key_prefix varchar(20) not null,
  key_hash varchar(128) not null,
  scopes text[] not null default array[]::text[],
  estado varchar(20) not null default 'ACTIVA'
    check (estado in ('ACTIVA', 'REVOCADA')),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_by bigint,
  revoked_by bigint,
  unique (key_prefix),
  unique (key_hash)
);

create index if not exists idx_empresa_api_keys_empresa
  on empresa_api_keys (id_empresa, estado, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_empresa_white_label_updated_at') then
    create trigger trg_empresa_white_label_updated_at
      before update on empresa_white_label_config
      for each row execute function app.set_updated_at();
  end if;
end $$;

alter table empresa_white_label_config enable row level security;
drop policy if exists empresa_white_label_tenant_policy on empresa_white_label_config;
create policy empresa_white_label_tenant_policy on empresa_white_label_config
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table empresa_api_keys enable row level security;
drop policy if exists empresa_api_keys_tenant_policy on empresa_api_keys;
create policy empresa_api_keys_tenant_policy on empresa_api_keys
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

insert into permisos_catalogo (codigo, nombre, modulo, riesgo)
values
  ('company.white_label.read', 'Ver configuracion white label', 'EMPRESAS', 'BAJO'),
  ('company.white_label.update', 'Actualizar configuracion white label', 'EMPRESAS', 'ALTO'),
  ('company.api_keys.manage', 'Gestionar claves API privadas', 'EMPRESAS', 'ALTO')
on conflict (codigo) do nothing;

create or replace function app.white_label_empresa(p_empresa bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'nivel', coalesce(wl.nivel, 'NONE'),
    'estado', coalesce(wl.estado, 'INACTIVO'),
    'dominio_principal', wl.dominio_principal,
    'subdominio', wl.subdominio,
    'ssl_gestionado', coalesce(wl.ssl_gestionado, true),
    'correo_dominio', wl.correo_dominio,
    'email_from', wl.email_from,
    'api_privada_activa', coalesce(wl.api_privada_activa, false),
    'api_base_path', coalesce(wl.api_base_path, '/api/private'),
    'dedicated_db_estado', coalesce(wl.dedicated_db_estado, 'NO_APLICA'),
    'recursos_config', coalesce(wl.recursos_config, '{}'::jsonb),
    'backup_config', coalesce(wl.backup_config, '{}'::jsonb),
    'sla_config', coalesce(wl.sla_config, '{}'::jsonb),
    'metadata', coalesce(wl.metadata, '{}'::jsonb)
  )
  from empresas e
  left join empresa_white_label_config wl
    on wl.id_empresa = e.id_empresa
  where e.id_empresa = p_empresa
  limit 1;
$$;

grant execute on function app.white_label_empresa(bigint) to public;
