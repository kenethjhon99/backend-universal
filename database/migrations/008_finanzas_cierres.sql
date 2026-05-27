insert into modulos (codigo, nombre, descripcion)
values ('FINANZAS', 'Finanzas', 'Cartera, notas formales y cierres por periodo')
on conflict (codigo) do update
set
  nombre = excluded.nombre,
  descripcion = excluded.descripcion,
  updated_at = now();

insert into empresas_modulos (
  id_empresa,
  id_modulo,
  activo,
  config,
  created_by,
  updated_by
)
select
  e.id_empresa,
  m.id_modulo,
  true,
  '{}'::jsonb,
  null,
  null
from empresas e
cross join modulos m
where m.codigo = 'FINANZAS'
on conflict (id_empresa, id_modulo) do nothing;

alter table ventas
  add column if not exists dias_credito integer not null default 0,
  add column if not exists fecha_vencimiento date,
  add column if not exists saldo_pendiente numeric(14,2) not null default 0;

alter table compras
  add column if not exists condicion_pago varchar(20) not null default 'CONTADO',
  add column if not exists dias_credito integer not null default 0,
  add column if not exists fecha_vencimiento date,
  add column if not exists saldo_pendiente numeric(14,2) not null default 0;

update ventas
set
  saldo_pendiente = case
    when upper(coalesce(tipo_venta, '')) = 'CREDITO'
      or upper(coalesce(metodo_pago, '')) = 'CREDITO'
    then greatest(coalesce(total, 0) - coalesce(monto_revertido, 0), 0)
    else 0
  end,
  fecha_vencimiento = coalesce(
    fecha_vencimiento,
    case
      when upper(coalesce(tipo_venta, '')) = 'CREDITO'
        or upper(coalesce(metodo_pago, '')) = 'CREDITO'
      then fecha_venta::date
      else null
    end
  )
where saldo_pendiente = 0 or fecha_vencimiento is null;

create table if not exists cuentas_por_cobrar (
  id_cuenta_por_cobrar bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_cliente bigint not null,
  id_venta bigint,
  numero_documento varchar(50) not null,
  tipo_documento varchar(30) not null default 'FACTURA_CREDITO',
  estado varchar(20) not null default 'PENDIENTE',
  fecha_documento date not null,
  fecha_vencimiento date,
  monto_original numeric(14,2) not null default 0,
  saldo_actual numeric(14,2) not null default 0,
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, numero_documento),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente),
  foreign key (id_empresa, id_venta) references ventas(id_empresa, id_venta)
);

create table if not exists cuentas_por_cobrar_movimientos (
  id_cxc_movimiento bigserial primary key,
  id_empresa bigint not null,
  id_cuenta_por_cobrar bigint not null references cuentas_por_cobrar(id_cuenta_por_cobrar),
  id_sucursal bigint not null,
  id_usuario bigint not null,
  tipo_movimiento varchar(30) not null,
  metodo_pago varchar(20),
  monto numeric(14,2) not null,
  saldo_anterior numeric(14,2) not null,
  saldo_nuevo numeric(14,2) not null,
  referencia_tipo varchar(30),
  referencia_id bigint,
  fecha_movimiento date not null default current_date,
  observacion text,
  id_caja_sesion bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_caja_sesion) references caja_sesiones(id_caja_sesion)
);

create table if not exists cuentas_por_pagar (
  id_cuenta_por_pagar bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_proveedor bigint not null,
  id_compra bigint,
  numero_documento varchar(50) not null,
  tipo_documento varchar(30) not null default 'FACTURA_CREDITO_COMPRA',
  estado varchar(20) not null default 'PENDIENTE',
  fecha_documento date not null,
  fecha_vencimiento date,
  monto_original numeric(14,2) not null default 0,
  saldo_actual numeric(14,2) not null default 0,
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, numero_documento),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_proveedor) references proveedores(id_empresa, id_proveedor),
  foreign key (id_empresa, id_compra) references compras(id_empresa, id_compra)
);

create table if not exists cuentas_por_pagar_movimientos (
  id_cxp_movimiento bigserial primary key,
  id_empresa bigint not null,
  id_cuenta_por_pagar bigint not null references cuentas_por_pagar(id_cuenta_por_pagar),
  id_sucursal bigint not null,
  id_usuario bigint not null,
  tipo_movimiento varchar(30) not null,
  metodo_pago varchar(20),
  monto numeric(14,2) not null,
  saldo_anterior numeric(14,2) not null,
  saldo_nuevo numeric(14,2) not null,
  referencia_tipo varchar(30),
  referencia_id bigint,
  fecha_movimiento date not null default current_date,
  observacion text,
  id_caja_sesion bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_caja_sesion) references caja_sesiones(id_caja_sesion)
);

