alter table ordenes_servicio
  add column if not exists modulo varchar(30),
  add column if not exists numero_orden varchar(50),
  add column if not exists nombre_contacto varchar(150),
  add column if not exists telefono_contacto varchar(30),
  add column if not exists marca varchar(60),
  add column if not exists modelo varchar(60),
  add column if not exists anio integer,
  add column if not exists kilometraje varchar(30),
  add column if not exists id_usuario_asignado bigint,
  add column if not exists precio_servicio numeric(14,2) not null default 0,
  add column if not exists estado_cobro varchar(20) not null default 'PENDIENTE',
  add column if not exists monto_recibido numeric(14,2),
  add column if not exists cambio numeric(14,2) not null default 0,
  add column if not exists fecha_inicio timestamptz,
  add column if not exists fecha_finalizacion timestamptz,
  add column if not exists fecha_entrega timestamptz,
  add column if not exists fecha_cobro timestamptz;

update ordenes_servicio os
set modulo = sc.modulo
from servicios_catalogo sc
where sc.id_empresa = os.id_empresa
  and sc.id_servicio_catalogo = os.id_servicio_catalogo
  and os.modulo is null;

update ordenes_servicio
set modulo = 'SERVICIOS'
where modulo is null;

update ordenes_servicio
set precio_servicio = subtotal
where coalesce(precio_servicio, 0) = 0
  and coalesce(subtotal, 0) > 0;

update ordenes_servicio
set numero_orden = concat(
  case
    when upper(coalesce(modulo, 'SERVICIOS')) = 'CARWASH' then 'CW'
    else 'SRV'
  end,
  '-',
  lpad(id_orden_servicio::text, 8, '0')
)
where numero_orden is null;

alter table ordenes_servicio_productos
  add column if not exists cobra_al_cliente boolean not null default true,
  add column if not exists observacion text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ordenes_servicio_id_usuario_asignado_fkey'
  ) then
    alter table ordenes_servicio
      add constraint ordenes_servicio_id_usuario_asignado_fkey
      foreign key (id_empresa, id_usuario_asignado)
      references usuarios(id_empresa, id_usuario);
  end if;
end;
$$;

create unique index if not exists uq_ordenes_servicio_empresa_numero
  on ordenes_servicio (id_empresa, numero_orden)
  where numero_orden is not null;

create index if not exists idx_servicios_catalogo_empresa_modulo_activo
  on servicios_catalogo (id_empresa, modulo, activo, nombre);

create index if not exists idx_ordenes_servicio_empresa_sucursal_modulo_fecha
  on ordenes_servicio (id_empresa, id_sucursal, modulo, fecha_servicio desc);

create index if not exists idx_ordenes_servicio_empresa_estado_cobro
  on ordenes_servicio (id_empresa, estado, estado_cobro, fecha_servicio desc);

create index if not exists idx_ordenes_servicio_empresa_asignado
  on ordenes_servicio (id_empresa, id_usuario_asignado, fecha_servicio desc);

create index if not exists idx_ordenes_servicio_productos_empresa_orden
  on ordenes_servicio_productos (id_empresa, id_orden_servicio, id_orden_servicio_producto);
