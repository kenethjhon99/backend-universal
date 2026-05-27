-- 024_fidelidad.sql
-- Programa de puntos por compra. Modelo:
--   * fidelidad_config: una fila por empresa con la regla de puntos.
--   * fidelidad_movimientos: ledger inmutable de cada acumulacion / canje.
--   * El saldo de cada cliente se calcula como SUM(puntos) por id_cliente.
--   * Canje en venta: descuenta puntos a cambio de un monto fijo.

create table if not exists fidelidad_config (
  id_empresa bigint primary key references empresas(id_empresa),
  activo boolean not null default true,
  puntos_por_unidad numeric(8,4) not null default 1,        -- ej. 1 punto por cada Q1 gastado
  unidad_monetaria numeric(14,2) not null default 1,        -- "1 quetzal" como unidad
  redencion_monto numeric(14,2) not null default 0.10,      -- valor monetario de cada punto al canjear
  redencion_min_puntos integer not null default 100,        -- minimo a canjear
  vigencia_dias integer,                                    -- null = no vencen
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint
);

create table if not exists fidelidad_movimientos (
  id_movimiento bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_cliente bigint not null,
  tipo varchar(20) not null check (tipo in ('GANADO', 'CANJEADO', 'AJUSTE', 'EXPIRADO')),
  puntos integer not null,                                  -- positivo o negativo (canjeado/expirado son negativos)
  id_venta bigint,
  motivo text,
  vigente_hasta date,
  created_at timestamptz not null default now(),
  created_by bigint,
  foreign key (id_empresa, id_cliente) references clientes(id_empresa, id_cliente)
);

create index if not exists idx_fidelidad_movimientos_cliente
  on fidelidad_movimientos (id_empresa, id_cliente, created_at desc);

create index if not exists idx_fidelidad_movimientos_vigencia
  on fidelidad_movimientos (id_empresa, vigente_hasta)
  where tipo = 'GANADO' and vigente_hasta is not null;

-- Triggers
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_fidelidad_config_updated_at') then
    create trigger trg_fidelidad_config_updated_at
    before update on fidelidad_config
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
alter table fidelidad_config enable row level security;
drop policy if exists fidelidad_config_tenant_policy on fidelidad_config;
create policy fidelidad_config_tenant_policy on fidelidad_config
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table fidelidad_movimientos enable row level security;
drop policy if exists fidelidad_movimientos_tenant_policy on fidelidad_movimientos;
create policy fidelidad_movimientos_tenant_policy on fidelidad_movimientos
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Vista materializada de saldo por cliente
create or replace view fidelidad_saldos as
  select
    m.id_empresa,
    m.id_cliente,
    sum(m.puntos)::int as saldo,
    sum(m.puntos) filter (where m.tipo = 'GANADO')::int as ganados_total,
    sum(-m.puntos) filter (where m.tipo = 'CANJEADO')::int as canjeados_total,
    max(m.created_at) as ultimo_movimiento
  from fidelidad_movimientos m
  group by m.id_empresa, m.id_cliente;
