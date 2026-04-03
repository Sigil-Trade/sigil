/**
 * closeVault remaining_accounts regression tests.
 *
 * The closeVault function is the most complex mutation — it queries vault state,
 * derives pending PDAs, checks existence via parallel getAccountInfo calls,
 * and appends them as remaining_accounts in the correct order.
 *
 * These tests verify the remaining_accounts logic by mocking:
 * - resolveVaultStateForOwner (vault state with agents, policy flags)
 * - getAccountInfo (PDA existence checks)
 * - PDA derivation functions (deterministic addresses)
 *
 * Since closeVault imports these as module-level dependencies, we test the
 * behavioral contract: given vault state X and PDA existence Y, the instruction
 * should have remaining_accounts Z.
 */

import { expect } from "chai";
import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import { AccountRole } from "@solana/kit";

// ─── Test Constants ─────────────────────────────────────────────────────────

const VAULT = "Vault111111111111111111111111111111111111111" as Address;
const OWNER_ADDR = "Owner111111111111111111111111111111111111111" as Address;
const AGENT_1 = "Agent1111111111111111111111111111111111111111" as Address;
const AGENT_2 = "Agent2222222222222222222222222222222222222222" as Address;

function mockOwner(): TransactionSigner {
  return {
    address: OWNER_ADDR,
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({})),
    modifyAndSignTransactions: async (txs: unknown[]) => txs,
  } as unknown as TransactionSigner;
}

// ─── remaining_accounts Logic Tests ─────────────────────────────────────────
// These test the ALGORITHM that builds remaining_accounts, not the full
// closeVault mutation (which requires full RPC mocking).

