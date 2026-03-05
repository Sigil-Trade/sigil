import { expect } from "chai";
import { Hono } from "hono";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { TEMPLATES, type TemplateName } from "../src/lib/templates";

// Import routes for unit testing
import { discovery } from "../src/routes/discovery";
import { provision } from "../src/routes/provision";

describe("Actions Server", () => {
  describe("Discovery", () => {
    const app = new Hono();
    app.route("/", discovery);

    it("returns actions.json with correct rules", async () => {
      const res = await app.request("/.well-known/actions.json");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.rules).to.be.an("array");
      expect(body.rules[0].pathPattern).to.equal("/api/actions/**");
      expect(body.rules[0].apiPath).to.equal("/api/actions/**");
    });
  });

  describe("GET /api/actions/provision", () => {
    const app = new Hono();
    app.route("/", provision);

    it("returns ActionGetResponse with default template", async () => {
      const res = await app.request("/api/actions/provision");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.equal("Create Phalnx Vault");
      expect(body.label).to.equal("Create Vault");
      expect(body.links.actions).to.be.an("array");
      expect(body.links.actions.length).to.equal(3);
    });

    it("includes CORS headers", async () => {
      const res = await app.request("/api/actions/provision");
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
      expect(res.headers.get("X-Action-Version")).to.equal("2.1.3");
    });

    it("accepts template query param", async () => {
      const res = await app.request(
        "/api/actions/provision?template=aggressive",
      );
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.description).to.include("Aggressive");
    });

    for (const template of [
      "conservative",
      "moderate",
      "aggressive",
    ] as TemplateName[]) {
      it(`has action link for ${template} template`, async () => {
        const res = await app.request("/api/actions/provision");
        const body = (await res.json()) as any;
        const links = body.links.actions.map((a: any) => a.href);
        expect(links.some((h: string) => h.includes(`template=${template}`))).to
          .be.true;
      });
    }
  });

  describe("POST /api/actions/provision", () => {
    const app = new Hono();
    app.route("/", provision);

    it("rejects missing account", async () => {
      const res = await app.request(
        "/api/actions/provision?agentPubkey=11111111111111111111111111111111",
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

    it("rejects invalid account", async () => {
      const res = await app.request(
        "/api/actions/provision?agentPubkey=11111111111111111111111111111111",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: "not-a-pubkey" }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("account");
    });

    it("rejects missing agentPubkey", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const res = await app.request("/api/actions/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: owner }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("agentPubkey");
    });

    it("rejects invalid template", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const agent = Keypair.generate().publicKey.toBase58();
      const res = await app.request(
        `/api/actions/provision?template=invalid&agentPubkey=${agent}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: owner }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("template");
    });

    it("rejects invalid dailyCap", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const agent = Keypair.generate().publicKey.toBase58();
      const res = await app.request(
        `/api/actions/provision?agentPubkey=${agent}&dailyCap=-5`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: owner }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("dailyCap");
    });

    it("builds valid transaction for conservative template", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const agent = Keypair.generate().publicKey.toBase58();
      const res = await app.request(
        `/api/actions/provision?template=conservative&agentPubkey=${agent}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: owner }),
        },
      );

      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.transaction).to.be.a("string");
      expect(body.message).to.include("Vault created");

      // Verify the transaction deserializes correctly
      const txBytes = Buffer.from(body.transaction, "base64");
      const tx = VersionedTransaction.deserialize(txBytes);
      expect(tx.message.compiledInstructions.length).to.be.gte(3);
    });

    it("returns CORS headers on POST", async () => {
      const owner = Keypair.generate().publicKey.toBase58();
      const agent = Keypair.generate().publicKey.toBase58();
      const res = await app.request(
        `/api/actions/provision?template=conservative&agentPubkey=${agent}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: owner }),
        },
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });

    it("handles OPTIONS preflight", async () => {
      const res = await app.request("/api/actions/provision", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });

  describe("Templates", () => {
    it("has 3 templates", () => {
      expect(Object.keys(TEMPLATES).length).to.equal(3);
    });

    for (const [name, config] of Object.entries(TEMPLATES)) {
      it(`${name} template has valid config`, () => {
        expect(config.label).to.be.a("string");
        expect(config.description).to.be.a("string");
        expect(config.dailyCapUsd).to.be.a("number");
        expect(config.dailyCapUsd).to.be.greaterThan(0);
        expect(config.maxTxUsd).to.be.a("number");
        expect(config.protocols).to.be.an("array");
        expect(config.protocols.length).to.be.greaterThan(0);
        expect(config.maxLeverageBps).to.be.a("number");
      });
    }

    it("conservative has Jupiter only", () => {
      expect(TEMPLATES.conservative.protocols.length).to.equal(1);
    });

    it("moderate has 4 protocols", () => {
      expect(TEMPLATES.moderate.protocols.length).to.equal(4);
    });

    it("aggressive has 5 protocols", () => {
      expect(TEMPLATES.aggressive.protocols.length).to.equal(5);
    });
  });
});
