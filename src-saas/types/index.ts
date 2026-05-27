/**
 * Tipos de dominio del backend POS SaaS.
 * Sirven como contratos para los services y controllers cuando se vayan
 * migrando de .js a .ts. Mientras siguen en JS, se importan con
 * /** @typedef {import("../types").Auth} Auth *\/ en JSDoc.
 */

import type { Pool, PoolClient } from "pg";

// ============================================================
// Auth context (lo que pone el middleware authenticate en req.auth)
// ============================================================
export interface Auth {
  id_usuario: number;
  id_empresa: number;
  id_sucursal: number;
  rol:
    | "SUPER_ADMIN"
    | "ADMIN_EMPRESA"
    | "ENCARGADO_SUCURSAL"
    | "CAJERO"
    | string;
  sucursales: number[];
  modulos: string[];
  permisos: string[];
  empresa: { slug: string; nombre_legal: string } | null;
}

export interface RequestScope {
  id_empresa: number;
  id_sucursal: number;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

// ============================================================
// Tipos basicos compartidos
// ============================================================
export type ID = number;

export interface Paginated<T> {
  rows: T[];
  meta: {
    page: number;
    limit: number;
    totalRows: number;
    totalPages: number;
  };
}

export type Db = Pool | PoolClient;

// ============================================================
// Estados de dominio
// ============================================================
export type VentaEstado = "CONFIRMADA" | "ANULADA" | "NO_COBRADO";
export type EstadoReversion = "SIN_REVERSION" | "PARCIAL" | "TOTAL";
export type CajaEstado = "ABIERTA" | "CERRADA";
export type CajaMovimientoTipo = "INGRESO" | "EGRESO";
export type OrdenServicioEstado =
  | "RECIBIDO"
  | "EN_PROCESO"
  | "LISTO"
  | "ENTREGADO"
  | "ANULADA";
export type OrdenServicioCobroEstado =
  | "PENDIENTE"
  | "COBRADO"
  | "PARCIAL_REEMBOLSADO"
  | "REEMBOLSADO"
  | "ANULADA";
export type Modulo =
  | "POS"
  | "INVENTARIO"
  | "COMPRAS"
  | "REPORTES"
  | "SERVICIOS"
  | "CARWASH"
  | "FINANZAS";

// ============================================================
// Entidades principales
// ============================================================
export interface Venta {
  id_venta: number;
  id_empresa: number;
  id_sucursal: number;
  id_usuario: number;
  id_cliente: number | null;
  id_caja_sesion: number | null;
  numero_comprobante: string | null;
  tipo_comprobante: string | null;
  tipo_venta: "CONTADO" | "CREDITO";
  metodo_pago: string;
  estado: VentaEstado;
  subtotal: number;
  total: number;
  monto_recibido: number | null;
  cambio: number;
  saldo_pendiente: number;
  monto_revertido: number;
  estado_reversion: EstadoReversion;
  moneda: string | null;
  tasa_cambio: number | null;
  fecha_venta: string;
}

export interface VentaDetalle {
  id_venta_detalle: number;
  id_empresa: number;
  id_venta: number;
  id_producto: number;
  cantidad: number;
  precio_unitario: number;
  costo_unitario: number;
  subtotal: number;
  utilidad: number;
}

export interface OrdenServicio {
  id_orden_servicio: number;
  id_empresa: number;
  id_sucursal: number;
  id_servicio_catalogo: number;
  id_cliente: number | null;
  id_usuario: number;
  id_usuario_asignado: number | null;
  id_caja_sesion: number | null;
  modulo: "CARWASH" | "SERVICIOS";
  numero_orden: string | null;
  codigo_publico: string | null;
  placa: string | null;
  vehiculo_tipo: string | null;
  estado: OrdenServicioEstado;
  estado_cobro: OrdenServicioCobroEstado;
  total: number;
  precio_servicio: number;
  fecha_servicio: string;
}

// ============================================================
// HTTP errors (alineado con HttpError class del shared/http)
// ============================================================
export interface ApiErrorResponse {
  error: string;
  details?: unknown;
  reqId?: string;
}

export interface ApiSuccessResponse<T = unknown> {
  ok: true;
  data?: T;
  [key: string]: unknown;
}
