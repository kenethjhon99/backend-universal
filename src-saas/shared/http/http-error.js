export class HttpError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }

  static badRequest(message, details = null) {
    return new HttpError(400, message, details);
  }

  static unauthorized(message = "No autorizado", details = null) {
    return new HttpError(401, message, details);
  }

  /**
   * 402 Payment Required.
   * Usado cuando una accion esta bloqueada por estado de billing:
   *   - Plan sobrepasado (limite alcanzado)
   *   - Suscripcion suspendida por impago
   *   - Trial expirado sin pago
   * El frontend intercepta 402 y redirige a /subscription/suspended.
   */
  static paymentRequired(message = "Pago requerido", details = null) {
    return new HttpError(402, message, details);
  }

  static forbidden(message = "Sin permisos", details = null) {
    return new HttpError(403, message, details);
  }

  static notFound(message = "Recurso no encontrado", details = null) {
    return new HttpError(404, message, details);
  }

  static conflict(message, details = null) {
    return new HttpError(409, message, details);
  }

  static unprocessable(message, details = null) {
    return new HttpError(422, message, details);
  }

  static tooManyRequests(message = "Demasiadas peticiones", details = null) {
    return new HttpError(429, message, details);
  }

  static internal(message = "Error interno", details = null) {
    return new HttpError(500, message, details);
  }

  static serviceUnavailable(message = "Servicio no disponible", details = null) {
    return new HttpError(503, message, details);
  }
}

