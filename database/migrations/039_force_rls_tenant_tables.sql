-- 039_force_rls_tenant_tables.sql
-- =========================================================================
-- Fase 0: certificacion RLS.
--
-- ENABLE RLS no protege al owner de la tabla; si el rol de aplicacion llega a
-- ser owner, las policies pueden no aplicar. FORCE ROW LEVEL SECURITY obliga
-- a que incluso el owner pase por las policies.
-- =========================================================================

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'empresas',
    'sucursales',
    'empresas_modulos',
    'usuarios',
    'usuarios_roles',
    'usuarios_sucursales',
    'clientes',
    'proveedores',
    'productos',
    'stock_sucursal',
    'movimientos_inventario',
    'comprobante_series',
    'caja_sesiones',
    'caja_movimientos',
    'compras',
    'compra_detalles',
    'ventas',
    'venta_detalles',
    'servicios_catalogo',
    'ordenes_servicio',
    'ordenes_servicio_productos',
    'refresh_tokens',
    'servicios_tipos_vehiculo',
    'tipos_cambio',
    'comisiones_reglas',
    'comisiones_ordenes',
    'notificaciones_canales',
    'notificaciones_eventos',
    'fe_transmisiones',
    'promociones',
    'promociones_uso',
    'fidelidad_config',
    'fidelidad_movimientos',
    'webhooks_endpoints',
    'webhooks_eventos',
    'tickets',
    'tickets_mensajes',
    'integraciones_marketplace',
    'dashboards',
    'tenant_dominios',
    'bodegas',
    'empresa_uso_actual',
    'archivos',
    'usuarios_mfa'
  ]
  loop
    if to_regclass(format('public.%I', tenant_table)) is not null then
      execute format('alter table %I enable row level security', tenant_table);
      execute format('alter table %I force row level security', tenant_table);
    end if;
  end loop;
end $$;

-- Reinstalar la policy base de sucursales de forma explicita; es la tabla que
-- certifica el test de INSERT cross-tenant de Fase 0.
drop policy if exists sucursales_tenant_policy on sucursales;
create policy sucursales_tenant_policy on sucursales
  using (app.is_super_admin() or id_empresa = app.current_empresa_id())
  with check (app.is_super_admin() or id_empresa = app.current_empresa_id());
