-- 009_comprobantes_consolidacion.sql
-- Endurece la tabla comprobante_series y siembra series default
-- por (empresa, sucursal) para los modulos VENTA, VENTA_REVERSION,
-- SERVICIOS y CARWASH. Idempotente: se puede aplicar varias veces.

-- 1) CHECK constraints para invariantes en BD (no depender solo del codigo).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_comprobante_series_correlativo_no_negativo'
  ) then
    alter table comprobante_series
      add constraint chk_comprobante_series_correlativo_no_negativo
      check (ultimo_correlativo >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_comprobante_series_modulo_valido'
  ) then
    alter table comprobante_series
      add constraint chk_comprobante_series_modulo_valido
      check (modulo in (
        'VENTA',
        'VENTA_REVERSION',
        'COMPRA',
        'COMPRA_REVERSION',
        'SERVICIOS',
        'CARWASH'
      ));
  end if;
end $$;

-- 2) Indices utiles para listados y for-update por (empresa, sucursal, modulo, tipo).
create index if not exists idx_comprobante_series_empresa_sucursal_modulo
  on comprobante_series (id_empresa, id_sucursal, modulo, tipo_comprobante);

create index if not exists idx_comprobante_series_empresa_activo
  on comprobante_series (id_empresa, activo);

create index if not exists idx_comprobante_series_sucursal_activo
  on comprobante_series (id_empresa, id_sucursal, activo);

-- 3) Seed de series default por (empresa, sucursal) para empresas que ya
--    tienen sucursales creadas. ON CONFLICT DO NOTHING para no pisar series
--    personalizadas existentes.
insert into comprobante_series (
  id_empresa,
  id_sucursal,
  modulo,
  tipo_comprobante,
  nombre,
  serie,
  ultimo_correlativo,
  activo
)
select
  s.id_empresa,
  s.id_sucursal,
  data.modulo,
  data.tipo_comprobante,
  data.nombre,
  data.serie,
  0,
  true
from sucursales s
cross join (
  values
    -- VENTA
    ('VENTA',           'TICKET',          'Ticket POS',                'TKT'),
    ('VENTA',           'FACTURA',         'Factura',                   'FAC'),
    ('VENTA',           'CCF',             'Credito fiscal',            'CCF'),
    -- VENTA_REVERSION
    ('VENTA_REVERSION', 'DEVOLUCION',      'Devolucion de venta',       'DVV'),
    ('VENTA_REVERSION', 'NOTA_CREDITO',    'Nota de credito',           'NCV'),
    -- COMPRA
    ('COMPRA',          'FACTURA',         'Factura de compra',         'FCC'),
    -- COMPRA_REVERSION
    ('COMPRA_REVERSION','DEVOLUCION',      'Devolucion a proveedor',    'DVC'),
    ('COMPRA_REVERSION','NOTA_DEBITO',     'Nota de debito a proveedor','NDC'),
    -- SERVICIOS / CARWASH
    ('SERVICIOS',       'ORDEN_SERVICIO',  'Orden de servicio',         'SRV'),
    ('CARWASH',         'ORDEN_SERVICIO',  'Orden de carwash',          'CWA')
) as data(modulo, tipo_comprobante, nombre, serie)
on conflict (id_empresa, id_sucursal, modulo, tipo_comprobante, serie)
do nothing;
