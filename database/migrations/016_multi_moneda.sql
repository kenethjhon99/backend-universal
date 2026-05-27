-- 016_multi_moneda.sql
-- Soporte multi-moneda. Estrategia:
--   * `monedas` global (catalogo ISO-4217: GTQ, USD, MXN, etc.)
--   * `empresas.moneda_base` define la moneda contable
--   * `tipos_cambio` historicos (id_empresa, moneda_origen -> moneda_base, fecha, tasa)
--   * Las transacciones (ventas, compras) guardan moneda + tasa al momento
--   * Reportes pueden agregar en moneda base usando la tasa del documento

create table if not exists monedas (
  codigo varchar(3) primary key,           -- ISO-4217 (GTQ, USD, ...)
  nombre varchar(80) not null,
  simbolo varchar(8) not null,
  decimales smallint not null default 2,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into monedas (codigo, nombre, simbolo, decimales) values
  ('GTQ', 'Quetzal guatemalteco', 'Q', 2),
  ('USD', 'Dolar estadounidense', '$', 2),
  ('MXN', 'Peso mexicano', '$', 2),
  ('SVC', 'Colon salvadoreno', '₡', 2),
  ('HNL', 'Lempira hondureno', 'L', 2),
  ('NIO', 'Cordoba nicaraguense', 'C$', 2),
  ('CRC', 'Colon costarricense', '₡', 2),
  ('PAB', 'Balboa panameno', 'B/.', 2),
  ('DOP', 'Peso dominicano', 'RD$', 2),
  ('EUR', 'Euro', '€', 2)
on conflict (codigo) do nothing;

-- Moneda base por empresa
alter table empresas
  add column if not exists moneda_base varchar(3)
    references monedas(codigo);

update empresas set moneda_base = 'GTQ' where moneda_base is null;

-- Tipos de cambio historicos (moneda_origen -> moneda_base de la empresa)
create table if not exists tipos_cambio (
  id_tipo_cambio bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  moneda_origen varchar(3) not null references monedas(codigo),
  moneda_destino varchar(3) not null references monedas(codigo),
  tasa numeric(18,8) not null check (tasa > 0),
  fecha date not null,
  fuente varchar(80),                    -- ej. 'Banguat', 'manual', 'XE'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, moneda_origen, moneda_destino, fecha)
);

create index if not exists idx_tipos_cambio_empresa_origen_fecha
  on tipos_cambio (id_empresa, moneda_origen, fecha desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_monedas_updated_at') then
    create trigger trg_monedas_updated_at
    before update on monedas
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_tipos_cambio_updated_at') then
    create trigger trg_tipos_cambio_updated_at
    before update on tipos_cambio
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS por tenant en tipos_cambio
alter table tipos_cambio enable row level security;
drop policy if exists tipos_cambio_tenant_policy on tipos_cambio;
create policy tipos_cambio_tenant_policy on tipos_cambio
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Snapshot de moneda + tasa en ventas y compras
alter table ventas
  add column if not exists moneda varchar(3) references monedas(codigo),
  add column if not exists tasa_cambio numeric(18,8);

alter table compras
  add column if not exists moneda varchar(3) references monedas(codigo),
  add column if not exists tasa_cambio numeric(18,8);

-- Backfill: usar la moneda base de cada empresa con tasa 1
update ventas v
set moneda = coalesce(v.moneda, e.moneda_base, 'GTQ'),
    tasa_cambio = coalesce(v.tasa_cambio, 1.0)
from empresas e
where e.id_empresa = v.id_empresa
  and (v.moneda is null or v.tasa_cambio is null);

update compras c
set moneda = coalesce(c.moneda, e.moneda_base, 'GTQ'),
    tasa_cambio = coalesce(c.tasa_cambio, 1.0)
from empresas e
where e.id_empresa = c.id_empresa
  and (c.moneda is null or c.tasa_cambio is null);
