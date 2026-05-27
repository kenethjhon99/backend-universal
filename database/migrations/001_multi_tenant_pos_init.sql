create extension if not exists pgcrypto;
create schema if not exists app;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function app.current_empresa_id()
returns bigint
language sql
stable
as $$
  select nullif(current_setting('app.current_empresa_id', true), '')::bigint;
$$;

create or replace function app.current_rol()
returns text
language sql
stable
as $$
  select upper(nullif(current_setting('app.current_rol', true), ''));
$$;

create or replace function app.is_super_admin()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_rol() = 'SUPER_ADMIN', false);
$$;

create table if not exists empresas (
  id_empresa bigserial primary key,
  public_id uuid not null default gen_random_uuid(),
  slug varchar(80) not null unique,
  nombre_legal varchar(150) not null,
  nombre_comercial varchar(150),
  nit varchar(30),
  email varchar(150),
  telefono varchar(30),
  timezone varchar(50) not null default 'America/Guatemala',
  estado varchar(20) not null default 'ACTIVA',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (public_id),
  unique (nit)
);

create table if not exists sucursales (
  id_sucursal bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  codigo varchar(30) not null,
  nombre varchar(120) not null,
  direccion text,
  telefono varchar(30),
  es_principal boolean not null default false,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_sucursal),
  unique (id_empresa, codigo)
);

create table if not exists modulos (
  id_modulo bigserial primary key,
  codigo varchar(30) not null unique,
  nombre varchar(80) not null,
  descripcion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists empresas_modulos (
  id_empresa_modulo bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_modulo bigint not null references modulos(id_modulo),
  activo boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_modulo)
);

create table if not exists roles (
  id_rol bigserial primary key,
  codigo varchar(40) not null unique,
  nombre varchar(80) not null,
  descripcion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists usuarios (
  id_usuario bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  username varchar(60) not null,
  email varchar(150),
  password_hash text not null,
  nombre varchar(80) not null,
  apellido varchar(80) not null,
  id_sucursal_default bigint,
  activo boolean not null default true,
  ultimo_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_usuario),
  unique (id_empresa, username),
  unique (id_empresa, email),
  foreign key (id_empresa, id_sucursal_default) references sucursales(id_empresa, id_sucursal)
);

create table if not exists usuarios_roles (
  id_usuario_rol bigserial primary key,
  id_empresa bigint not null,
  id_usuario bigint not null,
  id_rol bigint not null references roles(id_rol),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_usuario, id_rol),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists usuarios_sucursales (
  id_usuario_sucursal bigserial primary key,
  id_empresa bigint not null,
  id_usuario bigint not null,
  id_sucursal bigint not null,
  es_predeterminada boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_usuario, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal)
);

create table if not exists clientes (
  id_cliente bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  codigo varchar(30),
  nombre varchar(150) not null,
  nit varchar(30),
  dui varchar(30),
  telefono varchar(30),
  email varchar(150),
  direccion text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_cliente),
  unique (id_empresa, codigo),
  unique (id_empresa, nit)
);

create table if not exists proveedores (
  id_proveedor bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  codigo varchar(30),
  nombre varchar(150) not null,
  nit varchar(30),
  telefono varchar(30),
  email varchar(150),
  direccion text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_proveedor),
  unique (id_empresa, codigo),
  unique (id_empresa, nit)
);

create table if not exists productos (
  id_producto bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  sku varchar(50) not null,
  codigo_barras varchar(50),
  nombre varchar(150) not null,
  descripcion text,
  precio_compra numeric(14,2) not null default 0,
  precio_venta numeric(14,2) not null default 0,
  tipo_producto varchar(20) not null default 'PRODUCTO',
  modulo_origen varchar(30) not null default 'POS',
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_producto),
  unique (id_empresa, sku),
  unique (id_empresa, codigo_barras)
);

create table if not exists stock_sucursal (
  id_stock bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_producto bigint not null,
  stock_actual numeric(14,3) not null default 0,
  stock_minimo numeric(14,3) not null default 0,
  stock_maximo numeric(14,3),
  ubicacion varchar(120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_sucursal, id_producto),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto)
);

