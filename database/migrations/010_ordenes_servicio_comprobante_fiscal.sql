-- 010_ordenes_servicio_comprobante_fiscal.sql
-- Permite asociar a una orden de servicio un comprobante fiscal opcional
-- (TICKET / FACTURA / CCF) ademas del numero_orden interno (SRV-/CWA-).
-- Idempotente.

alter table ordenes_servicio
  add column if not exists tipo_comprobante_fiscal varchar(30);

alter table ordenes_servicio
  add column if not exists numero_comprobante_fiscal varchar(50);

alter table ordenes_servicio
  add column if not exists id_comprobante_serie_fiscal bigint
    references comprobante_series(id_comprobante_serie);

create unique index if not exists uq_ordenes_servicio_comprobante_fiscal
  on ordenes_servicio (id_empresa, numero_comprobante_fiscal)
  where numero_comprobante_fiscal is not null;

create index if not exists idx_ordenes_servicio_serie_fiscal
  on ordenes_servicio (id_comprobante_serie_fiscal)
  where id_comprobante_serie_fiscal is not null;
