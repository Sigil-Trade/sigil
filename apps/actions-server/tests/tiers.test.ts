import { expect } from "chai";
import { Hono } from "hono";
import { tiers } from "../src/routes/tiers";

describe("Tiers Route", () => {
  const app = new Hono();
  app.route("/", tiers);

  describe("GET /api/actions/tiers", () => {
    it("returns 200 with tiers and templates", async () => {
      const res = await app.request("/api/actions/tiers");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.tiers).to.be.an("array");
      expect(body.templates).to.be.an("array");
      expect(body.recommendation).to.be.a("string");
    });

    it("returns exactly 3 tiers", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      expect(body.tiers).to.have.length(3);
      expect(body.tiers[0].tier).to.equal(1);
      expect(body.tiers[1].tier).to.equal(2);
      expect(body.tiers[2].tier).to.equal(3);
    });

    it("returns exactly 3 templates", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      expect(body.templates).to.have.length(3);
      const names = body.templates.map((t: any) => t.name);
      expect(names).to.include("conservative");
      expect(names).to.include("moderate");
      expect(names).to.include("aggressive");
    });

    it("only tier 3 is recommended", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      expect(body.tiers[0].recommended).to.equal(false);
      expect(body.tiers[1].recommended).to.equal(false);
      expect(body.tiers[2].recommended).to.equal(true);
    });

    it("tier 1 has limitations about no key protection", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      const tier1 = body.tiers[0];
      expect(tier1.limitations).to.be.an("array");
      const limitationsStr = tier1.limitations.join(" ");
      expect(limitationsStr).to.include("key protection");
      expect(limitationsStr).to.include("Not suitable for production");
    });

    it("tier 3 has on-chain enforcement features", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      const tier3 = body.tiers[2];
      expect(tier3.features).to.be.an("array");
      const featuresStr = tier3.features.join(" ").toLowerCase();
      expect(featuresStr).to.include("on-chain");
      expect(featuresStr).to.include("kill-switch");
      expect(featuresStr).to.include("audit trail");
    });

    it("recommendation favors tier 3", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      expect(body.recommendation).to.include("Tier 3");
      expect(body.recommendation).to.include("blockchain level");
    });

    it("includes CORS headers", async () => {
      const res = await app.request("/api/actions/tiers");
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
      expect(res.headers.get("Content-Type")).to.include("application/json");
    });

    it("templates include numeric fields", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      for (const t of body.templates) {
        expect(t.dailyCapUsd).to.be.a("number");
        expect(t.maxTxUsd).to.be.a("number");
        expect(t.maxLeverageBps).to.be.a("number");
        expect(t.maxConcurrentPositions).to.be.a("number");
        expect(t.protocols).to.be.an("array");
      }
    });

    it("tier info includes all required fields", async () => {
      const res = await app.request("/api/actions/tiers");
      const body = (await res.json()) as any;
      for (const tier of body.tiers) {
        expect(tier.tier).to.be.a("number");
        expect(tier.name).to.be.a("string");
        expect(tier.label).to.be.a("string");
        expect(tier.description).to.be.a("string");
        expect(tier.security).to.be.a("string");
        expect(tier.cost).to.be.a("string");
        expect(tier.setupTime).to.be.a("string");
        expect(tier.enforcement).to.be.a("string");
        expect(tier.recommended).to.be.a("boolean");
        expect(tier.features).to.be.an("array");
        expect(tier.limitations).to.be.an("array");
      }
    });
  });

  describe("OPTIONS /api/actions/tiers", () => {
    it("returns 200 for preflight", async () => {
      const res = await app.request("/api/actions/tiers", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });
});
