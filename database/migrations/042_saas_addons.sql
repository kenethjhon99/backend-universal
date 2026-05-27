-- 042_saas_addons.sql
-- Fase 5: arquitectura comercial de add-ons facturables.

create table if not exists saas_addons (
  codigo varchar(60) primary key,
  nombre varchar(120) not null,
  descripcion text,
  categoria varchar(60) not null default 'OPERACION',
  activo boolean not null default true,
  visible_publico boolean not null default true,
  trial_dias integer not null default 0,
  requiere_plan_minimo varchar(40) references saas_planes(codigo),
  permite_trial boolean not null default true,
  orden integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_addon_prices (
  id_addon_price bigserial primary key,
  addon_codigo varchar(60) not null references saas_addons(codigo) on delete cascade,
  moneda varchar(3) not null default 'USD',
  intervalo varchar(20) not null default 'MONTH'
    check (intervalo in ('MONTH', 'YEAR', 'ONE_TIME')),
  precio numeric(14,2) not null default 0,
  activo boolean not null default true,
  provider varchar(30),
  provider_price_id varchar(160),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (addon_codigo, moneda, intervalo, provider, provider_price_id)
);

create table if not exists saas_addon_modules (
  addon_codigo varchar(60) not null references saas_addons(codigo) on delete cascade,
  id_modulo bigint not null references modulos(id_modulo),
  activo boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (addon_codigo, id_modulo)
);

create table if not exists saas_plan_addons (
  plan_codigo varchar(40) not null references saas_planes(codigo) on delete cascade,
  addon_codigo varchar(60) not null references saas_addons(codigo) on delete cascade,
  incluido boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (plan_codigo, addon_codigo)
);

create table if not exists empresa_addons (
  id_empresa_addon bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa) on delete cascade,
  addon_codigo varchar(60) not null references saas_addons(codigo),
  estado varchar(20) not null default 'TRIAL'
    check (estado in ('TRIAL', 'ACTIVO', 'VENCIDO', 'SUSPENDIDO', 'CANCELADO')),
  origen varchar(30) not null default 'MANUAL'
    check (origen in ('PLAN', 'CHECKOUT', 'MANUAL', 'PROMO', 'MIGRACION')),
  trial_hasta date,
  vigente_desde date not null default current_date,
  vigente_hasta date,
  renovacion_hasta date,
  billing_provider varchar(30),
  billing_subscription_item_id varchar(160),
  billing_price_id varchar(160),
  cantidad integer not null default 1,
  limites jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, addon_codigo)
);

create table if not exists empresa_addon_events (
  id_event bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa) on delete cascade,
  addon_codigo varchar(60) references saas_addons(codigo),
  tipo_evento varchar(60) not null,
  estado_anterior varchar(20),
  estado_nuevo varchar(20),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by bigint
);

create index if not exists idx_empresa_addons_estado
  on empresa_addons (id_empresa, estado, addon_codigo);
create index if not exists idx_empresa_addon_events_empresa
  on empresa_addon_events (id_empresa, created_at desc);
create index if not exists idx_saas_addon_prices_codigo
  on saas_addon_prices (addon_codigo, activo);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_saas_addons_updated_at') then
    create trigger trg_saas_addons_updated_at
      before update on saas_addons
      for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_saas_addon_prices_updated_at') then
    create trigger trg_saas_addon_prices_updated_at
      before update on saas_addon_prices
      for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_empresa_addons_updated_at') then
    create trigger trg_empresa_addons_updated_at
      before update on empresa_addons
      for each row execute function app.set_updated_at();
  end if;
end $$;

alter table empresa_addons enable row level security;
drop policy if exists empresa_addons_tenant on empresa_addons;
create policy empresa_addons_tenant on empresa_addons
  for all
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table empresa_addon_events enable row level security;
drop policy if exists empresa_addon_events_tenant on empresa_addon_events;
create policy empresa_addon_events_tenant on empresa_addon_events
  for all
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

insert into saas_addons (codigo, nombre, descripcion, categoria, trial_dias, orden)
values
  ('CARWASH', 'CarWash', 'Modulo completo para autolavados: ordenes, tecnicos, consumo y productividad.', 'OPERACION', 14, 10),
  ('TALLER', 'Taller', 'Gestion de ordenes de taller, tecnicos y servicios mecanicos.', 'OPERACION', 14, 20),
  ('CRM', 'CRM', 'Seguimiento comercial, oportunidades y relacion con clientes.', 'VENTAS', 14, 30),
  ('FACTURACION_ELECTRONICA', 'Facturacion Electronica', 'Emision e integracion con facturacion electronica local.', 'FISCAL', 0, 40),
  ('WHATSAPP_BUSINESS', 'WhatsApp Business', 'Notificaciones y flujos de atencion por WhatsApp.', 'COMUNICACION', 7, 50),
  ('BI_AVANZADO', 'BI avanzado', 'Dashboards avanzados, analitica y reportes ejecutivos.', 'ANALITICA', 14, 60),
  ('IA', 'IA', 'Capacidades de inteligencia artificial para asistencia y automatizacion.', 'IA', 7, 70),
  ('APP_MOVIL', 'App movil', 'Acceso movil avanzado para operadores, clientes o administradores.', 'MOBILE', 14, 80),
  ('API_EXTERNA', 'API externa', 'Acceso API para integraciones de terceros.', 'INTEGRACION', 0, 90),
  ('PORTAL_CLIENTES', 'Portal de clientes', 'Portal de autoservicio para clientes finales.', 'PORTALES', 14, 100)
