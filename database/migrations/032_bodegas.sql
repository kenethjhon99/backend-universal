-- 032_bodegas.sql
-- Multi-bodega real. Hasta ahora una sucursal funcionaba como bodega única.
-- Ahora cada sucursal puede tener N bodegas (ej. "Salón", "Depósito",
-- "Vehículo de reparto"). El stock se rastrea por (empresa, sucursal, bodega).
-- Compat: las operaciones existentes siguen funcionando porque la migración
-- crea automáticamente una bodega 'PRINCIPAL' por cada sucursal existente,
-- y todo el stock previo de stock_sucursal se mapea a esa bodega.

create table if not exists bodegas (
  id_bodega bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_sucursal bigint not null,
  codigo varchar(30) not null,
  nombre varchar(120) not null,
  descripcion text,
  ubicacion varchar(200),
  es_principal boolean not null default false,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_sucursal, codigo),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal)
);

create unique index if not exists uq_bodegas_empresa_id
  on bodegas (id_empresa, id_bodega);

-- Solo UNA bodega principal por sucursal
create unique index if not exists uq_bodegas_principal_por_sucursal
  on bodegas (id_empresa, id_sucursal)
  where es_principal = true;

create index if not exists idx_bodegas_sucursal_activas
  on bodegas (id_empresa, id_sucursal, activa);

-- Seed: una bodega PRINCIPAL por sucursal existente
insert into bodegas (id_empresa, id_sucursal, codigo, nombre, es_principal, activa)
select id_empresa, id_sucursal, 'PRINCIPAL', 'Bodega principal', true, true
from sucursales
on conflict (id_empresa, id_sucursal, codigo) do nothing;

-- Agregar columna id_bodega a stock_sucursal (compat: se llena con la principal)
alter table stock_sucursal
  add column if not exists id_bodega bigint;

update stock_sucursal ss
set id_bodega = b.id_bodega
from bodegas b
where b.id_empresa = ss.id_empresa
  and b.id_sucursal = ss.id_sucursal
  and b.es_principal = true
  and ss.id_bodega is null;

-- Después del backfill, hacerla NOT NULL y agregar FK
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'stock_sucursal' and column_name = 'id_bodega' and is_nullable = 'YES'
  ) then
    -- Solo si todas las filas tienen id_bodega
    if not exists (select 1 from stock_sucursal where id_bodega is null) then
      alter table stock_sucursal alter column id_bodega set not null;
    end if;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fk_stock_sucursal_bodega'
  ) then
    alter table stock_sucursal
      add constraint fk_stock_sucursal_bodega
      foreign key (id_empresa, id_bodega) references bodegas(id_empresa, id_bodega);
  end if;
end $$;

-- El UNIQUE de stock_sucursal cambia: ahora es por (empresa, sucursal, producto, bodega)
do $$
begin
  if exists (
    select 1 from pg_indexes
    where tablename = 'stock_sucursal'
      and indexname like '%id_empresa_id_sucursal_id_producto%'
  ) then
    -- El indice anterior ya cubre lo basico; agregamos uno nuevo con id_bodega
    create unique index if not exists uq_stock_sucursal_empresa_sucursal_bodega_producto
      on stock_sucursal (id_empresa, id_sucursal, id_bodega, id_producto);
  end if;
end $$;

-- Movimientos de inventario también ganan id_bodega (compat con backfill)
alter table movimientos_inventario
  add column if not exists id_bodega bigint;

update movimientos_inventario mi
set id_bodega = b.id_bodega
from bodegas b
where b.id_empresa = mi.id_empresa
  and b.id_sucursal = mi.id_sucursal
  and b.es_principal = true
  and mi.id_bodega is null;

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_bodegas_updated_at') then
    create trigger trg_bodegas_updated_at
    before update on bodegas
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table bodegas enable row level security;
drop policy if exists bodegas_tenant_policy on bodegas;
create policy bodegas_tenant_policy on bodegas
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
