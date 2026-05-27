-- 019_onboarding_planes.sql
-- Self-service onboarding: catalogo de planes (tier comercial), trial,
-- y suscripcion del SaaS por empresa.

-- Catalogo de planes COMERCIALES (basico/pro/enterprise) que el SaaS vende
-- a las empresas. Diferente de membresias_planes (que son del cliente final).
create table if not exists saas_planes (
  codigo varchar(40) primary key,
  nombre varchar(120) not null,
  descripcion text,
  precio_mensual numeric(14,2) not null default 0,
  precio_anual numeric(14,2),
  moneda varchar(3) not null default 'USD',
  trial_dias integer not null default 14,
  -- Limites del plan
  max_sucursales integer,
  max_usuarios integer,
  max_ventas_mes integer,
  -- Modulos incluidos (codigos separados por coma o jsonb)
  modulos_incluidos jsonb not null default '[]'::jsonb,
  activo boolean not null default true,
  visible_publico boolean not null default true,
  orden integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Suscripcion del SaaS por empresa (qué plan tiene contratado)
alter table empresas
  add column if not exists saas_plan_codigo varchar(40)
    references saas_planes(codigo),
  add column if not exists saas_estado varchar(20) not null default 'TRIAL'
    check (saas_estado in ('TRIAL', 'ACTIVA', 'SUSPENDIDA', 'CANCELADA')),
  add column if not exists saas_trial_hasta date,
  add column if not exists saas_renovacion_hasta date,
  add column if not exists saas_billing_email varchar(150);

-- Eventos / log de cambios del plan SaaS por empresa
create table if not exists saas_subscription_events (
  id_event bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  tipo_evento varchar(40) not null,        -- TRIAL_STARTED, PLAN_CHANGED, PAYMENT_RECEIVED, SUSPENDED, ...
  plan_codigo varchar(40) references saas_planes(codigo),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by bigint
);

create index if not exists idx_saas_subscription_events_empresa
  on saas_subscription_events (id_empresa, created_at desc);

-- Seed de planes basicos
insert into saas_planes (codigo, nombre, descripcion, precio_mensual, trial_dias, max_sucursales, max_usuarios, modulos_incluidos, orden)
values
  ('FREE', 'Gratis', 'Plan basico para probar. Limitado.', 0, 0, 1, 2, '["POS", "INVENTARIO"]'::jsonb, 1),
  ('STARTER', 'Starter', 'Para emprendimientos chicos.', 19.99, 14, 1, 5, '["POS", "INVENTARIO", "REPORTES"]'::jsonb, 2),
  ('PRO', 'Pro', 'Para PYMES con varias sucursales.', 49.99, 14, 5, 20, '["POS", "INVENTARIO", "COMPRAS", "REPORTES", "SERVICIOS", "CARWASH", "FINANZAS"]'::jsonb, 3),
  ('ENTERPRISE', 'Enterprise', 'Empresas grandes. Soporte dedicado.', 199.99, 30, null, null, '["POS", "INVENTARIO", "COMPRAS", "REPORTES", "SERVICIOS", "CARWASH", "FINANZAS"]'::jsonb, 4)
on conflict (codigo) do nothing;

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_saas_planes_updated_at') then
    create trigger trg_saas_planes_updated_at
    before update on saas_planes
    for each row execute function app.set_updated_at();
  end if;
end $$;