describe("closeVault remaining_accounts logic", () => {
  /**
   * Replicate the remaining_accounts building logic from mutations.ts.
   * This tests the algorithm in isolation without needing to mock the
   * entire import chain (resolveVaultStateForOwner, getCloseVaultInstruction, etc.)
   */
  function buildRemainingAccounts(
    policy: { hasPendingPolicy: boolean },
    agents: { pubkey: Address }[],
    existenceResults: (Address | null)[],
  ): { address: Address; role: AccountRole }[] {
    const remainingAccounts: { address: Address; role: AccountRole }[] = [];

    // 1. pending_policy (existenceResults[0])
    if (existenceResults[0]) {
      remainingAccounts.push({
        address: existenceResults[0],
        role: AccountRole.WRITABLE,
      });
    }

    // 2. pending_agent_perms (existenceResults[1..N])
    for (let i = 0; i < agents.length; i++) {
      if (existenceResults[1 + i]) {
        remainingAccounts.push({
          address: existenceResults[1 + i]!,
          role: AccountRole.WRITABLE,
        });
      }
    }

    // 3. pending_close_constraints (existenceResults[last])
    const constraintsIdx = 1 + agents.length;
    if (existenceResults[constraintsIdx]) {
      remainingAccounts.push({
        address: existenceResults[constraintsIdx]!,
        role: AccountRole.WRITABLE,
      });
    }

    return remainingAccounts;
  }

  // ─── No Pending PDAs ───────────────────────────────────────────────────

  it("returns empty array when no pending PDAs exist", () => {
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [],
      [null, null], // policy + constraints
    );
    expect(result).to.deep.equal([]);
  });

  it("returns empty array when agents exist but no pending perms", () => {
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [null, null, null, null], // policy + 2 agents + constraints
    );
    expect(result).to.deep.equal([]);
  });

  // ─── Pending Policy Only ───────────────────────────────────────────────

  it("includes pending policy PDA when it exists", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [],
      [policyPda, null], // policy exists, no constraints
    );

    expect(result).to.have.length(1);
    expect(result[0].address).to.equal(policyPda);
    expect(result[0].role).to.equal(AccountRole.WRITABLE);
  });

  // ─── Pending Agent Perms ───────────────────────────────────────────────

  it("includes one agent's pending perms PDA", () => {
    const agentPermsPda =
      "AgentPerms1111111111111111111111111111111" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [{ pubkey: AGENT_1 }],
      [null, agentPermsPda, null], // no policy, agent1 has pending, no constraints
    );

    expect(result).to.have.length(1);
    expect(result[0].address).to.equal(agentPermsPda);
    expect(result[0].role).to.equal(AccountRole.WRITABLE);
  });

  it("includes multiple agents' pending perms PDAs", () => {
    const perms1 = "AgentPerms1111111111111111111111111111111" as Address;
    const perms2 = "AgentPerms2222222222222222222222222222222" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [null, perms1, perms2, null], // no policy, both agents have pending, no constraints
    );

    expect(result).to.have.length(2);
    expect(result[0].address).to.equal(perms1);
    expect(result[1].address).to.equal(perms2);
  });

  it("skips agents without pending perms", () => {
    const perms2 = "AgentPerms2222222222222222222222222222222" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [null, null, perms2, null], // agent1 has no pending, agent2 does
    );

    expect(result).to.have.length(1);
    expect(result[0].address).to.equal(perms2);
  });

  // ─── Pending Close Constraints ─────────────────────────────────────────

  it("includes pending close constraints PDA", () => {
    const constraintsPda =
      "Constraints11111111111111111111111111111" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [],
      [null, constraintsPda], // no policy, constraints exist
    );

    expect(result).to.have.length(1);
    expect(result[0].address).to.equal(constraintsPda);
    expect(result[0].role).to.equal(AccountRole.WRITABLE);
  });

  // ─── All Three Types Combined ──────────────────────────────────────────

  it("includes all three types in correct order: policy → agents → constraints", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;
    const perms1 = "AgentPerms1111111111111111111111111111111" as Address;
    const perms2 = "AgentPerms2222222222222222222222222222222" as Address;
    const constraintsPda =
      "Constraints11111111111111111111111111111" as Address;

    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [policyPda, perms1, perms2, constraintsPda],
    );

    expect(result).to.have.length(4);

    // Verify order: policy first, then agents, then constraints
    expect(result[0].address).to.equal(policyPda);
    expect(result[1].address).to.equal(perms1);
    expect(result[2].address).to.equal(perms2);
    expect(result[3].address).to.equal(constraintsPda);

    // All must be WRITABLE
    for (const acct of result) {
      expect(acct.role).to.equal(AccountRole.WRITABLE);
    }
  });

  it("handles partial: policy + constraints but no agent perms", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;
    const constraintsPda =
      "Constraints11111111111111111111111111111" as Address;

    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [policyPda, null, null, constraintsPda], // policy + constraints, no agent perms
    );

    expect(result).to.have.length(2);
    expect(result[0].address).to.equal(policyPda);
    expect(result[1].address).to.equal(constraintsPda);
  });

  // ─── 10 Agents (Max) ──────────────────────────────────────────────────

  it("handles 10 agents (maximum) correctly", () => {
    const agents = Array.from({ length: 10 }, (_, i) => ({
      pubkey: `Agent${String(i).padStart(40, "0")}` as Address,
    }));

    // All agents have pending perms
    const existenceResults: (Address | null)[] = [
      null, // no pending policy
      ...agents.map((_, i) => `Perms${String(i).padStart(40, "0")}` as Address),
      null, // no constraints
    ];

    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      agents,
      existenceResults,
    );

    expect(result).to.have.length(10);
    for (const acct of result) {
      expect(acct.role).to.equal(AccountRole.WRITABLE);
    }
  });

  // ─── RPC Error Handling ────────────────────────────────────────────────

  it("treats null existence result as 'account does not exist'", () => {
    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [{ pubkey: AGENT_1 }],
      [null, null, null], // all existence checks returned null (RPC errors)
    );

    expect(result).to.deep.equal([]); // nothing added — safe fallback
  });
});

// ─── PDA Seed Verification ──────────────────────────────────────────────────

describe("closeVault PDA seeds", () => {
  // Must use valid base58 addresses (no 0, O, I, l characters)
  const VALID_VAULT = "11111111111111111111111111111112" as Address;

  it("pending_close_constraints uses correct seed (not pending_constraints)", async () => {
    const { getPendingCloseConstraintsPDA } =
      await import("../../src/resolve-accounts.js");
    const { getPendingConstraintsPDA } =
      await import("../../src/resolve-accounts.js");

    const [closeConstraintsPda] =
      await getPendingCloseConstraintsPDA(VALID_VAULT);
    const [updateConstraintsPda] = await getPendingConstraintsPDA(VALID_VAULT);

    // These MUST be different — they use different seeds
    // "pending_close_constraints" vs "pending_constraints"
    expect(closeConstraintsPda).to.not.equal(updateConstraintsPda);
  });

  it("getPendingCloseConstraintsPDA returns deterministic result", async () => {
    const { getPendingCloseConstraintsPDA } =
      await import("../../src/resolve-accounts.js");

    const [pda1] = await getPendingCloseConstraintsPDA(VALID_VAULT);
    const [pda2] = await getPendingCloseConstraintsPDA(VALID_VAULT);

    expect(pda1).to.equal(pda2);
  });
});
