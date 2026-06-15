/**
 * Regression guard for the 2026-06-11 audit follow-up (HIGH-A..D): the
 * dashboard digest builders `siblingHandlerExpectedDigest` (consumed by
 * createPostAssertions / closePostAssertions) and the `queuePolicyUpdate`
 * digest must bind EVERY field the on-chain handler recomputes from live
 * state. Three fields had been silently omitted, defaulting in the encoder
 * (EMPTY_AGENT_SET_HASH / 0n / zero-pubkey) and producing a digest that
 * mismatches the on-chain recompute (PolicyPreviewMismatch, 6073) on real
 * vaults:
 *
 *   siblingHandlerExpectedDigest:  agent_set_hash, operator_grant_delay_seconds
 *   queuePolicyUpdate:             agent_set_hash, cosign_session_pubkey
 *
 * Strategy (non-circular, no hand-built oracle): drive the REAL exported
 * mutation through a mock RPC that serves an encoded PolicyConfig + AgentVault,
 * capture the wire transaction it signs, decode the Sigil instruction, and
 * read back the digest the owner would sign. Then run the SAME mutation twice
 * across two vault states that differ ONLY in one live-derived field, and
 * assert the two captured digests DIFFER. If the builder drops that field both
 * runs default to the same value and the digests collide — the test fails,
 * catching the regression. The on-chain recompute reads the same live field,
 * so "the digest changes when the live field changes" is exactly the property
 * that keeps the SDK digest matching on-chain.
 *
 * On-chain sources this guards (read firsthand):
 *   create_post_assertions.rs:129 agent_set_hash = compute_agent_set_hash(vault.agents)
 *   create_post_assertions.rs:136 operator_grant_delay_seconds = policy.*
 *   queue_policy_update.rs:559     agent_set_hash = compute_agent_set_hash(vault.agents)
 *   queue_policy_update.rs:565     cosign_session_pubkey = eff (= live when arg None)
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
} from "@solana/kit";
import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";

import {
  createPostAssertions,
  queuePolicyUpdate,
} from "../../src/dashboard/mutations.js";
import type { PolicyChanges } from "../../src/dashboard/types.js";
import type { PostAssertionEntry } from "../../src/generated/types/postAssertionEntry.js";
import { getPolicyConfigEncoder } from "../../src/generated/accounts/policyConfig.js";
import { getAgentVaultEncoder } from "../../src/generated/accounts/agentVault.js";
import { getCreatePostAssertionsInstructionDataDecoder } from "../../src/generated/instructions/createPostAssertions.js";
import { getQueuePolicyUpdateInstructionDataDecoder } from "../../src/generated/instructions/queuePolicyUpdate.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import { getPolicyPDA } from "../../src/resolve-accounts.js";
import { createMockVaultState } from "../../src/testing/mock-state.js";

const TARGET_ACCT = "So11111111111111111111111111111111111111112" as Address;

// All vault/agent/owner pubkeys are generated per-run (valid 32-byte base58 —
// the mock-state placeholder constants like "Vault111…" are display-only and
// throw when the account encoder base58-decodes them). Assigned in before().
let MOCK_VAULT: Address;
let SECOND_AGENT: Address;
let NON_DEFAULT_COSIGN: Address;
let ADDR_OWNER: Address;
let ADDR_AGENT: Address;
let ADDR_FEE: Address;

function validEntry(): PostAssertionEntry {
  return {
    targetAccount: TARGET_ACCT,
    offset: 0,
    valueLen: 1,
    operator: 0,
    expectedValue: new Uint8Array([1]),
    assertionMode: 0,
    auxValue: new Uint8Array(8),
    auxByte: 0,
  };
}

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}

/** Account-info JSON-RPC value shape that `fetchEncodedAccount` consumes. */
function accountInfo(dataB64: string) {
  return {
    value: {
      data: [dataB64, "base64"] as [string, "base64"],
      executable: false,
      lamports: 10_000_000n,
      owner: SIGIL_PROGRAM_ADDRESS,
      rentEpoch: 0n,
      space: BigInt(Buffer.from(dataB64, "base64").length),
    },
  };
}