create table if not exists movimientos_inventario (
  id_movimiento bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_producto bigint not null,
  id_usuario bigint not null,
  tipo varchar(30) not null,
  referencia_tipo varchar(30) not null,
  referencia_id bigint,
  cantidad numeric(14,3) not null,
  stock_antes numeric(14,3) not null,
  stock_despues numeric(14,3) not null,
  observacion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists comprobante_series (
  id_comprobante_serie bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_sucursal bigint not null,
  modulo varchar(30) not null,
  tipo_comprobante varchar(30) not null,
  nombre varchar(80) not null,
  serie varchar(20) not null,
  ultimo_correlativo bigint not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  unique (id_empresa, id_sucursal, modulo, tipo_comprobante, serie)
);

create table if not exists caja_sesiones (
  id_caja_sesion bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_usuario bigint not null,
  estado varchar(20) not null default 'ABIERTA',
  monto_apertura numeric(14,2) not null default 0,
  monto_cierre numeric(14,2),
  diferencia numeric(14,2),
  fecha_apertura timestamptz not null default now(),
  fecha_cierre timestamptz,
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_caja_sesion),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists caja_movimientos (
  id_caja_movimiento bigserial primary key,
  id_empresa bigint not null,
  id_caja_sesion bigint not null references caja_sesiones(id_caja_sesion),
  id_sucursal bigint not null,
  id_usuario bigint not null,
  tipo varchar(20) not null,
  categoria varchar(50),
  monto numeric(14,2) not null,
  descripcion text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists compras (
  id_compra bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_proveedor bigint not null,
  id_usuario bigint not null,
  numero_documento varchar(50),
  tipo_documento varchar(30) not null default 'FACTURA',
  estado varchar(20) not null default 'CONFIRMADA',
  subtotal numeric(14,2) not null default 0,
  descuento numeric(14,2) not null default 0,
  impuesto numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  fecha_compra timestamptz not null default now(),
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_compra),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_proveedor) references proveedores(id_empresa, id_proveedor),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists compra_detalles (
  id_compra_detalle bigserial primary key,
  id_empresa bigint not null,
  id_compra bigint not null,
  id_producto bigint not null,
  cantidad numeric(14,3) not null,
  costo_unitario numeric(14,2) not null,
  subtotal numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_compra) references compras(id_empresa, id_compra),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto)
);

create table if not exists ventas (
  id_venta bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_usuario bigint not null,
  id_cliente bigint,
  id_caja_sesion bigint references caja_sesiones(id_caja_sesion),
  numero_comprobante varchar(50) not null,
  tipo_comprobante varchar(30) not null default 'TICKET',
  tipo_venta varchar(20) not null default 'CONTADO',
  metodo_pago varchar(20) not null default 'EFECTIVO',
  estado varchar(20) not null default 'CONFIRMADA',
  subtotal numeric(14,2) not null default 0,
  descuento numeric(14,2) not null default 0,
  impuesto numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  monto_recibido numeric(14,2),
  cambio numeric(14,2) not null default 0,
  observaciones text,
  fecha_venta timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_venta),
  unique (id_empresa, numero_comprobante),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario),
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente)
);

create table if not exists venta_detalles (
  id_venta_detalle bigserial primary key,
  id_empresa bigint not null,
  id_venta bigint not null,
  id_producto bigint not null,
  cantidad numeric(14,3) not null,
  precio_unitario numeric(14,2) not null,
  descuento numeric(14,2) not null default 0,
  subtotal numeric(14,2) not null,
  costo_unitario numeric(14,2) not null default 0,
  utilidad numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_venta) references ventas(id_empresa, id_venta),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto)
);

create table if not exists servicios_catalogo (
  id_servicio_catalogo bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  modulo varchar(30) not null default 'CARWASH',
  codigo varchar(30) not null,
  nombre varchar(120) not null,
  descripcion text,
  precio_base numeric(14,2) not null default 0,
  duracion_minutos integer,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_servicio_catalogo),
  unique (id_empresa, codigo)
);

create table if not exists ordenes_servicio (
  id_orden_servicio bigserial primary key,
  id_empresa bigint not null,
  id_sucursal bigint not null,
  id_servicio_catalogo bigint not null,
  id_cliente bigint,
  id_usuario bigint not null,
  id_caja_sesion bigint references caja_sesiones(id_caja_sesion),
  placa varchar(30),
  vehiculo_tipo varchar(30),
  color varchar(40),
  estado varchar(20) not null default 'RECIBIDO',
  metodo_pago varchar(20),
  subtotal numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  observaciones text,
  fecha_servicio timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_sucursal) references sucursales(id_empresa, id_sucursal),
  foreign key (id_empresa, id_servicio_catalogo) references servicios_catalogo(id_empresa, id_servicio_catalogo),
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente),
  foreign key (id_empresa, id_usuario) references usuarios(id_empresa, id_usuario)
);

create table if not exists ordenes_servicio_productos (
  id_orden_servicio_producto bigserial primary key,
  id_empresa bigint not null,
  id_orden_servicio bigint not null,
  id_producto bigint not null,
  cantidad numeric(14,3) not null,
  costo_unitario numeric(14,2) not null default 0,
  precio_unitario numeric(14,2) not null default 0,
  subtotal numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto)
);

