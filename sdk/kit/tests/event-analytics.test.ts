/**
 * Tests for event-analytics.ts — activity feed, event categorization, descriptions.
 */

import { expect } from "chai";
import {
  categorizeEvent,
  describeEvent,
  buildActivityItem,
  getVaultActivity,
} from "../src/event-analytics.js";
import type { DecodedSigilEvent } from "../src/events.js";
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { getBase58Decoder } from "@solana/kit";
import { buildActivityRows } from "../src/dashboard/reads.js";
import { SIGIL_PROGRAM_ADDRESS } from "../src/generated/programs/index.js";
import { getValidateAndAuthorizeInstructionDataEncoder } from "../src/generated/instructions/validateAndAuthorize.js";

// ─── categorizeEvent ─────────────────────────────────────────────────────────

describe("categorizeEvent", () => {
  it("categorizes ActionAuthorized as trade", () => {
    expect(categorizeEvent("ActionAuthorized")).to.equal("trade");
  });

  it("categorizes FundsDeposited as deposit", () => {
    expect(categorizeEvent("FundsDeposited")).to.equal("deposit");
  });

  it("categorizes VaultFrozen as security", () => {
    expect(categorizeEvent("VaultFrozen")).to.equal("security");
  });

  it("categorizes PolicyChangeApplied as policy", () => {
    expect(categorizeEvent("PolicyChangeApplied")).to.equal("policy");
  });

  // V2 demolition: EscrowCreated event removed (no escrow category in EventCategory union).

  it("categorizes FeesCollected as fee", () => {
    expect(categorizeEvent("FeesCollected")).to.equal("fee");
  });

  it("defaults unknown events to trade", () => {
    expect(categorizeEvent("SomeNewEvent")).to.equal("trade");
  });

  it("categorizes known events into expected categories", () => {
    // Spot-check specific events against their actual categories
    // (tests the mapping logic, not just that a string is returned)
    expect(categorizeEvent("ActionAuthorized")).to.equal("trade");
    expect(categorizeEvent("SessionFinalized")).to.equal("trade");
    expect(categorizeEvent("FundsDeposited")).to.equal("deposit");
    expect(categorizeEvent("FundsWithdrawn")).to.equal("withdrawal");
    expect(categorizeEvent("PolicyChangeApplied")).to.equal("policy");
    expect(categorizeEvent("VaultCreated")).to.equal("security");
    expect(categorizeEvent("VaultFrozen")).to.equal("security");
    // V2 demolition: EscrowCreated removed (no escrow category in EventCategory union).
    expect(categorizeEvent("FeesCollected")).to.equal("fee");
    expect(categorizeEvent("AgentRegistered")).to.equal("agent");
  });
});

// ─── describeEvent ───────────────────────────────────────────────────────────

describe("describeEvent", () => {
  it("describes FundsDeposited with amount", () => {
    const decoded: DecodedSigilEvent = {
      name: "FundsDeposited",
      data: new Uint8Array(0),
      fields: {
        vault: "vault123",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 500_000_000n,
        timestamp: 1700000000n,
      },
    };
    const desc = describeEvent(decoded, "mainnet-beta");
    expect(desc).to.include("deposited");
    expect(desc).to.include("500");
  });

  it("describes VaultFrozen", () => {
    const decoded: DecodedSigilEvent = {
      name: "VaultFrozen",
      data: new Uint8Array(0),
      fields: { vault: "v", owner: "o", agentsPreserved: 2, timestamp: 0n },
    };
    expect(describeEvent(decoded)).to.equal(
      "Vault paused — all agent activity stopped",
    );
  });

  it("handles null fields gracefully", () => {
    const decoded: DecodedSigilEvent = {
      name: "ActionAuthorized",
      data: new Uint8Array(0),
      fields: null,
    };
    expect(describeEvent(decoded)).to.include("details unavailable");
  });

  it("describes expired session differently from failed", () => {
    const expired: DecodedSigilEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "a123456789abcdef",
        success: false,
        isExpired: true,
        timestamp: 0n,
      },
    };
    expect(describeEvent(expired)).to.include("expired");

    const failed: DecodedSigilEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "a123456789abcdef",
        success: false,
        isExpired: false,
        timestamp: 0n,
      },
    };
    expect(describeEvent(failed)).to.include("failed");
  });

  it("describes unknown event with name", () => {
    const decoded: DecodedSigilEvent = {
      name: "FutureEvent" as any,
      data: new Uint8Array(0),
      fields: {},
    };
    expect(describeEvent(decoded)).to.equal("FutureEvent event");
  });
});

// ─── buildActivityItem ───────────────────────────────────────────────────────

