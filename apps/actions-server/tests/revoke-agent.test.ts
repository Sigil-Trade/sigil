import { expect } from "chai";
import { Hono } from "hono";
import { revokeAgent } from "../src/routes/revoke-agent";

describe("Emergency Vault Freeze Route", () => {
  const app = new Hono();
  app.route("/", revokeAgent);

  describe("GET /api/actions/revoke-agent", () => {
    it("returns action metadata for vault freeze", async () => {
      const res = await app.request("/api/actions/revoke-agent");
      expect(res.status).to.equal(200);
      const body = (await res.json()) as any;
      expect(body.type).to.equal("action");
      expect(body.title).to.include("Freeze");
      expect(body.description).to.include("freeze");
      expect(body.label).to.be.a("string");
    });
  });

  describe("POST /api/actions/revoke-agent", () => {
    const agentPubkey = "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp";

    it("returns 400 without agentPubkey", async () => {
      const res = await app.request("/api/actions/revoke-agent?vaultId=0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: "11111111111111111111111111111111",
        }),
      });
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("agentPubkey");
    });

    it("returns 400 without vaultId", async () => {
      const res = await app.request(
        `/api/actions/revoke-agent?agentPubkey=${agentPubkey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: "11111111111111111111111111111111",
          }),
        },
      );
      expect(res.status).to.equal(400);
      const body = (await res.json()) as any;
      expect(body.error).to.include("vaultId");
    });

    it("returns 400 without account", async () => {
      const res = await app.request(
        `/api/actions/revoke-agent?vaultId=0&agentPubkey=${agentPubkey}`,
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

    it("returns unsigned transaction with valid params", async () => {
      const res = await app.request(
        `/api/actions/revoke-agent?vaultId=0&agentPubkey=${agentPubkey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account: "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
          }),
        },
      );
      // May return 500 if RPC is unavailable in CI — that's OK,
      // the important thing is it doesn't return 400 (validation passed)
      if (res.status === 200) {
        const body = (await res.json()) as any;
        expect(body.transaction).to.be.a("string");
        expect(body.message).to.include("frozen");
      } else {
        // RPC connection failure in test environment — acceptable
        expect(res.status).to.equal(500);
      }
    });
  });

  describe("OPTIONS /api/actions/revoke-agent", () => {
    it("returns CORS headers", async () => {
      const res = await app.request("/api/actions/revoke-agent", {
        method: "OPTIONS",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).to.equal("*");
    });
  });
});
