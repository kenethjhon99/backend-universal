import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { HttpError } from "../../shared/http/http-error.js";
import { getPrincipalSucursal } from "../bodegas/bodegas.service.js";

// Helper: usa el client transaccional de la request si esta presente, sino
// cae al pool global. Patron `req.db` documentado en RLS_MIGRATION.md.
const resolveDb = (db) => db || pool;

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return String(value).trim().toLowerCase() !== "false";
};

const normalizePositiveNumber = (value, fieldName) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw HttpError.badRequest(`${fieldName} debe ser un numero mayor o igual a 0`);
  }

  return numericValue;
};

const getStockBaseQuery = () => `
  select
    ss.id_stock,
    ss.id_empresa,
    ss.id_sucursal,
    ss.id_bodega,
    ss.id_producto,
    ss.stock_actual,
    ss.stock_minimo,
    ss.stock_maximo,
    ss.ubicacion,
    ss.created_at,
    ss.updated_at,
    p.sku,
    p.codigo_barras,
    p.nombre,
    p.descripcion,
    p.precio_compra,
    p.precio_venta,
    p.tipo_producto,
    p.modulo_origen,
    p.activo as producto_activo,
    greatest(coalesce(ss.stock_minimo, 0) - coalesce(ss.stock_actual, 0), 0) as faltante,
    (
      coalesce(ss.stock_minimo, 0) > 0
      and coalesce(ss.stock_actual, 0) <= coalesce(ss.stock_minimo, 0)
    ) as bajo_minimo
  from stock_sucursal ss
  inner join productos p
    on p.id_empresa = ss.id_empresa
   and p.id_producto = ss.id_producto
`;

const getStockItem = async ({ db, auth, idSucursal, idProducto, forUpdate = false }) => {
  const conn = resolveDb(db);
  const idBodega = await getPrincipalSucursal(conn, {
    idEmpresa: auth.id_empresa,
    idSucursal,
  });

  if (!idBodega) {
    throw HttpError.conflict("La sucursal activa no tiene bodega principal configurada");
  }

  const lockingClause = forUpdate ? "for update of ss" : "";
  const result = await conn.query(
    `
      ${getStockBaseQuery()}
      where ss.id_empresa = $1
        and ss.id_sucursal = $2
        and ss.id_bodega = $3
        and ss.id_producto = $4
      limit 1
      ${lockingClause}
    `,
    [auth.id_empresa, idSucursal, idBodega, idProducto]
  );

  const stock = result.rows[0];

  if (!stock) {
    throw HttpError.notFound("Stock no encontrado para ese producto en la sucursal activa");
  }

  return stock;
};

export const listStock = async ({ db, auth, scope, query }) => {
  const conn = resolveDb(db);
  const idBodega = await getPrincipalSucursal(conn, {
    idEmpresa: auth.id_empresa,
    idSucursal: scope.id_sucursal,
  });
  if (!idBodega) {
    throw HttpError.conflict("La sucursal activa no tiene bodega principal configurada");
  }
  const filters = [
    "ss.id_empresa = $1",
    "ss.id_sucursal = $2",
    "ss.id_bodega = $3",
  ];
  const params = [auth.id_empresa, scope.id_sucursal, idBodega];
  let index = 4;

  if (!normalizeBoolean(query?.incluir_inactivos, false)) {
    filters.push("p.activo = true");
  }

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

  if (normalizeBoolean(query?.solo_bajo_minimo, false)) {
    filters.push(
      "coalesce(ss.stock_minimo, 0) > 0 and coalesce(ss.stock_actual, 0) <= coalesce(ss.stock_minimo, 0)"
    );
  }

  // Auditoría: Añadir paginación obligatoria
  const limit = Math.max(1, Math.min(Number(query?.limit) || 50, 200));
  const offset = Math.max(0, Number(query?.offset) || 0);
  params.push(limit, offset);

  const result = await conn.query(
    `
      ${getStockBaseQuery()}
      where ${filters.join(" and ")}
      order by bajo_minimo desc, p.nombre asc, p.sku asc
      limit $${index} offset $${index + 1}
    `,
    params
  );

  return result.rows;
};

