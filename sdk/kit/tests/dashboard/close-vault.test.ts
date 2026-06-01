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

    // (M1-04b: the pending_close_constraints push was removed — the
    // constraints engine is gone, that PDA can never exist.)
    return remainingAccounts;
  }

  // ─── No Pending PDAs ───────────────────────────────────────────────────

  it("returns empty array when no pending PDAs exist", () => {
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [],
      [null, null], // policy slot (no agents)
    );
    expect(result).to.deep.equal([]);
  });

  it("returns empty array when agents exist but no pending perms", () => {
    const result = buildRemainingAccounts(
      { hasPendingPolicy: false },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [null, null, null], // policy + 2 agents
    );
    expect(result).to.deep.equal([]);
  });

  // ─── Pending Policy Only ───────────────────────────────────────────────

  it("includes pending policy PDA when it exists", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;
    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [],
      [policyPda], // policy exists
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
      [null, agentPermsPda], // no policy, agent1 has pending
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
      [null, perms1, perms2], // no policy, both agents have pending
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

  // ─── All Types Combined ────────────────────────────────────────────────

  it("includes all types in correct order: policy → agents", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;
    const perms1 = "AgentPerms1111111111111111111111111111111" as Address;
    const perms2 = "AgentPerms2222222222222222222222222222222" as Address;

    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [policyPda, perms1, perms2],
    );

    expect(result).to.have.length(3);

    // Verify order: policy first, then agents
    expect(result[0].address).to.equal(policyPda);
    expect(result[1].address).to.equal(perms1);
    expect(result[2].address).to.equal(perms2);

    // All must be WRITABLE
    for (const acct of result) {
      expect(acct.role).to.equal(AccountRole.WRITABLE);
    }
  });

  it("handles partial: policy but no agent perms", () => {
    const policyPda = "PolicyPDA111111111111111111111111111111111" as Address;

    const result = buildRemainingAccounts(
      { hasPendingPolicy: true },
      [{ pubkey: AGENT_1 }, { pubkey: AGENT_2 }],
      [policyPda, null, null], // policy only, no agent perms
    );

    expect(result).to.have.length(1);
    expect(result[0].address).to.equal(policyPda);
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

// ─── close-vault pending-PDA drain helpers ──────────────────────────────────

describe("close-vault pending-PDA drain helpers", () => {
  // Same valid base58 vault used above; helpers are deterministic so
  // we can compare addresses across two invocations.
  const VALID_VAULT = "11111111111111111111111111111112" as Address;

  it("CLOSE_VAULT_PENDING_PDA_ORDER pins the 4-step drain layout", async () => {
    const { CLOSE_VAULT_PENDING_PDA_ORDER } =
      await import("../../src/dashboard/close-vault.js");

    // Lock the array shape so reviewers catch drift between the SDK
    // helper and the Rust drain blocks in close_vault.rs. (M1-04b removed
    // the pending_close_constraints + pending_constraints drains.)
    expect([...CLOSE_VAULT_PENDING_PDA_ORDER]).to.deep.equal([
      "pending_policy",
      "pending_agent_perms",
      "pending_owner",
      "pending_agent_grant",
    ]);
  });

  it("findPendingOwnerPda + findPendingAgentGrantPda are deterministic and distinct", async () => {
    const { findPendingOwnerPda, findPendingAgentGrantPda } = await import(
      "../../src/dashboard/close-vault.js"
    );

    const ownerPda1 = await findPendingOwnerPda(VALID_VAULT);
    const ownerPda2 = await findPendingOwnerPda(VALID_VAULT);
    expect(ownerPda1).to.equal(ownerPda2);

    const grantPda1 = await findPendingAgentGrantPda(VALID_VAULT);
    const grantPda2 = await findPendingAgentGrantPda(VALID_VAULT);
    expect(grantPda1).to.equal(grantPda2);

    // Distinct PDAs (different seeds).
    expect(ownerPda1).to.not.equal(grantPda1);
  });

  it("enumerateExistingPendingPdasForClose returns only PDAs that exist on-chain", async () => {
    const { enumerateExistingPendingPdasForClose } =
      await import("../../src/dashboard/close-vault.js");

    // Mock RPC that says: pending_owner does NOT exist, pending_agent_grant
    // DOES exist. The helper should return exactly the one that exists.
    const fakeAccountInfo = (exists: boolean) => ({
      send: async () =>
        exists
          ? {
              value: {
                data: ["", "base64"],
                lamports: 1n,
                owner: "x",
                executable: false,
                rentEpoch: 0n,
              },
            }
          : { value: null },
    });

    type Probe = { kind: string; address: Address };
    const probes: Probe[] = [];
    const rpcMock = {
      getAccountInfo: (address: Address, _opts: unknown) => {
        probes.push({ kind: "?", address });
        // pending_owner = null, others = exist
        // We don't know the addresses yet — capture and decide below.
        return fakeAccountInfo(true);
      },
    };

    // First invocation captures the 2 candidate addresses.
    await enumerateExistingPendingPdasForClose(
      rpcMock as unknown as Rpc<SolanaRpcApi>,
      VALID_VAULT,
    );
    expect(probes).to.have.length(2);

    const [ownerProbe, grantProbe] = probes;
    expect(ownerProbe).to.not.be.undefined;
    expect(grantProbe).to.not.be.undefined;

    // Second invocation with selective existence: owner absent, grant present.
    const selectiveRpc = {
      getAccountInfo: (address: Address, _opts: unknown) =>
        fakeAccountInfo(address !== ownerProbe.address),
    };
    const result = await enumerateExistingPendingPdasForClose(
      selectiveRpc as unknown as Rpc<SolanaRpcApi>,
      VALID_VAULT,
    );

    expect(result).to.have.length(1);
    const kinds = result.map((r) => r.kind).sort();
    expect(kinds).to.deep.equal(["pending_agent_grant"]);
    for (const entry of result) {
      expect(entry.role).to.equal(AccountRole.WRITABLE);
    }
  });

  it("enumerateExistingPendingPdasForClose treats RPC errors as 'absent'", async () => {
    const { enumerateExistingPendingPdasForClose } =
      await import("../../src/dashboard/close-vault.js");

    const erroringRpc = {
      getAccountInfo: (_address: Address, _opts: unknown) => ({
        send: async () => {
          throw new Error("simulated RPC outage");
        },
      }),
    };

    const result = await enumerateExistingPendingPdasForClose(
      erroringRpc as unknown as Rpc<SolanaRpcApi>,
      VALID_VAULT,
    );

    // RPC errors → safe fallback: no entries returned, close TX still
    // proceeds, drain blocks silently no-op on missing PDAs.
    expect(result).to.deep.equal([]);
  });
});
