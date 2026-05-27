-- 030_nota_credito_fe.sql
-- Snapshot de certificacion fiscal en venta_reversiones para soportar
-- NOTA_CREDITO formal con DTE certificado por SAT/regulador.

alter table venta_reversiones
  add column if not exists fe_uuid varchar(80),
  add column if not exists fe_serie_dte varchar(20),
  add column if not exists fe_numero_dte varchar(40),
  add column if not exists fe_estado varchar(20)
    check (fe_estado in ('PENDIENTE', 'CERTIFICADO', 'RECHAZADO', 'ANULADO', null)),
  add column if not exists fe_fecha_certificacion timestamptz,
  add column if not exists fe_xml text,
  add column if not exists fe_url_pdf text;

create index if not exists idx_venta_reversiones_fe_estado
  on venta_reversiones (id_empresa, fe_estado)
  where fe_estado is not null;