/**
 * Mock RPC that (a) serves the encoded policy at its PDA and the encoded vault
 * at the vault address, (b) captures the base64 wire tx passed to
 * sendTransaction, and (c) returns canned values for the rest of the
 * send/confirm pipeline. `captured.wire` holds the signed tx after a mutation.
 */
function buildMockRpc(args: {
  policyAddress: Address;
  policyDataB64: string;
  vaultAddress: Address;
  vaultDataB64: string;
  captured: { wire: string | null };
}): Rpc<SolanaRpcApi> {
  const { policyAddress, policyDataB64, vaultAddress, vaultDataB64, captured } =
    args;
  return {
    getAccountInfo: (address: Address) => ({
      send: async () => {
        if (address === policyAddress) return accountInfo(policyDataB64);
        if (address === vaultAddress) return accountInfo(vaultDataB64);
        return { value: null };
      },
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
          lastValidBlockHeight: 1000n,
        },
      }),
    }),
    simulateTransaction: () => ({
      send: async () => ({
        value: { err: null, logs: [], unitsConsumed: 400_000 },
      }),
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        captured.wire = wire;
        return "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ confirmationStatus: "confirmed", err: null }],
      }),
    }),
    getSlot: () => ({ send: async () => 100n }),
    getMinimumBalanceForRentExemption: (size: bigint) => ({
      send: async () => (size + 128n) * 6_960n,
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

/** Decode a captured wire tx and return the Sigil instruction's `data`. */
function sigilInstructionData(wireB64: string): ReadonlyUint8Array {
  const bytes = getBase64Encoder().encode(wireB64);
  // wire = [compact-u16 sig count][64 * sigs][compiled message]. 1 signer.
  const numSigs = bytes[0]!;
  const messageBytes = bytes.slice(1 + 64 * numSigs);
  const message = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    staticAccounts: Address[];
    instructions: ReadonlyArray<{
      programAddressIndex: number;
      data?: ReadonlyUint8Array;
    }>;
  };
  const sigilIx = message.instructions.find(
    (ix) =>
      message.staticAccounts[ix.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
  );
  if (!sigilIx?.data) throw new Error("Sigil instruction not found in tx");
  return sigilIx.data;
}

/** A vault-state mutator applied to the decoded mock state before encoding. */
type StateTweak = (s: ReturnType<typeof createMockVaultState>) => void;

/**
 * Run `createPostAssertions` against a mock vault built from `tweak` and return
 * the `expectedDigest` the SDK signed.
 */
async function capturePostAssertionsDigest(
  owner: TransactionSigner,
  tweak: StateTweak,
): Promise<ReadonlyUint8Array> {
  const state = createMockVaultState({
    vault: MOCK_VAULT,
    agent: ADDR_AGENT,
    owner: ADDR_OWNER,
    feeDestination: ADDR_FEE,
  });
  tweak(state);
  const [policyAddress] = await getPolicyPDA(MOCK_VAULT);
  const captured = { wire: null as string | null };
  const rpc = buildMockRpc({
    policyAddress,
    policyDataB64: toBase64(
      getPolicyConfigEncoder().encode(state.policy as never),
    ),
    vaultAddress: MOCK_VAULT,
    vaultDataB64: toBase64(getAgentVaultEncoder().encode(state.vault as never)),
    captured,
  });
  await createPostAssertions(rpc, MOCK_VAULT, owner, "devnet", [validEntry()]);
  if (!captured.wire) throw new Error("no wire captured");
  const data = sigilInstructionData(captured.wire);
  return getCreatePostAssertionsInstructionDataDecoder().decode(data)
    .expectedDigest;
}

/** Same for `queuePolicyUpdate` (requires >=1 change). */
async function captureQueueDigest(
  owner: TransactionSigner,
  changes: PolicyChanges,
  tweak: StateTweak,
): Promise<ReadonlyUint8Array> {
  const state = createMockVaultState({
    vault: MOCK_VAULT,
    agent: ADDR_AGENT,
    owner: ADDR_OWNER,
    feeDestination: ADDR_FEE,
  });
  tweak(state);
  const [policyAddress] = await getPolicyPDA(MOCK_VAULT);
  const captured = { wire: null as string | null };
  const rpc = buildMockRpc({
    policyAddress,
    policyDataB64: toBase64(
      getPolicyConfigEncoder().encode(state.policy as never),
    ),
    vaultAddress: MOCK_VAULT,
    vaultDataB64: toBase64(getAgentVaultEncoder().encode(state.vault as never)),
    captured,
  });
  await queuePolicyUpdate(rpc, MOCK_VAULT, owner, "devnet", changes);
  if (!captured.wire) throw new Error("no wire captured");
  const data = sigilInstructionData(captured.wire);
  return getQueuePolicyUpdateInstructionDataDecoder().decode(data)
    .newPolicyPreviewDigest;
}

function hex(b: ReadonlyUint8Array): string {
  return Buffer.from(b as Uint8Array).toString("hex");
}

describe("dashboard digest builders bind all live-derived TA-19 fields (audit 2026-06-11 HIGH-A..D)", () => {
  let owner: TransactionSigner;
  before(async () => {
    owner = await generateKeyPairSigner();
    // Generate valid 32-byte base58 addresses for every pubkey the account
    // encoders must base58-decode.
    MOCK_VAULT = (await generateKeyPairSigner()).address;
    SECOND_AGENT = (await generateKeyPairSigner()).address;
    NON_DEFAULT_COSIGN = (await generateKeyPairSigner()).address;
    ADDR_OWNER = (await generateKeyPairSigner()).address;
    ADDR_AGENT = (await generateKeyPairSigner()).address;
    ADDR_FEE = (await generateKeyPairSigner()).address;
  });

  // ─── createPostAssertions (siblingHandlerExpectedDigest) ──────────────────

  it("agent_set_hash flows into the createPostAssertions digest", async () => {
    const oneAgent = await capturePostAssertionsDigest(owner, () => {});
    const twoAgents = await capturePostAssertionsDigest(owner, (s) => {
      s.vault.agents = [
        ...s.vault.agents,
        {
          pubkey: SECOND_AGENT,
          capability: 1,
          spendingLimitUsd: 0n,
          paused: false,
          consecutiveFailures: 0,
          reserved: new Uint8Array(6),
        } as never,
      ];
    });
    expect(hex(oneAgent)).to.not.equal(
      hex(twoAgents),
      "digest ignored the agent set — agent_set_hash omitted (HIGH-A regression)",
    );
  });

  it("operator_grant_delay_seconds flows into the createPostAssertions digest", async () => {
    const zeroDelay = await capturePostAssertionsDigest(owner, () => {});
    const withDelay = await capturePostAssertionsDigest(owner, (s) => {
      s.policy.operatorGrantDelaySeconds = 3600n;
    });
    expect(hex(zeroDelay)).to.not.equal(
      hex(withDelay),
      "digest ignored operator_grant_delay_seconds (HIGH-B regression)",
    );
  });

  // ─── queuePolicyUpdate ────────────────────────────────────────────────────

  it("agent_set_hash flows into the queuePolicyUpdate digest", async () => {
    const change: PolicyChanges = { maxSlippageBps: 250 };
    const oneAgent = await captureQueueDigest(owner, change, () => {});
    const twoAgents = await captureQueueDigest(owner, change, (s) => {
      s.vault.agents = [
        ...s.vault.agents,
        {
          pubkey: SECOND_AGENT,
          capability: 1,
          spendingLimitUsd: 0n,
          paused: false,
          consecutiveFailures: 0,
          reserved: new Uint8Array(6),
        } as never,
      ];
    });
    expect(hex(oneAgent)).to.not.equal(
      hex(twoAgents),
      "queue digest ignored the agent set — agent_set_hash omitted (HIGH-C regression)",
    );
  });

  it("cosign_session_pubkey flows into the queuePolicyUpdate digest", async () => {
    const change: PolicyChanges = { maxSlippageBps: 250 };
    const defaultCosign = await captureQueueDigest(owner, change, () => {});
    const setCosign = await captureQueueDigest(owner, change, (s) => {
      s.policy.cosignSessionPubkey = NON_DEFAULT_COSIGN as never;
    });
    expect(hex(defaultCosign)).to.not.equal(
      hex(setCosign),
      "queue digest ignored cosign_session_pubkey (HIGH-D regression)",
    );
  });
});
