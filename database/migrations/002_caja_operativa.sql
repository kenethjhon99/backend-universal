alter table caja_sesiones
  add column if not exists monto_cierre_reportado numeric(14,2),
  add column if not exists monto_cierre_calculado numeric(14,2),
  add column if not exists observaciones_apertura text,
  add column if not exists observaciones_cierre text,
  add column if not exists diferencia_validada_por bigint,
  add column if not exists diferencia_validada_en timestamptz,
  add column if not exists diferencia_validacion_nota text;

update caja_sesiones
set monto_cierre_reportado = monto_cierre
where monto_cierre_reportado is null
  and monto_cierre is not null;

update caja_sesiones
set observaciones_apertura = observaciones
where observaciones_apertura is null
  and observaciones is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'caja_sesiones_diferencia_validada_por_fkey'
  ) then
    alter table caja_sesiones
      add constraint caja_sesiones_diferencia_validada_por_fkey
      foreign key (id_empresa, diferencia_validada_por)
      references usuarios(id_empresa, id_usuario);
  end if;
end;
$$;

alter table caja_movimientos
  add column if not exists referencia_tipo varchar(30) not null default 'MANUAL',
  add column if not exists referencia_id bigint;

create unique index if not exists uq_caja_sesion_abierta_usuario
  on caja_sesiones (id_empresa, id_usuario)
  where estado = 'ABIERTA';

create index if not exists idx_caja_sesiones_empresa_sucursal_fecha
  on caja_sesiones (id_empresa, id_sucursal, fecha_apertura desc);

create index if not exists idx_caja_movimientos_empresa_sesion_fecha
  on caja_movimientos (id_empresa, id_caja_sesion, created_at desc);

create index if not exists idx_ventas_empresa_sucursal_fecha
  on ventas (id_empresa, id_sucursal, fecha_venta desc);
