import { HttpError } from "../http/http-error.js";

/**
 * Catalogo central de tipos de comprobante por modulo.
 * Cada combinacion (modulo, tipo_comprobante) tiene una serie por defecto y un nombre.
 *
 * Si una empresa quiere usar otra serie distinta a la default, puede crearla via
 * POST /api/saas/comprobantes/series.
 */
export const COMPROBANTE_TYPES = Object.freeze({
  VENTA: {
    label: "Venta",
    types: {
      TICKET: { serie: "TKT", nombre: "Ticket POS" },
      FACTURA: { serie: "FAC", nombre: "Factura" },
      CCF: { serie: "CCF", nombre: "Credito fiscal" },
    },
  },
  VENTA_REVERSION: {
    label: "Devolucion / Nota de credito",
    types: {
      DEVOLUCION: { serie: "DVV", nombre: "Devolucion de venta" },
      NOTA_CREDITO: { serie: "NCV", nombre: "Nota de credito" },
    },
  },
  COMPRA: {
    label: "Compra",
    types: {
      FACTURA: { serie: "FCC", nombre: "Factura de compra" },
    },
  },
  COMPRA_REVERSION: {
    label: "Devolucion a proveedor",
    types: {
      DEVOLUCION: { serie: "DVC", nombre: "Devolucion a proveedor" },
      NOTA_DEBITO: { serie: "NDC", nombre: "Nota de debito a proveedor" },
    },
  },
  SERVICIOS: {
    label: "Orden de servicio",
    types: {
      ORDEN_SERVICIO: { serie: "SRV", nombre: "Orden de servicio" },
    },
  },
  CARWASH: {
    label: "Orden de carwash",
    types: {
      ORDEN_SERVICIO: { serie: "CWA", nombre: "Orden de carwash" },
    },
  },
});

const CORRELATIVO_PADDING = 8;

const normalize = (value) => String(value || "").trim().toUpperCase();

const formatNumeroComprobante = (serie, correlativo) =>
  `${serie}-${String(correlativo).padStart(CORRELATIVO_PADDING, "0")}`;

/**
 * Devuelve los defaults conocidos para un (modulo, tipoComprobante).
 * Si no se encuentra, lanza 400.
 */
const getDefaultsFor = (modulo, tipoComprobante) => {
  const moduloKey = normalize(modulo);
  const tipoKey = normalize(tipoComprobante);

  const moduleEntry = COMPROBANTE_TYPES[moduloKey];

  if (!moduleEntry) {
    throw HttpError.badRequest(
      `Modulo de comprobante no soportado: ${moduloKey}`,
      { modulos_validos: Object.keys(COMPROBANTE_TYPES) }
    );
  }

  const typeEntry = moduleEntry.types[tipoKey];

  if (!typeEntry) {
    throw HttpError.badRequest(
      `Tipo de comprobante no soportado para modulo ${moduloKey}: ${tipoKey}`,
      { tipos_validos: Object.keys(moduleEntry.types) }
    );
  }

  return { moduloKey, tipoKey, ...typeEntry };
};

/**
 * Garantiza que exista una serie activa por defecto para (empresa, sucursal, modulo, tipo).
 * No falla si ya existe (ON CONFLICT DO NOTHING).
 */
const ensureDefaultSerie = async (
  client,
  { idEmpresa, idSucursal, moduloKey, tipoKey, serie, nombre, actorId = null }
) => {
  await client.query(
    `
      insert into comprobante_series (
        id_empresa,
        id_sucursal,
        modulo,
        tipo_comprobante,
        nombre,
        serie,
        ultimo_correlativo,
        activo,
        created_by,
        updated_by
      )
      values ($1,$2,$3,$4,$5,$6,0,true,$7,$7)
      on conflict (id_empresa, id_sucursal, modulo, tipo_comprobante, serie) do nothing
    `,
    [idEmpresa, idSucursal, moduloKey, tipoKey, nombre, serie, actorId]
  );
};

