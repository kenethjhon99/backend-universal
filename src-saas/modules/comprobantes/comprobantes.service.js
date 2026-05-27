import { pool } from "../../config/db.js";
import { HttpError } from "../../shared/http/http-error.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import {
  getComprobanteCatalog,
  listValidModules,
  listValidTypes,
} from "../../shared/comprobantes/comprobante-series.js";

const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN_EMPRESA"]);

const normalizeRole = (value) => String(value || "").trim().toUpperCase();
const normalizeText = (value) => String(value || "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();

const isPrivileged = (auth) => PRIVILEGED_ROLES.has(normalizeRole(auth?.rol));

const branchClause = (auth, alias = "cs", startIndex) => {
  if (isPrivileged(auth)) {
    return { clause: "", params: [] };
  }

  return {
    clause: `and ${alias}.id_sucursal = any($${startIndex}::bigint[])`,
    params: [auth.sucursales.map(Number)],
  };
};

const ensureBranchAccess = (auth, idSucursal) => {
  if (isPrivileged(auth)) return;

  const allowed = (Array.isArray(auth.sucursales) ? auth.sucursales : []).map(
    Number
  );

  if (!allowed.includes(Number(idSucursal))) {
    throw HttpError.forbidden(
      "No tienes acceso a la sucursal solicitada",
      { id_sucursal_solicitada: Number(idSucursal) }
    );
  }
};

const validateModuloTipo = (modulo, tipoComprobante) => {
  const moduloKey = normalizeUpper(modulo);
  const tipoKey = normalizeUpper(tipoComprobante);

  if (!listValidModules().includes(moduloKey)) {
    throw HttpError.badRequest(
      `Modulo invalido: ${moduloKey}`,
      { modulos_validos: listValidModules() }
    );
  }

  if (!listValidTypes(moduloKey).includes(tipoKey)) {
    throw HttpError.badRequest(
      `Tipo de comprobante invalido para ${moduloKey}: ${tipoKey}`,
      { tipos_validos: listValidTypes(moduloKey) }
    );
  }

  return { moduloKey, tipoKey };
};

const normalizeSerieInput = (serie) => {
  const trimmed = normalizeText(serie).toUpperCase();

  if (!/^[A-Z0-9-]{1,20}$/.test(trimmed)) {
    throw HttpError.badRequest(
      "La serie debe tener entre 1 y 20 caracteres alfanumericos / guiones"
    );
  }

  return trimmed;
};

const mapSerieRow = (row) => ({
  id_comprobante_serie: Number(row.id_comprobante_serie),
  id_empresa: Number(row.id_empresa),
  id_sucursal: Number(row.id_sucursal),
  modulo: row.modulo,
  tipo_comprobante: row.tipo_comprobante,
  nombre: row.nombre,
  serie: row.serie,
  ultimo_correlativo: Number(row.ultimo_correlativo || 0),
  proximo_correlativo: Number(row.ultimo_correlativo || 0) + 1,
  proximo_numero: `${row.serie}-${String(
    Number(row.ultimo_correlativo || 0) + 1
  ).padStart(8, "0")}`,
  activo: row.activo === true,
  created_at: row.created_at,
  updated_at: row.updated_at,
  sucursal_nombre: row.sucursal_nombre || null,
});

export const getCatalog = () => getComprobanteCatalog();

export const listSeries = async ({ auth, query }) => {
  const filters = ["cs.id_empresa = $1"];
  const params = [auth.id_empresa];
  let index = 2;

  if (query?.modulo) {
    filters.push(`cs.modulo = $${index}`);
    params.push(normalizeUpper(query.modulo));
    index += 1;
  }

  if (query?.tipo_comprobante) {
    filters.push(`cs.tipo_comprobante = $${index}`);
    params.push(normalizeUpper(query.tipo_comprobante));
    index += 1;
  }

  if (query?.id_sucursal) {
    const idSucursal = Number(query.id_sucursal);

    if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
      throw HttpError.badRequest("id_sucursal invalido");
    }

    ensureBranchAccess(auth, idSucursal);
    filters.push(`cs.id_sucursal = $${index}`);
    params.push(idSucursal);
    index += 1;
  }

  if (query?.activo !== undefined && query.activo !== "") {
    const wantsActive = ["true", "1", "si", "yes"].includes(
      String(query.activo).trim().toLowerCase()
    );
    filters.push(`cs.activo = $${index}`);
    params.push(wantsActive);
    index += 1;
  }

  const branchScope = branchClause(auth, "cs", index);

  if (branchScope.clause) {
    filters.push(branchScope.clause.replace(/^and\s+/, ""));
    params.push(...branchScope.params);
    index += branchScope.params.length;
  }

  const result = await pool.query(
    `
      select
        cs.*,
        s.nombre as sucursal_nombre
      from comprobante_series cs
      inner join sucursales s
        on s.id_empresa = cs.id_empresa
       and s.id_sucursal = cs.id_sucursal
      where ${filters.join(" and ")}
      order by cs.id_sucursal asc, cs.modulo asc, cs.tipo_comprobante asc, cs.serie asc
    `,
    params
  );

  return result.rows.map(mapSerieRow);
};

