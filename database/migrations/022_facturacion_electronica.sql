-- 022_facturacion_electronica.sql
-- Soporte de facturacion electronica fiscal (FEL en Guatemala, DGII en RD,
-- SAT en MX, etc.). Diseñado como adaptador: cada empresa elige su provider
-- y el sistema mantiene un campo de UUID/folio fiscal y status de la
-- transmision al ente regulador.

-- Configuracion de FE por empresa
alter table empresas
  add column if not exists fe_proveedor varchar(40),     -- 'FEL_GT', 'DGII_DO', 'SAT_MX', 'INFILE_GT', etc.
  add column if not exists fe_config jsonb default '{}'::jsonb,
  add column if not exists fe_activa boolean not null default false;

-- Snapshot del estado fiscal en la venta
alter table ventas
  add column if not exists fe_uuid varchar(80),          -- UUID/Authorization del SAT/FEL
  add column if not exists fe_serie_dte varchar(20),     -- serie del DTE
  add column if not exists fe_numero_dte varchar(40),    -- numero del DTE
  add column if not exists fe_estado varchar(20)         -- 'PENDIENTE', 'CERTIFICADO', 'RECHAZADO', 'ANULADO'
    check (fe_estado in ('PENDIENTE', 'CERTIFICADO', 'RECHAZADO', 'ANULADO', null)),
  add column if not exists fe_fecha_certificacion timestamptz,
  add column if not exists fe_xml text,                  -- XML firmado guardado para auditoria
  add column if not exists fe_url_pdf text;

create index if not exists idx_ventas_fe_estado
  on ventas (id_empresa, fe_estado)
  where fe_estado is not null;

-- Log de transacciones con el provider externo
create table if not exists fe_transmisiones (
  id_transmision bigserial primary key,
  id_empresa bigint not null references empresas(id_empresa),
  id_venta bigint not null,
  proveedor varchar(40) not null,
  intento integer not null default 1,
  request_payload jsonb,
  response_payload jsonb,
  http_status integer,
  resultado varchar(20) check (resultado in ('OK', 'ERROR', 'TIMEOUT')),
  duracion_ms integer,
  created_at timestamptz not null default now(),
  foreign key (id_empresa, id_venta) references ventas(id_empresa, id_venta)
);

create index if not exists idx_fe_transmisiones_venta
  on fe_transmisiones (id_empresa, id_venta, created_at desc);

-- RLS
alter table fe_transmisiones enable row level security;
drop policy if exists fe_transmisiones_tenant_policy on fe_transmisiones;
create policy fe_transmisiones_tenant_policy on fe_transmisiones
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
