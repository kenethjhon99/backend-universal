-- 034_saas_app_role.sql
-- =========================================================================
-- Cierra el agujero RLS: crea un rol Postgres dedicado para la aplicacion
-- que NO tiene BYPASSRLS. Hoy las queries corren como `postgres` (superuser),
-- lo cual hace que RLS este "activado" pero no proteja en runtime.
--
-- Plan de migracion (progresivo, opt-in):
--   1. Esta migracion crea el rol `saas_app` y le da los grants minimos.
--   2. La app sigue corriendo con `postgres` por default (sin cambios).
--   3. El middleware `withTenantDb` (en src-saas/middlewares/with-tenant-db.js)
--      envuelve requests en BEGIN/COMMIT + set_config('app.current_empresa_id').
--   4. Cuando todos los modulos usen `req.db` en vez de `pool`, se cambia
--      el PGUSER a `saas_app` en el .env de produccion → RLS empieza a
--      protegerse fisicamente.
-- =========================================================================

-- ---- 1) Crear rol si no existe ----
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'saas_app') then
    -- LOGIN: puede conectar. Password se setea con ALTER ROLE en deploy.
    -- NOBYPASSRLS: NO bypassa las policies RLS. Critico.
    create role saas_app
      with login
      password 'change-me-in-deploy'
      nobypassrls
      noinherit
      noreplication
      nosuperuser
      nocreatedb
      nocreaterole;
  end if;
end $$;

-- ---- 2) Grants minimos sobre el schema public ----
grant usage on schema public to saas_app;
grant usage on schema app to saas_app;

-- CRUD sobre todas las tablas existentes
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format(
      'grant select, insert, update, delete on %I.%I to saas_app',
      r.schemaname, r.tablename
    );
  end loop;
end $$;

-- Sequences (para los bigserial)
grant usage, select, update on all sequences in schema public to saas_app;

-- Funciones del schema app (current_empresa_id, set_updated_at, etc.)
grant execute on all functions in schema app to saas_app;
grant execute on all functions in schema public to saas_app;

-- ---- 3) Default privileges: aplicar a tablas/sequences FUTURAS ----
-- Asi cuando se crean tablas nuevas en migraciones siguientes, saas_app las
-- hereda automaticamente sin manualmente regrantear.
alter default privileges in schema public
  grant select, insert, update, delete on tables to saas_app;
alter default privileges in schema public
  grant usage, select, update on sequences to saas_app;
alter default privileges in schema public
  grant execute on functions to saas_app;
alter default privileges in schema app
  grant execute on functions to saas_app;

-- ---- 4) Confirmar que NO bypassa RLS ----
-- Sanity check: si alguien marca BYPASSRLS por accidente, esto lo revierte.
alter role saas_app nobypassrls;

-- ---- 5) Tablas que necesitan acceso PRE-AUTH ----
-- Algunas tablas se consultan ANTES de que `app.current_empresa_id` este
-- seteado (login, refresh, tenant resolution por host). Para estas, agregamos
-- policies permisivas en operaciones de lectura cuando current_empresa_id IS
-- NULL, manteniendo la policy normal cuando ya hay sesion.
--
-- Si una policy permisiva no aplica, el flujo de login debe usar funciones
-- SECURITY DEFINER (como app.resolve_tenant_by_host ya hace).

-- empresas: lectura necesaria para resolver slug en login antes de saber id_empresa
drop policy if exists empresas_login_lookup on empresas;
create policy empresas_login_lookup on empresas
  for select
  using (
    -- Pre-auth: si no hay current_empresa_id, permitir solo SELECT (no escritura)
    current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  );

-- usuarios: lectura pre-auth necesaria para validar credenciales en login
drop policy if exists usuarios_login_lookup on usuarios;
create policy usuarios_login_lookup on usuarios
  for select
  using (
    current_setting('app.current_empresa_id', true) is null
    or nullif(current_setting('app.current_empresa_id', true), '') is null
    or id_empresa = app.current_empresa_id()
    or app.is_super_admin()
  );

-- refresh_tokens: el lookup por hash sucede antes de saber id_empresa
do $$
begin
  if exists (select 1 from pg_tables where tablename = 'refresh_tokens') then
    execute 'alter table refresh_tokens enable row level security';
    execute 'drop policy if exists refresh_tokens_lookup on refresh_tokens';
    execute $POL$
      create policy refresh_tokens_lookup on refresh_tokens
        for all
        using (
          current_setting('app.current_empresa_id', true) is null
          or nullif(current_setting('app.current_empresa_id', true), '') is null
          or id_empresa = app.current_empresa_id()
          or app.is_super_admin()
        )
        with check (
          current_setting('app.current_empresa_id', true) is null
          or nullif(current_setting('app.current_empresa_id', true), '') is null
          or id_empresa = app.current_empresa_id()
          or app.is_super_admin()
        )
    $POL$;
  end if;
end $$;

-- ---- 6) Vista informativa para debug ----
create or replace view app.rls_diagnostico as
  select
    current_user as conexion_usuario,
    nullif(current_setting('app.current_empresa_id', true), '')::bigint as current_empresa_id,
    nullif(current_setting('app.current_sucursal_id', true), '')::bigint as current_sucursal_id,
    upper(nullif(current_setting('app.current_rol', true), '')) as current_rol,
    app.is_super_admin() as es_super_admin,
    (select count(*) from pg_roles where rolname = current_user and rolbypassrls) > 0 as bypassa_rls;

grant select on app.rls_diagnostico to saas_app;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant select on app.rls_diagnostico to postgres;
  end if;
end $$;

-- =========================================================================
-- Verificacion manual (correr despues de migrar):
--   set role saas_app;
--   select * from app.rls_diagnostico;
--      -> bypassa_rls debe ser false
--   select * from ventas;  -- debe devolver 0 filas (no hay session set)
--   select set_config('app.current_empresa_id', '1', false);
--   select * from ventas;  -- ahora si devuelve filas de empresa 1
--   reset role;
-- =========================================================================
