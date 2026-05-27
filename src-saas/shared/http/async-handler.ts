import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wrapper que convierte un handler async en uno compatible con Express
 * y propaga rejections al error middleware.
 */
export const asyncHandler =
  <Req extends Request = Request, Res extends Response = Response>(
    handler: (req: Req, res: Res, next: NextFunction) => Promise<unknown>
  ): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req as Req, res as Res, next);
    } catch (error) {
      next(error);
    }
  };
