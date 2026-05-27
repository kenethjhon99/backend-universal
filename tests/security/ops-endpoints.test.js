/**
 * Test: proteccion de /metrics, /api/saas/docs, /api/saas/openapi.json.
 *
 * Verificamos que en distintos modos (env vars) los endpoints responden
 * con el status code esperado. Usamos supertest si está disponible; si no,
 * llamamos al handler directamente con req/res mocks ligeros.
 *
 * Como el comportamiento del middleware depende de NODE_ENV evaluado al
 * importar, este test usa importDynamicly() con env reseteado en cada caso.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const reset = () => {
  process.env = { ...ORIGINAL_ENV };
};

beforeEach(reset);
afterEach(reset);

const importFresh = async () => {
  // Reset module cache para que el modulo lea las env vars nuevas.
  // Vitest no expone clearModule de forma trivial, usamos `?cacheBust=...`
  const url = `../../src-saas/middlewares/protect-ops-endpoints.js?cb=${Math.random()}`;
  return await import(url);
};

const mockReq = (headers = {}) => ({
  headers: Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  ),
});

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
  return res;
};

describe("protectMetrics", () => {
  it("dev sin METRICS_TOKEN: abierto (next)", async () => {
    process.env.NODE_ENV = "development";
    process.env.METRICS_TOKEN = "";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectMetrics } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    protectMetrics(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("dev con METRICS_TOKEN: requiere coincidir", async () => {
    process.env.NODE_ENV = "development";
    process.env.METRICS_TOKEN = "secret-abc";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectMetrics } = await importFresh();

    // Sin header
    {
      const req = mockReq();
      const res = mockRes();
      protectMetrics(req, res, () => {});
      expect(res.statusCode).toBe(401);
    }

    // Header mal
    {
      const req = mockReq({ "x-metrics-token": "wrong" });
      const res = mockRes();
      protectMetrics(req, res, () => {});
      expect(res.statusCode).toBe(401);
    }

    // Header bien
    {
      const req = mockReq({ "x-metrics-token": "secret-abc" });
      const res = mockRes();
      let nextCalled = false;
      protectMetrics(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }

    // Bearer bien
    {
      const req = mockReq({ authorization: "Bearer secret-abc" });
      const res = mockRes();
      let nextCalled = false;
      protectMetrics(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }
  });

  it("prod sin METRICS_TOKEN: 401 (no abrir por accidente)", async () => {
    process.env.NODE_ENV = "production";
    process.env.METRICS_TOKEN = "";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectMetrics } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    protectMetrics(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});

describe("protectDocs", () => {
  it("dev: default public (next)", async () => {
    process.env.NODE_ENV = "development";
    process.env.API_DOCS_MODE = "";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    protectDocs(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("prod: default off (404)", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    protectDocs(req, res, () => {});
    expect(res.statusCode).toBe(404);
  });

  it("token mode sin API_DOCS_TOKEN: 503", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "token";
    process.env.API_DOCS_TOKEN = "";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    protectDocs(req, res, () => {});
    expect(res.statusCode).toBe(503);
  });

  it("token mode con coincidencia: next", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "token";
    process.env.API_DOCS_TOKEN = "docs-secret";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq({ "x-docs-token": "docs-secret" });
    const res = mockRes();
    let nextCalled = false;
    protectDocs(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("token mode con token errado: 401", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "token";
    process.env.API_DOCS_TOKEN = "docs-secret";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq({ "x-docs-token": "wrong" });
    const res = mockRes();
    protectDocs(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it("admin mode sin Authorization: 401", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "admin";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq();
    const res = mockRes();
    protectDocs(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it("admin mode con JWT invalido: 401", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_DOCS_MODE = "admin";
    process.env.JWT_SECRET = "a".repeat(40);
    const { protectDocs } = await importFresh();
    const req = mockReq({ authorization: "Bearer not.a.jwt" });
    const res = mockRes();
    protectDocs(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});
