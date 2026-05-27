-- 018_membresias.sql
-- Membresias y planes recurrentes para CarWash y Servicios.
-- Modelo:
--   * membresias_planes: catalogo por empresa (ej. "Lavado ilimitado mensual")
--   * membresias_planes_servicios: que servicios del catalogo cubre el plan
--       (con limite opcional de usos por ciclo)
--   * membresias_clientes: suscripciones activas por cliente
--   * membresias_consumos: registro de cada uso aplicado a una orden
--
-- Flujo:
--   1. Admin crea plan: precio, duracion, ciclo de renovacion, servicios cubiertos
--   2. Cliente compra membresia -> se crea membresias_clientes con vencimiento
--   3. Cliente llega a hacer servicio cubierto -> chargeOrder detecta membresia
--      activa, registra membresias_consumos y NO cobra (o cobra extras)

create table if not exists membresias_planes (
  id_plan bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  modulo varchar(30) not null check (modulo in ('CARWASH', 'SERVICIOS')),
  nombre varchar(120) not null,
  descripcion text,
  precio numeric(14,2) not null check (precio >= 0),
  moneda varchar(3) references monedas(codigo),
  duracion_dias integer not null default 30 check (duracion_dias > 0),
  renovacion_automatica boolean not null default false,
  activo boolean not null default true,
  -- Limite global de usos en el ciclo (null = ilimitado)
  usos_max_por_ciclo integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, modulo, nombre)
);

-- Unique compuesto requerido por los FK de tablas hijas (debe existir ANTES
-- de las CREATE TABLE que lo referencian).
create unique index if not exists uq_membresias_planes_empresa_id
  on membresias_planes (id_empresa, id_plan);

create table if not exists membresias_planes_servicios (
  id_plan_servicio bigserial primary key,
  id_empresa bigint not null,
  id_plan bigint not null,
  id_servicio_catalogo bigint not null,
  -- Limite de usos por ciclo de ESTE servicio especifico (null = sin limite propio,
  -- aplica el limite global del plan si existe)
  usos_max_por_ciclo integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id_empresa, id_plan, id_servicio_catalogo),
  foreign key (id_empresa, id_plan) references membresias_planes(id_empresa, id_plan)
    deferrable initially deferred,
  foreign key (id_empresa, id_servicio_catalogo) references servicios_catalogo(id_empresa, id_servicio_catalogo)
);

create table if not exists membresias_clientes (
  id_membresia bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_plan bigint not null,
  id_cliente bigint not null,
  estado varchar(20) not null default 'ACTIVA'
    check (estado in ('ACTIVA', 'VENCIDA', 'CANCELADA', 'SUSPENDIDA')),
  fecha_inicio date not null default current_date,
  fecha_vencimiento date not null,
  precio_pagado numeric(14,2) not null,
  moneda varchar(3) references monedas(codigo),
  id_venta_origen bigint,            -- FK suelta a la venta que cobro la membresia
  renovacion_automatica boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_plan) references membresias_planes(id_empresa, id_plan),
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente)
);

create index if not exists idx_membresias_clientes_activas
  on membresias_clientes (id_empresa, id_cliente, estado, fecha_vencimiento)
  where estado = 'ACTIVA';

-- Unique compuesto requerido por el FK de membresias_consumos (debe existir
-- ANTES de la CREATE TABLE que lo referencia).
create unique index if not exists uq_membresias_clientes_empresa_id
  on membresias_clientes (id_empresa, id_membresia);

create table if not exists membresias_consumos (
  id_consumo bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_membresia bigint not null,
  id_orden_servicio bigint not null,
  id_servicio_catalogo bigint not null,
  fecha_uso timestamptz not null default now(),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_membresia) references membresias_clientes(id_empresa, id_membresia),
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio)
);

create index if not exists idx_membresias_consumos_membresia_fecha
  on membresias_consumos (id_empresa, id_membresia, fecha_uso desc);

create unique index if not exists uq_membresias_consumos_orden
  on membresias_consumos (id_empresa, id_orden_servicio);

-- Triggers de updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_membresias_planes_updated_at') then
    create trigger trg_membresias_planes_updated_at
    before update on membresias_planes
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_membresias_clientes_updated_at') then
    create trigger trg_membresias_clientes_updated_at
    before update on membresias_clientes
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_membresias_consumos_updated_at') then
    create trigger trg_membresias_consumos_updated_at
    before update on membresias_consumos
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
do $$
declare
  t text;
begin
  foreach t in array array[
    'membresias_planes',
    'membresias_planes_servicios',
    'membresias_clientes',
    'membresias_consumos'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_policy', t);
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      t || '_tenant_policy', t
    );
  end loop;
end $$;
