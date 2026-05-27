import { z } from "zod";

// ============================================================
// Schemas reutilizables
// ============================================================

export const idSchema = z.coerce
  .number()
  .int()
  .positive()
  .describe("Identificador entero positivo");

export const moneyAmountSchema = z.coerce
  .number()
  .nonnegative()
  .max(99_999_999.99);

export const positiveQuantitySchema = z.coerce
  .number()
  .positive()
  .max(999_999.999);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Debe tener formato YYYY-MM-DD");

export const optionalString = (max = 500) =>
  z
    .union([z.string().max(max), z.null(), z.undefined()])
    .transform((value) => {
      if (value === undefined || value === null) return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    });

export const requiredString = (max = 200) =>
  z
    .string()
    .trim()
    .min(1, "Es requerido")
    .max(max);

export const paramsIdSchema = z.object({
  id: idSchema,
});

// ============================================================
// Auth admin (para validar admin_username + admin_password en operaciones
// sensibles: NO_COBRADO, validacion de pendientes, cierre de caja con diferencia)
// ============================================================
export const adminAuthSchema = z.object({
  admin_username: z.string().trim().min(1).optional(),
  admin_password: z.string().min(1).optional(),
});

// ============================================================
// Schemas concretos por modulo (los mas usados)
// ============================================================

export const ventaItemSchema = z.object({
  id_producto: idSchema,
  cantidad: positiveQuantitySchema,
});

export const ventaCreateSchema = z
  .object({
    items: z.array(ventaItemSchema).min(1, "Debes enviar al menos un item"),
    tipo_venta: z
      .enum(["CONTADO", "CREDITO"])
      .default("CONTADO")
      .optional(),
    metodo_pago: z
      .enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA", "CREDITO"])
      .default("EFECTIVO")
      .optional(),
    tipo_comprobante: z
      .enum(["TICKET", "FACTURA", "CCF"])
      .default("TICKET")
      .optional(),
    id_cliente: idSchema.optional().nullable(),
    monto_recibido: moneyAmountSchema.optional().nullable(),
    dias_credito: z.coerce.number().int().nonnegative().optional().nullable(),
    fecha_vencimiento: isoDateSchema.optional().nullable(),
    observaciones: optionalString(1000),
    no_cobrar: z.coerce.boolean().optional(),
    no_cobrado_motivo: optionalString(500),
  })
  .extend(adminAuthSchema.shape);

export const ventaReversionSchema = z.object({
  tipo_reversion: z.enum(["DEVOLUCION", "NOTA_CREDITO"]).default("DEVOLUCION"),
  metodo_resolucion: z
    .enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA", "AJUSTE", "NOTA_CREDITO"])
    .default("AJUSTE"),
  reintegrar_stock: z.coerce.boolean().default(true),
  motivo: requiredString(500),
  items: z
    .array(
      z.object({
        id_venta_detalle: idSchema,
        cantidad: positiveQuantitySchema,
      })
    )
    .min(1, "Debes enviar al menos un item a revertir"),
});

export const cajaAperturaSchema = z.object({
  monto_apertura: moneyAmountSchema,
  observaciones_apertura: optionalString(500),
});

export const cajaMovimientoSchema = z
  .object({
    tipo: z.enum(["INGRESO", "EGRESO"]),
    monto: moneyAmountSchema.refine((value) => value > 0, {
      message: "monto debe ser mayor a 0",
    }),
    categoria: optionalString(50),
    descripcion: optionalString(500),
  })
  .extend(adminAuthSchema.shape);

export const cajaCierreSchema = z
  .object({
    monto_cierre_reportado: moneyAmountSchema,
    observaciones_cierre: optionalString(500),
    validacion_diferencia_nota: optionalString(500),
  })
  .extend(adminAuthSchema.shape);

export const validarPendienteSchema = z
  .object({
    id_venta: idSchema.optional(),
    autorizacion_admin_nota: optionalString(500),
    validacion_nota: optionalString(500),
  })
  .extend(adminAuthSchema.shape);

export const productoCreateSchema = z.object({
  sku: requiredString(50),
  codigo_barras: optionalString(50),
  nombre: requiredString(150),
  descripcion: optionalString(1000),
  precio_compra: moneyAmountSchema.default(0),
  precio_venta: moneyAmountSchema.default(0),
  tipo_producto: z.enum(["PRODUCTO", "SERVICIO"]).default("PRODUCTO"),
  modulo_origen: z
    .enum(["POS", "INVENTARIO", "SERVICIOS", "CARWASH"])
    .default("POS"),
  activo: z.coerce.boolean().default(true),
});

export const productoUpdateSchema = productoCreateSchema.partial();

export const setEstadoSchema = z.object({
  activo: z.coerce.boolean(),
});

export const tipoVehiculoSchema = z.object({
  modulo: z.enum(["CARWASH", "SERVICIOS"]),
  nombre: requiredString(80),
  slug: optionalString(80),
  descripcion: optionalString(500),
  icono: optionalString(80),
  orden: z.coerce.number().int().nonnegative().default(0),
  activo: z.coerce.boolean().default(true),
});

export const ajusteStockSchema = z.object({
  nueva_existencia: z.coerce.number().nonnegative(),
  observacion: optionalString(500),
});
