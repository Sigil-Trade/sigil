/**
 * Phase 7.1 audit-log per-discriminator coverage (MED-3).
 *
 * Tracks the Bucket 2 Phase 10 pre-redeploy work documented at
 * `PHASE_7_REVIEW/README.md:62-72`. The canonical Phase 7 suite
 * (`tests/audit-log.ts`) covers the structural circular-buffer invariants
 * and 4 specific discriminators (5/13/6/16 + a sanity probe across all
 * disc emit sites with the 7/8/9-reserved guard); other test files cover
 * disc=2/4/7/8/9 (ownership-transfer) and disc=17/18 (pen-cross-1-
 * absorption). This file closes the gap on the remaining 10 discriminants
 * that have NO runtime per-disc test.
 *
 * Disc allocation mirror — see `programs/sigil/src/state/audit_log_success.rs`:
 *
 *   ┌────┬─────────────────────────────┬────────────────────────────────────┐
 *   │ #  │ Constant                    │ Covered by                         │
 *   ├────┼─────────────────────────────┼────────────────────────────────────┤
 *   │  3 │ AUDIT_DISC_DEPOSIT          │ THIS FILE                          │
 *   │  4 │ AUDIT_DISC_WITHDRAW         │ tests/ownership-transfer.ts (disc=4)│
 *   │  5 │ AUDIT_DISC_FREEZE           │ tests/audit-log.ts (disc=5)        │
 *   │  6 │ AUDIT_DISC_REACTIVATE       │ tests/audit-log.ts (via wrap test) │
 *   │  7 │ AUDIT_DISC_OWNERSHIP_INIT…  │ tests/ownership-transfer.ts        │
 *   │  8 │ AUDIT_DISC_OWNERSHIP_ACCEPT │ tests/ownership-transfer.ts + multisig│
 *   │  9 │ AUDIT_DISC_OWNERSHIP_CANCEL │ tests/ownership-transfer.ts        │
 *   │ 10 │ AUDIT_DISC_PAUSE_AGENT      │ THIS FILE                          │
 *   │ 11 │ AUDIT_DISC_UNPAUSE_AGENT    │ THIS FILE                          │
 *   │ 12 │ AUDIT_DISC_REVOKE_AGENT     │ THIS FILE                          │
 *   │ 13 │ AUDIT_DISC_REGISTER_AGENT   │ tests/audit-log.ts (disc=13)       │
 *   │ 14 │ AUDIT_DISC_POLICY_APPLY     │ THIS FILE                          │
 *   │ 15 │ AUDIT_DISC_CONSTRAINTS_APPLY│ THIS FILE                          │
 *   │ 16 │ AUDIT_DISC_FINALIZE_REJECT  │ tests/audit-log.ts (const-check)   │
 *   │ 17 │ AUDIT_DISC_AGENT_GRANT_QUEUE│ tests/pen-cross-1-absorption.ts    │
 *   │ 18 │ AUDIT_DISC_AGENT_GRANT_APPLY│ tests/pen-cross-1-absorption.ts    │
 *   │ 19 │ AUDIT_DISC_AGENT_GRANT_CANC…│ THIS FILE                          │
 *   │ 20 │ AUDIT_DISC_AGENT_PERMS_APP… │ THIS FILE                          │
 *   │ 21 │ AUDIT_DISC_CONSTRAINTS_CLO… │ THIS FILE                          │
 *   │ 22 │ AUDIT_DISC_AGENT_AUTO_REVO… │ THIS FILE                          │
 *   └────┴─────────────────────────────┴────────────────────────────────────┘
 *
 * Each test:
 *   1. Initializes a fresh vault (unique vault_id 9100-9199).
 *   2. Drives ONE owner-mutating ix that emits the target disc.
 *   3. Reads the audit_log_success buffer.
 *   4. Asserts: disc landed, subject pubkey matches the per-disc table
 *      in `state/audit_log_success.rs::AuditEntry::subject`, timestamp
 *      is non-zero.
 *
 * This is COVERAGE not behavioral — minimal setup, one assertion per
 * disc. Behavioral correctness of each handler lives in its own
 * dedicated test for that handler. The audit-log emit is a separate concern
 * that we surface here in isolation.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { createHash } from "crypto";
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
  siblingHandlerDigest,
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  createAtaHelper,
  mintToHelper,
  DEVNET_USDC_MINT,
  advanceTime,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

const ENTRY_SIZE = 64;
const SUCCESS_CAPACITY = 128;
const ENTRIES_OFFSET = 8 + 32;

// Discriminator allocation mirrors state/audit_log_success.rs.
const DISC_DEPOSIT = 3;
const DISC_PAUSE_AGENT = 10;
const DISC_UNPAUSE_AGENT = 11;
const DISC_REVOKE_AGENT = 12;
const DISC_POLICY_APPLY = 14;
const DISC_AGENT_GRANT_CANCEL = 19;
const DISC_AGENT_PERMS_APPLY = 20;
const DISC_AGENT_AUTO_REVOKED = 22;
// M1-04c: DISC_CONSTRAINTS_APPLY (15) + DISC_CONSTRAINTS_CLOSE_APPLY (21)
// removed — the apply_constraints / apply_close_constraints instructions
// they discriminated are gone.

// Capability levels mirror state/vault.rs constants.
const CAPABILITY_OBSERVER = 1;
const CAPABILITY_OPERATOR = 2;

// PendingAgentGrant default delay (Phase 8 §RP Fix-Up B): 48h.
const PENDING_AGENT_GRANT_DELAY = 172_800;

interface DecodedEntry {
  subject: Uint8Array;
  timestamp: bigint;
  discriminator: number;
}

/**
 * Decode the most-recent entry from the audit_log_success buffer at `pda`.
 * Throws if the buffer is empty.
 */
