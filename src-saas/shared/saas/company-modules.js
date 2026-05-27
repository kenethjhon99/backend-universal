import { HttpError } from "../http/http-error.js";

export const DEFAULT_MODULE_CODES = [
  "POS",
  "INVENTARIO",
  "COMPRAS",
  "FINANZAS",
  "REPORTES",
];

const isPlainObject = (value) =>
  Object.prototype.toString.call(value) === "[object Object]";

export const normalizeModuleCode = (value) =>
  String(value || "").trim().toUpperCase();

const normalizeModuleConfig = (value) => {
  if (isPlainObject(value) || Array.isArray(value)) {
    return value;
  }

  return {};
};

export const normalizeActiveModuleCodes = (
  input,
  { fallback = DEFAULT_MODULE_CODES } = {}
) => {
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const moduleCodes = [];

  for (const item of source) {
    const code = normalizeModuleCode(
      typeof item === "string" ? item : item?.codigo
    );
    const isActive = typeof item === "string" ? true : item?.activo !== false;

    if (!code || !isActive || seen.has(code)) {
      continue;
    }

    seen.add(code);
    moduleCodes.push(code);
  }

  return moduleCodes;
};

export const normalizeModuleAssignments = (input) => {
  if (!Array.isArray(input)) {
    throw HttpError.badRequest("modulos debe ser un arreglo");
  }

  const seen = new Set();
  const assignments = [];

  for (const item of input) {
    const code = normalizeModuleCode(
      typeof item === "string" ? item : item?.codigo
    );

    if (!code) {
      continue;
    }

    if (seen.has(code)) {
      throw HttpError.badRequest(`Modulo duplicado: ${code}`);
    }

    seen.add(code);
    assignments.push({
      codigo: code,
      activo: typeof item === "string" ? true : item?.activo !== false,
      config:
        typeof item === "string" ? {} : normalizeModuleConfig(item?.config),
    });
  }

  return assignments;
};

export const getModuleCatalog = async (db) => {
  const result = await db.query(
    `
      select id_modulo, codigo, nombre, descripcion
      from modulos
      order by codigo asc
    `
  );

  return result.rows;
};

export const getModuleRowsByCodes = async (db, moduleCodes) => {
  if (!Array.isArray(moduleCodes) || moduleCodes.length === 0) {
    return [];
  }

  const normalizedCodes = [...new Set(moduleCodes.map(normalizeModuleCode))];
  const result = await db.query(
    `
      select id_modulo, codigo, nombre, descripcion
      from modulos
      where codigo = any($1::text[])
      order by codigo asc
    `,
    [normalizedCodes]
  );

  if (result.rowCount !== normalizedCodes.length) {
    const foundCodes = new Set(result.rows.map((row) => row.codigo));
    const missingCodes = normalizedCodes.filter((code) => !foundCodes.has(code));

    throw HttpError.badRequest("No se encontraron todos los modulos solicitados", {
      modulos_invalidos: missingCodes,
    });
  }

  return result.rows;
};

export const getCompanyModuleStates = async (db, idEmpresa) => {
  const result = await db.query(
    `
      select
        m.codigo,
        m.nombre,
        m.descripcion,
        coalesce(em.activo, false) as activo,
        coalesce(em.config, '{}'::jsonb) as config
      from modulos m
      left join empresas_modulos em
        on em.id_modulo = m.id_modulo
       and em.id_empresa = $1
      order by m.codigo asc
    `,
    [idEmpresa]
  );

  return result.rows;
};

export const syncCompanyModules = async (
  db,
  { idEmpresa, moduleAssignments, actorId = null }
) => {
  const catalog = await getModuleCatalog(db);
  const catalogByCode = new Map(catalog.map((row) => [row.codigo, row]));
  const assignmentByCode = new Map();

  for (const assignment of moduleAssignments) {
    const code = normalizeModuleCode(assignment?.codigo);

    if (!catalogByCode.has(code)) {
      throw HttpError.badRequest(`Modulo no reconocido: ${code}`);
    }

    assignmentByCode.set(code, {
      codigo: code,
      activo: assignment?.activo === true,
      config: normalizeModuleConfig(assignment?.config),
    });
  }

  for (const moduleRow of catalog) {
    const assignment = assignmentByCode.get(moduleRow.codigo) || {
      codigo: moduleRow.codigo,
      activo: false,
      config: {},
    };

    await db.query(
      `
        insert into empresas_modulos (
          id_empresa,
          id_modulo,
          activo,
          config,
          created_by,
          updated_by
        )
        values ($1,$2,$3,$4::jsonb,$5,$5)
        on conflict (id_empresa, id_modulo)
        do update
        set
          activo = excluded.activo,
          config = excluded.config,
          updated_at = now(),
          updated_by = excluded.updated_by
      `,
      [
        idEmpresa,
        moduleRow.id_modulo,
        assignment.activo,
        JSON.stringify(assignment.config),
        actorId,
      ]
    );
  }

  return getCompanyModuleStates(db, idEmpresa);
};
