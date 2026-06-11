/**
 * OwnerClient Devnet Integration Tests
 *
 * Tests the DX layer against the real deployed Sigil program on devnet.
 * Uses an existing vault (discovered via discoverVaults) — does not provision new ones.
 *
 * Run: ANCHOR_PROVIDER_URL=<rpc> npx mocha --require tsx tests/devnet/dashboard-integration.test.ts --timeout 300000
 */

import { expect } from "chai";
import { address } from "@solana/kit";
import type { Address, Rpc, SolanaRpcApi, KeyPairSigner } from "@solana/kit";

import {
  createDevnetRpc,
  loadOwnerSigner,
  provisionVault,
  createFundedAgent,
} from "../../src/testing/devnet.js";

import { OwnerClient } from "../../src/dashboard/index.js";
import { USDC_MINT_DEVNET, capability, usd } from "../../src/types.js";

const SKIP = !process.env.ANCHOR_PROVIDER_URL;

/** Pause between RPC-heavy tests to avoid 429 rate limiting. */
const RPC_COOLDOWN_MS = 1500;
function cooldown(): Promise<void> {
  return new Promise((r) => setTimeout(r, RPC_COOLDOWN_MS));
}

/**
 * V2 `reactivate_vault` enforces a 300s anti-thrash cooldown from the freeze
 * (`reactivate_vault.rs` requires `clock.unix_timestamp - frozen_at >= 300`,
 * `ErrReactivateCooldownActive` 6097 otherwise). Devnet has no clock
 * cheatcodes, so a resume immediately after a freeze must wait it out. Poll the
 * CLUSTER clock (getBlockTime — the same clock the on-chain check reads), with
 * a wall-clock fallback if getBlockTime is unavailable. Anchored to a
 * post-freeze cluster read, so the 305s wait conservatively clears the 300s
 * window measured from the (earlier) frozen_at.
 */
const REACTIVATE_COOLDOWN_S = 305;
async function clusterUnix(rpc: Rpc<SolanaRpcApi>): Promise<number | null> {
  try {
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    const t = await rpc.getBlockTime(slot).send();
    return t == null ? null : Number(t);
  } catch {
    return null;
  }
}
async function waitForReactivateCooldown(
  rpc: Rpc<SolanaRpcApi>,
): Promise<void> {
  const startCluster = await clusterUnix(rpc);
  const startWall = Date.now();
  for (;;) {
    const now = await clusterUnix(rpc);
    if (now != null && startCluster != null) {
      if (now - startCluster >= REACTIVATE_COOLDOWN_S) return;
    } else if ((Date.now() - startWall) / 1000 >= REACTIVATE_COOLDOWN_S + 10) {
      return; // getBlockTime unavailable → conservative wall-clock fallback
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
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

    // Prefer an existing active vault (in CI the devnet-*.ts suites create many
    // and the paid RPC supports getProgramAccounts). Fall back to provisioning a
    // fresh vault when discovery returns none — e.g. a public RPC that restricts
    // getProgramAccounts — so the mutation/validation tests are self-contained
    // on any RPC. These tests do only owner-ops (freeze/resume) + reads, never
    // agent spending, so the fallback uses the cheapest reactivatable vault:
    //   - Observer capability (1): instant-eligible — sidesteps the F-Q6
    //     OPERATOR grant timelock (6107).
    //   - One allowlisted protocol: an ACTIVE vault must be non-inert, enforced
    //     at init (F-11 6073) AND on the freeze→resume reactivate path (M-9
    //     ActiveVaultRequiresAllowlist). The tests never spend through it, so
    //     any valid program id satisfies the allowlist.
    //   - skipDeposit: no funds needed for owner-op/read tests.
    const vaults = await OwnerClient.discoverVaults(
      rpc,
      owner.address,
      "devnet",
    );
    const activeVault = vaults.find((v) => v.status === "active");
    if (activeVault) {
      vaultAddress = activeVault.address as Address;
    } else {
      const agent = await createFundedAgent(rpc, owner);
      const provisioned = await provisionVault(
        rpc,
        owner,
        agent,
        USDC_MINT_DEVNET,
        {
          permissions: capability(1n),
          skipDeposit: true,
          // The deployed mock-defi fixture — a real, non-default program id, so
          // it can't trip an init default-pubkey guard. Never invoked here.
          protocols: [address("2heRcfqPUcSiWpH1rAp2Zf4c4ZxfKmKaaVbJWGRa7Qm6")],
        },
      );
      vaultAddress = provisioned.vaultAddress;
    }

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
        expect(typeof first.capability).to.equal("number");
        expect(first.capabilityLabel).to.be.a("string");
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
      expect(typeof policy.sessionExpirySeconds).to.equal("bigint");
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
      // The resume must wait out the 300s reactivate cooldown (below), so this
      // test needs more than the suite-default 300s timeout.
      this.timeout(420_000);

      const freezeResult = await client.freezeVault();
      expect(freezeResult.signature).to.be.a("string");
      expect(freezeResult.signature.length).to.be.greaterThan(10);

      // TxResult.toJSON() works for MCP serialization
      const json = JSON.parse(JSON.stringify(freezeResult));
      expect(json.signature).to.be.a("string");

      await cooldown();

      const stateAfterFreeze = await client.getVaultState();
      expect(stateAfterFreeze.vault.status).to.equal("frozen");

      // V2: reactivate_vault has a 300s anti-thrash cooldown from the freeze
      // (ErrReactivateCooldownActive 6097). No clock cheatcodes on devnet —
      // wait it out against the cluster clock before resuming.
      await waitForReactivateCooldown(rpc);

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
          capability(0n),
          usd(500_000_000n),
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("no permissions");
      }
    });
  });
});
