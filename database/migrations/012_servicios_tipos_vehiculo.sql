-- 012_servicios_tipos_vehiculo.sql
-- Catalogo de tipos de vehiculo por empresa (multi-tenant) para los modulos
-- SERVICIOS y CARWASH. Sustituye al varchar libre `ordenes_servicio.vehiculo_tipo`
-- y permite que cada empresa tenga sus propios tipos (moto electrica, etc.).
-- Idempotente.

create table if not exists servicios_tipos_vehiculo (
  id_tipo_vehiculo bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  modulo varchar(30) not null,
  nombre varchar(80) not null,
  slug varchar(80) not null,
  descripcion text,
  icono varchar(80),
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, modulo, slug)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_servicios_tipos_vehiculo_modulo'
  ) then
    alter table servicios_tipos_vehiculo
      add constraint chk_servicios_tipos_vehiculo_modulo
      check (modulo in ('CARWASH', 'SERVICIOS'));
  end if;
end $$;

create index if not exists idx_servicios_tipos_vehiculo_empresa_modulo_activo
  on servicios_tipos_vehiculo (id_empresa, modulo, activo, orden);

-- Trigger updated_at (se reusa la funcion app.set_updated_at del 001)
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_servicios_tipos_vehiculo_updated_at') then
    create trigger trg_servicios_tipos_vehiculo_updated_at
    before update on servicios_tipos_vehiculo
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS por tenant
alter table servicios_tipos_vehiculo enable row level security;
drop policy if exists servicios_tipos_vehiculo_tenant_policy on servicios_tipos_vehiculo;
create policy servicios_tipos_vehiculo_tenant_policy on servicios_tipos_vehiculo
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Seed inicial: para cada empresa que ya tiene SERVICIOS o CARWASH como modulo
-- activo, sembrar el set basico de tipos de vehiculo.
insert into servicios_tipos_vehiculo (id_empresa, modulo, nombre, slug, descripcion, icono, orden, activo)
select e.id_empresa, data.modulo, data.nombre, data.slug, data.descripcion, data.icono, data.orden, true
from empresas e
cross join (
  values
    -- CARWASH
    ('CARWASH',   'Moto',     'moto',     'Motocicletas y motonetas',                'two_wheeler',     1),
    ('CARWASH',   'Carro',    'carro',    'Automoviles particulares',                'directions_car',  2),
    ('CARWASH',   'Pickup',   'pickup',   'Pickups y camionetas',                    'airport_shuttle', 3),
    ('CARWASH',   'Camion',   'camion',   'Camiones y vehiculos pesados',            'local_shipping',  4),
    -- SERVICIOS (taller)
    ('SERVICIOS', 'Moto',     'moto',     'Motocicletas para mantenimiento',         'two_wheeler',     1),
    ('SERVICIOS', 'Sedan',    'sedan',    'Automoviles livianos',                    'directions_car',  2),
    ('SERVICIOS', 'SUV',      'suv',      'SUV y camionetas familiares',             'airport_shuttle', 3),
    ('SERVICIOS', 'Pickup',   'pickup',   'Pickups de trabajo',                      'airport_shuttle', 4),
    ('SERVICIOS', 'Camion',   'camion',   'Camiones de carga',                       'local_shipping',  5),
    ('SERVICIOS', 'Microbus', 'microbus', 'Transporte liviano',                      'directions_bus',  6)
) as data(modulo, nombre, slug, descripcion, icono, orden)
on conflict (id_empresa, modulo, slug) do nothing;
