/**
 * CU Worst-Case Benchmark CI Gate (PR 2)
 *
 * Measures compute-unit consumption for the 6 worst-case validate→DeFi→finalize
 * scenarios from the V1 Week 1 plan and asserts each stays under a per-scenario
 * threshold. Failures are NOT silently lowered — they trigger the Tue 11:00 ET
 * design-review decision tree (PR 2 risk: redesign the constraint scan loop if
 * scenarios 4/5 blow past their budgets).
 *
 * Per-scenario thresholds (NOT a single 1M gate):
 *   1. validate-only ............................... ≤  60,000 CU
 *   2. validate + Jupiter-1-step ................... ≤ 150,000 CU
 *   3. validate + Jupiter-10-step .................. ≤ 400,000 CU
 *   4. validate + 64-entry OR-fall-through ......... ≤ 600,000 CU
 *   5. validate + Jupiter-10-step + 64 entries ..... ≤ 900,000 CU
 *   6. validate + finalize + ComputeBudget×32 pad .. ≤ 1,000,000 CU (baseline)
 *
 * Scenario 6 documents the unbounded post-finalize scan baseline. PR 2b will
 * add a hard 64-ix scan bound; this scenario verifies the protection works
 * once that PR lands.
 *
 * Implementation notes:
 *  - Jupiter program is not loadable as executable code in LiteSVM (it's a
 *    closed-source mainnet program). We load the existing mock-defi.so at
 *    JUPITER_PROGRAM_ID; mock-defi's Anchor entrypoint will fail the program-id
 *    check, but only AFTER validate_and_authorize has fully consumed CU. We
 *    measure CU from FailedTransactionMetadata.meta() in that case.
 *  - Scenarios 4/5 require 64 constraint entries — far beyond what fits in a
 *    single TX via the create_instruction_constraints ix path (Anchor encodes
 *    instruction data into a 1000-byte buffer, and TX limit is 1232 bytes).
 *    We bypass the create flow and write the InstructionConstraints PDA bytes
 *    directly via svm.setAccount(). This is exactly the worst-case the
 *    on-chain code is designed to handle (it explicitly allows 64 entries),
 *    and is what an attacker on real network can construct via incremental
 *    PDA writes once those primitives ship.
 *
 * LiteSVM in-process — no validator, ~1s per scenario.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { createHash } from "crypto";
import * as path from "path";
import { FailedTransactionMetadata } from "litesvm";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  recordCU,
  printCUSummary,
  resetCUMeasurements,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Real Jupiter V6 program ID — must match programs/sigil/src/state/mod.rs:JUPITER_PROGRAM. */
const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

/** Jupiter V6 `route` discriminator (jupiter.rs:13). */
const ROUTE_DISC = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);

/** MAX_ROUTE_STEPS from jupiter.rs:29 — sanity bound for variable-length route plan. */
const MAX_ROUTE_STEPS = 10;

/** MAX_CONSTRAINT_ENTRIES from constraints.rs — on-chain ceiling. */
const MAX_CONSTRAINT_ENTRIES = 64;

/** ConstraintEntryZC size from constraints.rs:155. */
const CONSTRAINT_ENTRY_ZC_SIZE = 560;

/** InstructionConstraints::SIZE from constraints.rs:172. */
const INSTRUCTION_CONSTRAINTS_SIZE =
  8 +
  32 +
  CONSTRAINT_ENTRY_ZC_SIZE * MAX_CONSTRAINT_ENTRIES +
  1 +
  1 +
  1 +
  1 +
  4;

/** Protocol treasury (must match hardcoded constant in program). */
const PROTOCOL_TREASURY = new PublicKey(
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
);

