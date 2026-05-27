-- 017_comisiones_tecnicos.sql
-- Comisiones para tecnicos en ordenes de servicio.
-- Modelo:
--   * comisiones_reglas (por empresa): define como se calcula la comision
--       - tipo PORCENTAJE -> % del monto de la orden
--       - tipo FIJO -> monto fijo por orden
--       - opcionalmente filtrado por modulo (CARWASH/SERVICIOS) y por tecnico
--   * comisiones_orden_servicio: snapshot por orden cuando se cobra,
--       calculado segun la regla aplicable. Persistente para reportes.

create table if not exists comisiones_reglas (
  id_regla bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_usuario_tecnico bigint,                -- null = aplica a todos los tecnicos
  modulo varchar(30),                       -- null = aplica a CARWASH y SERVICIOS
  tipo varchar(20) not null check (tipo in ('PORCENTAJE', 'FIJO')),
  valor numeric(14,4) not null check (valor >= 0),
  base_calculo varchar(20) not null default 'TOTAL'
    check (base_calculo in ('TOTAL', 'PRECIO_SERVICIO')),
  prioridad integer not null default 100,   -- menor numero = mas especifica
  activa boolean not null default true,
  vigente_desde date,
  vigente_hasta date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  foreign key (id_empresa, id_usuario_tecnico) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_comisiones_reglas_empresa_activas
  on comisiones_reglas (id_empresa, activa, prioridad)
  where activa = true;

create table if not exists comisiones_ordenes (
  id_comision bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_orden_servicio bigint not null,
  id_usuario_tecnico bigint not null,
  id_regla bigint references comisiones_reglas(id_regla),
  monto_base numeric(14,2) not null,
  porcentaje_aplicado numeric(8,4),
  monto_comision numeric(14,2) not null,
  estado varchar(20) not null default 'GENERADA'
    check (estado in ('GENERADA', 'PAGADA', 'ANULADA')),
  pagada_en timestamptz,
  pagada_por bigint,
  fecha_generacion timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint,
  unique (id_empresa, id_orden_servicio, id_usuario_tecnico),
  foreign key (id_empresa, id_orden_servicio) references ordenes_servicio(id_empresa, id_orden_servicio),
  foreign key (id_empresa, id_usuario_tecnico) references usuarios(id_empresa, id_usuario)
);

create index if not exists idx_comisiones_ordenes_tecnico_estado
  on comisiones_ordenes (id_empresa, id_usuario_tecnico, estado, fecha_generacion desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_comisiones_reglas_updated_at') then
    create trigger trg_comisiones_reglas_updated_at
    before update on comisiones_reglas
    for each row execute function app.set_updated_at();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'trg_comisiones_ordenes_updated_at') then
    create trigger trg_comisiones_ordenes_updated_at
    before update on comisiones_ordenes
    for each row execute function app.set_updated_at();
  end if;
end $$;

-- RLS por tenant
alter table comisiones_reglas enable row level security;
drop policy if exists comisiones_reglas_tenant_policy on comisiones_reglas;
create policy comisiones_reglas_tenant_policy on comisiones_reglas
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

alter table comisiones_ordenes enable row level security;
drop policy if exists comisiones_ordenes_tenant_policy on comisiones_ordenes;
create policy comisiones_ordenes_tenant_policy on comisiones_ordenes
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
