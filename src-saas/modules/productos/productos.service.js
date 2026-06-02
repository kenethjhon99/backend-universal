import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";

// Patron RLS: si la request paso por withTenantDb, usa el client transaccional
// con GUCs seteados; sino fallback al pool global.
const resolveDb = (db) => db || pool;

// ============================================================
// G5 - Generador interno de codigo de barras EAN-13
// ============================================================

const calculateEan13CheckDigit = (baseValue) => {
  const digits = String(baseValue || "").replace(/\D/g, "");

  if (digits.length !== 12) {
    throw new Error("El codigo base debe tener 12 digitos");
  }

  const total = digits
    .split("")
    .reduce(
      (acc, digit, index) =>
        acc + Number(digit) * (index % 2 === 0 ? 1 : 3),
      0
    );

  return (10 - (total % 10)) % 10;
};

/**
 * Genera un EAN-13 con prefijo "20" reservado para uso interno
 * (la norma reserva 20-29 para internos de tienda). Los 10 digitos
 * intermedios se siembran con timestamp + random para minimizar colisiones.
 */
const buildInternalEan13Candidate = () => {
  const seed = `${Date.now()}${Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0")}`.replace(/\D/g, "");
  const base12 = `20${seed.slice(-10).padStart(10, "0")}`;
  return `${base12}${calculateEan13CheckDigit(base12)}`;
};

/**
 * Genera un codigo de barras unico dentro de la empresa actual.
 * Si por alguna razon hay colision, reintenta hasta 30 veces.
 */
export const generateUniqueCodigoBarras = async ({ db, idEmpresa }) => {
  if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
    throw HttpError.badRequest("idEmpresa requerido para generar codigo de barras");
  }

  const conn = resolveDb(db);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = buildInternalEan13Candidate();
    const exists = await getProductoByField(conn, {
      idEmpresa,
      fieldName: "codigo_barras",
      value: candidate,
    });

    if (!exists) {
      return { codigo_barras: candidate };
    }
  }

  throw HttpError.conflict(
    "No se pudo generar un codigo de barras unico despues de varios intentos"
  );
};

const normalizeText = (value) => String(value || "").trim() || null;
const normalizeUpper = (value) =>
  String(value || "").trim().toUpperCase() || null;

const normalizeBoolean = (value, fallback = true) => {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() !== "false";
};

const normalizeMoney = (value, fieldName, fallback = 0) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw HttpError.badRequest(`${fieldName} debe ser un numero mayor o igual a 0`);
  }

  return Number(numericValue.toFixed(2));
};

const normalizeStockMap = (stockPorSucursal = []) => {
  const map = new Map();

  for (const item of Array.isArray(stockPorSucursal) ? stockPorSucursal : []) {
    const idSucursal = Number(item?.id_sucursal);

    if (!Number.isInteger(idSucursal) || idSucursal <= 0) continue;

    map.set(idSucursal, {
      stock_actual:
        item?.stock_actual !== undefined
          ? Number(item.stock_actual)
          : undefined,
      stock_minimo:
        item?.stock_minimo !== undefined
          ? Number(item.stock_minimo)
          : undefined,
      stock_maximo:
        item?.stock_maximo !== undefined
          ? Number(item.stock_maximo)
          : undefined,
      ubicacion:
        item?.ubicacion !== undefined
          ? normalizeText(item.ubicacion)
          : undefined,
    });
  }

  return map;
};

const getProductoByField = async (
  db,
  { idEmpresa, fieldName, value, excludeId = null }
) => {
  if (!value) {
    return null;
  }

  const result = await db.query(
    `
      select id_producto
      from productos
      where id_empresa = $1
        and ${fieldName} = $2
        and ($3::bigint is null or id_producto <> $3)
      limit 1
    `,
    [idEmpresa, value, excludeId]
  );

  return result.rows[0] || null;
};

const ensureProductoUniqueness = async (
  db,
  { idEmpresa, sku, codigoBarras, excludeId = null }
) => {
  const duplicateSku = await getProductoByField(db, {
    idEmpresa,
    fieldName: "sku",
    value: sku,
    excludeId,
  });

  if (duplicateSku) {
    throw HttpError.conflict("Ya existe un producto con ese SKU");
  }

  if (codigoBarras) {
    const duplicateBarcode = await getProductoByField(db, {
      idEmpresa,
      fieldName: "codigo_barras",
      value: codigoBarras,
      excludeId,
    });

    if (duplicateBarcode) {
      throw HttpError.conflict("Ya existe un producto con ese codigo de barras");
    }
  }
};