/** Per-scenario CU thresholds (worst-case bounds — failures trigger plan review).
 *
 * Phase 4 (Bundle integrity) measured 2026-05-18: validate body grew by
 * ~15-17K CU from the new TA-10 sandwich-integrity scan, TA-11 7-PDA
 * derivation set, and AC-10 session-nonce check. The new floor for
 * `validateOnly` was ~76K CU; threshold raised from 60K → 90K with ~14K
 * headroom for future regressions.
 *
 * SA4 H1 audit fix (2026-05-19): TA-11 protected-set extended to derive
 * `audit_success` + `audit_rejected` PDAs (Phase 7 LIVE audit-log
 * accounts — previously dropped into a `Pubkey::default()` sentinel
 * slot that could never match). The two extra `find_program_address`
 * calls add ~12K CU to validate. Floor moved from ~76K → ~88K; threshold
 * raised from 90K → 100K with ~12K headroom for future regressions.
 * Other thresholds left unchanged — they had abundant headroom already.
 * Production CU budget is 1.4M so the absolute cost remains negligible.
 */
const THRESHOLDS = {
  validateOnly: 100_000,
  jupiter1Step: 170_000,
  jupiter10Step: 420_000,
  or64Fallthrough: 620_000,
  combined: 920_000,
  computeBudgetPad32: 1_020_000,
} as const;