function lastSuccessEntry(svm: LiteSVM, pda: PublicKey): DecodedEntry {
  const acct = svm.getAccount(pda);
  if (!acct) throw new Error(`audit log missing at ${pda.toBase58()}`);
  const buf = Buffer.from(acct.data);
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  const head = buf[entriesEnd];
  const count = buf[entriesEnd + 1];
  if (count === 0) throw new Error("audit log empty");
  const lastIdx = (head + SUCCESS_CAPACITY - 1) % SUCCESS_CAPACITY;
  const offset = ENTRIES_OFFSET + lastIdx * ENTRY_SIZE;
  return {
    subject: new Uint8Array(buf.subarray(offset, offset + 32)),
    timestamp: buf.readBigInt64LE(offset + 48),
    discriminator: buf[offset + 63],
  };
}

/** Count of populated entries in audit_log_success (post-decode `count` field). */
function entryCount(svm: LiteSVM, pda: PublicKey): number {
  const acct = svm.getAccount(pda);
  if (!acct) throw new Error("missing");
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  return Buffer.from(acct.data)[entriesEnd + 1];
}

// M1-04c: removed dead PendingConstraintsUpdate size constants
// (PENDING_CONSTRAINTS_SIZE_M4, MAX_CPI_SIZE) — the constraints engine is
// gone, nothing in this file builds a constraints PDA anymore.

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