/**
 * Emite un comprobante de forma atomica:
 *   - Asegura que exista la serie default (si no, la crea).
 *   - Bloquea la fila con FOR UPDATE.
 *   - Incrementa correlativo.
 *   - Devuelve numero formateado y datos de la serie.
 *
 * Esta funcion DEBE ejecutarse dentro de una transaccion (recibe el client).
 *
 * @param {pg.PoolClient} client
 * @param {object} params
 * @param {number} params.idEmpresa
 * @param {number} params.idSucursal
 * @param {string} params.modulo  - VENTA | VENTA_REVERSION | COMPRA | SERVICIOS | CARWASH | ...
 * @param {string} params.tipoComprobante - TICKET | FACTURA | CCF | ORDEN_SERVICIO | DEVOLUCION | NOTA_CREDITO ...
 * @param {number} [params.actorId]
 * @returns {Promise<{
 *   id_comprobante_serie: number,
 *   modulo: string,
 *   tipo_comprobante: string,
 *   serie: string,
 *   correlativo: number,
 *   numero_comprobante: string,
 *   nombre: string,
 * }>}
 */
export const emitirComprobante = async (
  client,
  { idEmpresa, idSucursal, modulo, tipoComprobante, actorId = null }
) => {
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa invalido al emitir comprobante");
  }
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
    throw HttpError.badRequest("idSucursal invalido al emitir comprobante");
  }

  const { moduloKey, tipoKey, serie, nombre } = getDefaultsFor(
    modulo,
    tipoComprobante
  );

  await ensureDefaultSerie(client, {
    idEmpresa,
    idSucursal,
    moduloKey,
    tipoKey,
    serie,
    nombre,
    actorId,
  });

  const result = await client.query(
    `
      select id_comprobante_serie, serie, ultimo_correlativo, nombre
      from comprobante_series
      where id_empresa = $1
        and id_sucursal = $2
        and modulo = $3
        and tipo_comprobante = $4
        and activo = true
      order by id_comprobante_serie asc
      limit 1
      for update
    `,
    [idEmpresa, idSucursal, moduloKey, tipoKey]
  );

  const series = result.rows[0];

  if (!series) {
    throw HttpError.badRequest(
      `No hay una serie activa para ${moduloKey}/${tipoKey} en la sucursal ${idSucursal}`
    );
  }

  const nextCorrelative = Number(series.ultimo_correlativo || 0) + 1;

  await client.query(
    `
      update comprobante_series
      set ultimo_correlativo = $1,
          updated_by = coalesce($2, updated_by)
      where id_comprobante_serie = $3
    `,
    [nextCorrelative, actorId, series.id_comprobante_serie]
  );

  return {
    id_comprobante_serie: Number(series.id_comprobante_serie),
    modulo: moduloKey,
    tipo_comprobante: tipoKey,
    serie: series.serie,
    correlativo: nextCorrelative,
    numero_comprobante: formatNumeroComprobante(series.serie, nextCorrelative),
    nombre: series.nombre,
  };
};

/**
 * Devuelve el catalogo plano de tipos de comprobante por modulo.
 * Util para que el frontend muestre los tipos disponibles antes de emitir.
 */
export const getComprobanteCatalog = () =>
  Object.entries(COMPROBANTE_TYPES).map(([modulo, entry]) => ({
    modulo,
    label: entry.label,
    tipos: Object.entries(entry.types).map(([tipo, defaults]) => ({
      tipo_comprobante: tipo,
      serie_default: defaults.serie,
      nombre_default: defaults.nombre,
    })),
  }));

/**
 * Helper para listar los modulos validos (string[]).
 */
export const listValidModules = () => Object.keys(COMPROBANTE_TYPES);

/**
 * Helper para listar los tipos validos de un modulo (string[]).
 */
export const listValidTypes = (modulo) => {
  const moduleEntry = COMPROBANTE_TYPES[normalize(modulo)];
  return moduleEntry ? Object.keys(moduleEntry.types) : [];
};
