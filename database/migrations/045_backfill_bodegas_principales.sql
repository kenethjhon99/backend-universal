-- 045_backfill_bodegas_principales.sql
-- =========================================================================
-- Repara empresas/sucursales creadas antes de que el bootstrap creara bodega
-- principal. Inventario, ventas, compras y CarWash dependen de una bodega
-- principal activa por sucursal.
-- =========================================================================

-- 1) Si ya existe una bodega con codigo PRINCIPAL y la sucursal no tiene
-- principal, promover esa bodega. Esto evita chocar con el unique parcial
-- uq_bodegas_principal_por_sucursal.
update bodegas b
set es_principal = true,
    activa = true,
    updated_at = now()
where upper(b.codigo) = 'PRINCIPAL'
  and not exists (
    select 1
    from bodegas bp
    where bp.id_empresa = b.id_empresa
      and bp.id_sucursal = b.id_sucursal
      and bp.es_principal = true
  );

-- 2) Crear PRINCIPAL solo en sucursales que todavia no tienen principal ni
-- una bodega con codigo PRINCIPAL.
insert into bodegas (id_empresa, id_sucursal, codigo, nombre, es_principal, activa)
select s.id_empresa, s.id_sucursal, 'PRINCIPAL', 'Bodega principal', true, true
from sucursales s
where not exists (
  select 1
  from bodegas b
  where b.id_empresa = s.id_empresa
    and b.id_sucursal = s.id_sucursal
    and b.es_principal = true
)
and not exists (
  select 1
  from bodegas b
  where b.id_empresa = s.id_empresa
    and b.id_sucursal = s.id_sucursal
    and upper(b.codigo) = 'PRINCIPAL'
);

update bodegas
set activa = true,
    updated_at = now()
where es_principal = true
  and activa = false;

update stock_sucursal ss
set id_bodega = b.id_bodega
from bodegas b
where b.id_empresa = ss.id_empresa
  and b.id_sucursal = ss.id_sucursal
  and b.es_principal = true
  and ss.id_bodega is null;

insert into stock_sucursal (
  id_empresa,
  id_sucursal,
  id_bodega,
  id_producto,
  stock_actual,
  stock_minimo
)
select
  p.id_empresa,
  s.id_sucursal,
  b.id_bodega,
  p.id_producto,
  0,
  0
from productos p
inner join sucursales s
  on s.id_empresa = p.id_empresa
inner join bodegas b
  on b.id_empresa = s.id_empresa
 and b.id_sucursal = s.id_sucursal
 and b.es_principal = true
 and b.activa = true
where p.activo = true
on conflict (id_empresa, id_sucursal, id_bodega, id_producto)
do nothing;
