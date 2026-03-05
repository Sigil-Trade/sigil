import { expect } from "chai";
import { Hono } from "hono";
import { Keypair } from "@solana/web3.js";
import { fund } from "../src/routes/fund";

describe("Fund Route", () => {
  const app = new Hono();
  app.route("/", fund);

  const testDest = Keypair.generate().publicKey.toBase58();
  const testAccount = Keypair.generate().publicKey.toBase58();

  describe("GET /api/actions/fund", () => {
    it("returns ActionGetResponse with funding metadata", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}`,
      );
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.equal("Fund Phalnx Wallet");
      expect(body.label).to.include("SOL");
    });

    it("includes CORS headers", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}`,
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
      expect(res.headers.get("X-Action-Version")).to.equal("2.1.3");
    });

    it("shows token label when mint provided", async () => {
      const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&mint=${mint}`,
      );
      const body = (await res.json()) as any;
      expect(body.label).to.include("tokens");
    });

    it("includes amount in description when provided", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&amount=1.5`,
      );
      const body = (await res.json()) as any;
      expect(body.description).to.include("1.5");
    });
  });

  describe("POST /api/actions/fund", () => {
    it("rejects missing account", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&amount=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("account");
    });

    it("rejects missing destination", async () => {
      const res = await app.request(`/api/actions/fund?amount=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: testAccount }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("destination");
    });

    it("rejects missing amount", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: testAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("amount");
    });

    it("rejects invalid amount", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&amount=-5`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: testAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("amount");
    });

    it("rejects invalid account public key", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&amount=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: "not-a-key" }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("account");
    });

    it("rejects invalid destination public key", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=bad-dest&amount=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: testAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("destination");
    });

    it("rejects invalid mint public key", async () => {
      const res = await app.request(
        `/api/actions/fund?destination=${testDest}&amount=1&mint=bad-mint`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: testAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("mint");
    });

    it("handles OPTIONS preflight", async () => {
      const res = await app.request("/api/actions/fund", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });
});
