alter table ventas
  add column if not exists monto_revertido numeric(14,2) not null default 0,
  add column if not exists estado_reversion varchar(20) not null default 'SIN_REVERSION',
  add column if not exists fecha_ultima_reversion timestamptz;

alter table compras
  add column if not exists monto_revertido numeric(14,2) not null default 0,
  add column if not exists estado_reversion varchar(20) not null default 'SIN_REVERSION',
  add column if not exists fecha_ultima_reversion timestamptz;

create table if not exists venta_reversiones (
  id_venta_reversion bigserial primary key,
  id_empresa bigint not null,
  id_venta bigint not null,
  id_sucursal bigint not null,
  id_usuario bigint not null,
  tipo_reversion varchar(20) not null,
  numero_documento varchar(50) not null,
  metodo_resolucion varchar(20) not null default 'AJUSTE',
  motivo text not null,
  reintegrar_stock boolean not null default true,
  total numeric(14,2) not null default 0,
  id_caja_sesion bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_venta) references ventas(id_empresa, id_venta),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_caja_sesion) references caja_sesiones(id_caja_sesion),
  unique (id_empresa, numero_documento)
);

create table if not exists venta_reversion_detalles (
  id_venta_reversion_detalle bigserial primary key,
  id_empresa bigint not null,
  id_venta_reversion bigint not null,
  id_venta_detalle bigint not null,
  id_producto bigint not null,
  cantidad numeric(14,3) not null,
  precio_unitario numeric(14,2) not null,
  costo_unitario numeric(14,2) not null default 0,
  subtotal numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_venta_reversion) references venta_reversiones(id_venta_reversion),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto),
  foreign key (id_venta_detalle) references venta_detalles(id_venta_detalle)
);

create table if not exists compra_reversiones (
  id_compra_reversion bigserial primary key,
  id_empresa bigint not null,
  id_compra bigint not null,
  id_sucursal bigint not null,
  id_usuario bigint not null,
  tipo_reversion varchar(20) not null default 'DEVOLUCION_PROVEEDOR',
  numero_documento varchar(50) not null,
  motivo text not null,
  total numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_compra) references compras(id_empresa, id_compra),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  unique (id_empresa, numero_documento)
);

create table if not exists compra_reversion_detalles (
  id_compra_reversion_detalle bigserial primary key,
  id_empresa bigint not null,
  id_compra_reversion bigint not null,
  id_compra_detalle bigint not null,
  id_producto bigint not null,
  cantidad numeric(14,3) not null,
  costo_unitario numeric(14,2) not null,
  subtotal numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_compra_reversion) references compra_reversiones(id_compra_reversion),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto),
  foreign key (id_compra_detalle) references compra_detalles(id_compra_detalle)
);

create table if not exists compra_ajustes_costo (
  id_compra_ajuste_costo bigserial primary key,
  id_empresa bigint not null,
  id_compra bigint not null,
  id_compra_detalle bigint not null,
  id_sucursal bigint not null,
  id_producto bigint not null,
  id_usuario bigint not null,
  costo_unitario_anterior numeric(14,2) not null,
  costo_unitario_nuevo numeric(14,2) not null,
  diferencia_total numeric(14,2) not null default 0,
  motivo text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_compra) references compras(id_empresa, id_compra),
  foreign key (id_compra_detalle) references compra_detalles(id_compra_detalle),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_ventas_reversion_estado
  on ventas (id_empresa, id_sucursal, estado_reversion, fecha_venta desc);

create index if not exists idx_compras_reversion_estado
  on compras (id_empresa, id_sucursal, estado_reversion, fecha_compra desc);

create index if not exists idx_venta_reversiones_empresa_venta
  on venta_reversiones (id_empresa, id_venta, created_at desc);

create index if not exists idx_venta_reversion_detalles_empresa_detalle
  on venta_reversion_detalles (id_empresa, id_venta_detalle);

create index if not exists idx_compra_reversiones_empresa_compra
  on compra_reversiones (id_empresa, id_compra, created_at desc);

create index if not exists idx_compra_reversion_detalles_empresa_detalle
  on compra_reversion_detalles (id_empresa, id_compra_detalle);

create index if not exists idx_compra_ajustes_costo_empresa_compra
  on compra_ajustes_costo (id_empresa, id_compra, created_at desc);

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'venta_reversiones',
    'venta_reversion_detalles',
    'compra_reversiones',
    'compra_reversion_detalles',
    'compra_ajustes_costo'
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
  if not exists (select 1 from pg_trigger where tgname = 'trg_venta_reversiones_updated_at') then
    create trigger trg_venta_reversiones_updated_at
    before update on venta_reversiones
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_venta_reversion_detalles_updated_at') then
    create trigger trg_venta_reversion_detalles_updated_at
    before update on venta_reversion_detalles
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_compra_reversiones_updated_at') then
    create trigger trg_compra_reversiones_updated_at
    before update on compra_reversiones
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_compra_reversion_detalles_updated_at') then
    create trigger trg_compra_reversion_detalles_updated_at
    before update on compra_reversion_detalles
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_compra_ajustes_costo_updated_at') then
    create trigger trg_compra_ajustes_costo_updated_at
    before update on compra_ajustes_costo
    for each row execute function app.set_updated_at();
  end if;
end;
$$;