describe("buildActivityItem", () => {
  it("builds complete activity item from FundsDeposited", () => {
    const decoded: DecodedSigilEvent = {
      name: "FundsDeposited",
      data: new Uint8Array(0),
      fields: {
        vault: "vault123",
        tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 500_000_000n,
        timestamp: 1700000000n,
      },
    };

    const item = buildActivityItem(
      decoded,
      "tx123abc",
      1700000000,
      "mainnet-beta",
    );
    expect(item.category).to.equal("deposit");
    expect(item.amount).to.equal(500_000_000n);
    expect(item.success).to.equal(true);
    expect(item.txSignature).to.equal("tx123abc");
    expect(item.description).to.include("deposited");
  });

  // Legacy "actionType" decode test and "v6 isSpending field" test deleted
  // in V2 Option A — on-chain ActionType + isSpending event fields are gone;
  // VaultActivityItem.isSpending is now derived from amount > 0n in the
  // decode pipeline.

  it("derives isSpending from amount > 0n on ActionAuthorized", () => {
    const decoded: DecodedSigilEvent = {
      name: "ActionAuthorized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "agent123456789abc",
        tokenMint: "mint123",
        amount: 100_000_000n,
        usdAmount: 100_000_000n,
        protocol: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        rollingSpendUsdAfter: 0n,
        dailyCapUsd: 1_000_000_000n,
        delegated: true,
        timestamp: 1700000000n,
      },
    };

    const item = buildActivityItem(decoded, "tx456v2", 1700000000);
    expect(item.isSpending).to.equal(true);
    expect(item.amount).to.equal(100_000_000n);
    expect(item.category).to.equal("trade");
  });

  it("handles SessionFinalized with u8 actionType", () => {
    const decoded: DecodedSigilEvent = {
      name: "SessionFinalized",
      data: new Uint8Array(0),
      fields: {
        vault: "v",
        agent: "agent123456789abc",
        success: true,
        isExpired: false,
        timestamp: 1700000000n,
        actualSpendUsd: 50_000_000n,
        balanceAfterUsd: 950_000_000n,
        actionType: 0, // u8 for Swap
      },
    };

    const item = buildActivityItem(decoded, "tx789", 1700000000);
    expect(item.category).to.equal("trade");
    expect(item.success).to.equal(true);
  });

  it("defaults success to true for non-session events", () => {
    const decoded: DecodedSigilEvent = {
      name: "VaultCreated",
      data: new Uint8Array(0),
      fields: { vault: "v", owner: "o", vaultId: 1n, timestamp: 0n },
    };
    const item = buildActivityItem(decoded, "tx", 0);
    expect(item.success).to.equal(true);
  });
});

// ─── Blocked-attempt reconstruction (failed-tx branch) ────────────────────────