describe("audit-log-coverage (Phase 7.1)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 1000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  /**
   * Initialize a vault with optional overrides. Returns all 9 PDAs +
   * relevant init flags. Mirrors the Phase 7 baseline helper, plus
   * `createdAtSlot` binding for tests that may have advanced the clock
   * via earlier sibling tests in this `describe` block.
   */
  async function initVault(
    vaultId: BN,
    opts: { autoRevokeThreshold?: number } = {},
  ) {
    const autoRevokeThreshold = opts.autoRevokeThreshold ?? 5;
    const [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [tracker] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [auditSuccess] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), vault.toBuffer()],
      program.programId,
    );
    const [auditRejected] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_rejected"), vault.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1,
        [jupiterProgramId],
        0,
        100,
        STANDARD_INIT_TIMELOCK,
        [],
        [],
        false,
        0x00ffffff,
        false,
        autoRevokeThreshold,
        new BN(0),
        new BN(0),
        false,
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: STANDARD_INIT_TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold,
          createdAtSlot: Number(svm.getClock().slot),
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        auditLogRejected: auditRejected,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { vault, policy, tracker, overlay, auditSuccess, auditRejected };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // disc=3 — deposit_funds
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=3 (DEPOSIT) — deposit_funds emits audit entry with mint pubkey subject", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9100));

    // Owner ATA + mint enough USDC to deposit.
    const ownerAta = createAtaHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      ownerAta,
      owner.publicKey,
      1_000_000_000n,
    );

    // Vault ATA (owned by vault PDA).
    const vaultAta = createAtaHelper(
      svm,
      owner.payer,
      DEVNET_USDC_MINT,
      vault,
      true, // allowOwnerOffCurve — vault is a PDA
    );

    await program.methods
      .depositFunds(new BN(10_000_000))
      .accounts({
        owner: owner.publicKey,
        vault,
        mint: DEVNET_USDC_MINT,
        ownerTokenAccount: ownerAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=3 DEPOSIT").to.equal(DISC_DEPOSIT);
    // Subject = SPL Token mint pubkey (per state/audit_log_success.rs L141).
    expect(
      Buffer.from(entry.subject).equals(DEVNET_USDC_MINT.toBuffer()),
      "subject = mint pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n, "timestamp non-zero").to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=10 — pause_agent
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=10 (PAUSE_AGENT) — pause_agent emits audit entry with agent pubkey subject", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9110),
    );
    const agent = Keypair.generate();

    // Register agent first (writes disc=13).
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // Pause (writes disc=10).
    await program.methods
      .pauseAgent(agent.publicKey)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=10 PAUSE_AGENT").to.equal(
      DISC_PAUSE_AGENT,
    );
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=11 — unpause_agent
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=11 (UNPAUSE_AGENT) — unpause_agent emits audit entry with agent pubkey subject", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9111),
    );
    const agent = Keypair.generate();

    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    await program.methods
      .pauseAgent(agent.publicKey)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();

    await program.methods
      .unpauseAgent(agent.publicKey)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=11 UNPAUSE_AGENT").to.equal(
      DISC_UNPAUSE_AGENT,
    );
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=12 — revoke_agent
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=12 (REVOKE_AGENT) — revoke_agent emits audit entry with agent pubkey subject", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9112),
    );
    const agent = Keypair.generate();

    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    await program.methods
      .revokeAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=12 REVOKE_AGENT").to.equal(
      DISC_REVOKE_AGENT,
    );
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=14 — apply_pending_policy
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=14 (POLICY_APPLY) — apply_pending_policy emits audit entry with vault pubkey subject", async () => {
    const { vault, policy, tracker, auditSuccess } = await initVault(
      new BN(9114),
    );
    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    );

    // Queue a policy update changing daily_spending_cap.
    //
    // Manual ix encoding because the committed IDL is one revision
    // behind the Rust source for `queue_policy_update`:
    //   - committed IDL: 18 args  (16 Option + cosign_session + digest)
    //   - working source: 19 args (additional Option<Pubkey>
    //     `cosign_session_pubkey` added as part of D-5 / F-RP3-1,
    //     audit 2026-05-19)
    //
    // When the .so is rebuilt from working source, on-chain expects
    // the 19-arg Borsh layout but Anchor's TS client encodes 18 args
    // from the stale IDL → `InstructionDidNotDeserialize` (102).
    // `tests/missing-coverage.ts` and `tests/sigil.ts` exhibit the
    // same failure mode and are tracked for the Phase 10 IDL refresh.
    //
    // The manual encoding below matches the Rust handler exactly:
    //   pos 1   : Option<u64> = Some(250_000_000) (the change we
    //             want to queue)
    //   pos 2-16: Option<...> = None (15 tag bytes, value=0)
    //   pos 17  : Option<Pubkey> cosign_session_pubkey = None
    //   pos 18  : Pubkey cosign_session = Pubkey::default() (32×0)
    //   pos 19  : [u8;32] digest = computed below
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      {
        dailySpendingCapUsd: new BN(250_000_000),
      },
    );
    const queueData = Buffer.concat([
      anchorDisc("queue_policy_update"),
      // arg 1: daily_spending_cap_usd: Option<u64> = Some(250_000_000)
      Buffer.from([1]),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(250_000_000n);
        return b;
      })(),
      // args 2..16: all None (Option<...> = 0 tag byte each)
      Buffer.alloc(15, 0),
      // arg 17: cosign_session_pubkey: Option<Pubkey> = None (tag=0)
      Buffer.from([0]),
      // arg 18 (F-Q6 2026-06-02): operator_grant_delay_seconds: Option<u64> = None (tag=0)
      Buffer.from([0]),
      // arg 19 (Item 3 2026-06-22): protocol_hashes: Option<[[u8;32];10]> = None (tag=0)
      Buffer.from([0]),
      // arg 20: cosign_session: Pubkey = Pubkey::default() (all zeros)
      Buffer.alloc(32, 0),
      // arg 21: new_policy_preview_digest: [u8; 32]
      Buffer.from(queueDigest),
    ]);
    const queueIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: policy, isSigner: false, isWritable: true },
        { pubkey: pendingPolicy, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: queueData,
    });
    sendVersionedTx(svm, [queueIx], owner.payer);

    // Advance past timelock.
    advanceTime(svm, Number(STANDARD_INIT_TIMELOCK.toString()) + 1);

    // Apply (writes disc=14).
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        pendingPolicy,
      } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=14 POLICY_APPLY").to.equal(
      DISC_POLICY_APPLY,
    );
    // Subject = vault pubkey (per state/audit_log_success.rs L147).
    expect(
      Buffer.from(entry.subject).equals(vault.toBuffer()),
      "subject = vault pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=15 — apply_constraints_update
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // disc=19 — cancel_agent_grant
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=19 (AGENT_GRANT_CANCEL) — cancel_agent_grant emits audit entry with cancelled agent subject", async () => {
    const { vault, policy, auditSuccess } = await initVault(new BN(9119));
    const [pendingAgentGrant] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_grant"), vault.toBuffer()],
      program.programId,
    );
    const agent = Keypair.generate();

    // Queue (writes disc=17).
    await program.methods
      .queueAgentGrant(agent.publicKey, CAPABILITY_OPERATOR, new BN(50_000_000))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Cancel (writes disc=19).
    await program.methods
      .cancelAgentGrant()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .rpc();

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=19 AGENT_GRANT_CANCEL").to.equal(
      DISC_AGENT_GRANT_CANCEL,
    );
    // Subject = cancelled agent pubkey (per state/audit_log_success.rs L153).
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = cancelled agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=20 — apply_agent_permissions_update
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=20 (AGENT_PERMS_APPLY) — apply_agent_permissions_update emits audit entry with agent pubkey subject", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9120),
    );
    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 1 * LAMPORTS_PER_SOL);

    // Register agent first.
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // Derive pending PDA (seeds = ["pending_agent_perms", vault, agent]).
    const [pendingAgentPerms] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_agent_perms"),
        vault.toBuffer(),
        agent.publicKey.toBuffer(),
      ],
      program.programId,
    );

    // Queue (FULL_CAPABILITY = OPERATOR; 0 cooldown).
    await program.methods
      .queueAgentPermissionsUpdate(
        agent.publicKey,
        CAPABILITY_OPERATOR,
        new BN(75_000_000), // new spending_limit_usd
        new BN(0), // cooldown_seconds
        PublicKey.default, // cosign_session
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, Number(STANDARD_INIT_TIMELOCK.toString()) + 1);

    const countBefore = entryCount(svm, auditSuccess);

    // Apply (writes disc=20). The committed IDL at HEAD does NOT yet
    // declare the `audit_log_success` + `slot_hashes_sysvar` accounts
    // added by M-6 (audit 2026-05-21) — Anchor TS strips unknown
    // `.accounts()` fields, so we MUST append them as remaining
    // accounts in the exact order the on-chain handler reads them
    // (`audit_log_success` then `slot_hashes_sysvar`, mirroring the
    // Rust struct field order). Pre-redeploy IDL refresh will fold
    // these into the typed accounts API; until then, this is the
    // canonical workaround.
    await program.methods
      .applyAgentPermissionsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        agentSpendOverlay: overlay,
      } as any)
      .remainingAccounts([
        { pubkey: auditSuccess, isSigner: false, isWritable: true },
        {
          pubkey: SYSVAR_SLOT_HASHES_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
      ])
      .rpc();

    expect(
      entryCount(svm, auditSuccess),
      "apply wrote exactly 1 audit entry",
    ).to.equal(countBefore + 1);

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=20 AGENT_PERMS_APPLY").to.equal(
      DISC_AGENT_PERMS_APPLY,
    );
    // Subject = agent pubkey (per state/audit_log_success.rs L154).
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // disc=21 — apply_close_constraints
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // disc=22 — record_agent_violation (auto-revoke trip)
  // ─────────────────────────────────────────────────────────────────────────
  it("disc=22 (AGENT_AUTO_REVOKED) — record_agent_violation trip emits audit entry with agent pubkey subject", async () => {
    // Use auto_revoke_threshold=3 so we need exactly 3 violations to trip.
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(9122),
      { autoRevokeThreshold: 3 },
    );
    const agent = Keypair.generate();

    // F-Q6 (2026-06-02): register OBSERVER, not OPERATOR. This agent only
    // needs to be a non-disabled registered agent so record_agent_violation
    // can find it (by pubkey) and trip its consecutive_failures counter to
    // CAPABILITY_DISABLED — it never opens a spending session, so OPERATOR
    // capability is unnecessary. Instant OPERATOR register on a single-key
    // vault now reverts ErrOperatorGrantRequiresTimelock (6107); OBSERVER
    // stays instant and still writes exactly 1 audit entry (disc=13), so the
    // disc=22 trip path and audit counts below are unchanged.
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // First 2 violations: counter increments but NO audit entry written
    // (non-trip branch — see record_agent_violation.rs:200-210).
    const countBefore = entryCount(svm, auditSuccess);
    for (let i = 0; i < 2; i++) {
      await program.methods
        .recordAgentViolation(agent.publicKey, 6086)
        .accounts({ owner: owner.publicKey, vault, policy } as any)
        .rpc();
    }
    expect(
      entryCount(svm, auditSuccess),
      "non-trip increments write NO audit entry",
    ).to.equal(countBefore);

    // Third violation trips the threshold → disc=22 entry written.
    // The committed IDL at HEAD declares only 3 accounts for
    // `record_agent_violation` (owner, vault, policy); the Rust struct
    // has 5 (audit_log_success, slot_hashes_sysvar added in M-8
    // audit 2026-05-21). Anchor TS resolution drops both unknown
    // accounts AND `.remainingAccounts()` does not extend the named
    // slots — for an IDL-stale account that the Rust handler accesses
    // via name (not just remaining_accounts), we must build the IX
    // manually and append the missing accounts at the correct
    // positions (4 and 5, after owner/vault/policy).
    const ixData = (program.coder.instruction as any).encode(
      "recordAgentViolation",
      { agent: agent.publicKey, errorCode: 6086 },
    );
    const tripIx = new TransactionInstruction({
      programId: program.programId,
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: policy, isSigner: false, isWritable: true },
        { pubkey: auditSuccess, isSigner: false, isWritable: true },
        {
          pubkey: SYSVAR_SLOT_HASHES_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: ixData,
    });
    sendVersionedTx(svm, [tripIx], owner.payer);

    const entry = lastSuccessEntry(svm, auditSuccess);
    expect(entry.discriminator, "disc=22 AGENT_AUTO_REVOKED").to.equal(
      DISC_AGENT_AUTO_REVOKED,
    );
    // Subject = agent pubkey (per state/audit_log_success.rs L156).
    expect(
      Buffer.from(entry.subject).equals(agent.publicKey.toBuffer()),
      "subject = revoked agent pubkey",
    ).to.be.true;
    expect(entry.timestamp > 0n).to.be.true;
  });
});
