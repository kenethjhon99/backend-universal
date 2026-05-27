import { pool } from "../../config/db.js";
import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { parseCsv } from "./csv-parser.js";

const round2 = (n) => Number(Number(n || 0).toFixed(2));
const round3 = (n) => Number(Number(n || 0).toFixed(3));
const cleanString = (v, max = null) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};

// ============================================================
// PRODUCTOS
// Headers esperados: sku,codigo_barras,nombre,descripcion,precio_compra,precio_venta,stock_inicial,stock_minimo
// ============================================================

export const importProductos = async ({
  auth,
  scope,
  csvText,
  dryRun = true,
  requestMeta,
}) => {
  const { headers, rows } = parseCsv(csvText);

  if (rows.length === 0) {
    return { dryRun, total: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  }

  if (!headers.includes("sku") || !headers.includes("nombre")) {
    throw HttpError.badRequest(
      "El CSV debe tener al menos las columnas: sku, nombre"
    );
  }

  const stats = {
    dryRun,
    total: rows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const [index, row] of rows.entries()) {
    const linea = index + 2; // +1 por header, +1 por base 1
    const sku = cleanString(row.sku, 50);
    const nombre = cleanString(row.nombre, 150);

    if (!sku || !nombre) {
      stats.skipped += 1;
      stats.errors.push({ linea, error: "sku y nombre son requeridos" });
      continue;
    }

    const precioCompra = round2(row.precio_compra);
    const precioVenta = round2(row.precio_venta);
    const stockInicial = round3(row.stock_inicial || 0);
    const stockMinimo = round3(row.stock_minimo || 0);

    if (dryRun) {
      stats.inserted += 1;
      continue;
    }

    try {
      await runInTransaction(
        async (client) => {
          // Upsert por (id_empresa, sku)
          const ins = await client.query(
            `
              insert into productos (
                id_empresa, sku, codigo_barras, nombre, descripcion,
                precio_compra, precio_venta, tipo_producto, modulo_origen, activo,
                created_by, updated_by
              )
              values ($1,$2,$3,$4,$5,$6,$7,'PRODUCTO','POS',true,$8,$8)
              on conflict (id_empresa, sku) do update
                set codigo_barras = excluded.codigo_barras,
                    nombre = excluded.nombre,
                    descripcion = excluded.descripcion,
                    precio_compra = excluded.precio_compra,
                    precio_venta = excluded.precio_venta,
                    updated_by = excluded.updated_by
              returning id_producto, (xmax = 0) as inserted
            `,
            [
              auth.id_empresa,
              sku,
              cleanString(row.codigo_barras, 50),
              nombre,
              cleanString(row.descripcion, 1000),
              precioCompra,
              precioVenta,
              auth.id_usuario,
            ]
          );

          const idProducto = Number(ins.rows[0].id_producto);
          if (ins.rows[0].inserted) stats.inserted += 1;
          else stats.updated += 1;

          // Stock por sucursal default
          await client.query(
            `
              insert into stock_sucursal (
                id_empresa, id_sucursal, id_producto,
                stock_actual, stock_minimo
              )
              values ($1,$2,$3,$4,$5)
              on conflict (id_empresa, id_sucursal, id_producto)
                do update set stock_actual = excluded.stock_actual,
                              stock_minimo = excluded.stock_minimo
            `,
            [auth.id_empresa, scope.id_sucursal, idProducto, stockInicial, stockMinimo]
          );
        },
        { auth }
      );
    } catch (error) {
      stats.skipped += 1;
      stats.errors.push({ linea, sku, error: error.message });
    }
  }

  if (!dryRun) {
    await writeAuditEvent(pool, {
      auth,
      scope,
      requestMeta,
      modulo: "IMPORTADOR",
      entidad: "PRODUCTOS_BULK",
      entidadId: 0,
      accion: "IMPORT",
      despues: stats,
    });
  }

  return stats;
};

// ============================================================
// CLIENTES
// Headers: nombre,nit,telefono,email,direccion,codigo
// ============================================================

export const importClientes = async ({
  auth,
  scope,
  csvText,
  dryRun = true,
  requestMeta,
}) => {
  const { headers, rows } = parseCsv(csvText);

  if (rows.length === 0) {
    return { dryRun, total: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  }
  if (!headers.includes("nombre")) {
    throw HttpError.badRequest("El CSV debe tener al menos la columna: nombre");
  }

  const stats = {
    dryRun,
    total: rows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const [index, row] of rows.entries()) {
    const linea = index + 2;
    const nombre = cleanString(row.nombre, 150);
    if (!nombre) {
      stats.skipped += 1;
      stats.errors.push({ linea, error: "nombre es requerido" });
      continue;
    }

    if (dryRun) {
      stats.inserted += 1;
      continue;
    }

    try {
      const ins = await pool.query(
        `
          insert into clientes (
            id_empresa, codigo, nombre, nit, telefono, email, direccion,
            activo, created_by, updated_by
          )
          values ($1,$2,$3,$4,$5,$6,$7,true,$8,$8)
          on conflict (id_empresa, nit) where nit is not null
            do update set nombre = excluded.nombre,
                          telefono = excluded.telefono,
                          email = excluded.email,
                          direccion = excluded.direccion
          returning id_cliente, (xmax = 0) as inserted
        `,
        [
          auth.id_empresa,
          cleanString(row.codigo, 30),
          nombre,
          cleanString(row.nit, 30),
          cleanString(row.telefono, 30),
          cleanString(row.email, 150),
          cleanString(row.direccion, 250),
          auth.id_usuario,
        ]
      );
      if (ins.rows[0]?.inserted) stats.inserted += 1;
      else if (ins.rows[0]) stats.updated += 1;
      else stats.skipped += 1;
    } catch (error) {
      stats.skipped += 1;
      stats.errors.push({ linea, nombre, error: error.message });
    }
  }

  if (!dryRun) {
    await writeAuditEvent(pool, {
      auth,
      scope,
      requestMeta,
      modulo: "IMPORTADOR",
      entidad: "CLIENTES_BULK",
      entidadId: 0,
      accion: "IMPORT",
      despues: stats,
    });
  }

  return stats;
};
