-- 036_mfa_totp.sql
-- =========================================================================
-- MFA TOTP (RFC 6238).
--   - secret_encrypted: la clave compartida del usuario, encriptada con
--     AES-256-GCM y MFA_ENCRYPTION_KEY del .env. NUNCA en claro en BD.
--   - backup_codes_hash: array de bcrypt-hashes de codigos de respaldo
--     (8 codigos single-use generados al enrollar; se muestran una sola vez).
--   - habilitado: false inmediatamente despues de enroll, true tras la primera
--     verificacion exitosa con un codigo TOTP (confirma que el usuario tiene
--     la app configurada).
-- =========================================================================

create table if not exists usuarios_mfa (
  id_usuario bigint primary key references usuarios(id_usuario) on delete cascade,
  id_empresa bigint not null references empresas(id_empresa),
  metodo varchar(20) not null default 'TOTP' check (metodo in ('TOTP')),
  secret_encrypted text not null,
  secret_iv text not null,
  secret_auth_tag text not null,
  backup_codes_hash text[] not null default array[]::text[],
  habilitado boolean not null default false,
  habilitado_en timestamptz,
  ultimo_uso_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_usuarios_mfa_empresa on usuarios_mfa (id_empresa);

-- RLS: usuario ve su propio MFA. Admin de empresa puede leer pero no el secret.
-- Pero como el secret esta encriptado, leerlo igual es inutil sin la key.
alter table usuarios_mfa enable row level security;
drop policy if exists usuarios_mfa_self_or_admin on usuarios_mfa;
create policy usuarios_mfa_self_or_admin on usuarios_mfa
  using (
    app.is_super_admin()
    or id_empresa = app.current_empresa_id()
  )
  with check (
    app.is_super_admin()
    or id_empresa = app.current_empresa_id()
  );

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_usuarios_mfa_updated_at') then
    create trigger trg_usuarios_mfa_updated_at
      before update on usuarios_mfa
      for each row execute function app.set_updated_at();
  end if;
end $$;

-- Tabla auxiliar para tracking de intentos fallidos de MFA (anti-bruteforce).
-- Se borra al MFA exitoso o se limpia con un job semanal.
create table if not exists mfa_intentos_fallidos (
  id_intento bigserial primary key,
  id_usuario bigint not null references usuarios(id_usuario) on delete cascade,
  ip inet,
  user_agent text,
  motivo varchar(40), -- 'invalid_code', 'invalid_challenge', 'expired_challenge'
  created_at timestamptz not null default now()
);

create index if not exists idx_mfa_intentos_usuario_ts
  on mfa_intentos_fallidos (id_usuario, created_at desc);
