-- 033_roles_custom_por_empresa.sql
-- Roles custom por empresa con permisos asignables a la carta.
--
-- Modelo:
--   * Los 4 roles globales (SUPER_ADMIN, ADMIN_EMPRESA, ENCARGADO_SUCURSAL,
--     CAJERO) siguen existiendo en `roles` con id_empresa = NULL. Son "del
--     SaaS" y no se pueden borrar / editar.
--   * Cada empresa puede crear sus propios roles con id_empresa = <id>. Estos
--     roles guardan `permisos` como un array jsonb de strings (codigos del
--     catálogo de permisos).
--   * Un usuario puede tener uno o más roles (mezcla de globales y custom).
--     Sus permisos efectivos = unión de todos.

-- Permitir id_empresa NULL para roles globales del SaaS
alter table roles
  add column if not exists id_empresa bigint references empresas(id_empresa),
  add column if not exists permisos jsonb,
  add column if not exists es_sistema boolean not null default false;

-- Cambiar el unique global a unique por (id_empresa, codigo) usando indices parciales
do $$
begin
  -- Drop el unique simple en codigo (si existe)
  if exists (select 1 from pg_constraint where conname = 'roles_codigo_key') then
    alter table roles drop constraint roles_codigo_key;
  end if;
end $$;

-- Unique para roles globales (id_empresa null): codigo
create unique index if not exists uq_roles_globales_codigo
  on roles (codigo) where id_empresa is null;

-- Unique para roles custom: (id_empresa, codigo)
create unique index if not exists uq_roles_custom_empresa_codigo
  on roles (id_empresa, codigo) where id_empresa is not null;

-- Marcar los 4 roles iniciales como es_sistema
update roles
set es_sistema = true, id_empresa = null
where codigo in ('SUPER_ADMIN', 'ADMIN_EMPRESA', 'ENCARGADO_SUCURSAL', 'CAJERO');

-- RLS: los globales son visibles para todos. Los custom solo para su empresa.
alter table roles enable row level security;
drop policy if exists roles_tenant_policy on roles;
create policy roles_tenant_policy on roles
  using (
    id_empresa is null
    or app.is_super_admin()
    or id_empresa = app.current_empresa_id()
  )
  with check (
    id_empresa is null and app.is_super_admin()
    or id_empresa = app.current_empresa_id()
  );

-- ============================================================
-- Catálogo de permisos (referencia: lista oficial de codigos válidos)
-- ============================================================
-- Esto es solo para que el frontend / admin sepa qué codigos puede asignar.
-- La lógica de validación real vive en JS (shared/security/permissions.js).
create table if not exists permisos_catalogo (
  codigo varchar(60) primary key,
  nombre varchar(120) not null,
  descripcion text,
  modulo varchar(40),
  riesgo varchar(20) check (riesgo in ('BAJO', 'MEDIO', 'ALTO', 'CRITICO')),
  created_at timestamptz not null default now()
);

-- Seed del catalogo (refleja permissions.js)
insert into permisos_catalogo (codigo, nombre, modulo, riesgo) values
  ('company.create', 'Crear empresa', 'EMPRESAS', 'CRITICO'),
  ('company.read', 'Ver empresa', 'EMPRESAS', 'BAJO'),
  ('company.modules.catalog.read', 'Ver catálogo de módulos', 'EMPRESAS', 'BAJO'),
  ('company.modules.read', 'Ver módulos activos', 'EMPRESAS', 'BAJO'),
  ('company.modules.update', 'Activar/desactivar módulos', 'EMPRESAS', 'ALTO'),
  ('branches.read', 'Ver sucursales', 'SUCURSALES', 'BAJO'),
  ('branches.create', 'Crear sucursal', 'SUCURSALES', 'ALTO'),
  ('users.read', 'Ver usuarios', 'USUARIOS', 'BAJO'),
  ('users.create', 'Crear usuarios', 'USUARIOS', 'ALTO'),
  ('users.update', 'Editar usuarios', 'USUARIOS', 'ALTO'),
  ('users.status', 'Activar/desactivar usuarios', 'USUARIOS', 'ALTO'),
  ('users.roles', 'Asignar roles a usuarios', 'USUARIOS', 'CRITICO'),
  ('audit.read', 'Ver auditoría', 'AUDITORIA', 'BAJO'),
  ('catalogs.read', 'Ver catálogos', 'CATALOGOS', 'BAJO'),
  ('catalogs.manage', 'Gestionar catálogos', 'CATALOGOS', 'MEDIO'),
  ('inventory.read', 'Ver inventario', 'INVENTARIO', 'BAJO'),
  ('inventory.manage', 'Gestionar inventario', 'INVENTARIO', 'MEDIO'),
  ('purchases.read', 'Ver compras', 'COMPRAS', 'BAJO'),
  ('purchases.manage', 'Gestionar compras', 'COMPRAS', 'MEDIO'),
  ('purchases.adjust', 'Ajustar costos de compra', 'COMPRAS', 'ALTO'),
  ('finance.read', 'Ver finanzas', 'FINANZAS', 'MEDIO'),
  ('finance.manage', 'Gestionar finanzas (CXC/CXP)', 'FINANZAS', 'ALTO'),
  ('finance.close', 'Cerrar periodo contable', 'FINANZAS', 'CRITICO'),
  ('reports.read', 'Ver reportes', 'REPORTES', 'BAJO'),
  ('services.read', 'Ver servicios', 'SERVICIOS', 'BAJO'),
  ('services.manage', 'Gestionar servicios', 'SERVICIOS', 'MEDIO'),
  ('services.refund', 'Reembolsar/anular órdenes', 'SERVICIOS', 'ALTO'),
  ('services.reports.read', 'Ver reportes de servicios', 'SERVICIOS', 'BAJO'),
  ('sales.read', 'Ver ventas', 'VENTAS', 'BAJO'),
  ('sales.manage', 'Crear ventas', 'VENTAS', 'MEDIO'),
  ('sales.refund', 'Anular/devolver ventas', 'VENTAS', 'ALTO'),
  ('cash.read', 'Ver caja', 'CAJA', 'BAJO'),
  ('cash.manage', 'Operar caja', 'CAJA', 'MEDIO'),
  ('comprobantes.read', 'Ver comprobantes', 'COMPROBANTES', 'BAJO'),
  ('comprobantes.manage', 'Gestionar series de comprobantes', 'COMPROBANTES', 'ALTO'),
  ('roles.manage', 'Crear/editar roles custom', 'USUARIOS', 'CRITICO')
on conflict (codigo) do nothing;
