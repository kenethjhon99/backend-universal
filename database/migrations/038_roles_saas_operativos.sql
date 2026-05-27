-- 038_roles_saas_operativos.sql
-- =========================================================================
-- Consolida la matriz base de roles SaaS/operacion sin romper datos
-- existentes. SUPER_ADMIN se conserva por compatibilidad; SUPER_ADMIN_SAAS
-- queda como alias explicito del plano de control.
-- =========================================================================

create or replace function app.is_super_admin()
returns boolean
language sql
stable
as $$
  select coalesce(app.current_rol() in ('SUPER_ADMIN', 'SUPER_ADMIN_SAAS'), false);
$$;

insert into roles (codigo, nombre, descripcion)
values
  ('SUPER_ADMIN_SAAS', 'SuperAdmin SaaS', 'Administra plataforma, empresas, planes, modulos, billing y soporte; no opera tenants'),
  ('GERENTE', 'Gerente', 'Supervisa sucursales, personal, reportes y autorizaciones operativas'),
  ('BODEGUERO', 'Bodeguero', 'Gestiona stock, entradas, salidas, ajustes y traslados autorizados'),
  ('COMPRAS', 'Compras', 'Gestiona proveedores, compras y recepciones'),
  ('OPERADOR_CARWASH', 'Operador CarWash', 'Crea ordenes, actualiza estados y registra servicios realizados'),
  ('SUPERVISOR_CARWASH', 'Supervisor CarWash', 'Supervisa ordenes, productividad y autorizaciones de CarWash')
on conflict (codigo) do update
set
  nombre = excluded.nombre,
  descripcion = excluded.descripcion,
  updated_at = now();

update roles
set es_sistema = true,
    id_empresa = null
where codigo in (
  'SUPER_ADMIN',
  'SUPER_ADMIN_SAAS',
  'ADMIN_EMPRESA',
  'ENCARGADO_SUCURSAL',
  'GERENTE',
  'CAJERO',
  'BODEGUERO',
  'COMPRAS',
  'OPERADOR_CARWASH',
  'SUPERVISOR_CARWASH'
);
