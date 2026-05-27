-- 014_refresh_tokens.sql
-- Tabla para refresh tokens rotativos. Cada token vive como hash (no se
-- almacena el secreto en claro), y al usarse para refrescar se revoca y se
-- emite uno nuevo (rotacion). Si un token revocado es reusado, es senal de
-- robo y se revocan TODOS los del usuario.

create table if not exists refresh_tokens (
  id_refresh_token bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_usuario bigint not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by_id bigint references refresh_tokens(id_refresh_token),
  user_agent text,
  ip varchar(64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_refresh_tokens_usuario_activos
  on refresh_tokens (id_empresa, id_usuario)
  where revoked_at is null;

create index if not exists idx_refresh_tokens_expires
  on refresh_tokens (expires_at)
  where revoked_at is null;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_refresh_tokens_updated_at') then
    create trigger trg_refresh_tokens_updated_at
    before update on refresh_tokens
    for each row execute function app.set_updated_at();
  end if;
end $$;

alter table refresh_tokens enable row level security;
drop policy if exists refresh_tokens_tenant_policy on refresh_tokens;
create policy refresh_tokens_tenant_policy on refresh_tokens
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