export const getSerieById = async ({ auth, idComprobanteSerie }) => {
  const result = await pool.query(
    `
      select cs.*, s.nombre as sucursal_nombre
      from comprobante_series cs
      inner join sucursales s
        on s.id_empresa = cs.id_empresa
       and s.id_sucursal = cs.id_sucursal
      where cs.id_empresa = $1
        and cs.id_comprobante_serie = $2
      limit 1
    `,
    [auth.id_empresa, idComprobanteSerie]
  );

  const row = result.rows[0];

  if (!row) {
    throw HttpError.notFound("Serie de comprobante no encontrada");
  }

  ensureBranchAccess(auth, row.id_sucursal);

  return mapSerieRow(row);
};

export const createSerie = async ({ auth, scope, body, requestMeta }) => {
  const { moduloKey, tipoKey } = validateModuloTipo(
    body?.modulo,
    body?.tipo_comprobante
  );

  const idSucursal = Number(body?.id_sucursal ?? scope?.id_sucursal);

  if (!Number.isInteger(idSucursal) || idSucursal <= 0) {
    throw HttpError.badRequest("id_sucursal invalido");
  }

  ensureBranchAccess(auth, idSucursal);

  const serie = normalizeSerieInput(body?.serie);
  const nombre = normalizeText(body?.nombre);

  if (!nombre) {
    throw HttpError.badRequest("nombre es requerido");
  }

  const correlativoInicial = Number(body?.ultimo_correlativo ?? 0);

  if (
    !Number.isInteger(correlativoInicial) ||
    correlativoInicial < 0 ||
    correlativoInicial > 9_999_999
  ) {
    throw HttpError.badRequest(
      "ultimo_correlativo debe ser un entero entre 0 y 9999999"
    );
  }

  const insertResult = await pool.query(
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
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      on conflict (id_empresa, id_sucursal, modulo, tipo_comprobante, serie)
      do nothing
      returning *
    `,
    [
      auth.id_empresa,
      idSucursal,
      moduloKey,
      tipoKey,
      nombre,
      serie,
      correlativoInicial,
      body?.activo === false ? false : true,
      auth.id_usuario,
    ]
  );

  if (insertResult.rowCount === 0) {
    throw HttpError.conflict(
      "Ya existe una serie con esa combinacion de modulo, tipo_comprobante y serie en la sucursal"
    );
  }

  const created = mapSerieRow({
    ...insertResult.rows[0],
    sucursal_nombre: null,
  });

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "COMPROBANTES",
    entidad: "COMPROBANTE_SERIE",
    entidadId: created.id_comprobante_serie,
    accion: "CREATE",
    despues: created,
  });

  return getSerieById({
    auth,
    idComprobanteSerie: created.id_comprobante_serie,
  });
};

export const updateSerie = async ({
  auth,
  scope,
  idComprobanteSerie,
  body,
  requestMeta,
}) => {
  const before = await getSerieById({ auth, idComprobanteSerie });

  const updates = [];
  const params = [];
  let index = 1;

  if (body?.nombre !== undefined) {
    const nombre = normalizeText(body.nombre);

    if (!nombre) {
      throw HttpError.badRequest("nombre no puede estar vacio");
    }

    updates.push(`nombre = $${index}`);
    params.push(nombre);
    index += 1;
  }

  if (body?.activo !== undefined) {
    updates.push(`activo = $${index}`);
    params.push(body.activo === true || String(body.activo) === "true");
    index += 1;
  }

  if (body?.ultimo_correlativo !== undefined) {
    if (!isPrivileged(auth)) {
      throw HttpError.forbidden(
        "Solo SUPER_ADMIN o ADMIN_EMPRESA pueden ajustar el correlativo"
      );
    }

    const valor = Number(body.ultimo_correlativo);

    if (!Number.isInteger(valor) || valor < 0 || valor > 9_999_999) {
      throw HttpError.badRequest(
        "ultimo_correlativo debe ser un entero entre 0 y 9999999"
      );
    }

    if (valor < Number(before.ultimo_correlativo)) {
      throw HttpError.badRequest(
        `No puedes retroceder el correlativo. Valor actual: ${before.ultimo_correlativo}`
      );
    }

    updates.push(`ultimo_correlativo = $${index}`);
    params.push(valor);
    index += 1;
  }

  if (updates.length === 0) {
    return before;
  }

  updates.push(`updated_by = $${index}`);
  params.push(auth.id_usuario);
  index += 1;

  params.push(auth.id_empresa, idComprobanteSerie);

  await pool.query(
    `
      update comprobante_series
      set ${updates.join(", ")}
      where id_empresa = $${index}
        and id_comprobante_serie = $${index + 1}
    `,
    params
  );

  const after = await getSerieById({ auth, idComprobanteSerie });

  await writeAuditEvent(pool, {
    auth,
    scope,
    requestMeta,
    modulo: "COMPROBANTES",
    entidad: "COMPROBANTE_SERIE",
    entidadId: idComprobanteSerie,
    accion: "UPDATE",
    antes: before,
    despues: after,
  });

  return after;
};
