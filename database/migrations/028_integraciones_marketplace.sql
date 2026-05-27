-- 028_integraciones_marketplace.sql
-- Integraciones con marketplaces externos (Shopify, WooCommerce, Tienda Nube...).
-- Permite sync de stock y opcionalmente catalogo de productos en ambas direcciones.

create table if not exists marketplace_integraciones (
  id_integracion bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  proveedor varchar(40) not null check (proveedor in ('SHOPIFY', 'WOOCOMMERCE', 'TIENDANUBE', 'MERCADOLIBRE')),
  nombre varchar(120) not null,
  config jsonb not null default '{}'::jsonb,             -- credenciales, store_url, api_version
  -- Una sucursal por integracion: de ahi sale el stock que se publica
  id_sucursal_origen bigint,
  modo_sync varchar(20) not null default 'STOCK'
    check (modo_sync in ('STOCK', 'STOCK_PRECIOS', 'CATALOGO_COMPLETO')),
  activa boolean not null default true,
  ultima_sync timestamptz,
  estado_ultima_sync varchar(20),
  notas_ultima_sync text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, proveedor, nombre),
  foreign key (id_empresa, id_sucursal_origen) references sucursales(id_empresa, id_sucursal)
);

create unique index if not exists uq_marketplace_integraciones_empresa_id
  on marketplace_integraciones (id_empresa, id_integracion);

-- Mapeo producto local <-> producto externo (necesario porque los IDs cambian)
create table if not exists marketplace_producto_mapping (
  id_mapping bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_integracion bigint not null,
  id_producto bigint not null,
  external_id varchar(120) not null,
  external_variant_id varchar(120),
  external_sku varchar(120),
  sync_habilitado boolean not null default true,
  ultima_sync timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id_empresa, id_integracion, external_id, external_variant_id),
  foreign key (id_empresa, id_integracion) references marketplace_integraciones(id_empresa, id_integracion),
  foreign key (id_empresa, id_producto) references productos(id_empresa, id_producto)
);

create index if not exists idx_marketplace_mapping_producto
  on marketplace_producto_mapping (id_empresa, id_producto);

-- Log de sincronizaciones
create table if not exists marketplace_sync_log (
  id_log bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_integracion bigint not null,
  direccion varchar(20) not null check (direccion in ('LOCAL_A_EXTERNO', 'EXTERNO_A_LOCAL')),
  tipo_recurso varchar(40) not null,                    -- stock, precio, producto, orden
  exito boolean not null default false,
  payload jsonb,
  resultado jsonb,
  error_msg text,
  duracion_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_marketplace_sync_log_integracion
  on marketplace_sync_log (id_empresa, id_integracion, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_marketplace_integraciones_updated_at') then
    create trigger trg_marketplace_integraciones_updated_at
    before update on marketplace_integraciones
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_marketplace_mapping_updated_at') then
    create trigger trg_marketplace_mapping_updated_at
    before update on marketplace_producto_mapping
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
do $$
declare t text;
begin
  foreach t in array array['marketplace_integraciones','marketplace_producto_mapping','marketplace_sync_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_policy', t);
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      t || '_tenant_policy', t
    );
  end loop;
end $$;