export const listMovimientos = async ({ db, auth, scope, query }) => {
  const conn = resolveDb(db);
  const idBodega = await getPrincipalSucursal(conn, {
    idEmpresa: auth.id_empresa,
    idSucursal: scope.id_sucursal,
  });
  if (!idBodega) {
    throw HttpError.conflict("La sucursal activa no tiene bodega principal configurada");
  }
  const filters = [
    "mi.id_empresa = $1",
    "mi.id_sucursal = $2",
    "mi.id_bodega = $3",
  ];
  const params = [auth.id_empresa, scope.id_sucursal, idBodega];
  let index = 4;

  if (query?.id_producto) {
    filters.push(`mi.id_producto = $${index}`);
    params.push(Number(query.id_producto));
    index += 1;
  }

  if (query?.tipo) {
    filters.push(`mi.tipo = $${index}`);
    params.push(String(query.tipo).trim().toUpperCase());
    index += 1;
  }

  if (query?.desde) {
    filters.push(`mi.created_at::date >= $${index}::date`);
    params.push(String(query.desde).trim());
    index += 1;
  }

  if (query?.hasta) {
    filters.push(`mi.created_at::date <= $${index}::date`);
    params.push(String(query.hasta).trim());
    index += 1;
  }

  if (query?.search) {
    filters.push(
      `(p.nombre ilike $${index} or coalesce(p.sku, '') ilike $${index} or coalesce(mi.observacion, '') ilike $${index} or coalesce(u.username, '') ilike $${index} or coalesce(u.nombre, '') ilike $${index})`
    );
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }

  const limit = Math.max(1, Math.min(Number(query?.limit) || 100, 500));
  params.push(limit);

  const result = await conn.query(
    `
      select
        mi.*,
        p.sku,
        p.codigo_barras,
        p.nombre as producto_nombre,
        p.modulo_origen,
        u.username as usuario_username,
        concat(u.nombre, ' ', u.apellido) as usuario_nombre
      from movimientos_inventario mi
      inner join productos p
        on p.id_empresa = mi.id_empresa
       and p.id_producto = mi.id_producto
      left join usuarios u
        on u.id_empresa = mi.id_empresa
       and u.id_usuario = mi.id_usuario
      where ${filters.join(" and ")}
      order by mi.created_at desc, mi.id_movimiento desc
      limit $${index}
    `,
    params
  );

  return result.rows;
};

export const updateStockConfig = async ({ auth, scope, idProducto, body }) =>
  runInTransaction(
    async (client) => {
      const stockForConfig = await getStockItem({
        db: client,
        auth,
        idSucursal: scope.id_sucursal,
        idProducto,
        forUpdate: true,
      });

      const stockMinimo =
        body?.stock_minimo !== undefined
          ? normalizePositiveNumber(body.stock_minimo, "stock_minimo")
          : undefined;
      const stockMaximo =
        body?.stock_maximo !== undefined
          ? normalizePositiveNumber(body.stock_maximo, "stock_maximo")
          : undefined;
      const ubicacion =
        body?.ubicacion !== undefined ? String(body.ubicacion || "").trim() || null : undefined;

      if (
        stockMinimo === undefined &&
        stockMaximo === undefined &&
        ubicacion === undefined
      ) {
        throw HttpError.badRequest(
          "Debes enviar stock_minimo, stock_maximo o ubicacion"
        );
      }

      if (
        stockMinimo !== undefined &&
        stockMaximo !== undefined &&
        stockMaximo > 0 &&
        stockMinimo > stockMaximo
      ) {
        throw HttpError.badRequest(
          "stock_minimo no puede ser mayor que stock_maximo"
        );
      }

      const fields = [];
      const values = [];
      let index = 1;

      if (stockMinimo !== undefined) {
        fields.push(`stock_minimo = $${index}`);
        values.push(stockMinimo);
        index += 1;
      }

      if (stockMaximo !== undefined) {
        fields.push(`stock_maximo = $${index}`);
        values.push(stockMaximo);
        index += 1;
      }

      if (ubicacion !== undefined) {
        fields.push(`ubicacion = $${index}`);
        values.push(ubicacion);
        index += 1;
      }

      fields.push(`updated_by = $${index}`);
      values.push(auth.id_usuario);
      index += 1;

      values.push(auth.id_empresa, scope.id_sucursal, stockForConfig.id_bodega, idProducto);

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

      return getStockItem({
        db: client,
        auth,
        idSucursal: scope.id_sucursal,
        idProducto,
      });
    },
    { auth }
  );

