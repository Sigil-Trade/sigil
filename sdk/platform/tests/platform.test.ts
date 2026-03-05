import { expect } from "chai";
import * as sinon from "sinon";
import { PhalnxPlatform } from "../src/index";

describe("PhalnxPlatform", () => {
  const BASE_URL = "https://app.phalnx.io";
  let platform: PhalnxPlatform;
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    platform = new PhalnxPlatform(BASE_URL);
    fetchStub = sinon.stub(globalThis, "fetch");
  });

  afterEach(() => {
    fetchStub.restore();
  });

  // ── URL Generation ────────────────────────────────────────────

  describe("getProvisionActionUrl", () => {
    it("returns base URL with no options", () => {
      const url = platform.getProvisionActionUrl();
      expect(url).to.equal(`${BASE_URL}/api/actions/provision`);
    });

    it("includes template param", () => {
      const url = platform.getProvisionActionUrl({ template: "moderate" });
      expect(url).to.equal(
        `${BASE_URL}/api/actions/provision?template=moderate`,
      );
    });

    it("includes dailyCap param", () => {
      const url = platform.getProvisionActionUrl({ dailyCap: 1000 });
      expect(url).to.equal(`${BASE_URL}/api/actions/provision?dailyCap=1000`);
    });

    it("includes both params", () => {
      const url = platform.getProvisionActionUrl({
        template: "aggressive",
        dailyCap: 5000,
      });
      expect(url).to.include("template=aggressive");
      expect(url).to.include("dailyCap=5000");
    });

    it("strips trailing slash from base URL", () => {
      const p = new PhalnxPlatform("https://example.com/");
      const url = p.getProvisionActionUrl();
      expect(url).to.equal("https://example.com/api/actions/provision");
    });
  });

  describe("getBlinkUrl", () => {
    it("wraps action URL in dial.to format", () => {
      const url = platform.getBlinkUrl({ dailyCap: 500 });
      expect(url).to.include("https://dial.to/?action=solana-action:");
      expect(url).to.include(encodeURIComponent("/api/actions/provision"));
    });
  });

  // ── API Calls ─────────────────────────────────────────────────

  describe("getActionMetadata", () => {
    it("fetches GET endpoint", async () => {
      const mockMetadata = {
        type: "action",
        title: "Create Phalnx Protected Vault",
        icon: "https://example.com/icon.png",
        description: "Test",
        label: "Create Vault",
        links: { actions: [] },
      };

      fetchStub.resolves({
        ok: true,
        json: async () => mockMetadata,
      } as Response);

      const result = await platform.getActionMetadata();
      expect(result.title).to.equal("Create Phalnx Protected Vault");
      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal(
        `${BASE_URL}/api/actions/provision`,
      );
      expect(fetchStub.firstCall.args[1]?.method).to.equal("GET");
    });

    it("throws on HTTP error", async () => {
      fetchStub.resolves({ ok: false, status: 500 } as Response);

      try {
        await platform.getActionMetadata();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("500");
      }
    });
  });

  describe("requestProvision", () => {
    it("sends POST with account", async () => {
      const mockResponse = {
        type: "transaction",
        transaction: "base64-tx-data",
        message: "Creating vault...",
      };

      fetchStub.resolves({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await platform.requestProvision("owner-pubkey", {
        dailyCap: 500,
      });

      expect(result.transaction).to.equal("base64-tx-data");
      expect(fetchStub.calledOnce).to.be.true;

      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.include("/api/actions/provision");
      expect(url).to.include("dailyCap=500");
      expect(opts.method).to.equal("POST");
      expect(JSON.parse(opts.body)).to.deep.equal({ account: "owner-pubkey" });
    });

    it("throws on rate limit error", async () => {
      fetchStub.resolves({
        ok: false,
        status: 429,
        json: async () => ({ error: "Rate limit exceeded" }),
      } as unknown as Response);

      try {
        await platform.requestProvision("owner");
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Rate limit");
      }
    });
  });

  describe("checkStatus", () => {
    it("fetches status endpoint", async () => {
      const mockStatus = {
        status: "confirmed",
        vaultAddress: "vault123",
        agentPubkey: "agent456",
        agentLocator: "wallet:agent456",
      };

      fetchStub.resolves({
        ok: true,
        json: async () => mockStatus,
      } as Response);

      const result = await platform.checkStatus("tx-sig");
      expect(result.status).to.equal("confirmed");
      expect(result.vaultAddress).to.equal("vault123");
      expect(fetchStub.firstCall.args[0]).to.equal(
        `${BASE_URL}/api/actions/status/tx-sig`,
      );
    });
  });

  describe("waitForProvision", () => {
    it("returns immediately if confirmed", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          status: "confirmed",
          vaultAddress: "vault123",
          agentPubkey: "agent456",
          agentLocator: "wallet:agent456",
        }),
      } as Response);

      const result = await platform.waitForProvision("tx-sig");
      expect(result.status).to.equal("confirmed");
      expect(fetchStub.calledOnce).to.be.true;
    });

    it("polls until confirmed", async () => {
      let callCount = 0;
      fetchStub.callsFake(async () => {
        callCount++;
        if (callCount < 3) {
          return {
            ok: true,
            json: async () => ({ status: "pending" }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: "confirmed",
            vaultAddress: "vault123",
            agentPubkey: "agent456",
          }),
        };
      });

      const result = await platform.waitForProvision("tx-sig", 10_000, 50);
      expect(result.status).to.equal("confirmed");
      expect(callCount).to.equal(3);
    });

    it("throws on timeout", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({ status: "pending" }),
      } as Response);

      try {
        await platform.waitForProvision("tx-sig", 200, 50);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("timed out");
      }
    });

    it("throws on error result", async () => {
      fetchStub.resolves({
        ok: true,
        json: async () => ({
          status: "not_found",
          error: "TX does not involve Phalnx",
        }),
      } as Response);

      try {
        await platform.waitForProvision("tx-sig", 5000, 50);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Provision failed");
      }
    });
  });

  // ── Message Formatting ────────────────────────────────────────

  describe("formatProvisionMessage", () => {
    it("includes action URL and blink URL", () => {
      const msg = platform.formatProvisionMessage({ dailyCap: 500 });
      expect(msg).to.include("/api/actions/provision");
      expect(msg).to.include("dial.to");
      expect(msg).to.include("500 USDC/day");
    });

    it("uses defaults when no options", () => {
      const msg = platform.formatProvisionMessage();
      expect(msg).to.include("conservative");
      expect(msg).to.include("500 USDC/day");
    });
  });
});
