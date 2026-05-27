-- 040_auth_security_sessions.sql
-- =========================================================================
-- Fase 1: seguridad de autenticacion y sesiones.
-- Agrega soporte para recuperacion de password, bloqueo persistente por
-- intentos fallidos y gestion visible/revocable de sesiones por dispositivo.
-- =========================================================================

create table if not exists password_reset_tokens (
  id_password_reset bigserial primary key,
  id_empresa bigint not null,
  id_usuario bigint not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  ip varchar(64),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_password_reset_usuario
    foreign key (id_empresa, id_usuario)
    references usuarios (id_empresa, id_usuario)
    on delete cascade
);

create index if not exists idx_password_reset_usuario_activos
  on password_reset_tokens (id_empresa, id_usuario, created_at desc)
  where used_at is null;

create index if not exists idx_password_reset_expires
  on password_reset_tokens (expires_at)
  where used_at is null;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_password_reset_tokens_updated_at') then
    create trigger trg_password_reset_tokens_updated_at
    before update on password_reset_tokens
    for each row execute function app.set_updated_at();
  end if;
end $$;

alter table password_reset_tokens enable row level security;
alter table password_reset_tokens force row level security;
drop policy if exists password_reset_tokens_tenant_policy on password_reset_tokens;
create policy password_reset_tokens_tenant_policy on password_reset_tokens
  for all
  using (
    current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  )
  with check (
    current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  );

create table if not exists login_intentos_fallidos (
  id_intento bigserial primary key,
  id_empresa bigint,
  id_usuario bigint,
  email varchar(150) not null,
  ip varchar(64),
  user_agent text,
  motivo varchar(40) not null default 'invalid_credentials',
  created_at timestamptz not null default now(),
  constraint fk_login_intentos_usuario
    foreign key (id_empresa, id_usuario)
    references usuarios (id_empresa, id_usuario)
    on delete cascade
);

create index if not exists idx_login_intentos_email_fecha
  on login_intentos_fallidos (lower(email), created_at desc);

create index if not exists idx_login_intentos_usuario_fecha
  on login_intentos_fallidos (id_empresa, id_usuario, created_at desc)
  where id_usuario is not null;

alter table login_intentos_fallidos enable row level security;
alter table login_intentos_fallidos force row level security;
drop policy if exists login_intentos_fallidos_tenant_policy on login_intentos_fallidos;
create policy login_intentos_fallidos_tenant_policy on login_intentos_fallidos
  for all
  using (
    id_empresa is null
    or current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  )
  with check (
    id_empresa is null
    or current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  );

alter table refresh_tokens
  add column if not exists last_used_at timestamptz,
  add column if not exists last_ip varchar(64),
  add column if not exists last_user_agent text,
  add column if not exists revoked_reason varchar(40),
  add column if not exists device_label text;

create index if not exists idx_refresh_tokens_usuario_sesiones
  on refresh_tokens (id_empresa, id_usuario, revoked_at, expires_at desc);

alter table auditoria_eventos enable row level security;
alter table auditoria_eventos force row level security;
drop policy if exists auditoria_eventos_tenant_policy on auditoria_eventos;
create policy auditoria_eventos_tenant_policy on auditoria_eventos
  for all
  using (
    id_empresa is null
    or current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  )
  with check (
    id_empresa is null
    or current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  );