/** Anchor account discriminator: sha256("account:<name>")[0..8]. */
function anchorAccountDisc(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a valid Jupiter V1 `route` instruction data buffer.
 *
 * Layout: disc(8) + vec_len(4) + steps × {swap_disc(1) + percent(1) + input_idx(1) + output_idx(1)}
 *         + suffix(19)
 *
 * `route` (vs shared_accounts_route) has no `id` byte — cursor starts at 8.
 * Each step uses Saber (variant 0) which has 0 swap_fields → minimum bloat.
 */
function buildJupiterRouteData(stepCount: number): Buffer {
  if (stepCount < 1 || stepCount > MAX_ROUTE_STEPS) {
    throw new Error(`stepCount must be 1..=${MAX_ROUTE_STEPS}`);
  }
  const data = Buffer.alloc(8 + 4 + stepCount * 4 + 19);
  let cursor = 0;
  ROUTE_DISC.copy(data, cursor);
  cursor += 8;
  data.writeUInt32LE(stepCount, cursor); // vec_len
  cursor += 4;
  for (let i = 0; i < stepCount; i++) {
    data.writeUInt8(0, cursor); // swap_disc = Saber (variant 0, 0 fields)
    data.writeUInt8(100, cursor + 1); // percent = 100
    data.writeUInt8(0, cursor + 2); // input_index
    data.writeUInt8(1, cursor + 3); // output_index
    cursor += 4;
  }
  // V1 suffix: in_amount(8) + quoted_out_amount(8) + slippage_bps(2) + platform_fee_bps(1)
  data.writeBigUInt64LE(1_000_000n, cursor); // in_amount
  data.writeBigUInt64LE(1_000_000n, cursor + 8); // quoted_out (must be > 0)
  data.writeUInt16LE(50, cursor + 16); // slippage_bps = 50 (≤ policy max 100)
  data.writeUInt8(0, cursor + 18); // platform_fee_bps = 0
  return data;
}

interface SyntheticEntry {
  programId: PublicKey;
  /** First DataConstraint must be Eq at offset 0 (A5 anchor). 8-byte value for Anchor8. */
  discriminatorValue: Buffer;
}

/**
 * Build the raw bytes for an InstructionConstraints zero-copy account.
 *
 * Bypasses the create_instruction_constraints ix path (which can't fit 64
 * entries in one TX). Writes the same layout the on-chain code reads via
 * `bytemuck::from_bytes::<InstructionConstraints>`.
 *
 * Layout (35,888 bytes) — V2 (REVAMP_PLAN §2.2): strict_mode byte removed,
 * padding grew from 4 to 5 to preserve the 35,888-byte invariant.
 *   [0..8)         Anchor disc
 *   [8..40)        vault: [u8; 32]
 *   [40..40+64×560)  entries: [ConstraintEntryZC; 64]
 *   [+0)           entry_count: u8
 *   [+1)           bump: u8
 *   [+2)           constraint_version: u8
 *   [+3..+8)       _padding: [u8; 5]
 */
function buildConstraintsAccountData(
  vault: PublicKey,
  bump: number,
  entries: SyntheticEntry[],
): Buffer {
  if (entries.length > MAX_CONSTRAINT_ENTRIES) {
    throw new Error(`max ${MAX_CONSTRAINT_ENTRIES} entries`);
  }
  const buf = Buffer.alloc(INSTRUCTION_CONSTRAINTS_SIZE);
  // Anchor account discriminator
  anchorAccountDisc("InstructionConstraints").copy(buf, 0);
  // vault
  vault.toBuffer().copy(buf, 8);
  // entries (only the first N are populated; rest stay zero)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryOffset = 40 + i * CONSTRAINT_ENTRY_ZC_SIZE;
    // ConstraintEntryZC layout (560 bytes):
    //   [0..32)   program_id
    //   [32..352) data_constraints[8]  — 8 × DataConstraintZC(40)
    //   [352..552) account_constraints[5] — 5 × AccountConstraintZC(40)
    //   [552)     data_count
    //   [553)     account_count
    //   [554)     _reserved_was_is_spending (M2 Option A — byte preserved
    //             for layout stability; runtime never reads it)
    //   [555)     discriminator_format
    //   [556..560) _padding[4]
    entry.programId.toBuffer().copy(buf, entryOffset + 0);
    // First DataConstraintZC: offset=0 Eq value=discriminatorValue
    //   DataConstraintZC layout (40 bytes):
    //     [0..2)  offset: u16
    //     [2)     operator: u8
    //     [3)     value_len: u8
    //     [4..36) value: [u8; 32]
    //     [36..40) _padding
    const dcOffset = entryOffset + 32;
    buf.writeUInt16LE(0, dcOffset + 0); // offset = 0
    buf.writeUInt8(0, dcOffset + 2); // operator = Eq
    buf.writeUInt8(entry.discriminatorValue.length, dcOffset + 3); // value_len
    entry.discriminatorValue.copy(buf, dcOffset + 4);
    // data_count = 1
    buf.writeUInt8(1, entryOffset + 552);
    // account_count = 0 (already zero)
    // byte 554 = _reserved_was_is_spending (M2 Option A — write preserved
    // for layout stability; runtime never reads it)
    buf.writeUInt8(1, entryOffset + 554);
    // discriminator_format = 0 (Anchor8) — already zero
  }
  // V2 layout: entry_count, bump, constraint_version, padding follow the
  // entries array (strict_mode byte removed — REVAMP_PLAN §2.2).
  const tailOffset = 40 + MAX_CONSTRAINT_ENTRIES * CONSTRAINT_ENTRY_ZC_SIZE;
  buf.writeUInt8(entries.length, tailOffset + 0); // entry_count
  buf.writeUInt8(bump, tailOffset + 1); // bump
  buf.writeUInt8(1, tailOffset + 2); // constraint_version = 1
  // padding zero (5 bytes at tailOffset+3..+8)
  return buf;
}

/**
 * Send a versioned TX and return CU consumed regardless of success/failure.
 *
 * For scenarios 2/3/4/5, the TX is expected to fail at the JUPITER_PROGRAM
 * dispatch step (Anchor program-id mismatch in mock-defi.so) AFTER
 * validate_and_authorize has fully run. We extract CU from
 * FailedTransactionMetadata.meta() in that case.
 */
