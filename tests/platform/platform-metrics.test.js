import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src-saas/config/db.js", () => ({
  pool: {
    query: queryMock,
  },
}));

vi.mock("../../src-saas/shared/audit/audit-log.js", () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("../../src-saas/shared/security/jwt.js", () => ({
  signAccessToken: vi.fn(() => "token"),
}));

const { getPlatformMetrics } = await import(
  "../../src-saas/modules/platform/platform.service.js"
);

describe("platform metrics", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("uses saas_planes.precio_mensual for MRR", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ estado: "ACTIVA", n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ mrr_usd: "49.99" }] })
      .mockResolvedValueOnce({
        rows: [{ plan: "PRO", empresas: 1, activas: 1 }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ churn_30d: 0 }] })
      .mockResolvedValueOnce({ rows: [{ nuevas_30d: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPlatformMetrics();
    const mrrSql = queryMock.mock.calls[1][0];

    expect(mrrSql).toContain("p.precio_mensual");
    expect(mrrSql).not.toContain("precio_mensual_usd");
    expect(result.mrr_usd).toBe(49.99);
    expect(result.arr_usd).toBe(599.88);
  });
});
