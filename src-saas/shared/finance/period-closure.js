import { HttpError } from "../http/http-error.js";

const ALLOWED_AREAS = new Set([
  "VENTAS",
  "COMPRAS",
  "FINANZAS",
  "SERVICIOS",
]);

const normalizeArea = (value) => String(value || "").trim().toUpperCase();

const toIsoDate = (value) => {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const raw = String(value).trim();

  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    return raw;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

export const getClosureArea = (value) => {
  const area = normalizeArea(value);

  if (!ALLOWED_AREAS.has(area)) {
    throw HttpError.badRequest("area de cierre invalida", {
      areas_permitidas: [...ALLOWED_AREAS],
    });
  }

  return area;
};

export const assertPeriodOpen = async (
  db,
  { idEmpresa, idSucursal = null, area, fechaOperacion }
) => {
  const normalizedArea = getClosureArea(area);
  const isoDate = toIsoDate(fechaOperacion);

  if (!isoDate) {
    throw HttpError.badRequest("fechaOperacion invalida para validar cierres");
  }

  const result = await db.query(
    `
      select
        id_cierre_periodo,
        id_sucursal,
        area,
        fecha_desde,
        fecha_hasta,
        observaciones
      from cierres_periodo
      where id_empresa = $1
        and upper(area) = $2
        and upper(coalesce(estado, '')) = 'CERRADO'
        and $3::date between fecha_desde and fecha_hasta
        and (id_sucursal is null or id_sucursal = $4)
      order by case when id_sucursal is null then 1 else 0 end asc,
               fecha_hasta desc,
               id_cierre_periodo desc
      limit 1
    `,
    [idEmpresa, normalizedArea, isoDate, idSucursal]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  throw HttpError.conflict(
    `El periodo ${row.fecha_desde} a ${row.fecha_hasta} esta cerrado para ${normalizedArea.toLowerCase()}`,
    {
      id_cierre_periodo: Number(row.id_cierre_periodo),
      area: row.area,
      id_sucursal: row.id_sucursal != null ? Number(row.id_sucursal) : null,
      fecha_desde: row.fecha_desde,
      fecha_hasta: row.fecha_hasta,
      observaciones: row.observaciones || null,
    }
  );
};
