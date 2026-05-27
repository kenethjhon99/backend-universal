-- 043_empresa_branding.sql
-- Branding empresarial por tenant: fuente central para login, app, documentos,
-- correos y PWA. tenant_dominios.branding queda como override por dominio.

create table if not exists empresa_branding (
  id_empresa bigint primary key references empresas(id_empresa) on delete cascade,
  nombre_comercial varchar(160),
  slogan varchar(240),
  logo_principal_url text,
  logo_secundario_url text,
  logo_dark_url text,
  favicon_url text,
  color_primario varchar(20) not null default '#2563eb',
  color_secundario varchar(20) not null default '#0f172a',
  color_acento varchar(20) not null default '#16a34a',
  modo_oscuro boolean not null default false,
  login_config jsonb not null default '{}'::jsonb,
  dashboard_config jsonb not null default '{}'::jsonb,
  nav_config jsonb not null default '{}'::jsonb,
  documento_config jsonb not null default '{}'::jsonb,
  email_config jsonb not null default '{}'::jsonb,
  pwa_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  constraint empresa_branding_color_primario_hex check (color_primario ~* '^#[0-9a-f]{6}$'),
  constraint empresa_branding_color_secundario_hex check (color_secundario ~* '^#[0-9a-f]{6}$'),
  constraint empresa_branding_color_acento_hex check (color_acento ~* '^#[0-9a-f]{6}$')
);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_empresa_branding_updated_at') then
    create trigger trg_empresa_branding_updated_at
      before update on empresa_branding
      for each row execute function app.set_updated_at();
  end if;
end $$;

alter table empresa_branding enable row level security;
drop policy if exists empresa_branding_tenant_policy on empresa_branding;
create policy empresa_branding_tenant_policy on empresa_branding
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

insert into empresa_branding (id_empresa, nombre_comercial, created_by, updated_by)
select e.id_empresa, e.nombre_comercial, e.created_by, e.updated_by
from empresas e
on conflict (id_empresa) do nothing;

insert into permisos_catalogo (codigo, nombre, modulo, riesgo)
values
  ('company.branding.read', 'Ver branding empresarial', 'EMPRESAS', 'BAJO'),
  ('company.branding.update', 'Actualizar branding empresarial', 'EMPRESAS', 'MEDIO')
on conflict (codigo) do nothing;

create or replace function app.branding_empresa(p_empresa bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'nombre_comercial', coalesce(eb.nombre_comercial, e.nombre_comercial, e.nombre_legal),
    'nombre_legal', e.nombre_legal,
    'slogan', eb.slogan,
    'logo_principal_url', eb.logo_principal_url,
    'logo_secundario_url', eb.logo_secundario_url,
    'logo_dark_url', eb.logo_dark_url,
    'favicon_url', eb.favicon_url,
    'color_primario', coalesce(eb.color_primario, '#2563eb'),
    'color_secundario', coalesce(eb.color_secundario, '#0f172a'),
    'color_acento', coalesce(eb.color_acento, '#16a34a'),
    'modo_oscuro', coalesce(eb.modo_oscuro, false),
    'login', coalesce(eb.login_config, '{}'::jsonb),
    'dashboard', coalesce(eb.dashboard_config, '{}'::jsonb),
    'nav', coalesce(eb.nav_config, '{}'::jsonb),
    'documentos', coalesce(eb.documento_config, '{}'::jsonb),
    'email', coalesce(eb.email_config, '{}'::jsonb),
    'pwa', coalesce(eb.pwa_config, '{}'::jsonb)
  ))
  from empresas e
  left join empresa_branding eb
    on eb.id_empresa = e.id_empresa
  where e.id_empresa = p_empresa
  limit 1;
$$;

grant execute on function app.branding_empresa(bigint) to public;

create or replace function app.resolve_tenant_by_host(host_in text)
returns table(id_empresa bigint, hostname varchar, es_primario boolean, verificado boolean, branding jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select
    td.id_empresa,
    td.hostname,
    td.es_primario,
    td.verificado,
    coalesce(app.branding_empresa(td.id_empresa), '{}'::jsonb)
      || coalesce(td.branding, '{}'::jsonb) as branding
  from tenant_dominios td
  where lower(td.hostname) = lower(host_in)
    and td.verificado = true
  limit 1;
$$;
