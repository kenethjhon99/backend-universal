-- 041_saas_commercial_limits.sql
-- Fase 4: completa limites comerciales SaaS para planes, uso y enforcement.

alter table saas_planes
  add column if not exists max_productos integer,
  add column if not exists max_cajas integer,
  add column if not exists max_bodegas integer,
  add column if not exists max_storage_mb integer,
  add column if not exists max_api_requests_mes integer,
  add column if not exists permite_addons boolean not null default true,
  add column if not exists requiere_contacto boolean not null default false;

alter table empresa_uso_actual
  add column if not exists productos_count integer not null default 0,
  add column if not exists cajas_count integer not null default 0,
  add column if not exists api_requests_mes_count integer not null default 0,
  add column if not exists api_requests_mes_periodo date not null default date_trunc('month', current_date)::date;

update saas_planes
set
  max_productos = coalesce(max_productos, case codigo
    when 'FREE' then 50
    when 'STARTER' then 500
    when 'PRO' then 5000
    else null
  end),
  max_cajas = coalesce(max_cajas, case codigo
    when 'FREE' then 1
    when 'STARTER' then 1
    when 'PRO' then 5
    else null
  end),
  max_bodegas = coalesce(max_bodegas, case codigo
    when 'FREE' then 1
    when 'STARTER' then 2
    when 'PRO' then 10
    else null
  end),
  max_storage_mb = coalesce(max_storage_mb, case codigo
    when 'FREE' then 250
    when 'STARTER' then 1024
    when 'PRO' then 10240
    else null
  end),
  max_api_requests_mes = coalesce(max_api_requests_mes, case codigo
    when 'FREE' then 0
    when 'STARTER' then 10000
    when 'PRO' then 100000
    else null
  end)
where codigo in ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

insert into saas_planes (
  codigo, nombre, descripcion, precio_mensual, precio_anual, moneda,
  trial_dias, max_sucursales, max_usuarios, max_ventas_mes,
  max_productos, max_cajas, max_bodegas, max_storage_mb, max_api_requests_mes,
  modulos_incluidos, orden, requiere_contacto
)
values (
  'WHITE_LABEL',
  'White Label',
  'Marca propia, dominio personalizado y configuracion premium.',
  499.00,
  4990.00,
  'USD',
  30,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  '["POS", "INVENTARIO", "COMPRAS", "REPORTES", "SERVICIOS", "CARWASH", "FINANZAS"]'::jsonb,
  5,
  true
)
on conflict (codigo) do nothing;

create or replace function app.trg_productos_uso()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform app.ensure_uso_row(new.id_empresa);
    if coalesce(new.activo, true) then
      update empresa_uso_actual
        set productos_count = productos_count + 1
        where id_empresa = new.id_empresa;
    end if;
  elsif tg_op = 'DELETE' then
    if coalesce(old.activo, true) then
      update empresa_uso_actual
        set productos_count = greatest(0, productos_count - 1)
        where id_empresa = old.id_empresa;
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(old.activo, true) and not coalesce(new.activo, true) then
      update empresa_uso_actual
        set productos_count = greatest(0, productos_count - 1)
        where id_empresa = old.id_empresa;
    elsif not coalesce(old.activo, true) and coalesce(new.activo, true) then
      perform app.ensure_uso_row(new.id_empresa);
      update empresa_uso_actual
        set productos_count = productos_count + 1
        where id_empresa = new.id_empresa;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_productos_uso on productos;
create trigger trg_productos_uso
  after insert or update or delete on productos
  for each row execute function app.trg_productos_uso();

create or replace function app.trg_cajas_uso()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform app.ensure_uso_row(new.id_empresa);
    update empresa_uso_actual
      set cajas_count = cajas_count + 1
      where id_empresa = new.id_empresa;
  elsif tg_op = 'DELETE' then
    update empresa_uso_actual
      set cajas_count = greatest(0, cajas_count - 1)
      where id_empresa = old.id_empresa;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_cajas_uso on caja_sesiones;
create trigger trg_cajas_uso
  after insert or delete on caja_sesiones
  for each row execute function app.trg_cajas_uso();

update empresa_uso_actual u
  set productos_count = coalesce(p.c, 0)
  from (
    select id_empresa, count(*)::int as c
    from productos
    where activo = true
    group by id_empresa
  ) p
  where p.id_empresa = u.id_empresa;

update empresa_uso_actual u
  set cajas_count = coalesce(c.c, 0)
  from (
    select id_empresa, count(*)::int as c
    from caja_sesiones
    group by id_empresa
  ) c
  where c.id_empresa = u.id_empresa;

create or replace function app.empresa_puede_crear(p_empresa bigint, p_recurso text)
returns table(permitido boolean, current_count integer, max_count integer, plan_codigo text)
language plpgsql
stable
as $$
declare
  v_plan record;
  v_uso record;
  v_max integer;
  v_cur integer;
begin
  select p.* into v_plan
  from empresas e
  left join saas_planes p on p.codigo = e.saas_plan_codigo
  where e.id_empresa = p_empresa;

  select * into v_uso from empresa_uso_actual where id_empresa = p_empresa;

  if v_plan is null then
    return query select true, 0, null::integer, null::text;
    return;
  end if;

  case lower(p_recurso)
    when 'sucursal' then
      v_max := v_plan.max_sucursales;
      v_cur := coalesce(v_uso.sucursales_count, 0);
    when 'usuario' then
      v_max := v_plan.max_usuarios;
      v_cur := coalesce(v_uso.usuarios_count, 0);
    when 'venta' then
      v_max := v_plan.max_ventas_mes;
      v_cur := coalesce(v_uso.ventas_mes_count, 0);
      if v_uso.ventas_mes_periodo is null
         or v_uso.ventas_mes_periodo <> date_trunc('month', current_date)::date then
        v_cur := 0;
      end if;
    when 'producto' then
      v_max := v_plan.max_productos;
      v_cur := coalesce(v_uso.productos_count, 0);
    when 'caja' then
      v_max := v_plan.max_cajas;
      v_cur := coalesce(v_uso.cajas_count, 0);
    when 'bodega' then
      v_max := v_plan.max_bodegas;
      v_cur := coalesce(v_uso.bodegas_count, 0);
    when 'storage_mb' then
      v_max := v_plan.max_storage_mb;
      v_cur := ceil(coalesce(v_uso.storage_bytes, 0)::numeric / 1048576)::integer;
    when 'api_request' then
      v_max := v_plan.max_api_requests_mes;
      v_cur := coalesce(v_uso.api_requests_mes_count, 0);
      if v_uso.api_requests_mes_periodo is null
         or v_uso.api_requests_mes_periodo <> date_trunc('month', current_date)::date then
        v_cur := 0;
      end if;
    else
      v_max := null;
      v_cur := 0;
  end case;

  return query select
    (v_max is null or v_cur < v_max) as permitido,
    v_cur as current_count,
    v_max as max_count,
    v_plan.codigo as plan_codigo;
end;
$$;

grant execute on function app.empresa_puede_crear(bigint, text) to public;
