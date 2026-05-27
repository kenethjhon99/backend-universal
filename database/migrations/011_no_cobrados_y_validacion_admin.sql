-- 011_no_cobrados_y_validacion_admin.sql
-- Habilita el flujo de "venta NO_COBRADO" (cliente se fue sin pagar con
-- autorizacion admin) y agrega campos de autorizacion administrativa a los
-- movimientos manuales de caja, para soportar validacion uno-por-uno antes
-- de cerrar caja.
-- Idempotente.

-- ----- Ventas: campos para NO_COBRADO -----
alter table ventas
  add column if not exists no_cobrado_motivo text;

alter table ventas
  add column if not exists no_cobrado_autorizado_por bigint;

alter table ventas
  add column if not exists no_cobrado_autorizado_en timestamptz;

alter table ventas
  add column if not exists no_cobrado_validado_por bigint;

alter table ventas
  add column if not exists no_cobrado_validado_en timestamptz;

alter table ventas
  add column if not exists no_cobrado_validacion_nota text;

create index if not exists idx_ventas_no_cobrado_pendientes
  on ventas (id_empresa, id_caja_sesion)
  where estado = 'NO_COBRADO' and no_cobrado_validado_en is null;

-- ----- Caja_movimientos: autorizacion admin para movimientos manuales -----
alter table caja_movimientos
  add column if not exists autorizado_por_admin_id bigint;

alter table caja_movimientos
  add column if not exists autorizado_por_admin_en timestamptz;

alter table caja_movimientos
  add column if not exists autorizacion_admin_nota text;

create index if not exists idx_caja_movimientos_pendientes_validacion
  on caja_movimientos (id_empresa, id_caja_sesion)
  where coalesce(referencia_tipo, 'MANUAL') = 'MANUAL'
    and autorizado_por_admin_id is null;
