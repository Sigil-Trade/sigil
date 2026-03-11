import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  mapPoliciesToVaultParams,
  harden,
  withVault,
  type HardenOptions,
} from "../src/harden.js";
import { resolvePolicies } from "../src/policies.js";

// Valid base58 addresses (no 0, I, O, l)
const OWNER = "11111111111111111111111111111112" as Address;
const AGENT = "11111111111111111111111111111113" as Address;
const FEE_DEST = "11111111111111111111111111111114" as Address;
const PROTOCOL_A = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const PROTOCOL_B = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" as Address;

function mockOwner() {
  return {
    address: OWNER,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

function mockAgentSigner() {
  return {
    address: AGENT,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

describe("harden", () => {
  describe("mapPoliciesToVaultParams()", () => {
    it("collapses multiple spend limits to largest", () => {
      const resolved = resolvePolicies({
        maxSpend: [
          { mint: "USDC", amount: 100n, windowMs: 86_400_000 },
          { mint: "USDT", amount: 500n, windowMs: 86_400_000 },
          { mint: "SOL", amount: 200n, windowMs: 86_400_000 },
        ],
      });
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST);
      expect(params.dailySpendingCap).to.equal(500n);
    });

    it("default spend limits apply when no config given", () => {
      const resolved = resolvePolicies({});
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST);
      // Default policies include a non-zero spending cap
      expect(typeof params.dailySpendingCap).to.equal("bigint");
      expect(params.dailySpendingCap > 0n).to.be.true;
    });

    it("protocols set → allowlist mode", () => {
      const resolved = resolvePolicies({
        allowedProtocols: [PROTOCOL_A, PROTOCOL_B],
      });
      const params = mapPoliciesToVaultParams(resolved, 1n, FEE_DEST);
      expect(params.protocolMode).to.equal(1);
      expect(params.protocols).to.have.length(2);
    });

    it("no protocols → mode 0 (all allowed)", () => {
      const resolved = resolvePolicies({});
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST);
      expect(params.protocolMode).to.equal(0);
      expect(params.protocols).to.have.length(0);
    });

    it("caps protocols at 10", () => {
      // Use valid base58 addresses
      const base = "11111111111111111111111111111111";
      const protocols = Array.from(
        { length: 15 },
        (_, i) => base.slice(0, -1) + String(i + 2),
      );
      const resolved = resolvePolicies({ allowedProtocols: protocols });
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST);
      expect(params.protocols).to.have.length(10);
    });

    it("respects optional override parameters", () => {
      const resolved = resolvePolicies({});
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST, {
        developerFeeRate: 200,
        maxLeverageBps: 5000,
        maxConcurrentPositions: 3,
        timelockDuration: 3600,
        maxSlippageBps: 250,
      });
      expect(params.developerFeeRate).to.equal(200);
      expect(params.maxLeverageBps).to.equal(5000);
      expect(params.maxConcurrentPositions).to.equal(3);
      expect(params.timelockDuration).to.equal(3600);
      expect(params.maxSlippageBps).to.equal(250);
    });

    it("uses default values when opts not provided", () => {
      const resolved = resolvePolicies({});
      const params = mapPoliciesToVaultParams(resolved, 0n, FEE_DEST);
      expect(params.developerFeeRate).to.equal(0);
      expect(params.maxLeverageBps).to.equal(0);
      expect(params.maxConcurrentPositions).to.equal(5);
      expect(params.timelockDuration).to.equal(0);
      expect(params.maxSlippageBps).to.equal(100);
    });

    it("preserves vaultId and feeDestination", () => {
      const resolved = resolvePolicies({});
      const params = mapPoliciesToVaultParams(resolved, 42n, FEE_DEST);
      expect(params.vaultId).to.equal(42n);
      expect(params.feeDestination).to.equal(FEE_DEST);
    });
  });

  describe("harden()", () => {
    it("rejects owner === agent", async () => {
      const sameKey = mockOwner();
      try {
        await harden({
          rpc: {} as any,
          network: "devnet",
          owner: sameKey,
          agent: sameKey,
        });
        expect.fail("should throw");
      } catch (e: any) {
        expect(e.message).to.include("Owner and agent must be different");
      }
    });

    it("returns vault info with explicit vaultId", async () => {
      const result = await harden({
        rpc: {} as any,
        network: "devnet",
        owner: mockOwner(),
        agent: mockAgentSigner(),
        vaultId: 0n,
      });
      expect(result.vaultAddress).to.be.a("string");
      expect(result.vaultId).to.equal(0n);
      expect(result.policyAddress).to.be.a("string");
      expect(result.pendingPolicyAddress).to.be.a("string");
      expect(result.agentAddress).to.equal(AGENT);
      expect(result.ownerAddress).to.equal(OWNER);
    });

    it("derives deterministic PDAs", async () => {
      const r1 = await harden({
        rpc: {} as any,
        network: "devnet",
        owner: mockOwner(),
        agent: mockAgentSigner(),
        vaultId: 0n,
      });
      const r2 = await harden({
        rpc: {} as any,
        network: "devnet",
        owner: mockOwner(),
        agent: mockAgentSigner(),
        vaultId: 0n,
      });
      expect(r1.vaultAddress).to.equal(r2.vaultAddress);
      expect(r1.policyAddress).to.equal(r2.policyAddress);
    });
  });

  describe("withVault()", () => {
    it("returns both shield and harden results", async () => {
      const result = await withVault({
        rpc: {} as any,
        network: "devnet",
        owner: mockOwner(),
        agent: mockAgentSigner(),
        vaultId: 0n,
      });
      expect(result.shield).to.exist;
      expect(result.shield.isPaused).to.be.false;
      expect(result.harden.vaultAddress).to.be.a("string");
    });

    it("passes shield policies through", async () => {
      const result = await withVault({
        rpc: {} as any,
        network: "devnet",
        owner: mockOwner(),
        agent: mockAgentSigner(),
        vaultId: 0n,
        policies: { blockUnknownPrograms: true },
      });
      expect(result.shield.resolvedPolicies.blockUnknownPrograms).to.be.true;
    });
  });
});