describe("getVaultActivity — blocked-attempt reconstruction", () => {
  const SIGIL = SIGIL_PROGRAM_ADDRESS as string;
  const VAULT = "11111111111111111111111111111112" as Address;
  // Real, valid base58 pubkeys for agent + protocol.
  const AGENT_KEY = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address; // sample wallet
  const PROTOCOL_KEY = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address; // Jupiter v6
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
  const OTHER_PROGRAM =
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

  /** Encode a real validate_and_authorize data blob, returned as a base58 string. */
  function validateIxDataBase58(amount: bigint): string {
    const bytes = getValidateAndAuthorizeInstructionDataEncoder().encode({
      tokenMint: USDC,
      amount,
      targetProtocol: PROTOCOL_KEY,
      expectedPolicyVersion: 1n,
      expectedNonce: 0n,
      expectedIntentDigest: new Uint8Array(32),
    });
    return getBase58Decoder().decode(bytes);
  }

  /**
   * Build a JSON-encoded failed-tx mock containing a real validate_and_authorize
   * instruction. accountKeys index map: 0=agent, 1=vault, … 15 metas total,
   * then [16]=sigil program, [17]=other program. The validate ix points its 15
   * account metas at indices 0..14 (so accounts[0] == agent) and its programId
   * at the sigil index.
   */
  function failedTxWithValidateIx(opts: {
    logMessages: string[];
    amount?: bigint;
    includeValidateIx?: boolean;
    truncateValidateAccounts?: boolean;
    /**
     * If set, the validate ix's `agent` meta points at this NON-signer victim
     * address instead of the real signer at accountKeys[0]. Models an agent
     * trying to frame a different agent in the owner feed (must be nulled).
     */
    spoofVictim?: Address;
    /** numRequiredSignatures (default 1 — the validate invariant). */
    numSigners?: number;
  }) {
    // accountKeys[0] is ALWAYS the real tx signer. The validate ix's 15 account
    // metas point at indices 0..14; index 0 (agent meta) → the signer, UNLESS a
    // spoof victim is supplied, in which case it points at a trailing non-signer.
    const baseKeys: Address[] = [
      AGENT_KEY, // 0 — real signer + agent
      VAULT, // 1
      VAULT, // 2
      VAULT, // 3
      VAULT, // 4
      VAULT, // 5
      VAULT, // 6
      USDC, // 7
      VAULT, // 8
      VAULT, // 9
      VAULT, // 10
      VAULT, // 11
      OTHER_PROGRAM, // 12
      "11111111111111111111111111111111" as Address, // 13
      "Sysvar1nstructions1111111111111111111111111" as Address, // 14
    ];
    const sigilIndex = baseKeys.length; // 15
    const otherIndex = sigilIndex + 1; // 16
    const accountKeys: Address[] = [
      ...baseKeys,
      SIGIL as Address, // 15
      OTHER_PROGRAM, // 16
    ];
    // Validate ix account-meta indices: [0..14]; swap the agent slot to a
    // trailing non-signer victim index when spoofing.
    let agentMetaIndex = 0;
    if (opts.spoofVictim) {
      agentMetaIndex = accountKeys.length; // 17
      accountKeys.push(opts.spoofVictim);
    }
    // 15 metas: slot 0 = agent (swappable to the spoof index), slots 1..14 fixed.
    const ixAccountIndices = [
      agentMetaIndex,
      ...Array.from({ length: 14 }, (_, i) => i + 1),
    ];

    const instructions: {
      programIdIndex: number;
      accounts: number[];
      data: string;
    }[] = [];

    if (opts.includeValidateIx !== false) {
      instructions.push({
        programIdIndex: sigilIndex,
        accounts: opts.truncateValidateAccounts
          ? ixAccountIndices.slice(0, 5) // < 15 metas → parser throws → null
          : ixAccountIndices,
        data: validateIxDataBase58(opts.amount ?? 250_000_000n),
      });
    }
    // A trailing non-Sigil instruction (the DeFi venue ix) for realism.
    instructions.push({
      programIdIndex: otherIndex,
      accounts: [0, 7],
      data: "3", // arbitrary
    });

    return {
      meta: {
        err: { InstructionError: [0, { Custom: 6006 }] },
        logMessages: opts.logMessages,
      },
      transaction: {
        message: {
          header: { numRequiredSignatures: opts.numSigners ?? 1 },
          accountKeys,
          instructions,
        },
      },
    };
  }

  /** Minimal mock rpc: one signature → the given failed tx. */
  function mockRpc(tx: unknown, err: unknown = { Custom: 6006 }) {
    return {
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: "sigFailed111", err, blockTime: 1_700_000_000n },
        ],
      }),
      getTransaction: () => ({
        send: async () => tx,
      }),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  const anchorBlockLogs = [
    `Program ${SIGIL} invoke [1]`,
    "Program log: Instruction: ValidateAndAuthorize",
    "Program log: AnchorError thrown in src/instructions/validate_and_authorize.rs:512. Error Code: SpendingCapExceeded. Error Number: 6006. Error Message: Rolling 24h spending cap would be exceeded.",
    `Program ${SIGIL} consumed 12345 of 1400000 compute units`,
    `Program ${SIGIL} failed: custom program error: 0x1776`,
  ];

  it("reconstructs a blocked item from an Anchor 'Error Number: 6006' log", async () => {
    const tx = failedTxWithValidateIx({ logMessages: anchorBlockLogs });
    const items = await getVaultActivity(
      mockRpc(tx),
      VAULT,
      10,
      "mainnet-beta",
    );

    expect(items).to.have.lengthOf(1);
    const item = items[0]!;
    expect(item.success).to.equal(false);
    expect(item.description).to.equal("SpendingCapExceeded");
    expect(item.txSignature).to.equal("sigFailed111");
    expect(item.timestamp).to.equal(1_700_000_000);
    // Reconstructed actor fields from the decoded validate ix.
    expect(item.agent).to.equal(AGENT_KEY);
    expect(item.protocol).to.equal(PROTOCOL_KEY);
    expect(item.amount).to.equal(250_000_000n);

    // buildActivityRows maps it to a blocked row (ISC-30).
    const rows = buildActivityRows(items);
    expect(rows).to.have.lengthOf(1);
    expect(rows[0]!.status).to.equal("blocked");
    expect(rows[0]!.reason).to.equal("SpendingCapExceeded");
  });

  it("reconstructs from a raw 'custom program error: 0x1776' (hex path)", async () => {
    const hexLogs = [
      `Program ${SIGIL} invoke [1]`,
      "Program log: Instruction: ValidateAndAuthorize",
      `Program ${SIGIL} consumed 9000 of 1400000 compute units`,
      `Program ${SIGIL} failed: custom program error: 0x1776`,
    ];
    const tx = failedTxWithValidateIx({ logMessages: hexLogs });
    const items = await getVaultActivity(
      mockRpc(tx),
      VAULT,
      10,
      "mainnet-beta",
    );

    expect(items).to.have.lengthOf(1);
    expect(items[0]!.success).to.equal(false);
    expect(items[0]!.description).to.equal("SpendingCapExceeded");

    const rows = buildActivityRows(items);
    expect(rows[0]!.status).to.equal("blocked");
    expect(rows[0]!.reason).to.equal("SpendingCapExceeded");
  });

  it("skips a failed tx whose error is NON-Sigil (downstream 0x1)", async () => {
    // The failure comes from ANOTHER program; the Sigil frame opened+succeeded.
    const downstreamLogs = [
      `Program ${SIGIL} invoke [1]`,
      "Program log: Instruction: ValidateAndAuthorize",
      `Program ${SIGIL} consumed 8000 of 1400000 compute units`,
      `Program ${SIGIL} success`,
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program ${OTHER_PROGRAM} failed: custom program error: 0x1`,
    ];
    const tx = failedTxWithValidateIx({ logMessages: downstreamLogs });
    const items = await getVaultActivity(
      mockRpc(tx, { Custom: 1 }),
      VAULT,
      10,
      "mainnet-beta",
    );
    // No Sigil-attributable code → no fabricated blocked row.
    expect(items).to.have.lengthOf(0);
    expect(buildActivityRows(items)).to.have.lengthOf(0);
  });

  it("skips a Sigil error in a NON-agent category (owner-auth 6002 UnauthorizedOwner)", async () => {
    // 6002 IS a real Sigil code (0x1772) but its category is PERMISSION (an
    // owner action), not an agent policy-block. A failed OWNER tx must NOT
    // appear as a "blocked attempt" in the agent's activity trail.
    const ownerErrLogs = [
      `Program ${SIGIL} invoke [1]`,
      "Program log: AnchorError thrown in src/instructions/queue_policy_update.rs:1. Error Code: UnauthorizedOwner. Error Number: 6002. Error Message: Only the vault owner may perform this action.",
      `Program ${SIGIL} consumed 5000 of 1400000 compute units`,
      `Program ${SIGIL} failed: custom program error: 0x1772`,
    ];
    const tx = failedTxWithValidateIx({ logMessages: ownerErrLogs });
    const items = await getVaultActivity(
      mockRpc(tx, { Custom: 6002 }),
      VAULT,
      10,
      "mainnet-beta",
    );
    // Sigil code present, but category PERMISSION → not an agent block → no row.
    expect(items).to.have.lengthOf(0);
    expect(buildActivityRows(items)).to.have.lengthOf(0);
  });

  it("leaves a successful tx unchanged (no blocked regression)", async () => {
    // A success tx emits a real ActionAuthorized event and meta.err == null.
    // Reuse the production decode path by feeding a Program data: line. Since
    // crafting a real event blob here is heavy, assert the NEGATIVE: a tx with
    // err == null never enters the blocked branch even if logs mention a code.
    const successishLogs = [
      `Program ${SIGIL} invoke [1]`,
      "Program log: Instruction: ValidateAndAuthorize",
      `Program ${SIGIL} success`,
    ];
    const tx = {
      meta: { err: null, logMessages: successishLogs },
      transaction: { message: { accountKeys: [], instructions: [] } },
    };
    const items = await getVaultActivity(
      mockRpc(tx, null),
      VAULT,
      10,
      "mainnet-beta",
    );
    // No success events decoded AND err == null → neither branch fires.
    expect(items).to.have.lengthOf(0);
  });

  it("emits a blocked row with null actor fields when the validate ix can't be decoded", async () => {
    // Truncated validate ix (< 15 account metas) → codama parser throws → null
    // agent/protocol/amount, but the block itself is still surfaced.
    const tx = failedTxWithValidateIx({
      logMessages: anchorBlockLogs,
      truncateValidateAccounts: true,
    });
    const items = await getVaultActivity(
      mockRpc(tx),
      VAULT,
      10,
      "mainnet-beta",
    );

    expect(items).to.have.lengthOf(1);
    const item = items[0]!;
    expect(item.success).to.equal(false);
    expect(item.description).to.equal("SpendingCapExceeded");
    expect(item.agent).to.equal(null);
    expect(item.protocol).to.equal(null);
    expect(item.amount).to.equal(null);
    expect(item.amountDisplay).to.equal(null);

    const rows = buildActivityRows(items);
    expect(rows[0]!.status).to.equal("blocked");
    expect(rows[0]!.reason).to.equal("SpendingCapExceeded");
  });

  it("does NOT fabricate a block from a nested (CPI'd, depth-2) Sigil failure", async () => {
    // A wrapper program CPIs Sigil at depth 2; Sigil fails 6006 but the failure
    // is not the authoritative top-level outcome. Only the depth-1 runtime
    // `failed:` line is trusted — a depth-2 Sigil failure must NOT yield a row.
    const cpiLogs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program ${SIGIL} invoke [2]`,
      "Program log: AnchorError thrown in validate_and_authorize.rs. Error Number: 6006. Error Message: cap.",
      `Program ${SIGIL} consumed 1000 of 1400000 compute units`,
      `Program ${SIGIL} failed: custom program error: 0x1776`,
      // Wrapper "catches" the CPI error, keeps going, then fails for its own
      // reason — the tx err is non-Sigil.
      `Program ${OTHER_PROGRAM} failed: custom program error: 0x2`,
    ];
    const tx = failedTxWithValidateIx({ logMessages: cpiLogs });
    const items = await getVaultActivity(
      mockRpc(tx, { Custom: 2 }),
      VAULT,
      10,
      "mainnet-beta",
    );
    expect(items).to.have.lengthOf(0);
    expect(buildActivityRows(items)).to.have.lengthOf(0);
  });

  it("does NOT fabricate a block from forged 'Error Number' text in a non-Sigil frame", async () => {
    // An attacker program emits a lookalike AnchorError line OUTSIDE any Sigil
    // frame. Sigil itself succeeded; the tx fails downstream. No row.
    const forgedLogs = [
      `Program ${SIGIL} invoke [1]`,
      "Program log: Instruction: ValidateAndAuthorize",
      `Program ${SIGIL} success`,
      `Program ${OTHER_PROGRAM} invoke [1]`,
      "Program log: AnchorError thrown. Error Number: 6006. (forged by attacker program)",
      `Program ${OTHER_PROGRAM} failed: custom program error: 0x1776`,
    ];
    const tx = failedTxWithValidateIx({ logMessages: forgedLogs });
    const items = await getVaultActivity(
      mockRpc(tx, { Custom: 6006 }),
      VAULT,
      10,
      "mainnet-beta",
    );
    // 0x1776 is in-range, but it came from a non-Sigil `failed:` line → ignored.
    expect(items).to.have.lengthOf(0);
  });

  it("nulls a spoofed agent (decoded agent is not a tx signer)", async () => {
    // Malicious agent puts a VICTIM pubkey in the validate ix agent meta to try
    // to frame them. The decoded agent is not among the tx signers → nulled,
    // but the block is still surfaced (with the real reason).
    const VICTIM = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" as Address;
    const tx = failedTxWithValidateIx({
      logMessages: anchorBlockLogs,
      spoofVictim: VICTIM,
    });
    const items = await getVaultActivity(
      mockRpc(tx),
      VAULT,
      10,
      "mainnet-beta",
    );

    expect(items).to.have.lengthOf(1);
    const item = items[0]!;
    expect(item.success).to.equal(false);
    expect(item.description).to.equal("SpendingCapExceeded");
    // Anti-spoof: victim is NOT shown as the actor.
    expect(item.agent).to.equal(null);
    // protocol/amount are still surfaced (descriptive, no impersonation risk).
    expect(item.protocol).to.equal(PROTOCOL_KEY);
    expect(item.amount).to.equal(250_000_000n);
  });

  it("nulls the agent on a multi-signer tx (validate has exactly one signer)", async () => {
    // 2 required signers — a legitimate validate_and_authorize has exactly one
    // (the agent), so we refuse to attribute rather than risk naming the wrong
    // signer (e.g. a fee payer). Agent meta still points at accountKeys[0].
    const tx = failedTxWithValidateIx({
      logMessages: anchorBlockLogs,
      numSigners: 2,
    });
    const items = await getVaultActivity(
      mockRpc(tx),
      VAULT,
      10,
      "mainnet-beta",
    );

    expect(items).to.have.lengthOf(1);
    expect(items[0]!.success).to.equal(false);
    expect(items[0]!.description).to.equal("SpendingCapExceeded");
    expect(items[0]!.agent).to.equal(null);
  });
});