export const createMovimientoManual = async ({ auth, scope, body }) =>
  runInTransaction(
    async (client) => {
      const idProducto = Number(body?.id_producto);
      const tipo = String(body?.tipo || "").trim().toUpperCase();

      if (!Number.isInteger(idProducto) || idProducto <= 0) {
        throw HttpError.badRequest("id_producto invalido");
      }

      if (!["ENTRADA", "SALIDA", "AJUSTE"].includes(tipo)) {
        throw HttpError.badRequest("tipo debe ser ENTRADA, SALIDA o AJUSTE");
      }

      const stock = await getStockItem({
        db: client,
        auth,
        idSucursal: scope.id_sucursal,
        idProducto,
        forUpdate: true,
      });

      if (!stock.producto_activo) {
        throw HttpError.badRequest("No puedes mover inventario de un producto inactivo");
      }

      const stockAntes = Number(stock.stock_actual || 0);
      let stockDespues = stockAntes;
      let cantidadMovimiento = 0;

      if (tipo === "AJUSTE") {
        const nuevaExistencia = normalizePositiveNumber(
          body?.nueva_existencia,
          "nueva_existencia"
        );

        if (nuevaExistencia === stockAntes) {
          throw HttpError.badRequest("El ajuste no cambia la existencia actual");
        }

        stockDespues = nuevaExistencia;
        cantidadMovimiento = Math.abs(nuevaExistencia - stockAntes);
      } else {
        const cantidad = normalizePositiveNumber(body?.cantidad, "cantidad");

        if (cantidad <= 0) {
          throw HttpError.badRequest("cantidad debe ser mayor que 0");
        }

        cantidadMovimiento = cantidad;
        stockDespues =
          tipo === "ENTRADA" ? stockAntes + cantidad : stockAntes - cantidad;

        if (stockDespues < 0) {
          throw HttpError.badRequest(
            `Stock insuficiente. Disponible: ${stockAntes}`
          );
        }
      }

      await client.query(
        `
          update stock_sucursal
          set stock_actual = $1,
              updated_by = $4
          where id_empresa = $2
            and id_sucursal = $3
            and id_bodega = $5
            and id_producto = $6
        `,
        [
          stockDespues,
          auth.id_empresa,
          scope.id_sucursal,
          auth.id_usuario,
          stock.id_bodega,
          idProducto,
        ]
      );

      const movementResult = await client.query(
        `
          insert into movimientos_inventario (
            id_empresa,
            id_sucursal,
            id_bodega,
            id_producto,
            id_usuario,
            tipo,
            referencia_tipo,
            referencia_id,
            cantidad,
            stock_antes,
            stock_despues,
            observacion,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,$6,'MANUAL',null,$7,$8,$9,$10,$5,$5)
          returning *
        `,
        [
          auth.id_empresa,
          scope.id_sucursal,
          stock.id_bodega,
          idProducto,
          auth.id_usuario,
          tipo,
          cantidadMovimiento,
          stockAntes,
          stockDespues,
          String(body?.observacion || "").trim() || null,
        ]
      );

      return {
        stock: await getStockItem({
          db: client,
          auth,
          idSucursal: scope.id_sucursal,
          idProducto,
        }),
        movimiento: movementResult.rows[0],
      };
    },
    { auth }
  );

// ============================================================
// G7 - Alias: ajuste directo de existencia (PUT /stock/:idProducto/ajuste)
// Internamente reusa createMovimientoManual con tipo='AJUSTE'.
// ============================================================
export const ajustarStock = async ({ auth, scope, idProducto, body }) =>
  createMovimientoManual({
    auth,
    scope,
    body: {
      id_producto: idProducto,
      tipo: "AJUSTE",
      nueva_existencia: body?.nueva_existencia,
      observacion: body?.observacion || body?.motivo || null,
    },
  });
