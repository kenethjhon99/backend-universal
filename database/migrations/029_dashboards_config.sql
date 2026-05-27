-- 029_dashboards_config.sql
-- Dashboards configurables por usuario. Cada usuario puede tener uno o varios
-- dashboards con widgets posicionados en grid.
-- El frontend renderiza widgets en base a config jsonb; el catalogo de widgets
-- disponibles esta hardcoded en el frontend.

create table if not exists dashboards (
  id_dashboard bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_usuario bigint not null,
  nombre varchar(120) not null,
  layout jsonb not null default '[]'::jsonb,             -- array de widgets con { id, type, x, y, w, h, params }
  es_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_dashboards_usuario
  on dashboards (id_empresa, id_usuario, es_default desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_dashboards_updated_at') then
    create trigger trg_dashboards_updated_at
    before update on dashboards
    for each row execute function app.set_updated_at();
  end if;
end $$;

alter table dashboards enable row level security;
drop policy if exists dashboards_tenant_policy on dashboards;
create policy dashboards_tenant_policy on dashboards
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
