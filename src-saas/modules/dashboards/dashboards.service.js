import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";

/**
 * Catalogo de widgets disponibles. El frontend usa esto para mostrar
 * el "Add widget" picker. Cada widget tiene:
 *   - type: identificador unico
 *   - label: display
 *   - default_size: {w, h} en celdas del grid
 *   - data_source: endpoint que provee data (opcional)
 */
const WIDGET_CATALOG = [
  { type: "ventas_hoy", label: "Ventas hoy", default_size: { w: 3, h: 2 }, data_source: "/reportes/general" },
  { type: "utilidad_hoy", label: "Utilidad hoy", default_size: { w: 3, h: 2 }, data_source: "/reportes/general" },
  { type: "ticket_promedio", label: "Ticket promedio", default_size: { w: 3, h: 2 }, data_source: "/reportes/general" },
  { type: "stock_bajo_count", label: "Productos con stock bajo", default_size: { w: 3, h: 2 }, data_source: "/reportes/general" },
  { type: "ventas_por_dia", label: "Ventas por día (chart)", default_size: { w: 6, h: 4 }, data_source: "/reportes/general" },
  { type: "metodos_pago", label: "Métodos de pago (pie)", default_size: { w: 6, h: 4 }, data_source: "/reportes/general" },
  { type: "top_productos", label: "Top productos", default_size: { w: 6, h: 4 }, data_source: "/reportes/general" },
  { type: "caja_activa", label: "Caja activa", default_size: { w: 4, h: 3 }, data_source: "/caja/sesion-activa" },
  { type: "tickets_abiertos", label: "Tickets abiertos", default_size: { w: 3, h: 2 }, data_source: "/tickets/stats" },
  { type: "alerta_quiebre_stock", label: "Productos en alerta de quiebre", default_size: { w: 6, h: 4 }, data_source: "/prediccion/productos" },
  { type: "no_cobrados_pendientes", label: "No cobrados pendientes", default_size: { w: 6, h: 3 }, data_source: "/caja/sesion-activa" },
  { type: "comisiones_pendientes", label: "Comisiones pendientes", default_size: { w: 4, h: 3 }, data_source: "/comisiones/reporte" },
];

export const getWidgetCatalog = () => WIDGET_CATALOG;

// ============================================================
// Dashboards CRUD
// ============================================================

const validateLayout = (layout) => {
  if (!Array.isArray(layout)) {
    throw HttpError.badRequest("layout debe ser un array");
  }
  const validTypes = new Set(WIDGET_CATALOG.map((w) => w.type));
  for (const item of layout) {
    if (!item || typeof item !== "object") {
      throw HttpError.badRequest("layout contiene items invalidos");
    }
    if (!validTypes.has(item.type)) {
      throw HttpError.badRequest(`widget type invalido: ${item.type}`);
    }
    for (const k of ["x", "y", "w", "h"]) {
      if (typeof item[k] !== "number" || item[k] < 0) {
        throw HttpError.badRequest(`widget ${item.type}: ${k} invalido`);
      }
    }
  }
};

export const listMine = async ({ auth }) => {
  const r = await pool.query(
    `select id_dashboard, nombre, es_default, layout, updated_at
     from dashboards
     where id_empresa = $1 and id_usuario = $2
     order by es_default desc, nombre asc`,
    [auth.id_empresa, auth.id_usuario]
  );
  return r.rows;
};

export const getDefault = async ({ auth }) => {
  let r = await pool.query(
    `select * from dashboards
     where id_empresa = $1 and id_usuario = $2 and es_default = true
     limit 1`,
    [auth.id_empresa, auth.id_usuario]
  );
  if (r.rowCount > 0) return r.rows[0];

  // Sin default: devolver el más reciente o un layout inicial sugerido
  r = await pool.query(
    `select * from dashboards
     where id_empresa = $1 and id_usuario = $2
     order by updated_at desc limit 1`,
    [auth.id_empresa, auth.id_usuario]
  );
  if (r.rowCount > 0) return r.rows[0];

  // Layout sugerido para el primer dashboard de un usuario nuevo
  return {
    id_dashboard: null,
    nombre: "Mi dashboard",
    es_default: true,
    layout: [
      { type: "ventas_hoy", x: 0, y: 0, w: 3, h: 2 },
      { type: "utilidad_hoy", x: 3, y: 0, w: 3, h: 2 },
      { type: "stock_bajo_count", x: 6, y: 0, w: 3, h: 2 },
      { type: "tickets_abiertos", x: 9, y: 0, w: 3, h: 2 },
      { type: "ventas_por_dia", x: 0, y: 2, w: 6, h: 4 },
      { type: "metodos_pago", x: 6, y: 2, w: 6, h: 4 },
    ],
  };
};

export const create = async ({ auth, body }) => {
  const nombre = String(body?.nombre || "").trim();
  if (!nombre) throw HttpError.badRequest("nombre requerido");
  validateLayout(body?.layout || []);

  // Si se marca como default, desmarcar los demás
  if (body?.es_default) {
    await pool.query(
      `update dashboards set es_default = false where id_empresa = $1 and id_usuario = $2`,
      [auth.id_empresa, auth.id_usuario]
    );
  }

  const r = await pool.query(
    `
      insert into dashboards (id_empresa, id_usuario, nombre, layout, es_default, created_by, updated_by)
      values ($1, $2, $3, $4::jsonb, $5, $2, $2)
      returning *
    `,
    [
      auth.id_empresa,
      auth.id_usuario,
      nombre,
      JSON.stringify(body?.layout || []),
      body?.es_default === true,
    ]
  );
  return r.rows[0];
};

export const update = async ({ auth, idDashboard, body }) => {
  const updates = [];
  const params = [];
  let i = 1;

  if (body?.nombre !== undefined) {
    const nombre = String(body.nombre || "").trim();
    if (!nombre) throw HttpError.badRequest("nombre no puede estar vacio");
    updates.push(`nombre = $${i}`);
    params.push(nombre);
    i += 1;
  }
  if (body?.layout !== undefined) {
    validateLayout(body.layout);
    updates.push(`layout = $${i}::jsonb`);
    params.push(JSON.stringify(body.layout));
    i += 1;
  }
  if (body?.es_default === true) {
    // Desmarcar otros
    await pool.query(
      `update dashboards set es_default = false where id_empresa = $1 and id_usuario = $2`,
      [auth.id_empresa, auth.id_usuario]
    );
    updates.push(`es_default = true`);
  } else if (body?.es_default === false) {
    updates.push(`es_default = false`);
  }

  if (updates.length === 0) {
    throw HttpError.badRequest("nada que actualizar");
  }

  updates.push(`updated_by = $${i}`);
  params.push(auth.id_usuario);
  i += 1;

  params.push(auth.id_empresa, auth.id_usuario, idDashboard);

  const r = await pool.query(
    `update dashboards set ${updates.join(", ")}
     where id_empresa = $${i} and id_usuario = $${i + 1} and id_dashboard = $${i + 2}
     returning *`,
    params
  );
  if (r.rowCount === 0) throw HttpError.notFound("Dashboard no encontrado");
  return r.rows[0];
};

export const remove = async ({ auth, idDashboard }) => {
  const r = await pool.query(
    `delete from dashboards
     where id_empresa = $1 and id_usuario = $2 and id_dashboard = $3
     returning id_dashboard`,
    [auth.id_empresa, auth.id_usuario, idDashboard]
  );
  if (r.rowCount === 0) throw HttpError.notFound("Dashboard no encontrado");
  return { ok: true };
};
