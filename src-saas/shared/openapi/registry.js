import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Registry para coleccionar definiciones de endpoints y schemas zod
 * y luego serializarlos como OpenAPI 3.1.
 *
 * Uso:
 *   import { registerPath } from "../shared/openapi/registry.js";
 *   import { ventaCreateSchema } from "../shared/validation/common-schemas.js";
 *
 *   registerPath({
 *     method: "post",
 *     path: "/api/saas/ventas",
 *     summary: "Crear venta",
 *     tags: ["Ventas"],
 *     security: [{ bearerAuth: [] }],
 *     body: ventaCreateSchema,
 *     responses: {
 *       201: { description: "Venta creada" },
 *       400: { description: "Validacion fallida" },
 *     },
 *   });
 */

const paths = new Map(); // path -> { method -> spec }
const schemasByName = new Map();

const slugifyName = (name) =>
  String(name || "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * Registra (o reusa) un schema zod nombrado para que aparezca en
 * components/schemas y se pueda referenciar via $ref.
 */
export const registerNamedSchema = (name, zodSchema) => {
  const cleanName = slugifyName(name);
  if (!schemasByName.has(cleanName)) {
    schemasByName.set(
      cleanName,
      zodToJsonSchema(zodSchema, { name: cleanName, target: "openApi3" })
    );
  }
  return { $ref: `#/components/schemas/${cleanName}` };
};

const buildSchemaInline = (zodSchema) =>
  zodToJsonSchema(zodSchema, { target: "openApi3" });

const upsertPath = (path) => {
  if (!paths.has(path)) paths.set(path, {});
  return paths.get(path);
};

/**
 * Registra un endpoint.
 *
 * @param {object} opts
 * @param {"get"|"post"|"put"|"patch"|"delete"} opts.method
 * @param {string} opts.path  - ruta openapi (con :id se convierte a {id})
 * @param {string} opts.summary
 * @param {string} [opts.description]
 * @param {string[]} [opts.tags]
 * @param {object[]} [opts.security]  - default: [{ bearerAuth: [] }]
 * @param {ZodSchema} [opts.body]
 * @param {ZodSchema} [opts.query]
 * @param {Record<string, ZodSchema>} [opts.params]
 * @param {object} [opts.responses]
 */
export const registerPath = (opts) => {
  const {
    method,
    path,
    summary,
    description,
    tags = [],
    security,
    body,
    query,
    params,
    responses = { 200: { description: "OK" } },
  } = opts;

  // Convertir :param a {param}
  const openapiPath = path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
  const pathItem = upsertPath(openapiPath);

  const operation = {
    summary,
    description,
    tags,
    security: security || [{ bearerAuth: [] }],
    parameters: [],
    responses,
  };

  // Path parameters
  if (params) {
    for (const [name, schema] of Object.entries(params)) {
      operation.parameters.push({
        name,
        in: "path",
        required: true,
        schema: buildSchemaInline(schema),
      });
    }
  }
  // Auto-detect path params del openapiPath si no estan en params explicitos
  const pathParamNames = [...openapiPath.matchAll(/\{([^}]+)\}/g)].map(
    (m) => m[1]
  );
  for (const name of pathParamNames) {
    if (!operation.parameters.find((p) => p.name === name && p.in === "path")) {
      operation.parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 },
      });
    }
  }

  // Query
  if (query) {
    const qSchema = buildSchemaInline(query);
    if (qSchema?.properties) {
      const required = new Set(qSchema.required || []);
      for (const [name, def] of Object.entries(qSchema.properties)) {
        operation.parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema: def,
        });
      }
    }
  }

  // Body
  if (body) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: buildSchemaInline(body),
        },
      },
    };
  }

  // X-Sucursal-Id header (estandar del SaaS)
  operation.parameters.push({
    name: "X-Sucursal-Id",
    in: "header",
    required: false,
    schema: { type: "integer", minimum: 1 },
    description: "Sucursal contextual de la operacion",
  });

  pathItem[method.toLowerCase()] = operation;
};

/**
 * Construye el documento OpenAPI 3.1 completo.
 */
export const buildOpenApiDocument = ({
  title = "POS SaaS API",
  version = "1.0.0",
  description = "API multi-tenant para POS + CarWash",
  serverUrl = "/api/saas",
} = {}) => {
  const pathsObj = {};
  for (const [path, methods] of paths.entries()) {
    pathsObj[path] = methods;
  }

  const componentsSchemas = {};
  for (const [name, schema] of schemasByName.entries()) {
    componentsSchemas[name] = schema;
  }

  return {
    openapi: "3.1.0",
    info: {
      title,
      version,
      description,
    },
    servers: [{ url: serverUrl }],
    components: {
      schemas: componentsSchemas,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "saas_rt",
        },
      },
    },
    paths: pathsObj,
  };
};

/**
 * HTML que monta Swagger UI desde CDN apuntando a /api/saas/openapi.json
 */
export const buildSwaggerUiHtml = (specUrl) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>POS SaaS API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0}#swagger-ui{max-width:1200px;margin:0 auto}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis],
      deepLinking: true,
      docExpansion: "list",
      defaultModelsExpandDepth: 1,
    });
  </script>
</body>
</html>`;
