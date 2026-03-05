import { expect } from "chai";
import { Hono } from "hono";
import { protection } from "../src/routes/protection";

describe("Protection Route", () => {
  const app = new Hono();
  app.route("/", protection);

  describe("GET /api/actions/protection", () => {
    it("returns 200 with protection info and templates", async () => {
      const res = await app.request("/api/actions/protection");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.protection).to.be.an("object");
      expect(body.templates).to.be.an("array");
    });

    it("returns single protection model (not tiers)", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      expect(body.protection.name).to.equal("Phalnx");
      expect(body.protection.layers).to.be.an("array");
      expect(body.protection.layers.length).to.equal(3);
    });

    it("returns exactly 3 templates", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      expect(body.templates).to.have.length(3);
      const names = body.templates.map((t: any) => t.name);
      expect(names).to.include("conservative");
      expect(names).to.include("moderate");
      expect(names).to.include("aggressive");
    });

    it("protection description mentions on-chain guardrails", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      expect(body.protection.description.toLowerCase()).to.include("on-chain");
      expect(body.protection.description).to.include("Solana validators");
    });

    it("features include on-chain enforcement capabilities", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      const features = body.protection.features;
      expect(features).to.be.an("array");
      const featuresStr = features.join(" ").toLowerCase();
      expect(featuresStr).to.include("on-chain");
      expect(featuresStr).to.include("kill-switch");
      expect(featuresStr).to.include("audit trail");
    });

    it("includes cost and setup time", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      expect(body.protection.cost).to.be.a("string");
      expect(body.protection.setupTime).to.be.a("string");
      expect(body.protection.cost).to.include("SOL");
    });

    it("includes CORS headers", async () => {
      const res = await app.request("/api/actions/protection");
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
      expect(res.headers.get("Content-Type")).to.include("application/json");
    });

    it("templates include numeric fields", async () => {
      const res = await app.request("/api/actions/protection");
      const body = (await res.json()) as any;
      for (const t of body.templates) {
        expect(t.dailyCapUsd).to.be.a("number");
        expect(t.maxTxUsd).to.be.a("number");
        expect(t.maxLeverageBps).to.be.a("number");
        expect(t.maxConcurrentPositions).to.be.a("number");
        expect(t.protocols).to.be.an("array");
      }
    });
  });

  describe("OPTIONS /api/actions/protection", () => {
    it("returns 200 for preflight", async () => {
      const res = await app.request("/api/actions/protection", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });
});