on conflict (codigo) do nothing;

insert into saas_addon_prices (addon_codigo, moneda, intervalo, precio)
values
  ('CARWASH', 'USD', 'MONTH', 19.00),
  ('TALLER', 'USD', 'MONTH', 19.00),
  ('CRM', 'USD', 'MONTH', 15.00),
  ('FACTURACION_ELECTRONICA', 'USD', 'MONTH', 25.00),
  ('WHATSAPP_BUSINESS', 'USD', 'MONTH', 15.00),
  ('BI_AVANZADO', 'USD', 'MONTH', 29.00),
  ('IA', 'USD', 'MONTH', 39.00),
  ('APP_MOVIL', 'USD', 'MONTH', 29.00),
  ('API_EXTERNA', 'USD', 'MONTH', 19.00),
  ('PORTAL_CLIENTES', 'USD', 'MONTH', 15.00)
on conflict do nothing;

insert into saas_addon_modules (addon_codigo, id_modulo)
select data.addon_codigo, m.id_modulo
from (
  values
    ('CARWASH', 'CARWASH'),
    ('TALLER', 'SERVICIOS'),
    ('CRM', 'REPORTES'),
    ('FACTURACION_ELECTRONICA', 'POS'),
    ('WHATSAPP_BUSINESS', 'POS'),
    ('BI_AVANZADO', 'REPORTES'),
    ('IA', 'REPORTES'),
    ('APP_MOVIL', 'POS'),
    ('API_EXTERNA', 'REPORTES'),
    ('PORTAL_CLIENTES', 'POS')
) as data(addon_codigo, modulo_codigo)
inner join modulos m on m.codigo = data.modulo_codigo
on conflict (addon_codigo, id_modulo) do nothing;

insert into saas_plan_addons (plan_codigo, addon_codigo, incluido)
values
  ('PRO', 'CARWASH', true),
  ('ENTERPRISE', 'CARWASH', true),
  ('ENTERPRISE', 'BI_AVANZADO', true),
  ('WHITE_LABEL', 'CARWASH', true),
  ('WHITE_LABEL', 'BI_AVANZADO', true),
  ('WHITE_LABEL', 'API_EXTERNA', true),
  ('WHITE_LABEL', 'APP_MOVIL', true)
on conflict (plan_codigo, addon_codigo) do nothing;

create or replace function app.addons_efectivos(p_empresa bigint)
returns text[]
language sql
stable
as $$
  with plan_addons as (
    select pa.addon_codigo as codigo
    from empresas e
    inner join saas_plan_addons pa
      on pa.plan_codigo = e.saas_plan_codigo
     and pa.incluido = true
    inner join saas_addons a
      on a.codigo = pa.addon_codigo
     and a.activo = true
    where e.id_empresa = p_empresa
  ),
  contracted_addons as (
    select ea.addon_codigo as codigo
    from empresa_addons ea
    inner join saas_addons a
      on a.codigo = ea.addon_codigo
     and a.activo = true
    where ea.id_empresa = p_empresa
      and ea.estado in ('TRIAL', 'ACTIVO')
      and (ea.vigente_hasta is null or ea.vigente_hasta >= current_date)
      and (
        ea.estado <> 'TRIAL'
        or ea.trial_hasta is null
        or ea.trial_hasta >= current_date
      )
  )
  select array(
    select distinct codigo from plan_addons
    union
    select distinct codigo from contracted_addons
  );
$$;

grant execute on function app.addons_efectivos(bigint) to public;

create or replace function app.modulos_efectivos(p_empresa bigint)
returns text[]
language sql
stable
as $$
  with plan_modules as (
    select jsonb_array_elements_text(coalesce(p.modulos_incluidos, '[]'::jsonb)) as codigo
    from empresas e
    left join saas_planes p on p.codigo = e.saas_plan_codigo
    where e.id_empresa = p_empresa
  ),
  addon_modules as (
    select m.codigo
    from unnest(app.addons_efectivos(p_empresa)) a(addon_codigo)
    inner join saas_addon_modules am
      on am.addon_codigo = a.addon_codigo
     and am.activo = true
    inner join modulos m on m.id_modulo = am.id_modulo
  ),
  override_modules as (
    select m.codigo
    from empresas_modulos em
    inner join modulos m on m.id_modulo = em.id_modulo
    where em.id_empresa = p_empresa and em.activo = true
  )
  select array(
    select distinct codigo from plan_modules where codigo is not null and codigo <> ''
    union
    select distinct codigo from addon_modules where codigo is not null and codigo <> ''
    union
    select codigo from override_modules
  );
$$;

grant execute on function app.modulos_efectivos(bigint) to public;
