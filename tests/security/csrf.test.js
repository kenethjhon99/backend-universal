/**
 * Test: csrfGuard middleware.
 *
 * Cubre:
 *  - GET / HEAD / OPTIONS: nunca bloquea.
 *  - Origin valido + cookie+header coincidentes: pasa.
 *  - Origin invalido: 403.
 *  - Sin Origin ni Referer en produccion: 403.
 *  - Cookie/header mismatch: 403.
 *  - Cookie sin header (o viceversa): 403 en prod, bypass en dev.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const reset = () => {
  process.env = { ...ORIGINAL_ENV };
  // Defaults para que env.js no se queje
  process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(40);
  process.env.PGDATABASE = process.env.PGDATABASE || "pos_saas_test";
  process.env.PGUSER = process.env.PGUSER || "postgres";
  process.env.PGPASSWORD = process.env.PGPASSWORD || "x";
};

beforeEach(reset);
afterEach(reset);

const importFresh = async () => {
  const url = `../../src-saas/middlewares/csrf.js?cb=${Math.random()}`;
  return await import(url);
};

const mockReq = ({ method = "POST", headers = {}, cookies = {} } = {}) => ({
  method,
  originalUrl: "/api/saas/auth/refresh",
  headers: Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  ),
  cookies,
});

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return res;
};

describe("csrfGuard - safe methods", () => {
  it("GET pasa sin validar nada", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    let called = false;
    csrfGuard(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("OPTIONS pasa sin validar nada", async () => {
    process.env.NODE_ENV = "production";
    const { csrfGuard } = await importFresh();
    const req = mockReq({ method: "OPTIONS" });
    const res = mockRes();
    let called = false;
    csrfGuard(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe("csrfGuard - validacion Origin/Referer", () => {
  it("prod: sin Origin ni Referer = 403", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    csrfGuard(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("csrf_origin_required");
  });

  it("prod: Origin no en lista = 403", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: { origin: "https://evil.com" },
    });
    const res = mockRes();
    csrfGuard(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("csrf_origin_invalid");
  });

  it("prod: Origin valido + cookie+header coincidentes = pasa", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: { origin: "https://app.test.com", "x-xsrf-token": "abc123" },
      cookies: { "XSRF-TOKEN": "abc123" },
    });
    const res = mockRes();
    let called = false;
    csrfGuard(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("prod: Referer valido cuando no hay Origin = pasa (con token)", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: {
        referer: "https://app.test.com/dashboard",
        "x-xsrf-token": "abc",
      },
      cookies: { "XSRF-TOKEN": "abc" },
    });
    const res = mockRes();
    let called = false;
    csrfGuard(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("dev: sin Origin permite (DX curl/postman)", async () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_ORIGINS = "http://localhost:5173";
    const { csrfGuard } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    let called = false;
    csrfGuard(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe("csrfGuard - double-submit token", () => {
  it("prod: cookie sin header = 403", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: { origin: "https://app.test.com" },
      cookies: { "XSRF-TOKEN": "abc" },
    });
    const res = mockRes();
    csrfGuard(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("csrf_token_missing");
  });

  it("prod: header sin cookie = 403", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: { origin: "https://app.test.com", "x-xsrf-token": "abc" },
    });
    const res = mockRes();
    csrfGuard(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("csrf_token_missing");
  });

  it("prod: cookie != header = 403", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGINS = "https://app.test.com";
    const { csrfGuard } = await importFresh();
    const req = mockReq({
      headers: { origin: "https://app.test.com", "x-xsrf-token": "wrong" },
      cookies: { "XSRF-TOKEN": "right" },
    });
    const res = mockRes();
    csrfGuard(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("csrf_token_mismatch");
  });
});
