-- 015_orden_servicio_codigo_publico.sql
-- Agrega un codigo publico aleatorio a cada orden de servicio para usarlo
-- como URL publica que el cliente puede consultar sin autenticarse.
-- El codigo es opaco (no es el id) para evitar enumeracion.

alter table ordenes_servicio
  add column if not exists codigo_publico varchar(40);

create unique index if not exists uq_ordenes_servicio_codigo_publico
  on ordenes_servicio (codigo_publico)
  where codigo_publico is not null;

-- Generar codigos para registros existentes que no lo tengan
update ordenes_servicio
set codigo_publico = encode(gen_random_bytes(16), 'hex')
where codigo_publico is null;