function sendAndMeasureCU(
  svm: LiteSVM,
  instructions: TransactionInstruction[],
  payer: Keypair,
): {
  computeUnitsConsumed: number;
  succeeded: boolean;
  errStr: string | null;
  logs: string[];
} {
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: svm.latestBlockhash(),
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);
  const res = svm.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    const meta = res.meta();
    return {
      computeUnitsConsumed: Number(meta.computeUnitsConsumed()),
      succeeded: false,
      errStr: res.err().toString(),
      logs: meta.logs(),
    };
  }
  return {
    computeUnitsConsumed: Number(res.computeUnitsConsumed()),
    succeeded: true,
    errStr: null,
    logs: res.logs(),
  };
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("cu-budget", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  let usdcMint: PublicKey;
  let ownerUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  /** Per-vault state — each scenario uses its own vault to keep state independent. */
  interface VaultCtx {
    vault: PublicKey;
    policy: PublicKey;
    tracker: PublicKey;
    overlay: PublicKey;
    constraints: PublicKey;
    constraintsBump: number;
    vaultAta: PublicKey;
  }

  async function setupVault(
    vaultId: BN,
    targetProtocols: PublicKey[],
  ): Promise<VaultCtx> {
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
    const [constraints, constraintsBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("constraints"), vault.toBuffer()],
      program.programId,
    );

    // F-15 audit fix: protocolMode is unconditionally PROTOCOL_MODE_ALLOWLIST under
    // Phase 2 Option A (mode 0/2 paths deleted). The prior ternary kept dead
    // branches alive.
    // F-11 audit fix: an active (non-observe_only) vault needs at least ONE
    // protocol on the allowlist. Inject JUPITER_PROGRAM_ID as a safe baseline
    // when the caller passes an empty list — every cu-budget scenario builds a
    // bundle targeting JUPITER_PROGRAM_ID anyway, so this matches actual usage.
    const initProtocols =
      targetProtocols.length === 0 ? [JUPITER_PROGRAM_ID] : targetProtocols;
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(200_000_000),
        1,
        initProtocols,
        0,
        100,
        new BN(1800),
        [],
        [],
        false, // observeOnly (Phase 2 TA-19)
        0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
        false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
        5, // auto_revoke_threshold (TA-17 Phase 3 — default)
        new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
        new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
        false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(200_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: initProtocols,
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accountsPartial({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // F-Q6: a single-key vault (cosignRequired:false) can no longer instantly
    // register an OPERATOR-class agent — that now reverts
    // ErrOperatorGrantRequiresTimelock (6107). The agent here drives the
    // validate→DeFi→finalize spending sessions every CU scenario benchmarks, so
    // it MUST be OPERATOR; we seat it via the timelocked queue→advance→apply
    // helper. register_agent's own CU is NOT what any scenario measures (they
    // benchmark validate/finalize), so switching the seat path is benign here.
    // The helper advances unix_timestamp by 601s but leaves the slot untouched,
    // so the later (slot-based) session validate/finalize CU is unaffected.
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault,
      agent: agent.publicKey,
    });

    const vaultAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      vault,
      true,
    );
    await program.methods
      .depositFunds(new BN(500_000_000))
      .accountsPartial({
        owner: owner.publicKey,
        vault,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return {
      vault,
      policy,
      tracker,
      overlay,
      constraints,
      constraintsBump,
      vaultAta,
    };
  }

  async function buildValidateIx(
    ctx: VaultCtx,
    amount: BN,
    targetProtocol: PublicKey,
    remainingAccounts?: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[],
  ): Promise<TransactionInstruction> {
    const [session] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        ctx.vault.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );
    let builder = program.methods
      .validateAndAuthorize(
        usdcMint,
        amount,
        targetProtocol,
        ((await program.account.policyConfig.fetch(ctx.policy))
          .policyVersion as BN) ?? new BN(0),
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: ctx.vault,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount,
            targetProtocol,
          }),
        ),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: ctx.vault,
        policy: ctx.policy,
        tracker: ctx.tracker,
        session,
        agentSpendOverlay: ctx.overlay,
        vaultTokenAccount: ctx.vaultAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      });
    if (remainingAccounts)
      builder = builder.remainingAccounts(remainingAccounts);
    return builder.instruction();
  }

  async function buildFinalizeIx(
    ctx: VaultCtx,
  ): Promise<TransactionInstruction> {
    const [session] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        ctx.vault.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );
    return program.methods
      .finalizeSession()
      .accountsPartial({
        payer: agent.publicKey,
        vault: ctx.vault,
        session,
        sessionRentRecipient: agent.publicKey,
        policy: ctx.policy,
        tracker: ctx.tracker,
        agentSpendOverlay: ctx.overlay,
        vaultTokenAccount: ctx.vaultAta,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Materialize a 64-entry constraints PDA via raw setAccount.
   * 63 entries have a fake disc that does NOT match the target ix data;
   * the 64th entry has the matching ROUTE_DISC. This forces the OR-evaluation
   * loop to walk all 64 entries before finding a match — the worst case for
   * the verify_against_entries_zc scan.
   */

  before(async () => {
    resetCUMeasurements();
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Load mock-defi.so AT THE JUPITER_PROGRAM_ID address. mock-defi will fail
    // its Anchor program-id check at entrypoint, but ONLY AFTER
    // validate_and_authorize has fully executed — its slippage parser is what
    // we measure. The runtime returns InvalidProgramForExecution(12) and the
    // TX fails, but FailedTransactionMetadata.meta().computeUnitsConsumed()
    // still reports the partial CU. That is what sendAndMeasureCU extracts.
    svm.addProgramFromFile(
      JUPITER_PROGRAM_ID,
      path.resolve(__dirname, "fixtures/mock-defi.so"),
    );

    airdropSol(svm, owner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 20 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      500_000_000_000n,
    );

    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      PROTOCOL_TREASURY,
      true,
    );
  });

  after(() => printCUSummary());

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 1: validate-only (no DeFi ix; just validate→finalize)
  // ───────────────────────────────────────────────────────────────────────────
  it(`Scenario 1: validate-only ≤ ${THRESHOLDS.validateOnly.toLocaleString()} CU`, async () => {
    // F-15/F-11: setupVault now uses PROTOCOL_MODE_ALLOWLIST + JUPITER baseline
    // when caller passes []. Scenario is a non-spending validate so allowlist
    // semantics don't load-bear; only CU floor matters.
    const ctx = await setupVault(new BN(60001), []);
    const validateIx = await buildValidateIx(
      ctx,
      new BN(0), // non-spending — no DeFi ix required
      JUPITER_PROGRAM_ID,
    );
    const finalizeIx = await buildFinalizeIx(ctx);
    const result = sendAndMeasureCU(svm, [validateIx, finalizeIx], agent);
    recordCU("1:validate-only", result);
    console.log(
      `  measured: ${result.computeUnitsConsumed.toLocaleString()} CU` +
        `  (succeeded=${result.succeeded})`,
    );
    expect(result.succeeded, `unexpected failure: ${result.errStr}`).to.equal(
      true,
    );
    expect(result.computeUnitsConsumed).to.be.lessThan(THRESHOLDS.validateOnly);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 2: validate + Jupiter-1-step swap
  // ───────────────────────────────────────────────────────────────────────────
  it(`Scenario 2: validate + Jupiter-1-step ≤ ${THRESHOLDS.jupiter1Step.toLocaleString()} CU`, async () => {
    const ctx = await setupVault(new BN(60002), [JUPITER_PROGRAM_ID]);
    const validateIx = await buildValidateIx(
      ctx,
      new BN(50_000_000), // spending
      JUPITER_PROGRAM_ID,
      // F-Q1a completeness: the jupiter ix surfaces the fee-payer agent as a
      // writable meta on-chain (compiled message), so it must be resolvable in
      // validate's remaining_accounts (else DestinationAccountUnresolvable).
      [{ pubkey: agent.publicKey, isSigner: false, isWritable: false }],
    );
    // Mock Jupiter ix: programId=JUPITER_PROGRAM, valid V1 1-step route data.
    // mock-defi.so is loaded at JUPITER_PROGRAM_ID — it will fail the Anchor
    // program-id check (TX fails at dispatch). validate's slippage parser
    // already ran before that, and CU is measured from FailedTransactionMetadata.
    const jupiterIx = new TransactionInstruction({
      programId: JUPITER_PROGRAM_ID,
      keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: false }],
      data: buildJupiterRouteData(1),
    });
    const finalizeIx = await buildFinalizeIx(ctx);
    const result = sendAndMeasureCU(
      svm,
      [validateIx, jupiterIx, finalizeIx],
      agent,
    );
    recordCU("2:jupiter-1-step", result);
    console.log(
      `  measured: ${result.computeUnitsConsumed.toLocaleString()} CU` +
        `  (succeeded=${result.succeeded})` +
        (result.errStr ? `  err=${result.errStr}` : ""),
    );
    expect(result.computeUnitsConsumed).to.be.greaterThan(0);
    expect(result.computeUnitsConsumed).to.be.lessThan(THRESHOLDS.jupiter1Step);
    // Sanity: Sigil's validate ran successfully BEFORE mock-defi failed at
    // the program-id check. The error must come from the JUPITER ix at
    // index 1, NOT from validate at index 0. If validate failed (e.g., due
    // to a structural problem with the bundle), we'd see index:0.
    expect(
      result.errStr,
      "expected failure at jupiter ix, not validate",
    ).to.match(/index:\s*1/);
    // Verify validate ran successfully. Post-Phase-1 (Option A demolition,
    // 2026-05-17) the on-chain Jupiter slippage parser
    // (`verify_jupiter_slippage`) was deleted; validate now treats the
    // Jupiter program ID as a generic, non-parsed DeFi program in the
    // forward scan. A failed validate would truncate at index 0.
    const validateRanOk = result.logs.some((l) =>
      l.includes("Instruction: ValidateAndAuthorize"),
    );
    expect(
      validateRanOk,
      `validate did not appear in logs: ${result.logs.join("\n")}`,
    ).to.equal(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 3: validate + Jupiter-10-step (max route plan)
  // ───────────────────────────────────────────────────────────────────────────
  it(`Scenario 3: validate + Jupiter-10-step ≤ ${THRESHOLDS.jupiter10Step.toLocaleString()} CU`, async () => {
    const ctx = await setupVault(new BN(60003), [JUPITER_PROGRAM_ID]);
    const validateIx = await buildValidateIx(
      ctx,
      new BN(50_000_000),
      JUPITER_PROGRAM_ID,
      // F-Q1a completeness: fee-payer agent is a writable meta on-chain.
      [{ pubkey: agent.publicKey, isSigner: false, isWritable: false }],
    );
    const jupiterIx = new TransactionInstruction({
      programId: JUPITER_PROGRAM_ID,
      keys: [{ pubkey: agent.publicKey, isSigner: true, isWritable: false }],
      data: buildJupiterRouteData(MAX_ROUTE_STEPS),
    });
    const finalizeIx = await buildFinalizeIx(ctx);
    const result = sendAndMeasureCU(
      svm,
      [validateIx, jupiterIx, finalizeIx],
      agent,
    );
    recordCU("3:jupiter-10-step", result);
    console.log(
      `  measured: ${result.computeUnitsConsumed.toLocaleString()} CU` +
        `  (succeeded=${result.succeeded})` +
        (result.errStr ? `  err=${result.errStr}` : ""),
    );
    expect(result.computeUnitsConsumed).to.be.greaterThan(0);
    expect(result.computeUnitsConsumed).to.be.lessThan(
      THRESHOLDS.jupiter10Step,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 4: validate + 64-entry OR-fall-through (V2: strict-by-default)
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 5: validate + Jupiter-10-step + 64 entries combined
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 6: validate + finalize + ComputeBudget×32 pad attack baseline
  //
  // Documents the unbounded post-finalize scan baseline. The current scan loop
  // BREAKS at finalize, so post-finalize ComputeBudget noops aren't scanned by
  // Sigil — but they ARE executed by the runtime, contributing to total tx CU.
  // PR 2b will add a hard 64-ix scan bound; this scenario verifies that
  // protection works once that PR lands.
  //
  // Each ComputeBudget ix uses a unique kind to avoid TransactionErrorDuplicateInstruction:
  //   - 1× SetComputeUnitLimit
  //   - 1× SetComputeUnitPrice
  //   - 1× SetLoadedAccountsDataSizeLimit
  //   - 29× SetComputeUnitLimit with varying values (still triggers dedup)
  //
  // The runtime rejects duplicate Compute-Budget instructions at TX validation
  // BEFORE any program runs. To work around this we use a mix of ComputeBudget
  // variants and System Program transfer noops to fill the 32 slots.
  // ───────────────────────────────────────────────────────────────────────────
  it(`Scenario 6: ComputeBudget×16 pad ≤ ${THRESHOLDS.computeBudgetPad32.toLocaleString()} CU`, async () => {
    // F-15/F-11: setupVault now uses PROTOCOL_MODE_ALLOWLIST + JUPITER baseline.
    // Non-spending validate-only scenario; allowlist not load-bearing.
    const ctx = await setupVault(new BN(60006), []);
    const validateIx = await buildValidateIx(
      ctx,
      new BN(0),
      JUPITER_PROGRAM_ID,
    );
    const finalizeIx = await buildFinalizeIx(ctx);

    // Build 16 unique padding instructions (2 ComputeBudget kinds + 14
    // SystemProgram transfers). The pad COUNT is bounded by the 1232-byte TX
    // WIRE limit, NOT by CU: validate+finalize already consume ~92k CU
    // (Scenario 3), far under the 1.02M budget, so the pads are "noise" for the
    // CU assertion — their real job is to prove the post-finalize scan does NOT
    // iterate them (CU stays bounded regardless of N). The count has shrunk as
    // validate/finalize grew their account tables + instruction data:
    //   32 (pre-Phase-7) → 28 (Phase-7 added 3 finalize accounts) → 16 here
    // because F-Q1a/F-Q4 (writable-destination + Token-2022-mint
    // remaining-accounts) and F-Q1a's intent-digest 6th validate arg pushed the
    // account table + ix data past 1232 bytes at 28. 16 leaves clear headroom.
    // M11/SIMD-0296 caps the sysvar-scan ITERATION count (not the pad count),
    // so 16 vs 32 is equally adversarial for that guard.
    //
    // ComputeBudget rejects duplicate SetComputeUnitLimit at TX-level
    // validation, so we mix 2 ComputeBudget kinds + N SystemProgram transfers
    // with VARYING LAMPORT AMOUNTS (lamports are ix data — different amounts
    // make each ix bytewise unique even when sharing accounts). A SINGLE shared
    // destination keeps the account table to one extra entry. (agent pre-funded.)
    const padDest = Keypair.generate().publicKey;
    const padIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ];
    for (let i = 0; i < 14; i++) {
      padIxs.push(
        SystemProgram.transfer({
          fromPubkey: agent.publicKey,
          toPubkey: padDest,
          lamports: i + 1, // unique per ix → bytewise distinct
        }),
      );
    }
    expect(padIxs.length).to.equal(16);

    const result = sendAndMeasureCU(
      svm,
      [validateIx, finalizeIx, ...padIxs],
      agent,
    );
    recordCU("6:computebudget-pad32", result);
    console.log(
      `  measured: ${result.computeUnitsConsumed.toLocaleString()} CU` +
        `  (succeeded=${result.succeeded})` +
        (result.errStr ? `  err=${result.errStr}` : ""),
    );
    expect(result.computeUnitsConsumed).to.be.greaterThan(0);
    expect(result.computeUnitsConsumed).to.be.lessThan(
      THRESHOLDS.computeBudgetPad32,
    );
  });
});
