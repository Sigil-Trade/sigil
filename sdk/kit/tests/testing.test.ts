/**
 * Tests for @phalnx/kit/testing utilities.
 *
 * Validates mock RPC, mock agent, and mock vault state factories
 * work correctly and integrate with wrap().
 */

import { expect } from "chai";
import type { Address } from "@solana/kit";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import {
  createMockRpc,
  createMockAgent,
  createMockVaultState,
  MOCK_VAULT,
  MOCK_AGENT,
  MOCK_OWNER,
  MOCK_SIGNATURE,
  MOCK_BLOCKHASH,
  type MockRpcOverrides,
  type MockVaultStateOverrides,
} from "../src/testing/index.js";
import { wrap } from "../src/wrap.js";
import { FULL_PERMISSIONS } from "../src/types.js";

// ─── Known program addresses for wrap() test ────────────────────────────────

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;

describe("testing utilities", () => {
  // ─── createMockRpc ──────────────────────────────────────────────────────

  describe("createMockRpc()", () => {
    it("returns object with getLatestBlockhash, simulateTransaction, sendTransaction", async () => {
      const rpc = createMockRpc();
      const blockhash = await rpc.getLatestBlockhash().send();
      expect(blockhash.value).to.deep.equal(MOCK_BLOCKHASH);

      const sim = await rpc.simulateTransaction("" as any).send();
      expect(sim.value.err).to.be.null;

      const sig = await rpc.sendTransaction("" as any).send();
      expect(sig).to.equal(MOCK_SIGNATURE);
    });

    it("with overrides returns custom simulateResult", async () => {
      const customResult = { value: { err: "custom-error", logs: ["log1"] } };
      const rpc = createMockRpc({ simulateResult: customResult });
      const sim = await rpc.simulateTransaction("" as any).send();
      expect(sim).to.deep.equal(customResult);
    });
  });

  // ─── createMockAgent ────────────────────────────────────────────────────

  describe("createMockAgent()", () => {
    it("has address and signTransactions", async () => {
      const agent = createMockAgent();
      expect(agent.address).to.equal(MOCK_AGENT);
      expect(agent.signTransactions).to.be.a("function");

      const txs = [{ mock: true }];
      const signed = await agent.signTransactions(txs);
      expect(signed).to.deep.equal(txs);
    });

    it("uses provided address", () => {
      const custom = "Custom11111111111111111111111111111111111111" as Address;
      const agent = createMockAgent(custom);
      expect(agent.address).to.equal(custom);
    });
  });

  // ─── createMockVaultState ───────────────────────────────────────────────

  describe("createMockVaultState()", () => {
    it("returns valid ResolvedVaultState with Active status", () => {
      const state = createMockVaultState();
      expect(state.vault.status).to.equal(VaultStatus.Active);
      expect(state.vault.owner).to.equal(MOCK_OWNER);
      expect(state.vault.agents).to.have.length(1);
      expect(state.vault.agents[0].pubkey).to.equal(MOCK_AGENT);
      expect(state.vault.agents[0].permissions).to.equal(FULL_PERMISSIONS);
      expect(state.policy.dailySpendingCapUsd).to.equal(1_000_000_000n);
      expect(state.globalBudget.remaining).to.equal(1_000_000_000n);
      expect(state.tracker).to.be.null;
      expect(state.overlay).to.be.null;
      expect(state.stablecoinBalances).to.deep.equal({ usdc: 0n, usdt: 0n });
    });

    it("overrides status to Frozen", () => {
      const state = createMockVaultState({ status: VaultStatus.Frozen });
      expect(state.vault.status).to.equal(VaultStatus.Frozen);
    });

    it("noAgents: true returns empty agents array", () => {
      const state = createMockVaultState({ noAgents: true });
      expect(state.vault.agents).to.deep.equal([]);
    });

    it("overrides spending budget", () => {
      const state = createMockVaultState({
        dailyCap: 500_000_000n,
        spent24h: 200_000_000n,
      });
      expect(state.policy.dailySpendingCapUsd).to.equal(500_000_000n);
      expect(state.globalBudget.spent24h).to.equal(200_000_000n);
      expect(state.globalBudget.remaining).to.equal(300_000_000n);
    });

    it("overrides stablecoin balances", () => {
      const state = createMockVaultState({
        stablecoinBalances: { usdc: 1_000_000n, usdt: 500_000n },
      });
      expect(state.stablecoinBalances.usdc).to.equal(1_000_000n);
      expect(state.stablecoinBalances.usdt).to.equal(500_000n);
    });

    it("overrides P&L fields", () => {
      const state = createMockVaultState({
        totalDepositedUsd: 10_000_000_000n,
        totalWithdrawnUsd: 3_000_000_000n,
      });
      expect(state.vault.totalDepositedUsd).to.equal(10_000_000_000n);
      expect(state.vault.totalWithdrawnUsd).to.equal(3_000_000_000n);
    });

    it("result accepted by wrap() — returns WrapResult", async () => {
      const vault = "11111111111111111111111111111112" as Address;
      const agent = createMockAgent(
        "11111111111111111111111111111113" as Address,
      );
      const state = createMockVaultState({
        vault,
        agent: agent.address,
      });

      const result = await wrap({
        vault,
        agent,
        instructions: [
          {
            programAddress: JUPITER,
            accounts: [],
            data: new Uint8Array([1, 2, 3]),
          },
        ],
        rpc: createMockRpc() as any,
        network: "devnet",
        tokenMint: USDC_DEVNET,
        amount: 100_000_000n,
        cachedState: state,
        blockhash: {
          blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
          lastValidBlockHeight: 200n,
        },
      });

      expect(result).to.have.property("transaction");
      expect(result).to.have.property("actionType");
    });
  });
});
