-- 035_empresa_uso_y_planes.sql
-- =========================================================================
-- Enforcement de planes SaaS:
--   1) Tabla empresa_uso_actual con contadores en vivo (sucursales, usuarios,
--      bodegas, ventas/mes). Mantenida via triggers.
--   2) Funcion app.modulos_efectivos(empresa) — fuente unica de verdad de
--      que modulos tiene activa una empresa (union de plan.modulos_incluidos
--      + empresas_modulos overrides).
--   3) Funcion app.empresa_puede_crear(empresa, recurso) — devuelve bool
--      considerando limites del plan vs uso actual.
-- =========================================================================

-- ---- 1) Tabla de uso actual ----
create table if not exists empresa_uso_actual (
  id_empresa bigint primary key references empresas(id_empresa) on delete cascade,
  sucursales_count integer not null default 0,
  usuarios_count integer not null default 0,
  bodegas_count integer not null default 0,
  ventas_mes_count integer not null default 0,
  ventas_mes_periodo date not null default date_trunc('month', current_date)::date,
  storage_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_empresa_uso_actual_periodo
  on empresa_uso_actual (ventas_mes_periodo desc);

-- RLS: misma policy que el resto (super_admin ve todo, empresa ve la suya)
alter table empresa_uso_actual enable row level security;
drop policy if exists empresa_uso_actual_tenant on empresa_uso_actual;
create policy empresa_uso_actual_tenant on empresa_uso_actual
  for all
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());

-- Trigger updated_at
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_empresa_uso_updated_at') then
    create trigger trg_empresa_uso_updated_at
      before update on empresa_uso_actual
      for each row execute function app.set_updated_at();
  end if;
end $$;

-- ---- 2) Helper: asegurar row para una empresa ----
create or replace function app.ensure_uso_row(p_empresa bigint)
returns void language plpgsql as $$
begin
  insert into empresa_uso_actual (id_empresa)
  values (p_empresa)
  on conflict (id_empresa) do nothing;
end;
$$;

-- ---- 3) Trigger sobre sucursales ----
create or replace function app.trg_sucursales_uso()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform app.ensure_uso_row(new.id_empresa);
    if coalesce(new.activa, true) then
      update empresa_uso_actual
        set sucursales_count = sucursales_count + 1
        where id_empresa = new.id_empresa;
    end if;
  elsif tg_op = 'DELETE' then
    if coalesce(old.activa, true) then
      update empresa_uso_actual
        set sucursales_count = greatest(0, sucursales_count - 1)
        where id_empresa = old.id_empresa;
    end if;
  elsif tg_op = 'UPDATE' then
    -- toggling activa: ajustar
    if coalesce(old.activa, true) and not coalesce(new.activa, true) then
      update empresa_uso_actual
        set sucursales_count = greatest(0, sucursales_count - 1)
        where id_empresa = old.id_empresa;
    elsif not coalesce(old.activa, true) and coalesce(new.activa, true) then
      perform app.ensure_uso_row(new.id_empresa);
      update empresa_uso_actual
        set sucursales_count = sucursales_count + 1
        where id_empresa = new.id_empresa;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sucursales_uso on sucursales;
create trigger trg_sucursales_uso
  after insert or update or delete on sucursales
  for each row execute function app.trg_sucursales_uso();

-- ---- 4) Trigger sobre usuarios ----
create or replace function app.trg_usuarios_uso()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform app.ensure_uso_row(new.id_empresa);
    if coalesce(new.activo, true) then
      update empresa_uso_actual
        set usuarios_count = usuarios_count + 1
        where id_empresa = new.id_empresa;
    end if;
  elsif tg_op = 'DELETE' then
    if coalesce(old.activo, true) then
      update empresa_uso_actual
        set usuarios_count = greatest(0, usuarios_count - 1)
        where id_empresa = old.id_empresa;
    end if;
  elsif tg_op = 'UPDATE' then
    if coalesce(old.activo, true) and not coalesce(new.activo, true) then
      update empresa_uso_actual
        set usuarios_count = greatest(0, usuarios_count - 1)
        where id_empresa = old.id_empresa;
    elsif not coalesce(old.activo, true) and coalesce(new.activo, true) then
      perform app.ensure_uso_row(new.id_empresa);
      update empresa_uso_actual
        set usuarios_count = usuarios_count + 1
        where id_empresa = new.id_empresa;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_usuarios_uso on usuarios;
create trigger trg_usuarios_uso
  after insert or update or delete on usuarios
  for each row execute function app.trg_usuarios_uso();

