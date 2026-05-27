import { describe, expect, it } from "vitest";
import {
  computeEffectivePermissions,
  hasPermission,
} from "../../src-saas/shared/security/permissions.js";

describe("role permission boundaries", () => {
  it("SUPER_ADMIN is limited to SaaS control-plane permissions", () => {
    const permissions = computeEffectivePermissions({ rol: "SUPER_ADMIN" });

    expect(hasPermission(permissions, "company.create")).toBe(true);
    expect(hasPermission(permissions, "company.modules.update")).toBe(true);
    expect(hasPermission(permissions, "sales.manage")).toBe(false);
    expect(hasPermission(permissions, "cash.manage")).toBe(false);
    expect(hasPermission(permissions, "inventory.manage")).toBe(false);
    expect(hasPermission(permissions, "services.manage")).toBe(false);
    expect(hasPermission(permissions, "purchases.manage")).toBe(false);
  });

  it("new operational roles expose only their intended permission families", () => {
    const bodeguero = computeEffectivePermissions({ rol: "BODEGUERO" });
    const compras = computeEffectivePermissions({ rol: "COMPRAS" });
    const operadorCarwash = computeEffectivePermissions({
      rol: "OPERADOR_CARWASH",
    });

    expect(hasPermission(bodeguero, "inventory.manage")).toBe(true);
    expect(hasPermission(bodeguero, "sales.manage")).toBe(false);

    expect(hasPermission(compras, "purchases.manage")).toBe(true);
    expect(hasPermission(compras, "cash.manage")).toBe(false);

    expect(hasPermission(operadorCarwash, "services.manage")).toBe(true);
    expect(hasPermission(operadorCarwash, "sales.manage")).toBe(false);
  });
});
