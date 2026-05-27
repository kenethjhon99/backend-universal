// Schema minimo para tests de ventas y reversiones.
// Crea solo las tablas necesarias para validar la logica de createVenta y
// createVentaReversion sin requerir todo el dump del SaaS.
import bcrypt from "bcrypt";
import { getTestPool, getTestSchema } from "./test-schema.js";

export const setupSalesSchema = async () => {
  const pool = getTestPool();
  const schema = getTestSchema();

  if (!schema) {
    throw new Error("Llama setupTestSchema() antes de setupSalesSchema()");
  }

  await pool.query(`set search_path to ${schema}, public`);

  // Empresas y sucursales (tabla minima)
  await pool.query(`
    create table if not exists ${schema}.empresas (
      id_empresa bigserial primary key,
      slug varchar(80) not null unique,
      nombre_legal varchar(150) not null,
      timezone varchar(50) not null default 'America/Guatemala',
      moneda_base varchar(3) not null default 'GTQ'
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.sucursales (
      id_sucursal bigserial primary key,
      id_empresa bigint not null,
      codigo varchar(30) not null,
      nombre varchar(120) not null,
      es_principal boolean not null default false,
      activa boolean not null default true,
      unique (id_empresa, id_sucursal)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.bodegas (
      id_bodega bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      codigo varchar(30) not null,
      nombre varchar(120) not null,
      es_principal boolean not null default false,
      activa boolean not null default true,
      unique (id_empresa, id_bodega),
      unique (id_empresa, id_sucursal, codigo)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.usuarios (
      id_usuario bigserial primary key,
      id_empresa bigint not null,
      username varchar(60) not null,
      email varchar(150),
      password_hash text not null default '$2b$04$testhashplaceholdertesthashplacehol',
      nombre varchar(80) not null default 'Test',
      apellido varchar(80) not null default 'User',
      activo boolean not null default true,
      unique (id_empresa, id_usuario)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.usuarios_sucursales (
      id_usuario_sucursal bigserial primary key,
      id_empresa bigint not null,
      id_usuario bigint not null,
      id_sucursal bigint not null,
      unique (id_empresa, id_usuario, id_sucursal)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.roles (
      id_rol bigserial primary key,
      codigo varchar(40) not null unique,
      nombre varchar(80) not null
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.usuarios_roles (
      id_usuario_rol bigserial primary key,
      id_empresa bigint not null,
      id_usuario bigint not null,
      id_rol bigint not null,
      unique (id_empresa, id_usuario, id_rol)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.clientes (
      id_cliente bigserial primary key,
      id_empresa bigint not null,
      nombre varchar(150) not null,
      telefono varchar(40),
      activo boolean not null default true,
      unique (id_empresa, id_cliente)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.productos (
      id_producto bigserial primary key,
      id_empresa bigint not null,
      sku varchar(50) not null,
      codigo_barras varchar(80),
      nombre varchar(150) not null,
      precio_compra numeric(14,2) not null default 0,
      precio_venta numeric(14,2) not null default 0,
      activo boolean not null default true,
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_producto)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.stock_sucursal (
      id_stock bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_bodega bigint,
      id_producto bigint not null,
      stock_actual numeric(14,3) not null default 0,
      stock_minimo numeric(14,3) not null default 0,
      stock_maximo numeric(14,3),
      ubicacion varchar(120),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_sucursal, id_bodega, id_producto)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.movimientos_inventario (
      id_movimiento bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_bodega bigint,
      id_producto bigint not null,
      id_usuario bigint not null,
      tipo varchar(30) not null,
      referencia_tipo varchar(30) not null,
      referencia_id bigint,
      cantidad numeric(14,3) not null,
      stock_antes numeric(14,3) not null,
      stock_despues numeric(14,3) not null,
      observacion text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.caja_sesiones (
      id_caja_sesion bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_usuario bigint not null,
      estado varchar(20) not null default 'ABIERTA',
      fecha_apertura timestamptz not null default now(),
      fecha_cierre timestamptz,
      monto_apertura numeric(14,2) not null default 0,
      monto_cierre numeric(14,2),
      monto_cierre_reportado numeric(14,2),
      monto_cierre_calculado numeric(14,2),
      diferencia numeric(14,2),
      observaciones text,
      observaciones_cierre text,
      diferencia_validada_por bigint,
      diferencia_validada_en timestamptz,
      diferencia_validacion_nota text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.caja_movimientos (
      id_caja_movimiento bigserial primary key,
      id_empresa bigint not null,
      id_caja_sesion bigint not null,
      id_sucursal bigint not null,
      id_usuario bigint not null,
      tipo varchar(20) not null,
      categoria varchar(50),
      monto numeric(14,2) not null,
      descripcion text,
      referencia_tipo varchar(30),
      referencia_id bigint,
      autorizado_por_admin_id bigint,
      autorizado_por_admin_en timestamptz,
      autorizacion_admin_nota text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ventas (
      id_venta bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_usuario bigint not null,
      id_cliente bigint,
      id_caja_sesion bigint,
      numero_comprobante varchar(50),
      tipo_comprobante varchar(30),
      tipo_venta varchar(30) not null default 'CONTADO',
      metodo_pago varchar(30) not null default 'EFECTIVO',
      estado varchar(20) not null default 'CONFIRMADA',
      subtotal numeric(14,2) not null default 0,
      descuento numeric(14,2) not null default 0,
      impuesto numeric(14,2) not null default 0,
      total numeric(14,2) not null default 0,
      monto_recibido numeric(14,2),
      cambio numeric(14,2) not null default 0,
      dias_credito integer,
      fecha_vencimiento date,
      saldo_pendiente numeric(14,2) not null default 0,
      monto_revertido numeric(14,2) not null default 0,
      estado_reversion varchar(20) not null default 'SIN_REVERSION',
      fecha_ultima_reversion timestamptz,
      observaciones text,
      no_cobrado_motivo text,
      no_cobrado_autorizado_por bigint,
      no_cobrado_autorizado_en timestamptz,
      no_cobrado_validado_por bigint,
      no_cobrado_validado_en timestamptz,
      no_cobrado_validacion_nota text,
      moneda varchar(3) not null default 'GTQ',
      tasa_cambio numeric(18,8) not null default 1,
      fecha_venta timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.venta_detalles (
      id_venta_detalle bigserial primary key,
      id_empresa bigint not null,
      id_venta bigint not null,
      id_producto bigint not null,
      cantidad numeric(14,3) not null,
      precio_unitario numeric(14,2) not null,
      descuento numeric(14,2) not null default 0,
      subtotal numeric(14,2) not null,
      costo_unitario numeric(14,2) not null default 0,
      utilidad numeric(14,2) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.comprobante_series (
      id_comprobante_serie bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      modulo varchar(30) not null,
      tipo_comprobante varchar(30) not null,
      nombre varchar(80) not null,
      serie varchar(20) not null,
      ultimo_correlativo bigint not null default 0,
      activo boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_sucursal, modulo, tipo_comprobante, serie)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.proveedores (
      id_proveedor bigserial primary key,
      id_empresa bigint not null,
      nombre varchar(150) not null,
      activo boolean not null default true,
      unique (id_empresa, id_proveedor)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.compras (
      id_compra bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_proveedor bigint not null,
      id_usuario bigint not null,
      numero_documento varchar(50),
      tipo_documento varchar(30) not null default 'FACTURA',
      estado varchar(20) not null default 'CONFIRMADA',
      subtotal numeric(14,2) not null default 0,
      descuento numeric(14,2) not null default 0,
      impuesto numeric(14,2) not null default 0,
      total numeric(14,2) not null default 0,
      fecha_compra timestamptz not null default now(),
      condicion_pago varchar(30) not null default 'CONTADO',
      dias_credito integer,
      fecha_vencimiento date,
      saldo_pendiente numeric(14,2) not null default 0,
      monto_revertido numeric(14,2) not null default 0,
      estado_reversion varchar(20) not null default 'SIN_REVERSION',
      fecha_ultima_reversion timestamptz,
      observaciones text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_compra)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.compra_detalles (
      id_compra_detalle bigserial primary key,
      id_empresa bigint not null,
      id_compra bigint not null,
      id_producto bigint not null,
      cantidad numeric(14,3) not null,
      costo_unitario numeric(14,2) not null,
      subtotal numeric(14,2) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.compra_reversiones (
      id_compra_reversion bigserial primary key,
      id_empresa bigint not null,
      id_compra bigint not null,
      id_sucursal bigint not null,
      id_usuario bigint not null,
      tipo_reversion varchar(30) not null,
      numero_documento varchar(50) not null,
      motivo text,
      total numeric(14,2) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.compra_reversion_detalles (
      id_compra_reversion_detalle bigserial primary key,
      id_empresa bigint not null,
      id_compra_reversion bigint not null,
      id_compra_detalle bigint not null,
      id_producto bigint not null,
      cantidad numeric(14,3) not null,
      costo_unitario numeric(14,2) not null,
      subtotal numeric(14,2) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.compra_ajustes_costo (
      id_compra_ajuste_costo bigserial primary key,
      id_empresa bigint not null,
      id_compra bigint not null,
      id_compra_detalle bigint not null,
      id_sucursal bigint not null,
      id_producto bigint not null,
      id_usuario bigint not null,
      costo_unitario_anterior numeric(14,2) not null,
      costo_unitario_nuevo numeric(14,2) not null,
      diferencia_total numeric(14,2) not null default 0,
      motivo text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.venta_reversiones (
      id_venta_reversion bigserial primary key,
      id_empresa bigint not null,
      id_venta bigint not null,
      id_sucursal bigint not null,
      id_usuario bigint not null,
      id_caja_sesion bigint,
      tipo_reversion varchar(30) not null,
      numero_documento varchar(50) not null,
      metodo_resolucion varchar(30) not null,
      motivo text,
      reintegrar_stock boolean not null default true,
      total numeric(14,2) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.venta_reversion_detalles (
      id_venta_reversion_detalle bigserial primary key,
      id_empresa bigint not null,
      id_venta_reversion bigint not null,
      id_venta_detalle bigint not null,
      id_producto bigint not null,
      cantidad numeric(14,3) not null,
      precio_unitario numeric(14,2) not null,
      costo_unitario numeric(14,2) not null default 0,
      subtotal numeric(14,2) not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.servicios_catalogo (
      id_servicio_catalogo bigserial primary key,
      id_empresa bigint not null,
      modulo varchar(30) not null default 'CARWASH',
      codigo varchar(50) not null,
      nombre varchar(150) not null,
      descripcion text,
      precio_base numeric(14,2) not null default 0,
      duracion_minutos integer,
      activo boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_servicio_catalogo),
      unique (id_empresa, modulo, codigo)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ordenes_servicio (
      id_orden_servicio bigserial primary key,
      id_empresa bigint not null,
      id_sucursal bigint not null,
      id_servicio_catalogo bigint not null,
      id_cliente bigint,
      id_usuario bigint not null,
      id_usuario_asignado bigint,
      id_caja_sesion bigint,
      modulo varchar(30) not null default 'CARWASH',
      numero_orden varchar(50),
      codigo_publico varchar(80),
      placa varchar(30),
      vehiculo_tipo varchar(30),
      color varchar(40),
      marca varchar(80),
      modelo varchar(80),
      anio integer,
      kilometraje varchar(40),
      estado varchar(30) not null default 'RECIBIDO',
      estado_cobro varchar(30) not null default 'PENDIENTE',
      metodo_pago varchar(30),
      prioridad varchar(20) not null default 'NORMAL',
      agenda_estado varchar(30) not null default 'NO_PROGRAMADA',
      subtotal numeric(14,2) not null default 0,
      precio_servicio numeric(14,2) not null default 0,
      total numeric(14,2) not null default 0,
      reembolso_monto numeric(14,2) not null default 0,
      reembolso_metodo varchar(30),
      monto_recibido numeric(14,2),
      cambio numeric(14,2) not null default 0,
      nombre_contacto varchar(150),
      telefono_contacto varchar(40),
      observaciones text,
      fecha_servicio timestamptz not null default now(),
      fecha_programada_inicio timestamptz,
      fecha_programada_fin timestamptz,
      fecha_promesa timestamptz,
      fecha_inicio timestamptz,
      fecha_finalizacion timestamptz,
      fecha_entrega timestamptz,
      fecha_cobro timestamptz,
      fecha_reembolso timestamptz,
      cancelada_por bigint,
      cancelada_en timestamptz,
      cancelacion_motivo text,
      reembolsado_por bigint,
      reembolso_motivo text,
      reembolso_id_caja_sesion bigint,
      stock_reintegrado boolean not null default false,
      stock_reintegrado_en timestamptz,
      stock_reintegrado_por bigint,
      tipo_comprobante_fiscal varchar(30),
      numero_comprobante_fiscal varchar(50),
      id_comprobante_serie_fiscal bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_orden_servicio)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ordenes_servicio_productos (
      id_orden_servicio_producto bigserial primary key,
      id_empresa bigint not null,
      id_orden_servicio bigint not null,
      id_producto bigint not null,
      cantidad numeric(14,3) not null,
      costo_unitario numeric(14,2) not null default 0,
      precio_unitario numeric(14,2) not null default 0,
      subtotal numeric(14,2) not null default 0,
      cobra_al_cliente boolean not null default true,
      observacion text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.servicios_tecnicos (
      id_servicio_tecnico bigserial primary key,
      id_empresa bigint not null,
      id_usuario bigint not null,
      alias varchar(120),
      especialidades text[],
      color_agenda varchar(30),
      notas text,
      activo boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_usuario)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ordenes_servicio_tecnicos (
      id_orden_servicio_tecnico bigserial primary key,
      id_empresa bigint not null,
      id_orden_servicio bigint not null,
      id_usuario bigint not null,
      es_principal boolean not null default false,
      estado_asignacion varchar(30) not null default 'ASIGNADO',
      horas_estimadas numeric(8,2),
      horas_reales numeric(8,2),
      notas text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_orden_servicio, id_usuario)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.servicios_checklist_templates (
      id_servicio_checklist_template bigserial primary key,
      id_empresa bigint not null,
      id_servicio_catalogo bigint not null,
      titulo varchar(180) not null,
      instrucciones text,
      orden smallint not null default 1,
      obligatorio boolean not null default true,
      activo boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint,
      unique (id_empresa, id_servicio_checklist_template)
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ordenes_servicio_checklist (
      id_orden_servicio_checklist bigserial primary key,
      id_empresa bigint not null,
      id_orden_servicio bigint not null,
      id_servicio_checklist_template bigint,
      titulo varchar(180) not null,
      instrucciones text,
      orden smallint not null default 1,
      obligatorio boolean not null default true,
      estado varchar(30) not null default 'PENDIENTE',
      observacion text,
      completado_por bigint,
      completado_en timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);

  await pool.query(`
    create table if not exists ${schema}.ordenes_servicio_reversiones (
      id_orden_servicio_reversion bigserial primary key,
      id_empresa bigint not null,
      id_orden_servicio bigint not null,
      tipo varchar(30) not null,
      monto numeric(14,2) not null default 0,
      metodo_pago varchar(30),
      motivo text,
      reintegrar_stock boolean not null default false,
      id_caja_sesion bigint,
      id_usuario bigint not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      created_by bigint,
      updated_by bigint
    )
  `);
};

/**
 * Helper para sembrar una venta basica con sus detalles, lista para
 * revertir parcialmente.
 */
export const seedSampleSale = async ({
  idEmpresa,
  idSucursal,
  idUsuario,
  idProducto,
  cantidad = 5,
  precioUnitario = 100,
  costoUnitario = 60,
  numeroComprobante = "TKT-00000001",
}) => {
  const pool = getTestPool();
  const subtotal = Number((cantidad * precioUnitario).toFixed(2));
  const utilidad = Number(((precioUnitario - costoUnitario) * cantidad).toFixed(2));

  const ventaResult = await pool.query(
    `
      insert into ventas (
        id_empresa, id_sucursal, id_usuario, id_cliente, id_caja_sesion,
        numero_comprobante, tipo_comprobante, tipo_venta, metodo_pago, estado,
        subtotal, total, monto_recibido, cambio, saldo_pendiente,
        created_by, updated_by
      )
      values ($1,$2,$3,null,1,$4,'TICKET','CONTADO','EFECTIVO','CONFIRMADA',$5,$5,$5,0,0,$3,$3)
      returning id_venta
    `,
    [idEmpresa, idSucursal, idUsuario, numeroComprobante, subtotal]
  );

  const idVenta = Number(ventaResult.rows[0].id_venta);

  const detalleResult = await pool.query(
    `
      insert into venta_detalles (
        id_empresa, id_venta, id_producto, cantidad, precio_unitario,
        descuento, subtotal, costo_unitario, utilidad,
        created_by, updated_by
      )
      values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$9)
      returning id_venta_detalle
    `,
    [
      idEmpresa,
      idVenta,
      idProducto,
      cantidad,
      precioUnitario,
      subtotal,
      costoUnitario,
      utilidad,
      idUsuario,
    ]
  );

  return {
    idVenta,
    idVentaDetalle: Number(detalleResult.rows[0].id_venta_detalle),
    subtotal,
    utilidad,
  };
};

/**
 * Inserta caja sesion abierta para que createVentaReversion con metodo
 * EFECTIVO encuentre donde registrar el egreso.
 */
export const seedCajaSesionAbierta = async ({
  idEmpresa,
  idSucursal,
  idUsuario,
}) => {
  const pool = getTestPool();
  const result = await pool.query(
    `
      insert into caja_sesiones (id_empresa, id_sucursal, id_usuario, estado)
      values ($1, $2, $3, 'ABIERTA')
      returning id_caja_sesion
    `,
    [idEmpresa, idSucursal, idUsuario]
  );
  return Number(result.rows[0].id_caja_sesion);
};

export const seedBaseTenant = async () => {
  const pool = getTestPool();

  await pool.query(`insert into empresas (id_empresa, slug, nombre_legal) values (1, 'demo', 'Demo SA')`);
  await pool.query(`insert into sucursales (id_sucursal, id_empresa, codigo, nombre) values (1, 1, 'C', 'Central')`);
  await pool.query(`insert into bodegas (id_bodega, id_empresa, id_sucursal, codigo, nombre, es_principal, activa) values (1, 1, 1, 'PRINCIPAL', 'Bodega principal', true, true)`);
  await pool.query(`insert into usuarios (id_usuario, id_empresa, username) values (1, 1, 'tester')`);
  await pool.query(
    `insert into usuarios_sucursales (id_empresa, id_usuario, id_sucursal)
     values (1, 1, 1)
     on conflict (id_empresa, id_usuario, id_sucursal) do nothing`
  );
  await pool.query(`select setval(pg_get_serial_sequence('empresas', 'id_empresa'), 1, true)`);
  await pool.query(`select setval(pg_get_serial_sequence('sucursales', 'id_sucursal'), 1, true)`);
  await pool.query(`select setval(pg_get_serial_sequence('bodegas', 'id_bodega'), 1, true)`);
  await pool.query(`select setval(pg_get_serial_sequence('usuarios', 'id_usuario'), 1, true)`);
  await pool.query(
    `insert into productos (id_producto, id_empresa, sku, nombre, precio_compra, precio_venta) values (1, 1, 'P-1', 'Producto 1', 60, 100)`
  );
  await pool.query(`select setval(pg_get_serial_sequence('productos', 'id_producto'), 1, true)`);
  await pool.query(
    `insert into stock_sucursal (id_empresa, id_sucursal, id_bodega, id_producto, stock_actual) values (1, 1, 1, 1, 100)`
  );
};

/**
 * Crea un admin (ADMIN_EMPRESA) con password real bcrypt para que
 * verifyAdminAuthorization pueda verificarlo en tests.
 *
 * @returns {Promise<{idUsuario: number, username: string, password: string}>}
 */
export const seedAdminUser = async ({
  username = "admin1",
  password = "Admin1234!",
  idEmpresa = 1,
} = {}) => {
  const pool = getTestPool();
  const passwordHash = await bcrypt.hash(password, 4);

  // Garantizar rol ADMIN_EMPRESA en catalogo (codigo unique)
  await pool.query(
    `insert into roles (codigo, nombre) values ('ADMIN_EMPRESA', 'Admin empresa') on conflict (codigo) do nothing`
  );

  const userResult = await pool.query(
    `insert into usuarios (id_empresa, username, password_hash, nombre, apellido)
     values ($1, $2, $3, 'Admin', 'Test')
     returning id_usuario`,
    [idEmpresa, username, passwordHash]
  );

  const idUsuario = Number(userResult.rows[0].id_usuario);

  const roleResult = await pool.query(
    `select id_rol from roles where codigo = 'ADMIN_EMPRESA'`
  );

  await pool.query(
    `insert into usuarios_roles (id_empresa, id_usuario, id_rol) values ($1, $2, $3)`,
    [idEmpresa, idUsuario, Number(roleResult.rows[0].id_rol)]
  );

  return { idUsuario, username, password };
};