-- ---- 5) Trigger sobre bodegas (si la tabla existe — migracion 032) ----
do $$
begin
  if exists (select 1 from pg_tables where tablename = 'bodegas') then
    execute $FN$
      create or replace function app.trg_bodegas_uso()
      returns trigger language plpgsql as $TR$
      begin
        if tg_op = 'INSERT' then
          perform app.ensure_uso_row(new.id_empresa);
          update empresa_uso_actual
            set bodegas_count = bodegas_count + 1
            where id_empresa = new.id_empresa;
        elsif tg_op = 'DELETE' then
          update empresa_uso_actual
            set bodegas_count = greatest(0, bodegas_count - 1)
            where id_empresa = old.id_empresa;
        end if;
        return null;
      end;
      $TR$;
    $FN$;

    execute 'drop trigger if exists trg_bodegas_uso on bodegas';
    execute 'create trigger trg_bodegas_uso
      after insert or delete on bodegas
      for each row execute function app.trg_bodegas_uso()';
  end if;
end $$;

-- ---- 6) Trigger sobre ventas con reset automatico mensual ----
do $$
begin
  if exists (select 1 from pg_tables where tablename = 'ventas') then
    execute $FN$
      create or replace function app.trg_ventas_uso()
      returns trigger language plpgsql as $TR$
      declare
        v_mes_actual date := date_trunc('month', current_date)::date;
      begin
        if tg_op = 'INSERT' then
          perform app.ensure_uso_row(new.id_empresa);
          update empresa_uso_actual
            set ventas_mes_count = case
                  when ventas_mes_periodo = v_mes_actual then ventas_mes_count + 1
                  else 1
                end,
                ventas_mes_periodo = v_mes_actual
            where id_empresa = new.id_empresa;
        end if;
        return null;
      end;
      $TR$;
    $FN$;

    execute 'drop trigger if exists trg_ventas_uso on ventas';
    execute 'create trigger trg_ventas_uso
      after insert on ventas
      for each row execute function app.trg_ventas_uso()';
  end if;
end $$;

-- ---- 7) Backfill: contar lo que ya existe ----
insert into empresa_uso_actual (id_empresa)
  select id_empresa from empresas
  on conflict (id_empresa) do nothing;

update empresa_uso_actual u
  set sucursales_count = coalesce(s.c, 0)
  from (
    select id_empresa, count(*)::int as c
    from sucursales where activa = true
    group by id_empresa
  ) s
  where u.id_empresa = s.id_empresa;

update empresa_uso_actual u
  set usuarios_count = coalesce(s.c, 0)
  from (
    select id_empresa, count(*)::int as c
    from usuarios where activo = true
    group by id_empresa
  ) s
  where u.id_empresa = s.id_empresa;

do $$
begin
  if exists (select 1 from pg_tables where tablename = 'bodegas') then
    execute $SQL$
      update empresa_uso_actual u
        set bodegas_count = coalesce(b.c, 0)
        from (
          select id_empresa, count(*)::int as c from bodegas group by id_empresa
        ) b
        where u.id_empresa = b.id_empresa
    $SQL$;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_tables where tablename = 'ventas') then
    execute $SQL$
      update empresa_uso_actual u
        set ventas_mes_count = coalesce(v.c, 0),
            ventas_mes_periodo = date_trunc('month', current_date)::date
        from (
          select id_empresa, count(*)::int as c
          from ventas
          where created_at >= date_trunc('month', current_date)
          group by id_empresa
        ) v
        where u.id_empresa = v.id_empresa
    $SQL$;
  end if;
end $$;

-- ---- 8) Funcion: modulos efectivos por empresa ----
-- Union de:
--   a) saas_planes.modulos_incluidos (jsonb array)
--   b) empresas_modulos overrides activos
create or replace function app.modulos_efectivos(p_empresa bigint)
returns text[]
language sql
stable
as $$
  with plan_modules as (
    select jsonb_array_elements_text(coalesce(p.modulos_incluidos, '[]'::jsonb)) as codigo
    from empresas e
    left join saas_planes p on p.codigo = e.saas_plan_codigo
    where e.id_empresa = p_empresa
  ),
  override_modules as (
    select m.codigo
    from empresas_modulos em
    inner join modulos m on m.id_modulo = em.id_modulo
    where em.id_empresa = p_empresa and em.activo = true
  )
  select array(
    select distinct codigo from plan_modules where codigo is not null and codigo <> ''
    union
    select codigo from override_modules
  );
$$;

grant execute on function app.modulos_efectivos(bigint) to public;

-- ---- 9) Funcion: empresa_puede_crear(empresa, recurso) ----
-- Devuelve true si el plan permite crear un recurso mas (sucursal/usuario/bodega/venta).
-- recurso: 'sucursal' | 'usuario' | 'bodega' | 'venta'
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
    -- empresa sin plan asignado: permitir (caso bootstrap)
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
      -- si el periodo cacheado no es el mes actual, contamos 0
      if v_uso.ventas_mes_periodo is null
         or v_uso.ventas_mes_periodo <> date_trunc('month', current_date)::date then
        v_cur := 0;
      end if;
    when 'bodega' then
      v_max := null; -- no hay limite por plan hoy; siempre permite
      v_cur := coalesce(v_uso.bodegas_count, 0);
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
