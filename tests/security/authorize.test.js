import { describe, expect, it } from "vitest";
import { authorize } from "../../src-saas/middlewares/authorize.js";

const runMiddleware = (middleware, req) =>
  new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });

const baseAuth = {
  id_empresa: 1,
  id_sucursal: 10,
  id_usuario: 5,
  sucursales: [10, 11],
};

describe("authorize tenant operation boundaries", () => {
  it("blocks SaaS super admins on tenant DB routes unless impersonating", async () => {
    const error = await runMiddleware(
      authorize({
        roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
        allowAnyAssignedSucursal: true,
      }),
      {
        tenantDbContext: true,
        auth: {
          ...baseAuth,
          rol: "SUPER_ADMIN",
        },
      }
    );

    expect(error).toBeTruthy();
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain("administrador SaaS");
  });

  it("blocks SaaS super admins on mixed tenant/control-plane role gates", async () => {
    const error = await runMiddleware(
      authorize({
        roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
        allowAnyAssignedSucursal: true,
      }),
      {
        headers: {},
        auth: {
          ...baseAuth,
          rol: "SUPER_ADMIN",
        },
      }
    );

    expect(error).toBeTruthy();
    expect(error.statusCode).toBe(403);
  });

  it("allows tenant admins on tenant DB routes", async () => {
    const error = await runMiddleware(
      authorize({
        roles: ["ADMIN_EMPRESA"],
        allowAnyAssignedSucursal: true,
      }),
      {
        headers: {},
        tenantDbContext: true,
        auth: {
          ...baseAuth,
          rol: "ADMIN_EMPRESA",
        },
      }
    );

    expect(error).toBeNull();
  });

  it("allows impersonated SaaS sessions on tenant DB routes", async () => {
    const error = await runMiddleware(
      authorize({
        roles: ["SUPER_ADMIN", "ADMIN_EMPRESA"],
        allowAnyAssignedSucursal: true,
      }),
      {
        headers: {},
        tenantDbContext: true,
        auth: {
          ...baseAuth,
          rol: "SUPER_ADMIN",
          impersonation: true,
        },
      }
    );

    expect(error).toBeNull();
  });
});