create table if not exists notas_formales (
  id_nota_formal bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_usuario bigint not null,
  destino varchar(10) not null,
  tipo_nota varchar(20) not null,
  numero_documento varchar(50) not null,
  id_cliente bigint,
  id_proveedor bigint,
  id_cuenta_por_cobrar bigint,
  id_cuenta_por_pagar bigint,
  id_venta bigint,
  id_compra bigint,
  monto numeric(14,2) not null default 0,
  fecha_emision date not null default current_date,
  motivo text not null,
  observaciones text,
  estado varchar(20) not null default 'EMITIDA',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, numero_documento),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente),
  foreign key (id_empresa, id_proveedor) references proveedores(id_empresa, id_proveedor),
  foreign key (id_cuenta_por_cobrar) references cuentas_por_cobrar(id_cuenta_por_cobrar),
  foreign key (id_cuenta_por_pagar) references cuentas_por_pagar(id_cuenta_por_pagar),
  foreign key (id_empresa, id_venta) references ventas(id_empresa, id_venta),
  foreign key (id_empresa, id_compra) references compras(id_empresa, id_compra)
);

create table if not exists cierres_periodo (
  id_cierre_periodo bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint,
  area varchar(20) not null,
  fecha_desde date not null,
  fecha_hasta date not null,
  estado varchar(20) not null default 'CERRADO',
  resumen jsonb not null default '{}'::jsonb,
  observaciones text,
  cerrado_por bigint not null,
  cerrado_en timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, cerrado_por) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_cxc_empresa_estado_vencimiento
  on cuentas_por_cobrar (id_empresa, id_sucursal, estado, fecha_vencimiento);

create index if not exists idx_cxc_empresa_cliente
  on cuentas_por_cobrar (id_empresa, id_cliente, fecha_documento desc);

create index if not exists idx_cxc_movimientos_empresa_cuenta
  on cuentas_por_cobrar_movimientos (id_empresa, id_cuenta_por_cobrar, fecha_movimiento desc);

create index if not exists idx_cxp_empresa_estado_vencimiento
  on cuentas_por_pagar (id_empresa, id_sucursal, estado, fecha_vencimiento);

create index if not exists idx_cxp_empresa_proveedor
  on cuentas_por_pagar (id_empresa, id_proveedor, fecha_documento desc);

create index if not exists idx_cxp_movimientos_empresa_cuenta
  on cuentas_por_pagar_movimientos (id_empresa, id_cuenta_por_pagar, fecha_movimiento desc);

create index if not exists idx_notas_formales_empresa_destino
  on notas_formales (id_empresa, destino, fecha_emision desc);

create index if not exists idx_cierres_periodo_empresa_area
  on cierres_periodo (id_empresa, id_sucursal, area, fecha_desde, fecha_hasta);

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'cuentas_por_cobrar',
    'cuentas_por_cobrar_movimientos',
    'cuentas_por_pagar',
    'cuentas_por_pagar_movimientos',
    'notas_formales',
    'cierres_periodo'
  ]
  loop
    execute format('alter table %I enable row level security', tenant_table);
    execute format(
      'drop policy if exists %I on %I',
      tenant_table || '_tenant_policy',
      tenant_table
    );
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      tenant_table || '_tenant_policy',
      tenant_table
    );
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_cuentas_por_cobrar_updated_at') then
    create trigger trg_cuentas_por_cobrar_updated_at
    before update on cuentas_por_cobrar
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_cxc_movimientos_updated_at') then
    create trigger trg_cxc_movimientos_updated_at
    before update on cuentas_por_cobrar_movimientos
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_cuentas_por_pagar_updated_at') then
    create trigger trg_cuentas_por_pagar_updated_at
    before update on cuentas_por_pagar
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_cxp_movimientos_updated_at') then
    create trigger trg_cxp_movimientos_updated_at
    before update on cuentas_por_pagar_movimientos
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_notas_formales_updated_at') then
    create trigger trg_notas_formales_updated_at
    before update on notas_formales
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_cierres_periodo_updated_at') then
    create trigger trg_cierres_periodo_updated_at
    before update on cierres_periodo
    for each row execute function app.set_updated_at();
  end if;
end;
$$;
