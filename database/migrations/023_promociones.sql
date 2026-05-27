-- 023_promociones.sql
-- Sistema de promociones y descuentos.
--
-- Tipos soportados:
--   PORCENTAJE_VENTA  - % off al subtotal de la venta completa
--   MONTO_VENTA       - monto fijo off al total
--   PORCENTAJE_LINEA  - % off por linea (de productos especificos)
--   NX_M              - "lleva N, paga M" (ej. 3x2)
--   CUPON             - codigo aplicado por el cajero (cualquiera de los anteriores)
--
-- Filtros:
--   - vigencia (fecha desde/hasta)
--   - dias de la semana / horarios
--   - productos especificos (whitelist) o categorias (no implementado, futuro)
--   - clientes especificos o grupos (cliente_grupo, futuro)
--   - monto minimo de venta
--   - canal (POS, ONLINE, etc.) — futuro
--
-- Aplicacion:
--   En createVenta se llama a `resolveActivePromotions(items, cliente?)` y
--   devuelve un breakdown de descuentos. El total final ya viene rebajado.
--   Cada uso queda registrado en promociones_uso para reportes/limites.

create table if not exists promociones (
  id_promocion bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  codigo varchar(40),                         -- codigo de cupon (null = automatica)
  nombre varchar(120) not null,
  descripcion text,
  tipo varchar(30) not null check (tipo in (
    'PORCENTAJE_VENTA', 'MONTO_VENTA', 'PORCENTAJE_LINEA', 'NX_M', 'CUPON'
  )),
  -- Para PORCENTAJE_*: 0..100. Para MONTO_VENTA: monto. Para NX_M: usar nx_n y nx_m.
  valor numeric(14,4) not null default 0,
  nx_n integer,
  nx_m integer,
  -- Productos elegibles (null = todos). Array de id_producto.
  productos_elegibles jsonb,
  -- Filtros
  monto_minimo numeric(14,2) not null default 0,
  vigente_desde timestamptz,
  vigente_hasta timestamptz,
  dias_semana jsonb,                         -- ej. [1,2,3,4,5] (lun-vie)
  horario_desde time,
  horario_hasta time,
  -- Limites
  usos_max_total integer,                     -- null = ilimitado
  usos_max_por_cliente integer,
  prioridad integer not null default 100,
  combinable boolean not null default false,  -- si false, no puede combinarse con otras
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, codigo)
);

create index if not exists idx_promociones_empresa_activas
  on promociones (id_empresa, activa, prioridad)
  where activa = true;

-- Unique compuesto requerido por el FK de promociones_uso (debe existir
-- ANTES de la CREATE TABLE que lo referencia).
create unique index if not exists uq_promociones_empresa_id
  on promociones (id_empresa, id_promocion);

create table if not exists promociones_uso (
  id_uso bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_promocion bigint not null,
  id_venta bigint not null,
  id_cliente bigint,
  monto_descontado numeric(14,2) not null,
  detalle jsonb,                              -- breakdown del descuento aplicado
  created_at timestamptz not null default now(),
  foreign key (id_empresa, id_promocion) references promociones(id_empresa, id_promocion)
);

create index if not exists idx_promociones_uso_empresa_promo
  on promociones_uso (id_empresa, id_promocion, created_at desc);

create index if not exists idx_promociones_uso_cliente
  on promociones_uso (id_empresa, id_cliente, id_promocion)
  where id_cliente is not null;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_promociones_updated_at') then
    create trigger trg_promociones_updated_at
    before update on promociones
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table promociones enable row level security;
drop policy if exists promociones_tenant_policy on promociones;
create policy promociones_tenant_policy on promociones
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table promociones_uso enable row level security;
drop policy if exists promociones_uso_tenant_policy on promociones_uso;
create policy promociones_uso_tenant_policy on promociones_uso
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Columnas en ventas para snapshot del descuento aplicado
alter table ventas
  add column if not exists descuento_promocional numeric(14,2) not null default 0,
  add column if not exists promociones_aplicadas jsonb;
