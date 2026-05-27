-- 031_tenant_dominios.sql
-- Multi-tenant marca blanca: cada empresa puede tener uno o varios dominios
-- propios (CNAME apuntando al SaaS). El backend resuelve la empresa por el
-- host header de la request.
--
-- Casos de uso:
--   * empresa-x.com → tenant "empresa-x"
--   * empresa-y.miempresa.com → tenant "empresa-y"
--   * pos-juan.tu-saas.com (subdominio del SaaS para tenants sin dominio propio)

create table if not exists tenant_dominios (
  id_dominio bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  hostname varchar(150) not null,
  -- es_primario: el host canónico (para redirects de los demás)
  es_primario boolean not null default false,
  verificado boolean not null default false,
  verification_token varchar(64),               -- usado para verificar DNS TXT
  ssl_estado varchar(20) default 'PENDIENTE'
    check (ssl_estado in ('PENDIENTE', 'EMITIDO', 'ERROR')),
  branding jsonb default '{}'::jsonb,           -- { logo_url, color_primario, color_secundario, favicon_url }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (hostname)
);

create index if not exists idx_tenant_dominios_empresa
  on tenant_dominios (id_empresa, es_primario desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_dominios_updated_at') then
    create trigger trg_tenant_dominios_updated_at
    before update on tenant_dominios
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS (excepto que el lookup por hostname tiene que funcionar antes del JWT;
-- por eso este lookup va por la conexión de aplicación, no por la del usuario)
alter table tenant_dominios enable row level security;
drop policy if exists tenant_dominios_tenant_policy on tenant_dominios;
create policy tenant_dominios_tenant_policy on tenant_dominios
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Indice publico/auxiliar para resolver hostname → id_empresa sin RLS
-- (la query usa SECURITY DEFINER en una función)
create or replace function app.resolve_tenant_by_host(host_in text)
returns table(id_empresa bigint, hostname varchar, es_primario boolean, verificado boolean, branding jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select id_empresa, hostname, es_primario, verificado, branding
  from tenant_dominios
  where lower(hostname) = lower(host_in)
    and verificado = true
  limit 1;
$$;
