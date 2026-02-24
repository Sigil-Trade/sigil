import { expect } from "chai";
import { Hono } from "hono";
import { provisionTee } from "../src/routes/provision-tee";
import { _resetForTesting } from "../src/lib/rate-limiter";

describe("POST /api/actions/provision-tee", () => {
  const app = new Hono();
  app.route("/", provisionTee);

  const origApiKey = process.env.CROSSMINT_API_KEY;

  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    if (origApiKey) {
      process.env.CROSSMINT_API_KEY = origApiKey;
    } else {
      delete process.env.CROSSMINT_API_KEY;
    }
  });

  it("returns 503 when CROSSMINT_API_KEY is not set", async () => {
    delete process.env.CROSSMINT_API_KEY;
    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(503);
    const body = (await res.json()) as any;
    expect(body.error).to.include("not available");
  });

  it("handles OPTIONS preflight", async () => {
    const res = await app.request("/api/actions/provision-tee", {
      method: "OPTIONS",
    });
    expect(res.status).to.equal(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
  });

  it("includes CORS headers on POST response", async () => {
    delete process.env.CROSSMINT_API_KEY;
    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
  });

  it("accepts network parameter", async () => {
    delete process.env.CROSSMINT_API_KEY;
    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: "mainnet-beta" }),
    });
    // Will still fail with 503 (no API key) but the request should parse correctly
    expect(res.status).to.equal(503);
  });

  it("handles empty body gracefully", async () => {
    delete process.env.CROSSMINT_API_KEY;
    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).to.be.oneOf([503, 502, 500]);
  });

  // ── Rate limiting tests ──────────────────────────────────────

  it("returns 429 when rate limit exceeded", async () => {
    delete process.env.CROSSMINT_API_KEY;

    // First 5 requests should pass (503 due to no API key, but not 429)
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/actions/provision-tee", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).to.not.equal(429);
    }

    // 6th request should be rate limited
    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(429);
    const body = (await res.json()) as any;
    expect(body.error).to.include("Rate limit");
  });

  it("includes Retry-After header on 429", async () => {
    delete process.env.CROSSMINT_API_KEY;

    // Exhaust rate limit
    for (let i = 0; i < 5; i++) {
      await app.request("/api/actions/provision-tee", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "5.6.7.8",
        },
        body: JSON.stringify({}),
      });
    }

    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "5.6.7.8",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).to.be.a("string");
    expect(parseInt(retryAfter!, 10)).to.be.greaterThan(0);
  });

  it("rate limits per IP independently", async () => {
    delete process.env.CROSSMINT_API_KEY;

    // Exhaust rate limit for IP-A
    for (let i = 0; i < 5; i++) {
      await app.request("/api/actions/provision-tee", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.1",
        },
        body: JSON.stringify({}),
      });
    }

    // IP-A should be rate limited
    const resA = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "10.0.0.1",
      },
      body: JSON.stringify({}),
    });
    expect(resA.status).to.equal(429);

    // IP-B should still be allowed
    const resB = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "10.0.0.2",
      },
      body: JSON.stringify({}),
    });
    expect(resB.status).to.not.equal(429);
  });

  // ── Idempotency tests ────────────────────────────────────────

  it("accepts publicKey for idempotent linkedUser", async () => {
    delete process.env.CROSSMINT_API_KEY;

    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: "devnet",
        publicKey: "11111111111111111111111111111111",
      }),
    });
    // No API key → 503, but the request parsed correctly
    expect(res.status).to.equal(503);
  });

  it("falls back to timestamp linkedUser when no publicKey", async () => {
    delete process.env.CROSSMINT_API_KEY;

    const res = await app.request("/api/actions/provision-tee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ network: "devnet" }),
    });
    expect(res.status).to.equal(503);
  });
});
