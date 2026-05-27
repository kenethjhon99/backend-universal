import { describe, expect, it, vi } from "vitest";
import {
  assertLoginNotLocked,
  clearLoginFailures,
  getLoginLockStatus,
  recordLoginFailure,
} from "../../src-saas/shared/security/login-attempts.js";

describe("login-attempts security helpers", () => {
  it("allows login when failed attempts are below the lock threshold", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{ total: 2, last_attempt_at: new Date().toISOString() }],
      })),
    };

    const status = await assertLoginNotLocked(db, {
      email: "User@Example.com",
    });

    expect(status.locked).toBe(false);
  });

  it("locks login when recent failed attempts reach the threshold", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [{ total: 5, last_attempt_at: new Date().toISOString() }],
      })),
    };

    await expect(
      getLoginLockStatus(db, { email: "user@example.com" })
    ).resolves.toMatchObject({ locked: true, failedAttempts: 5 });

    await expect(
      assertLoginNotLocked(db, { email: "user@example.com" })
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("persists and clears failed attempts using normalized email", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };

    await recordLoginFailure(db, {
      email: " User@Example.com ",
      idEmpresa: 1,
      idUsuario: 2,
      ip: "127.0.0.1",
      userAgent: "vitest",
      motivo: "invalid_credentials",
    });
    await clearLoginFailures(db, {
      email: " User@Example.com ",
      idEmpresa: 1,
      idUsuario: 2,
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1][2]).toBe("user@example.com");
    expect(db.query.mock.calls[1][1][0]).toBe("user@example.com");
  });
});