const getProductoBaseQuery = () => `
  select
    p.id_producto,
    p.id_empresa,
    p.sku,
    p.codigo_barras,
    p.nombre,
    p.descripcion,
    p.precio_compra,
    p.precio_venta,
    p.tipo_producto,
    p.modulo_origen,
    p.activo,
    p.created_at,
    p.updated_at,
    coalesce(ss.stock_actual, 0) as stock_actual,
    coalesce(ss.stock_minimo, 0) as stock_minimo,
    ss.stock_maximo,
    ss.ubicacion,
    ss.id_sucursal,
    ss.id_bodega
  from productos p
  left join bodegas b
    on b.id_empresa = p.id_empresa
   and b.id_sucursal = $2
   and b.es_principal = true
   and b.activa = true
  left join stock_sucursal ss
    on ss.id_empresa = p.id_empresa
   and ss.id_producto = p.id_producto
   and ss.id_sucursal = $2
   and ss.id_bodega = b.id_bodega
`;

export const listProductos = async ({ db, auth, scope, query }) => {
  const conn = resolveDb(db);
  const filters = ["p.id_empresa = $1"];
  const params = [auth.id_empresa, scope.id_sucursal];
  let index = 3;

  if (query?.search) {
    filters.push(
      `(p.nombre ilike $${index} or coalesce(p.descripcion, '') ilike $${index} or coalesce(p.sku, '') ilike $${index} or coalesce(p.codigo_barras, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  if (query?.modulo_origen) {
    filters.push(`p.modulo_origen = $${index}`);
    params.push(String(query.modulo_origen).trim().toUpperCase());
    index += 1;
  }

  if (query?.activo !== undefined) {
    filters.push(`p.activo = $${index}`);
    params.push(normalizeBoolean(query.activo));
    index += 1;
  }

  const result = await conn.query(
    `
      ${getProductoBaseQuery()}
      where ${filters.join(" and ")}
      order by p.activo desc, p.nombre asc, p.sku asc
    `,
    params
  );

  return result.rows;
};

export const getProductoById = async ({ db, auth, idProducto, idSucursal }) => {
  const conn = resolveDb(db);
  const result = await conn.query(
    `
      ${getProductoBaseQuery()}
      where p.id_empresa = $1
        and p.id_producto = $3
      limit 1
    `,
    [auth.id_empresa, idSucursal, idProducto]
  );

  const product = result.rows[0];

  if (!product) {
    throw HttpError.notFound("Producto no encontrado");
  }

  return product;
};

export const createProducto = async ({ auth, body }) =>
  runInTransaction(
    async (client) => {
      const sku = normalizeUpper(body?.sku);
      const nombre = String(body?.nombre || "").trim();
      const codigoBarras = normalizeUpper(body?.codigo_barras);

      if (!sku || !nombre) {
        throw HttpError.badRequest("sku y nombre son requeridos");
      }

      await ensureProductoUniqueness(client, {
        idEmpresa: auth.id_empresa,
        sku,
        codigoBarras,
      });

      const productResult = await client.query(
        `
          insert into productos (
            id_empresa,
            sku,
            codigo_barras,
            nombre,
            descripcion,
            precio_compra,
            precio_venta,
            tipo_producto,
            modulo_origen,
            activo,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
          returning *
        `,
        [
          auth.id_empresa,
          sku,
          codigoBarras,
          nombre,
          normalizeText(body?.descripcion),
          normalizeMoney(body?.precio_compra, "precio_compra"),
          normalizeMoney(body?.precio_venta, "precio_venta"),
          normalizeUpper(body?.tipo_producto) || "PRODUCTO",
          normalizeUpper(body?.modulo_origen) || "POS",
          normalizeBoolean(body?.activo, true),
          auth.id_usuario,
        ]
      );

      const product = productResult.rows[0];
      const branchesResult = await client.query(
        `
          select s.id_sucursal, b.id_bodega
          from sucursales s
          inner join bodegas b
            on b.id_empresa = s.id_empresa
           and b.id_sucursal = s.id_sucursal
           and b.es_principal = true
           and b.activa = true
          where s.id_empresa = $1
            and s.activa = true
        `,
        [auth.id_empresa]
      );

      const stockMap = normalizeStockMap(body?.stock_por_sucursal);

      for (const branch of branchesResult.rows) {
        const config = stockMap.get(Number(branch.id_sucursal)) || {};

        await client.query(
          `
            insert into stock_sucursal (
              id_empresa,
              id_sucursal,
              id_bodega,
              id_producto,
              stock_actual,
              stock_minimo,
              stock_maximo,
              ubicacion,
              created_by,
              updated_by
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
          `,
          [
            auth.id_empresa,
            branch.id_sucursal,
            branch.id_bodega,
            product.id_producto,
            Number(config.stock_actual || 0),
            Number(config.stock_minimo || 0),
            config.stock_maximo ?? null,
            config.ubicacion ?? null,
            auth.id_usuario,
          ]
        );
      }

      return getProductoById({
        db: client,
        auth,
        idProducto: product.id_producto,
        idSucursal: auth.id_sucursal,
      });
    },
    { auth }
  );

export const updateProducto = async ({ auth, idProducto, idSucursal, body }) =>
  runInTransaction(
    async (client) => {
      const current = await getProductoById({
        auth,
        idProducto,
        idSucursal,
      });

      const nextSku =
        body?.sku !== undefined ? normalizeUpper(body.sku) : current.sku;
      const nextNombre =
        body?.nombre !== undefined
          ? String(body.nombre || "").trim()
          : current.nombre;
      const nextCodigoBarras =
        body?.codigo_barras !== undefined
          ? normalizeUpper(body.codigo_barras)
          : current.codigo_barras;

      if (!nextSku || !nextNombre) {
        throw HttpError.badRequest("sku y nombre son requeridos");
      }

      await ensureProductoUniqueness(client, {
        idEmpresa: auth.id_empresa,
        sku: nextSku,
        codigoBarras: nextCodigoBarras,
        excludeId: idProducto,
      });

      await client.query(
        `
          update productos
          set
            sku = $1,
            codigo_barras = $2,
            nombre = $3,
            descripcion = $4,
            precio_compra = $5,
            precio_venta = $6,
            tipo_producto = $7,
            modulo_origen = $8,
            activo = $9,
            updated_by = $10
          where id_empresa = $11
            and id_producto = $12
        `,
        [
          nextSku,
          nextCodigoBarras,
          nextNombre,
          body?.descripcion !== undefined
            ? normalizeText(body.descripcion)
            : current.descripcion,
          body?.precio_compra !== undefined
            ? normalizeMoney(body.precio_compra, "precio_compra")
            : current.precio_compra,
          body?.precio_venta !== undefined
            ? normalizeMoney(body.precio_venta, "precio_venta")
            : current.precio_venta,
          body?.tipo_producto !== undefined
            ? normalizeUpper(body.tipo_producto)
            : current.tipo_producto,
          body?.modulo_origen !== undefined
            ? normalizeUpper(body.modulo_origen)
            : current.modulo_origen,
          body?.activo !== undefined
            ? normalizeBoolean(body.activo)
            : current.activo,
          auth.id_usuario,
          auth.id_empresa,
          idProducto,
        ]
      );

      const stockMap = normalizeStockMap(body?.stock_por_sucursal);

      for (const [branchId, config] of stockMap.entries()) {
        const idBodega = await getPrincipalSucursal(client, {
          idEmpresa: auth.id_empresa,
          idSucursal: branchId,
        });
        if (!idBodega) continue;

        const fields = [];
        const values = [];
        let index = 1;

        if (config.stock_minimo !== undefined) {
          fields.push(`stock_minimo = $${index}`);
          values.push(Number(config.stock_minimo || 0));
          index += 1;
        }

        if (config.stock_maximo !== undefined) {
          fields.push(`stock_maximo = $${index}`);
          values.push(config.stock_maximo === null ? null : Number(config.stock_maximo));
          index += 1;
        }

        if (config.ubicacion !== undefined) {
          fields.push(`ubicacion = $${index}`);
          values.push(config.ubicacion);
          index += 1;
        }

        if (fields.length === 0) {
          continue;
        }

        fields.push(`updated_by = $${index}`);
        values.push(auth.id_usuario);
        index += 1;

        values.push(auth.id_empresa, branchId, idBodega, idProducto);

        await client.query(
          `
            update stock_sucursal
            set ${fields.join(", ")}
            where id_empresa = $${index}
              and id_sucursal = $${index + 1}
              and id_bodega = $${index + 2}
              and id_producto = $${index + 3}
          `,
          values
        );
      }

      return getProductoById({
        db: client,
        auth,
        idProducto,
        idSucursal,
      });
    },
    { auth }
  );

// ============================================================
// G8 - PATCH /:id/estado coherente (activar / desactivar)
// ============================================================
export const setProductoEstado = async ({
  db,
  auth,
  idProducto,
  idSucursal,
  activo,
}) => {
  if (typeof activo !== "boolean") {
    throw HttpError.badRequest("activo debe ser boolean (true|false)");
  }

  const conn = resolveDb(db);
  const result = await conn.query(
    `
      update productos
      set activo = $1,
          updated_by = $2
      where id_empresa = $3
        and id_producto = $4
      returning id_producto
    `,
    [activo, auth.id_usuario, auth.id_empresa, idProducto]
  );

  if (result.rowCount === 0) {
    throw HttpError.notFound("Producto no encontrado");
  }

  return getProductoById({ db, auth, idProducto, idSucursal });
};
