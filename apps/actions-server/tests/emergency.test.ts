import { expect } from "chai";
import { Hono } from "hono";
import { emergency } from "../src/routes/emergency";

describe("Emergency Response Routes", () => {
  const app = new Hono();
  app.route("/", emergency);

  const validAccount = "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp";
  const validAgent = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

  // ═══ freeze-vault ═══════════════════════════════════════════

  describe("GET /api/actions/freeze-vault", () => {
    it("returns action metadata", async () => {
      const res = await app.request("/api/actions/freeze-vault");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.include("Freeze");
      expect(body.label).to.be.a("string");
    });
  });

  describe("POST /api/actions/freeze-vault", () => {
    it("returns 400 without account", async () => {
      const res = await app.request("/api/actions/freeze-vault?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("account");
    });

    it("returns 400 without vaultId", async () => {
      const res = await app.request("/api/actions/freeze-vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: validAccount }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("vaultId");
    });

    it("returns 400 for invalid account", async () => {
      const res = await app.request("/api/actions/freeze-vault?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: "bad" }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("not a valid public key");
    });

    it("returns transaction or 500 with valid params", async () => {
      const res = await app.request("/api/actions/freeze-vault?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: validAccount }),
      });
      if (res.status === 200) {
        const body = (await res.json()) as any;
        expect(body.transaction).to.be.a("string");
        expect(body.message).to.include("frozen");
      } else {
        expect(res.status).to.equal(500);
      }
    });
  });

  describe("OPTIONS /api/actions/freeze-vault", () => {
    it("returns CORS headers", async () => {
      const res = await app.request("/api/actions/freeze-vault", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });

  // ═══ pause-agent ════════════════════════════════════════════

  describe("GET /api/actions/pause-agent", () => {
    it("returns action metadata", async () => {
      const res = await app.request("/api/actions/pause-agent");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.include("Pause");
    });
  });

  describe("POST /api/actions/pause-agent", () => {
    it("returns 400 without account", async () => {
      const res = await app.request(
        `/api/actions/pause-agent?vaultId=0&agentPubkey=${validAgent}`,
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

    it("returns 400 without agentPubkey", async () => {
      const res = await app.request("/api/actions/pause-agent?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: validAccount }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("agentPubkey");
    });

    it("returns 400 without vaultId", async () => {
      const res = await app.request(
        `/api/actions/pause-agent?agentPubkey=${validAgent}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: validAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("vaultId");
    });
  });

  describe("OPTIONS /api/actions/pause-agent", () => {
    it("returns CORS headers", async () => {
      const res = await app.request("/api/actions/pause-agent", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });

  // ═══ unpause-agent ══════════════════════════════════════════

  describe("GET /api/actions/unpause-agent", () => {
    it("returns action metadata", async () => {
      const res = await app.request("/api/actions/unpause-agent");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.include("Unpause");
    });
  });

  describe("POST /api/actions/unpause-agent", () => {
    it("returns 400 without account", async () => {
      const res = await app.request(
        `/api/actions/unpause-agent?vaultId=0&agentPubkey=${validAgent}`,
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

    it("returns 400 without agentPubkey", async () => {
      const res = await app.request("/api/actions/unpause-agent?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: validAccount }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("agentPubkey");
    });

    it("returns 400 without vaultId", async () => {
      const res = await app.request(
        `/api/actions/unpause-agent?agentPubkey=${validAgent}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: validAccount }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("vaultId");
    });
  });

  describe("OPTIONS /api/actions/unpause-agent", () => {
    it("returns CORS headers", async () => {
      const res = await app.request("/api/actions/unpause-agent", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });
});