create table if not exists auditoria_eventos (
  id_auditoria bigserial primary key,
  id_empresa bigint,
  id_sucursal bigint,
  id_usuario bigint,
  modulo varchar(40) not null,
  entidad varchar(60) not null,
  entidad_id bigint not null,
  accion varchar(30) not null,
  datos_antes jsonb,
  datos_despues jsonb,
  ip varchar(64),
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sucursales_empresa on sucursales(id_empresa);
create index if not exists idx_usuarios_empresa on usuarios(id_empresa);
create index if not exists idx_clientes_empresa on clientes(id_empresa);
create index if not exists idx_proveedores_empresa on proveedores(id_empresa);
create index if not exists idx_productos_empresa on productos(id_empresa);
create index if not exists idx_stock_sucursal_scope on stock_sucursal(id_empresa, id_sucursal, id_producto);
create index if not exists idx_movimientos_scope on movimientos_inventario(id_empresa, id_sucursal, created_at desc);
create index if not exists idx_ventas_scope on ventas(id_empresa, id_sucursal, fecha_venta desc);
create index if not exists idx_compras_scope on compras(id_empresa, id_sucursal, fecha_compra desc);
create index if not exists idx_ordenes_servicio_scope on ordenes_servicio(id_empresa, id_sucursal, fecha_servicio desc);

create trigger trg_empresas_updated_at before update on empresas for each row execute function app.set_updated_at();
create trigger trg_sucursales_updated_at before update on sucursales for each row execute function app.set_updated_at();
create trigger trg_modulos_updated_at before update on modulos for each row execute function app.set_updated_at();
create trigger trg_empresas_modulos_updated_at before update on empresas_modulos for each row execute function app.set_updated_at();
create trigger trg_roles_updated_at before update on roles for each row execute function app.set_updated_at();
create trigger trg_usuarios_updated_at before update on usuarios for each row execute function app.set_updated_at();
create trigger trg_usuarios_roles_updated_at before update on usuarios_roles for each row execute function app.set_updated_at();
create trigger trg_usuarios_sucursales_updated_at before update on usuarios_sucursales for each row execute function app.set_updated_at();
create trigger trg_clientes_updated_at before update on clientes for each row execute function app.set_updated_at();
create trigger trg_proveedores_updated_at before update on proveedores for each row execute function app.set_updated_at();
create trigger trg_productos_updated_at before update on productos for each row execute function app.set_updated_at();
create trigger trg_stock_sucursal_updated_at before update on stock_sucursal for each row execute function app.set_updated_at();
create trigger trg_movimientos_inventario_updated_at before update on movimientos_inventario for each row execute function app.set_updated_at();
create trigger trg_comprobante_series_updated_at before update on comprobante_series for each row execute function app.set_updated_at();
create trigger trg_caja_sesiones_updated_at before update on caja_sesiones for each row execute function app.set_updated_at();
create trigger trg_caja_movimientos_updated_at before update on caja_movimientos for each row execute function app.set_updated_at();
create trigger trg_compras_updated_at before update on compras for each row execute function app.set_updated_at();
create trigger trg_compra_detalles_updated_at before update on compra_detalles for each row execute function app.set_updated_at();
create trigger trg_ventas_updated_at before update on ventas for each row execute function app.set_updated_at();
create trigger trg_venta_detalles_updated_at before update on venta_detalles for each row execute function app.set_updated_at();
create trigger trg_servicios_catalogo_updated_at before update on servicios_catalogo for each row execute function app.set_updated_at();
create trigger trg_ordenes_servicio_updated_at before update on ordenes_servicio for each row execute function app.set_updated_at();
create trigger trg_ordenes_servicio_productos_updated_at before update on ordenes_servicio_productos for each row execute function app.set_updated_at();

insert into roles (codigo, nombre, descripcion)
values
  ('SUPER_ADMIN', 'Super administrador', 'Control total de la plataforma y soporte'),
  ('ADMIN_EMPRESA', 'Administrador de empresa', 'Administra la empresa y todas sus sucursales'),
  ('ENCARGADO_SUCURSAL', 'Encargado de sucursal', 'Opera y administra una o varias sucursales'),
  ('CAJERO', 'Cajero', 'Registra ventas y opera caja en su sucursal')
on conflict (codigo) do nothing;

insert into modulos (codigo, nombre, descripcion)
values
  ('POS', 'Punto de venta', 'Ventas, caja y comprobantes'),
  ('INVENTARIO', 'Inventario', 'Stock, movimientos y existencias'),
  ('COMPRAS', 'Compras', 'Registro de compras y proveedores'),
  ('REPORTES', 'Reportes', 'Reporteria operativa y gerencial'),
  ('SERVICIOS', 'Servicios', 'Ordenes de servicio, agenda y operacion tecnica'),
  ('CARWASH', 'Carwash', 'Servicios de autolavado y atencion vehicular')
on conflict (codigo) do nothing;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'sucursales',
    'empresas_modulos',
    'usuarios',
    'usuarios_roles',
    'usuarios_sucursales',
    'clientes',
    'proveedores',
    'productos',
    'stock_sucursal',
    'movimientos_inventario',
    'comprobante_series',
    'caja_sesiones',
    'caja_movimientos',
    'compras',
    'compra_detalles',
    'ventas',
    'venta_detalles',
    'servicios_catalogo',
    'ordenes_servicio',
    'ordenes_servicio_productos'
  ]
  loop
    execute format('alter table %I enable row level security', tenant_table);
    execute format('drop policy if exists %I on %I', tenant_table || '_tenant_policy', tenant_table);
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      tenant_table || '_tenant_policy',
      tenant_table
    );
  end loop;
end $$;
