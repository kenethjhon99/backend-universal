/**
 * Errores HTTP tipados.
 * Reemplaza progresivamente a http-error.js (que se mantiene como re-export
 * por retrocompatibilidad de imports `.js`).
 */

export class HttpError extends Error {
  statusCode: number;
  details: unknown;

  constructor(statusCode: number, message: string, details: unknown = null) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }

  static badRequest(message: string, details: unknown = null): HttpError {
    return new HttpError(400, message, details);
  }

  static unauthorized(
    message = "No autorizado",
    details: unknown = null
  ): HttpError {
    return new HttpError(401, message, details);
  }

  static forbidden(
    message = "Sin permisos",
    details: unknown = null
  ): HttpError {
    return new HttpError(403, message, details);
  }

  static notFound(
    message = "Recurso no encontrado",
    details: unknown = null
  ): HttpError {
    return new HttpError(404, message, details);
  }

  static conflict(message: string, details: unknown = null): HttpError {
    return new HttpError(409, message, details);
  }
}
