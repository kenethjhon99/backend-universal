import { describe, expect, it, vi } from "vitest";
import { requireModule } from "../../src-saas/middlewares/require-module.js";

const runMiddleware = (middleware, req) =>
  new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });

describe("requireModule", () => {
  it("blocks SaaS super admins from operating tenant modules directly", async () => {
    const error = await runMiddleware(requireModule("POS"), {
      auth: {
        rol: "SUPER_ADMIN",
        modulos: ["POS"],
      },
    });

    expect(error).toBeTruthy();
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain("administrador SaaS");
  });

  it("allows impersonated tenant sessions to use tenant modules", async () => {
    const next = vi.fn();
    const middleware = requireModule("POS");

    middleware(
      {
        auth: {
          rol: "ADMIN_EMPRESA",
          impersonation: true,
          modulos: ["POS"],
        },
      },
      {},
      next
    );

    expect(next).toHaveBeenCalledWith();
  });
});
