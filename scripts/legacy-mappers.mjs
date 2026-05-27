/**
 * Funciones puras de transformacion legacy -> SaaS.
 * Toman una fila legacy + contexto y devuelven { values: [...], legacyId }
 * listos para ser insertados con SQL parametrizado.
 *
 * Las claves naturales (username, sku, codigo_barras, numero_comprobante,
 * etc.) se usan como criterio de unicidad para idempotencia.
 */

const ROLE_LEGACY_TO_SAAS = {
  SUPER_ADMIN: "SUPER_ADMIN",
  SUPERADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN_EMPRESA",
  ENCARGADO_SERVICIOS: "ENCARGADO_SUCURSAL",
  CAJERO: "CAJERO",
  MECANICO: "CAJERO", // se mapea a CAJERO porque SaaS no tiene MECANICO
  LECTURA: "CAJERO",
};

export const mapLegacyRoleCode = (legacyRoleName) => {
  const normalized = String(legacyRoleName || "")
    .replace(/\s+/g, "_")
    .toUpperCase();
  return ROLE_LEGACY_TO_SAAS[normalized] || "CAJERO";
};

export const mapMetodoPago = (legacy) => {
  const value = String(legacy || "").toUpperCase();
  // En SaaS no existe NO_COBRADO como metodo, se traduce a EFECTIVO
  // y la venta queda con estado NO_COBRADO si aplica.
  if (value === "NO_COBRADO") return "EFECTIVO";
  if (["EFECTIVO", "TARJETA", "TRANSFERENCIA", "CREDITO"].includes(value)) {
    return value;
  }
  return "EFECTIVO";
};

export const mapTipoVenta = (legacy) =>
  String(legacy || "CONTADO").toUpperCase() === "CREDITO"
    ? "CREDITO"
    : "CONTADO";

export const mapEstadoVenta = (legacy) => {
  const value = String(legacy || "").toUpperCase();
  if (value === "ANULADA") return "ANULADA";
  if (value === "NO_COBRADO") return "NO_COBRADO";
  return "CONFIRMADA";
};

export const mapEstadoCompra = (legacy) => {
  const value = String(legacy || "").toUpperCase();
  if (value === "ANULADA") return "ANULADA";
  return "CONFIRMADA";
};

export const mapEstadoOrdenServicio = (legacy) => {
  const value = String(legacy || "").toUpperCase();
  switch (value) {
    case "RECIBIDO":
    case "EN_DIAGNOSTICO":
      return "RECIBIDO";
    case "EN_PROCESO":
    case "EN_REPARACION":
    case "LAVANDO":
    case "PRUEBAS":
      return "EN_PROCESO";
    case "LAVADO":
    case "FINALIZADO":
    case "LISTO":
      return "LISTO";
    case "ENTREGADO":
      return "ENTREGADO";
    case "ANULADA":
      return "ANULADA";
    default:
      return "RECIBIDO";
  }
};

export const mapEstadoCobroOrden = (legacyEstado) => {
  const value = String(legacyEstado || "").toUpperCase();
  if (value === "PAGADO") return "COBRADO";
  if (value === "NO_COBRADO") return "PENDIENTE";
  if (value === "ANULADA") return "ANULADA";
  return "PENDIENTE";
};

export const round2 = (value) =>
  Number(Number(value || 0).toFixed(2));

export const round3 = (value) =>
  Number(Number(value || 0).toFixed(3));

export const cleanString = (value, max = null) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return max != null ? s.slice(0, max) : s;
};
