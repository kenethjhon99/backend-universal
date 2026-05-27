import { ZodError } from "zod";
import { HttpError } from "../http/http-error.js";

/**
 * Convierte un ZodError en HttpError 400 con detalles legibles.
 * Cada error incluye `path` (ej. "items.0.cantidad") y `message` corto.
 */
const formatZodError = (zodError) => {
  return zodError.errors.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
};

/**
 * Helper para validar `req.body | req.query | req.params` con un schema zod.
 * Si la validacion falla lanza HttpError.badRequest("Validacion fallida", details).
 *
 *   const dto = parseOrThrow(VentasCreateSchema, req.body, "body");
 *   // dto es el body parseado y tipado segun el schema
 */
export const parseOrThrow = (schema, value, location = "body") => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw HttpError.badRequest(`Validacion fallida en ${location}`, {
      issues: formatZodError(result.error),
    });
  }

  return result.data;
};

/**
 * Middleware factory para validar request automaticamente.
 *
 *   router.post("/", validate({ body: VentasCreateSchema }), controller.createVenta);
 *
 * Si validan multiples partes en un solo middleware:
 *   validate({ body: BodySchema, query: QuerySchema, params: ParamsSchema })
 *
 * Las versiones parseadas se asignan a req.validated.body / .query / .params
 * para que los controllers consuman datos ya tipados sin re-validar.
 */
export const validate = (schemas = {}) => {
  return (req, _res, next) => {
    try {
      req.validated = req.validated || {};

      if (schemas.body) {
        req.validated.body = parseOrThrow(schemas.body, req.body, "body");
      }
      if (schemas.query) {
        req.validated.query = parseOrThrow(schemas.query, req.query, "query");
      }
      if (schemas.params) {
        req.validated.params = parseOrThrow(
          schemas.params,
          req.params,
          "params"
        );
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(
          HttpError.badRequest("Validacion fallida", {
            issues: formatZodError(error),
          })
        );
      } else {
        next(error);
      }
    }
  };
};
