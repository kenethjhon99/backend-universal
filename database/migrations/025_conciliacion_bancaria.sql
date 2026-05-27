-- 025_conciliacion_bancaria.sql
-- Conciliacion bancaria: importar movimientos del extracto del banco y
-- matchearlos con caja_movimientos (depositos), ventas (transferencias),
-- y compras (pagos a proveedor).
--
-- Modelo:
--   cuentas_bancarias    - cuentas registradas por empresa
--   banco_extractos      - cada importacion de un periodo
--   banco_movimientos    - cada linea del extracto (parseada)
--   conciliacion_matches - quien matchea con que (banco_movimiento <-> caja_movimiento u otra ref)

create table if not exists cuentas_bancarias (
  id_cuenta bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  banco varchar(80) not null,
  numero_cuenta varchar(50) not null,
  alias varchar(80),
  moneda varchar(3) references monedas(codigo),
  saldo_inicial numeric(14,2) not null default 0,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, numero_cuenta)
);

-- Unique compuesto requerido por FK de tablas hijas (debe existir antes).
create unique index if not exists uq_cuentas_bancarias_empresa_id
  on cuentas_bancarias (id_empresa, id_cuenta);

create table if not exists banco_extractos (
  id_extracto bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_cuenta bigint not null,
  periodo_desde date not null,
  periodo_hasta date not null,
  archivo_origen varchar(200),
  total_movimientos integer not null default 0,
  saldo_apertura numeric(14,2),
  saldo_cierre numeric(14,2),
  estado varchar(20) not null default 'IMPORTADO'
    check (estado in ('IMPORTADO', 'EN_CONCILIACION', 'CONCILIADO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_cuenta) references cuentas_bancarias(id_empresa, id_cuenta)
);

-- Unique compuesto requerido por FK de banco_movimientos.
create unique index if not exists uq_banco_extractos_empresa_id
  on banco_extractos (id_empresa, id_extracto);

create table if not exists banco_movimientos (
  id_mov bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_extracto bigint not null,
  fecha date not null,
  descripcion text,
  referencia varchar(80),
  tipo varchar(10) not null check (tipo in ('CREDITO', 'DEBITO')),
  monto numeric(14,2) not null check (monto >= 0),
  conciliado boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (id_empresa, id_extracto) references banco_extractos(id_empresa, id_extracto)
);

create index if not exists idx_banco_movimientos_no_conciliados
  on banco_movimientos (id_empresa, id_extracto, fecha)
  where conciliado = false;

-- Unique compuesto requerido por FK de conciliacion_matches.
create unique index if not exists uq_banco_movimientos_empresa_id
  on banco_movimientos (id_empresa, id_mov);

create table if not exists conciliacion_matches (
  id_match bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_banco_mov bigint not null,
  -- una entre las siguientes:
  id_caja_movimiento bigint,
  id_venta bigint,
  id_compra bigint,
  monto_match numeric(14,2) not null,
  manual boolean not null default false,
  notas text,
  created_at timestamptz not null default now(),
  created_by bigint,
  foreign key (id_empresa, id_banco_mov) references banco_movimientos(id_empresa, id_mov)
);

create index if not exists idx_conciliacion_matches_caja
  on conciliacion_matches (id_empresa, id_caja_movimiento)
  where id_caja_movimiento is not null;

-- Triggers
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_cuentas_bancarias_updated_at') then
    create trigger trg_cuentas_bancarias_updated_at
    before update on cuentas_bancarias
    for each row execute function app.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_banco_extractos_updated_at') then
    create trigger trg_banco_extractos_updated_at
    before update on banco_extractos
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS
do $$
declare t text;
begin
  foreach t in array array['cuentas_bancarias','banco_extractos','banco_movimientos','conciliacion_matches']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_policy', t);
    execute format(
      'create policy %I on %I using (app.is_super_admin() or id_empresa = app.current_empresa_id()) with check (app.is_super_admin() or id_empresa = app.current_empresa_id())',
      t || '_tenant_policy', t
    );
  end loop;
end $$;
