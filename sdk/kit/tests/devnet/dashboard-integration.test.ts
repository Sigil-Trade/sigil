/**
 * OwnerClient Devnet Integration Tests
 *
 * Tests the DX layer against the real deployed Sigil program on devnet.
 * Uses an existing vault (discovered via discoverVaults) — does not provision new ones.
 *
 * Run: ANCHOR_PROVIDER_URL=<rpc> npx mocha --require tsx tests/devnet/dashboard-integration.test.ts --timeout 300000
 */

import { expect } from "chai";
import type { Address, Rpc, SolanaRpcApi, KeyPairSigner } from "@solana/kit";

import { createDevnetRpc, loadOwnerSigner } from "../../src/testing/devnet.js";

import { OwnerClient } from "../../src/dashboard/index.js";
import { USDC_MINT_DEVNET } from "../../src/types.js";

const SKIP = !process.env.ANCHOR_PROVIDER_URL;

/** Pause between RPC-heavy tests to avoid 429 rate limiting. */
const RPC_COOLDOWN_MS = 1500;
function cooldown(): Promise<void> {
  return new Promise((r) => setTimeout(r, RPC_COOLDOWN_MS));
}

describe("OwnerClient Devnet Integration", function () {
  if (SKIP) return;

  this.timeout(300_000);

  let rpc: Rpc<SolanaRpcApi>;
  let owner: KeyPairSigner;
  let client: OwnerClient;
  let vaultAddress: Address;

  before(async function () {
    rpc = createDevnetRpc();
    const { signer } = await loadOwnerSigner();
    owner = signer;

    // Discover an existing active vault instead of provisioning
    const vaults = await OwnerClient.discoverVaults(
      rpc,
      owner.address,
      "devnet",
    );
    const activeVault = vaults.find((v) => v.status === "active");
    if (!activeVault) {
      console.log("No active vault found — skipping mutation tests");
      return;
    }

    vaultAddress = activeVault.address as Address;
    client = new OwnerClient({
      rpc,
      vault: vaultAddress,
      owner,
      network: "devnet",
    });
  });

  // ─── Static Methods ─────────────────────────────────────────────────────────

  describe("discoverVaults", function () {
    afterEach(cooldown);
    it("finds vaults owned by this keypair", async function () {
      const vaults = await OwnerClient.discoverVaults(
        rpc,
        owner.address,
        "devnet",
      );

      expect(vaults).to.be.an("array");
      expect(vaults.length).to.be.greaterThan(0);

      const first = vaults[0];
      expect(first.address).to.be.a("string");
      expect(first.address.length).to.be.greaterThanOrEqual(32);
      expect(first.status).to.be.oneOf(["active", "frozen", "closed"]);
      expect(typeof first.vaultId).to.equal("bigint");
      expect(typeof first.agentCount).to.equal("number");
    });

    it("toJSON() serializes vaultId bigint to string", async function () {
      const vaults = await OwnerClient.discoverVaults(
        rpc,
        owner.address,
        "devnet",
      );
      if (vaults.length === 0) return this.skip();

      const json = JSON.parse(JSON.stringify(vaults[0]));
      expect(typeof json.vaultId).to.equal("string");
      expect(json.status).to.be.oneOf(["active", "frozen", "closed"]);
    });
  });

  // ─── Reads ──────────────────────────────────────────────────────────────────

  describe("reads", function () {
    afterEach(cooldown);
    beforeEach(function () {
      if (!client) this.skip();
    });

    it("getVaultState() returns valid state with correct types", async function () {
      const state = await client.getVaultState();

      expect(state.vault.address).to.equal(vaultAddress);
      expect(state.vault.status).to.be.oneOf(["active", "frozen", "closed"]);
      expect(typeof state.vault.totalVolume).to.equal("bigint");
      expect(typeof state.vault.totalFees).to.equal("bigint");
      expect(typeof state.balance.total).to.equal("bigint");
      expect(state.health.level).to.be.oneOf([
        "healthy",
        "elevated",
        "critical",
      ]);
      expect(typeof state.pnl.percent).to.equal("number");
      expect(typeof state.pnl.absolute).to.equal("bigint");
    });

    it("getVaultState().toJSON() serializes bigints to strings", async function () {
      const state = await client.getVaultState();
      const json = JSON.parse(JSON.stringify(state));

      expect(typeof json.vault.totalVolume).to.equal("string");
      expect(typeof json.balance.total).to.equal("string");
      expect(typeof json.pnl.absolute).to.equal("string");
      expect(typeof json.pnl.percent).to.equal("number");
    });

    it("getAgents() returns agent data", async function () {
      const agents = await client.getAgents();

      expect(agents).to.be.an("array");
      if (agents.length > 0) {
        const first = agents[0];
        expect(first.address).to.be.a("string");
        expect(first.status).to.be.oneOf(["active", "paused"]);
        expect(typeof first.permissionBitmask).to.equal("bigint");
        expect(first.permissions).to.be.an("array");
        expect(typeof first.spending.amount).to.equal("bigint");
      }
    });

    it("getSpending() returns spending data with chart points", async function () {
      const spending = await client.getSpending();

      expect(typeof spending.global.today).to.equal("bigint");
      expect(typeof spending.global.cap).to.equal("bigint");
      expect(typeof spending.global.percent).to.equal("number");
      expect(spending.chart).to.be.an("array");
      expect(spending.protocolBreakdown).to.be.an("array");
    });

    it("getActivity() returns activity rows", async function () {
      const activity = await client.getActivity();

      expect(activity.rows).to.be.an("array");
      expect(activity.summary.total).to.be.a("number");
      expect(typeof activity.summary.volume).to.equal("bigint");
    });

    it("getActivity() respects status filter", async function () {
      const filtered = await client.getActivity({
        status: "blocked",
        timeRange: "24h",
      });

      expect(filtered.rows).to.be.an("array");
      for (const row of filtered.rows) {
        expect(row.status).to.equal("blocked");
      }
    });

    it("getHealth() returns health data", async function () {
      const health = await client.getHealth();

      expect(health.level).to.be.oneOf(["healthy", "elevated", "critical"]);
      expect(health.checks).to.be.an("array");
      expect(health.checks.length).to.be.greaterThan(0);
      for (const check of health.checks) {
        expect(check.name).to.be.a("string");
        expect(typeof check.passed).to.equal("boolean");
      }
    });

    it("getPolicy() returns all policy fields", async function () {
      const policy = await client.getPolicy();

      expect(typeof policy.dailyCap).to.equal("bigint");
      expect(typeof policy.maxPerTrade).to.equal("bigint");
      expect(policy.approvedApps).to.be.an("array");
      expect(policy.protocolMode).to.be.oneOf([
        "whitelist",
        "blacklist",
        "unrestricted",
      ]);
      expect(typeof policy.hasProtocolCaps).to.equal("boolean");
      expect(typeof policy.canOpenPositions).to.equal("boolean");
      expect(typeof policy.sessionExpirySlots).to.equal("bigint");
      expect(typeof policy.policyVersion).to.equal("bigint");
      expect(typeof policy.timelockSeconds).to.equal("number");
    });

    it("getPolicy().toJSON() serializes all bigints", async function () {
      const policy = await client.getPolicy();
      const json = JSON.parse(JSON.stringify(policy));

      expect(typeof json.dailyCap).to.equal("string");
      expect(typeof json.policyVersion).to.equal("string");
      expect(typeof json.timelockSeconds).to.equal("number");
    });
  });

  // ─── Mutations ──────────────────────────────────────────────────────────────

  describe("mutations", function () {
    afterEach(cooldown);
    beforeEach(function () {
      if (!client) this.skip();
    });

    it("freezeVault() freezes, resumeVault() resumes, toJSON() serializes", async function () {
      const freezeResult = await client.freezeVault();
      expect(freezeResult.signature).to.be.a("string");
      expect(freezeResult.signature.length).to.be.greaterThan(10);

      // TxResult.toJSON() works for MCP serialization
      const json = JSON.parse(JSON.stringify(freezeResult));
      expect(json.signature).to.be.a("string");

      await cooldown();

      const stateAfterFreeze = await client.getVaultState();
      expect(stateAfterFreeze.vault.status).to.equal("frozen");

      await cooldown();

      const resumeResult = await client.resumeVault();
      expect(resumeResult.signature).to.be.a("string");

      await cooldown();

      const stateAfterResume = await client.getVaultState();
      expect(stateAfterResume.vault.status).to.equal("active");
    });
  });

  // ─── Validation ─────────────────────────────────────────────────────────────

  describe("client-side validation", () => {
    it("rejects deposit with amount 0", async function () {
      try {
        await client.deposit(USDC_MINT_DEVNET, 0n);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("must be positive");
      }
    });

    it("rejects invalid agent address", async function () {
      try {
        await client.pauseAgent("bad" as Address);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("not a valid");
      }
    });

    it("rejects empty policy changes", async function () {
      try {
        await client.queuePolicyUpdate({});
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("At least one policy change");
      }
    });

    it("rejects permissions bitmask of 0", async function () {
      try {
        await client.addAgent(
          "11111111111111111111111111111113" as Address,
          0n,
          500_000_000n,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("no permissions");
      }
    });

    it("rejects syncPositions with value > 255", async function () {
      try {
        await client.syncPositions(256);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("0-255");
      }
    });
  });
});
