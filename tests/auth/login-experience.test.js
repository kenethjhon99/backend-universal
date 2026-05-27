import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const compareMock = vi.fn();

vi.mock("../../src-saas/config/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

vi.mock("bcrypt", () => ({
  default: {
    compare: compareMock,
  },
}));

vi.mock("../../src-saas/shared/security/jwt.js", () => ({
  signAccessToken: vi.fn(() => "access-token"),
}));

vi.mock("../../src-saas/modules/mfa/mfa.service.js", () => ({
  userHasMfaEnabled: vi.fn(async () => false),
}));

const authService = await import(
  "../../src-saas/modules/auth/auth.service.js"
);

describe("SaaS login experience", () => {
  beforeEach(() => {
    queryMock.mockReset();
    compareMock.mockReset();
  });

  it("returns platform branding context when no tenant host is resolved", async () => {
    const result = await authService.getPublicAuthContext();

    expect(result.mode).toBe("platform");
    expect(result.tenant).toBeNull();
    expect(result.branding.nombre_comercial).toBeTruthy();
    expect(result.capabilities.email_login).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns tenant branding context when host resolution provides a tenant", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id_empresa: 15,
          slug: "empresa-demo",
          nombre_legal: "Empresa Demo",
          estado: "ACTIVA",
        },
      ],
    });

    const result = await authService.getPublicAuthContext({
      tenantContext: {
        id_empresa: 15,
        hostname: "pos.empresa.test",
        branding: { nombre_comercial: "Demo POS", color_primario: "#111111" },
      },
    });

    expect(result.mode).toBe("tenant");
    expect(result.tenant.id_empresa).toBe(15);
    expect(result.tenant.hostname).toBe("pos.empresa.test");
    expect(result.branding.nombre_comercial).toBe("Demo POS");
    expect(result.branding.color_primario).toBe("#111111");
    expect(result.capabilities.white_label).toBe(true);
  });

  it("requires company selection after a valid password for a multi-company user", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ total: 0, last_attempt_at: null }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id_usuario: 10,
          id_empresa: 1,
          username: "ana",
          email: "ana@example.com",
          password_hash: "hash-a",
          activo: true,
          empresa_slug: "empresa-a",
          nombre_legal: "Empresa A",
          empresa_estado: "ACTIVA",
        },
        {
          id_usuario: 20,
          id_empresa: 2,
          username: "ana",
          email: "ana@example.com",
          password_hash: "hash-b",
          activo: true,
          empresa_slug: "empresa-b",
          nombre_legal: "Empresa B",
          empresa_estado: "ACTIVA",
        },
      ],
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    compareMock.mockResolvedValue(true);

    const result = await authService.login({
      email: "Ana@Example.com ",
      password: "correct-password",
    });

    expect(result.company_selection_required).toBe(true);
    expect(result.challenge_token).toBeTruthy();
    expect(result.companies).toEqual([
      { id_empresa: 1, slug: "empresa-a", nombre_legal: "Empresa A" },
      { id_empresa: 2, slug: "empresa-b", nombre_legal: "Empresa B" },
    ]);
  });
});
