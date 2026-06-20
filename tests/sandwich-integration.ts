/**
 * Phase 6.1 — End-to-end sandwich integration coverage for R-1/R-2/R-3/R-4 +
 * TA-12 + TA-14.
 *
 * Background. Phase 6 (Maestro borrows) shipped four new post-execution
 * assertion variants (R-1 MintDeltaCap, R-2 AtaAuthorityPin, R-3
 * OutputBalanceFloor, R-4 DeclarationConsistency) plus the Phase 5 post-exec
 * primitives TA-12 (stable balance floor) and TA-14 (per-recipient daily cap).
 * Coverage to date:
 *   - `tests/post-assertions-r-variants.ts`: validate-time entry acceptance/
 *     rejection (16 schema tests).
 *   - `tests/post-assertions-sandwich.ts`: SDK validator PASS/REJECT plus a
 *     single LiteSVM smoke test on the dispatcher fix. The sandwich variant
 *     coverage was scoped out as Phase 6.1 follow-up (see file header).
 *
 * This file closes the Phase 6.1 follow-up. Each test stands up a fresh
 * vault, attaches the relevant invariant configuration (post-assertion entry
 * for R-1..R-4, policy field for TA-12/TA-14), then sends a composed
 * `[validate_and_authorize, mock_defi, finalize_session]` transaction shaped
 * to violate the configured invariant. The assertion is that the bundle
 * reverts atomically at `finalize_session` with the specific Sigil error
 * code that pins the violation class.
 *
 * Mutation sensitivity. Each test triggers the violation by either:
 *   - actually mutating the vault ATA balance mid-sandwich via a CPI SPL
 *     transfer (mock-defi `drain_via_delegation` uses the validate-time
 *     agent delegation), OR
 *   - configuring the invariant so the no-op DeFi path can't satisfy it
 *     (e.g. `stable_balance_floor` set above current vault balance, R-3
 *     `min_increase > 0` with no actual inflow, R-2 target pointing at a
 *     non-vault-owned ATA).
 * Removing the load-bearing `require!` inside any of the post-execution
 * helpers (programs/sigil/src/utils/post_assertion_helpers.rs:62/100/160/256-262
 * or the TA-12/TA-14 sites in finalize_session.rs:572-654/697-839) will
 * cause the corresponding test to PASS the bundle that was previously
 * rejected — exactly the mutation signal the test is built for.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { expectSigilError } from "./helpers/strict-errors";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import {
  initVaultPreviewDigest,
  siblingHandlerDigest,
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  DEVNET_USDT_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
  buildMockDefiDrainIx,
  buildMockSwapToVaultIx,
  getTokenBalance,
  setRawTokenAccount,
} from "./helpers/litesvm-setup";

// ─── Constants ──────────────────────────────────────────────────────────────

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

// Mock-defi (test fixture) — three instructions: open_position (no-op),
// close_position (no-op), drain_via_delegation (CPI SPL transfer using
// agent's validate-time delegation). MOCK_DEFI_PROGRAM_ID, the no-op builder
// `buildMockDefiNoopIx`, AND the fund-moving `buildMockDefiDrainIx` are all
// hoisted into litesvm-setup.ts (shared across all spending-sandwich + cap
// tests post-F-Q2). They are imported above.

// Protocol treasury (hardcoded in programs/sigil/src/state/constants.rs).
const PROTOCOL_TREASURY = new PublicKey(
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
);

// ─── AL3 scalar intent digest (Bucket 2 / Phase 10 D-1 + D-6) ───────────────

/**
 * Mirror of `programs/sigil/src/utils/intent_digest.rs::compute_scalar_intent_digest`
 * and `sdk/kit/src/seal/intent-digest.ts::computeScalarIntentDigest`. The
 * canonical encoding is fixed:
 *
 *   1. magic:           b"SIG1"                (4 bytes)
 *   2. intent_version:  u8 = 2                 (1 byte)
 *   3. network_id:      u8 (0=devnet)          (1 byte)
 *   4. vault:           Pubkey                 (32 bytes)
 *   5. agent:           Pubkey                 (32 bytes)
 *   6. token_mint:      Pubkey                 (32 bytes)
 *   7. amount:          u64 LE                 (8 bytes)
 *   8. target_protocol: Pubkey                 (32 bytes; system program when omitted)
 *
 * Total: 142 bytes → SHA-256 → 32-byte digest.
 *
 * On-chain, `validate_and_authorize` recomputes this same digest from its
 * typed args and rejects on byte-equal mismatch (ErrIntentDigestMismatch
 * 6111). The network discriminant is bound by the program's cargo
 * feature — devnet builds emit `0`, mainnet builds emit `1`. Sigil's
 * compiled `target/deploy/sigil.so` is built with the default (devnet)
 * feature.
 */
function computeScalarIntentDigest(args: {
  vault: PublicKey;
  agent: PublicKey;
  tokenMint: PublicKey;
  amount: BN;
  targetProtocol: PublicKey;
}): Buffer {
  const crypto = require("crypto") as typeof import("crypto");
  const buf = Buffer.alloc(142);
  let off = 0;
  Buffer.from("SIG1", "ascii").copy(buf, off);
  off += 4;
  buf.writeUInt8(2, off); // intent_version v2
  off += 1;
  buf.writeUInt8(0, off); // network_id = devnet
  off += 1;
  args.vault.toBuffer().copy(buf, off);
  off += 32;
  args.agent.toBuffer().copy(buf, off);
  off += 32;
  args.tokenMint.toBuffer().copy(buf, off);
  off += 32;
  buf.writeBigUInt64LE(BigInt(args.amount.toString()), off);
  off += 8;
  args.targetProtocol.toBuffer().copy(buf, off);
  off += 32;
  if (off !== 142) {
    throw new Error(`scalar intent digest encoded ${off} bytes, expected 142`);
  }
  return crypto.createHash("sha256").update(buf).digest();
}

// ─── Mock-defi instruction builders ─────────────────────────────────────────
// `buildMockDefiNoopIx` (no-op open_position) and `buildMockDefiDrainIx`
// (fund-moving drain_via_delegation) are both imported from litesvm-setup.ts.

// ─── Suite ─────────────────────────────────────────────────────────────────

describe("sandwich-integration (Phase 6.1)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const feeDestination = Keypair.generate();

  let ownerUsdcAta: PublicKey;
  let ownerUsdtAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  // Counter to give each vault a fresh id so state doesn't bleed across cases.
  let vaultIdCounter = 11000;

  before(() => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 2_000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Stablecoin mints at hardcoded devnet addresses. The Sigil program's
    // `is_stablecoin_mint(...)` check requires these exact pubkeys.
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    createMintAtAddress(svm, DEVNET_USDT_MINT, owner.publicKey, 6);

    // Owner USDC/USDT ATAs — seed liquidity for every per-test deposit.
    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      owner.publicKey,
    );
    ownerUsdtAta = createAtaHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDT_MINT,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      ownerUsdcAta,
      owner.publicKey,
      100_000_000_000n, // 100K USDC
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDT_MINT,
      ownerUsdtAta,
      owner.publicKey,
      100_000_000_000n,
    );

    // Protocol treasury ATA (off-curve — PROTOCOL_TREASURY is not a PDA but
    // agent-side fee transfers expect the ATA to exist).
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      PROTOCOL_TREASURY,
      true,
    );
  });

  // ─── Shared vault setup ──────────────────────────────────────────────────

  interface VaultCtx {
    vaultId: BN;
    vault: PublicKey;
    policy: PublicKey;
    tracker: PublicKey;
    overlay: PublicKey;
    auditSuccess: PublicKey;
    auditRejected: PublicKey;
    postAssertionsPda: PublicKey;
    vaultUsdcAta: PublicKey;
    agent: Keypair;
  }

  interface VaultOpts {
    stableBalanceFloor?: BN;
    perRecipientDailyCapUsd?: BN;
    allowedDestinations?: PublicKey[];
    depositAmount?: BN; // default 600 USDC
    /**
     * Extra program IDs to add to the policy protocol allowlist (in ADDITION
     * to MOCK_DEFI_PROGRAM_ID). Used by the M1 ProtocolMismatch test, which
     * needs a second allowlisted program to set as target_protocol while the
     * executed DeFi ix targets MOCK_DEFI. These extras are NOT given
     * constraint entries (they are never executed — only used as the
     * authorized target value).
     */
    extraProtocols?: PublicKey[];
  }

  /**
   * Build a vault wired for the sandwich pattern: MOCK_DEFI in the protocol
   * allowlist, USDC deposited, agent registered with FULL_CAPABILITY (so
   * `validate_and_authorize`'s spending-capability gate passes).
   *
   * Returns every PDA the sandwich + post-assertion install need to reach.
   */
  async function freshVault(opts: VaultOpts = {}): Promise<VaultCtx> {
    const vaultId = new BN(vaultIdCounter++);
    const stableFloor = opts.stableBalanceFloor ?? new BN(0);
    const perRecipientCap = opts.perRecipientDailyCapUsd ?? new BN(0);
    const allowedDestinations = opts.allowedDestinations ?? [];
    const depositAmount = opts.depositAmount ?? new BN(600_000_000); // 600 USDC
    // Protocol allowlist = MOCK_DEFI plus any caller-supplied extras (M1
    // ProtocolMismatch test needs a 2nd allowlisted program to use as
    // target_protocol while executing a MOCK_DEFI ix). Same list must feed
    // both the initializeVault arg AND the preview digest, or the digest
    // mismatches (PolicyPreviewMismatch 6080).
    const protocols = [MOCK_DEFI_PROGRAM_ID, ...(opts.extraProtocols ?? [])];

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
    const [postAssertionsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("post_assertions"), vault.toBuffer()],
      program.programId,
    );

    // PEN-CROSS-2: the on-chain handler captures `Clock::get()?.slot` AT
    // handler entry. The off-chain digest helper must encode the SAME slot;
    // otherwise the digest mismatches and `PolicyPreviewMismatch` (6080)
    // fires before we ever reach the post-execution invariant under test.
    // Read live LiteSVM slot here so the digest matches the handler value.
    const createdAtSlot = Number(svm.getClock().slot);

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000_000), // 500K USDC daily cap (large; cap not under test here)
        new BN(100_000_000_000), // 100K USDC max-tx (large; not under test)
        1, // protocolMode = ALLOWLIST
        protocols,
        0, // developer fee rate
        100, // max slippage bps
        new BN(1800), // timelock duration
        allowedDestinations,
        [], // protocol_caps
        false, // observe_only
        0x00ffffff, // operating_hours (all 24)
        false, // auto_promote_grays
        5, // auto_revoke_threshold
        stableFloor,
        perRecipientCap,
        false, // cosign_required
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000_000),
          maxTransactionSizeUsd: new BN(100_000_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols,
          allowedDestinations,
          timelockDuration: new BN(1800),
          createdAtSlot,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          stableBalanceFloor: stableFloor,
          perRecipientDailyCapUsd: perRecipientCap,
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

    // Derive + deposit into vault's USDC ATA.
    const vaultUsdcAta = getAssociatedTokenAddressSync(
      DEVNET_USDC_MINT,
      vault,
      true,
    );
    await program.methods
      .depositFunds(depositAmount)
      .accounts({
        owner: owner.publicKey,
        vault,
        mint: DEVNET_USDC_MINT,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Register a spending agent. F-Q6: an instant OPERATOR
    // (FULL_CAPABILITY) grant on a single-key vault (cosign_required=false)
    // is rejected (ErrOperatorGrantRequiresTimelock 6107); seat it via the
    // timelocked queue→advance→apply path instead.
    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 5 * LAMPORTS_PER_SOL);
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault,
      agent: agent.publicKey,
    });

    // M1-04 (constraints-engine teardown): the permissive InstructionConstraints
    // PDA that used to be installed here is gone. validate_and_authorize no
    // longer interprets remaining_accounts[0] as a constraints PDA, so the
    // sandwich's post-assertions PDA passes through cleanly. The 9 tests below
    // assert FINALIZE-time outcome guarantees (mint-delta-cap, ATA-pin, output
    // floor, declaration consistency, stable-floor, per-recipient cap, the M1
    // single-DeFi-ix limit) — all independent of the deleted engine.

    return {
      vaultId,
      vault,
      policy,
      tracker,
      overlay,
      auditSuccess,
      auditRejected,
      postAssertionsPda,
      vaultUsdcAta,
      agent,
    };
  }

  /**
   * Install a single post-assertion entry on the vault via
   * `create_post_assertions`. The owner-signed digest is computed from the
   * live policy state (sibling-handler-mutation = has_post_assertions=1).
   */
  async function installPostAssertion(
    ctx: VaultCtx,
    entry: {
      targetAccount: PublicKey;
      offset?: number;
      valueLen?: number;
      operator?: number;
      expectedValue: Buffer;
      assertionMode: number;
      auxValue: number[]; // u64 LE bytes
      auxByte: number;
    },
  ): Promise<void> {
    const digest = await siblingHandlerDigest(program, ctx.policy, ctx.vault, {
      hasPostAssertions: 1,
    });
    await program.methods
      .createPostAssertions(
        [
          {
            targetAccount: entry.targetAccount,
            offset: entry.offset ?? 0,
            valueLen: entry.valueLen ?? 0,
            operator: entry.operator ?? 0,
            expectedValue: entry.expectedValue,
            assertionMode: entry.assertionMode,
            auxValue: entry.auxValue,
            auxByte: entry.auxByte,
          } as any,
        ],
        digest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: ctx.vault,
        policy: ctx.policy,
        postAssertions: ctx.postAssertionsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  // ─── Sandwich ix builders ────────────────────────────────────────────────

  interface SandwichOpts {
    ctx: VaultCtx;
    amount: BN;
    /** Accounts to pass via `validate_and_authorize.remaining_accounts`. */
    validateRemainingAccounts?: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[];
    /** Accounts to pass via `finalize_session.remaining_accounts`. */
    finalizeRemainingAccounts?: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[];
    /**
     * Override the authorized `target_protocol`. Defaults to
     * MOCK_DEFI_PROGRAM_ID (the program the executed DeFi ix targets). The M1
     * ProtocolMismatch test sets this to a DIFFERENT allowlisted program so
     * the executed MOCK_DEFI ix (program_id != target_protocol) trips
     * ProtocolMismatch. Both the intent digest and the ix arg use this value
     * so the AL3 intent-digest check passes and the mismatch is reached.
     */
    targetProtocolOverride?: PublicKey;
    /**
     * M1: the vault-owned account an acquiring spend credits. When set, validate
     * pins it + finalize requires it increased (gate 6112). Default null (None):
     * non-spending / zero-spend sandwiches don't trip the gate.
     */
    outputSwapAccount?: PublicKey | null;
  }

  async function buildValidateIx(
    opts: SandwichOpts,
  ): Promise<TransactionInstruction> {
    const { ctx, amount } = opts;
    const targetProtocol = opts.targetProtocolOverride ?? MOCK_DEFI_PROGRAM_ID;
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        ctx.vault.toBuffer(),
        ctx.agent.publicKey.toBuffer(),
        DEVNET_USDC_MINT.toBuffer(),
      ],
      program.programId,
    );
    const policyVersion =
      ((await program.account.policyConfig.fetch(ctx.policy))
        .policyVersion as BN) ?? new BN(0);

    // D-1 + D-6 (Bucket 2 2026-05-21): AL3 scalar intent digest. The
    // verifier inside `validate_and_authorize` (intent_digest.rs:159-191)
    // hashes (vault, agent, token_mint, amount, target_protocol, network)
    // and rejects on byte-equal mismatch. Compute from the same fields
    // we're passing as ix args so the on-chain recomputation matches.
    const intentDigest = computeScalarIntentDigest({
      vault: ctx.vault,
      agent: ctx.agent.publicKey,
      tokenMint: DEVNET_USDC_MINT,
      amount,
      targetProtocol,
    });

    let builder = program.methods
      .validateAndAuthorize(
        DEVNET_USDC_MINT,
        amount,
        targetProtocol,
        policyVersion,
        new BN(0),
        Array.from(intentDigest),
      )
      .accountsPartial({
        agent: ctx.agent.publicKey,
        vault: ctx.vault,
        policy: ctx.policy,
        tracker: ctx.tracker,
        session: sessionPda,
        vaultTokenAccount: ctx.vaultUsdcAta,
        tokenMintAccount: DEVNET_USDC_MINT,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        outputSwapAccount: opts.outputSwapAccount ?? null,
        agentSpendOverlay: ctx.overlay,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      });
    // F-Q1a completeness satisfier (mirrors seal()): the fee-payer agent is
    // writable in the compiled v0 message, so the on-chain destination check —
    // which reads writability from the compiled message via
    // load_instruction_at_checked — sees the agent as a writable meta of every
    // DeFi ix that references it (all mock-defi ixs list the agent signer). It
    // must be resolvable in validate's remaining_accounts or completeness
    // rejects with DestinationAccountUnresolvable. Append it to whatever the
    // test passes (de-duped on-chain by find()). Drain-ix tests additionally
    // pass the source + destination token accounts (the ix's declared writables)
    // in opts.validateRemainingAccounts.
    const validateRA = [
      ...(opts.validateRemainingAccounts ?? []),
      { pubkey: ctx.agent.publicKey, isSigner: false, isWritable: false },
    ];
    builder = builder.remainingAccounts(validateRA);
    return builder.instruction();
  }

  async function buildFinalizeIx(
    opts: SandwichOpts,
  ): Promise<TransactionInstruction> {
    const { ctx } = opts;
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        ctx.vault.toBuffer(),
        ctx.agent.publicKey.toBuffer(),
        DEVNET_USDC_MINT.toBuffer(),
      ],
      program.programId,
    );
    let builder = program.methods.finalizeSession().accountsPartial({
      payer: ctx.agent.publicKey,
      vault: ctx.vault,
      session: sessionPda,
      sessionRentRecipient: ctx.agent.publicKey,
      policy: ctx.policy,
      tracker: ctx.tracker,
      agentSpendOverlay: ctx.overlay,
      vaultTokenAccount: ctx.vaultUsdcAta,
      outputStablecoinAccount: null,
      outputSwapAccount: opts.outputSwapAccount ?? null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    });
    if (opts.finalizeRemainingAccounts) {
      builder = builder.remainingAccounts(opts.finalizeRemainingAccounts);
    }
    return builder.instruction();
  }

  // M1: stand up an acquiring-swap output — a non-USDC mint, a VAULT-OWNED ATA
  // to receive it (the acquisition finalize's output-ownership gate verifies),
  // and an agent-owned reserve to fund the swap's output leg (test-only — a real
  // swap sources output from a pool). Pair with buildMockSwapToVaultIx so a
  // stablecoin-input spend satisfies the mandatory gate (6112) while still
  // exercising the cap/assertion under test.
  function setupSwapOutput(ctx: VaultCtx): {
    outputMint: PublicKey;
    vaultOutputAta: PublicKey;
    agentReserve: PublicKey;
  } {
    const outputMint = Keypair.generate().publicKey;
    createMintAtAddress(svm, outputMint, owner.publicKey, 6);
    const vaultOutputAta = createAtaHelper(
      svm,
      (owner as any).payer,
      outputMint,
      ctx.vault,
      true,
    );
    const agentReserve = createAtaHelper(
      svm,
      (owner as any).payer,
      outputMint,
      ctx.agent.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      outputMint,
      agentReserve,
      owner.publicKey,
      1_000_000_000n,
    );
    return { outputMint, vaultOutputAta, agentReserve };
  }

  // ─── 1. R-1 MintDeltaCap exceeded ────────────────────────────────────────

  describe("R-1 MintDeltaCap: vault-balance decrease exceeds max_net_decrease", () => {
    it("rejects with ErrMintDeltaCapExceeded (6097)", async () => {
      const ctx = await freshVault();
      // M1: the spend must acquire a vault-owned output (else 6112 fires before
      // the R-1 MintDeltaCap we're testing). The USDC still decreases, so R-1 on
      // USDC still trips.
      const swap = setupSwapOutput(ctx);

      // Token-2022 ATA for the same (vault, USDC) pair. R-1 scope=0 sums both
      // the SPL classic ATA AND the Token-2022 ATA at finalize, so the
      // Token-2022 ATA pubkey MUST appear in remaining_accounts even when
      // uninitialized (otherwise the helper returns MintDeltaCapMisconfigured).
      const TOKEN_2022_PROGRAM_ID = new PublicKey(
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      );
      const vaultUsdcAta2022 = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        ctx.vault,
        true,
        TOKEN_2022_PROGRAM_ID,
      );

      // Recipient (off-vault) ATA — destination for the drain CPI.
      const drainRecipient = Keypair.generate();
      airdropSol(svm, drainRecipient.publicKey, 1 * LAMPORTS_PER_SOL);
      const drainRecipientAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        drainRecipient.publicKey,
      );

      // Install R-1 scope=0 MintDeltaCap entry for USDC with max_net_decrease=1
      // (1 micro-USDC — any real drain exceeds this). The pre-snapshot will
      // capture the current vault USDC balance (~600 USDC = 600M micros);
      // the drain transfers 10 USDC = 10M micros; net_decrease >> 1.
      const usdcMintBytes = Buffer.alloc(32);
      DEVNET_USDC_MINT.toBuffer().copy(usdcMintBytes, 0);
      await installPostAssertion(ctx, {
        targetAccount: PublicKey.default, // scope=0 ignores target_account
        expectedValue: usdcMintBytes,
        assertionMode: 4, // MintDeltaCap
        auxValue: Array.from(new BN(1).toArray("le", 8)), // max_net_decrease = 1 micro-USDC
        auxByte: 0, // scope=0 vault-wide
      });

      // remaining_accounts shape (validate + finalize):
      //   [0] constraints PDA (validate's position-0 requirement)
      //   [1] post_assertions PDA (found via .iter().find())
      //   [2..] derived USDC ATAs across SPL + Token-2022 (R-1 scope=0 sums
      //         both; the Token-2022 ATA is uninitialized but its pubkey
      //         still must be passed per MintDeltaCapMisconfigured guard).
      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000), // declared 50 USDC (validate-time delegation)
        outputSwapAccount: swap.vaultOutputAta,
        validateRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: vaultUsdcAta2022, isSigner: false, isWritable: false },
          // F-Q1a completeness: the drain ix's writable destination (the source
          // ctx.vaultUsdcAta is already above; the agent is auto-appended by
          // buildValidateIx).
          { pubkey: drainRecipientAta, isSigner: false, isWritable: false },
          { pubkey: swap.agentReserve, isSigner: false, isWritable: false },
          { pubkey: swap.vaultOutputAta, isSigner: false, isWritable: false },
        ],
        finalizeRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: vaultUsdcAta2022, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const drainIx = buildMockSwapToVaultIx(
        ctx.vaultUsdcAta,
        drainRecipientAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        ctx.agent.publicKey,
        new BN(10_000_000), // 10 USDC pulled via delegation (R-1 still trips)
        new BN(1_000), // tiny acquisition → satisfies the M1 gate
      );
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, drainIx, finalizeIx], ctx.agent);
        expect.fail("Expected R-1 MintDeltaCap drain to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrMintDeltaCapExceeded" });
      }
    });
  });

  // ─── 2. R-2 AtaAuthorityPin violated ─────────────────────────────────────

  describe("R-2 AtaAuthorityPin: target ATA authority is not the vault", () => {
    it("rejects with ErrAtaAuthorityChanged (6099)", async () => {
      const ctx = await freshVault();

      // Construct a token account whose authority is NOT the vault. R-2's
      // finalize helper reads bytes 32..64 (the SPL TokenAccount.owner field)
      // and requires it equal `vault_key`. Pointing the entry at a non-vault
      // ATA simulates the attack class where a vault ATA's authority was
      // changed mid-sandwich (the on-chain SetAuthority opcode is blocked at
      // validate, but in the wild a Token-2022 extension or close+reinit
      // could swap authority; R-2 catches the post-state divergence).
      const nonVaultOwner = Keypair.generate();
      const nonVaultUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        nonVaultOwner.publicKey,
      );

      await installPostAssertion(ctx, {
        targetAccount: nonVaultUsdcAta,
        expectedValue: Buffer.alloc(0),
        assertionMode: 5, // AtaAuthorityPin
        auxValue: Array.from(new BN(0).toArray("le", 8)),
        auxByte: 0,
      });

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        validateRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
        ],
        finalizeRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          // Pass the non-vault ATA so finalize can read it. R-2 verifies its
          // authority equals vault_key and rejects on mismatch.
          { pubkey: nonVaultUsdcAta, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail("Expected R-2 AtaAuthorityPin to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrAtaAuthorityChanged" });
      }
    });
  });

  // ─── 3. R-3 OutputBalanceFloor below ─────────────────────────────────────

  describe("R-3 OutputBalanceFloor: post-balance increase below min_increase", () => {
    it("rejects with ErrOutputBelowFloor (6100)", async () => {
      const ctx = await freshVault();

      // R-3 measures `(post_balance - pre_balance) >= aux_value (min_increase)`.
      // With a no-op middle ix, pre == post, so `delta = 0`. Setting
      // min_increase = 1 micro-USDC guarantees the assertion fails at finalize.
      //
      // The target must be VAULT-owned (validate-time check
      // `authority == vault_key` at validate_and_authorize.rs:1235-1238 /
      // post_assertion_helpers.rs:145-148). The vault USDC ATA is that
      // target.
      const usdcMintBytes = Buffer.alloc(32);
      DEVNET_USDC_MINT.toBuffer().copy(usdcMintBytes, 0);

      await installPostAssertion(ctx, {
        targetAccount: ctx.vaultUsdcAta,
        expectedValue: usdcMintBytes,
        assertionMode: 6, // OutputBalanceFloor
        auxValue: Array.from(new BN(1).toArray("le", 8)), // min_increase=1 micro-USDC
        auxByte: 0,
      });

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        validateRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
        ],
        finalizeRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail("Expected R-3 OutputBalanceFloor to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrOutputBelowFloor" });
      }
    });
  });

  // ─── 4. R-4 DeclarationConsistency mismatch ──────────────────────────────

  describe("R-4 DeclarationConsistency: declared recipient/mint ≠ CPI meta", () => {
    it("rejects with ErrDeclarationInconsistent (6101)", async () => {
      const ctx = await freshVault();

      // Pick a declared mint that differs from what's at meta_index 0 of the
      // mock-defi ix. The mock-defi noop ix has only `signer` at keys[0]
      // (the agent — a wallet, NOT a token account). R-4 will:
      //   1. Look up the meta pubkey (= agent) in remaining_accounts.
      //   2. Check `owner == SPL Token || Token-2022`. Agent is a wallet
      //      owned by SystemProgram → check fails → 6101.
      // We can also assert via mint mismatch: declare USDT but the meta
      // points to the agent (no mint at all). Either path reaches 6101.
      const usdtMintBytes = Buffer.alloc(32);
      DEVNET_USDT_MINT.toBuffer().copy(usdtMintBytes, 0);
      const declaredRecipient = Keypair.generate().publicKey; // arbitrary non-default

      await installPostAssertion(ctx, {
        targetAccount: declaredRecipient,
        expectedValue: usdtMintBytes,
        assertionMode: 7, // DeclarationConsistency
        auxValue: Array.from(new BN(0).toArray("le", 8)),
        auxByte: 0, // meta_index = 0 → mock-defi noop keys[0] = agent (wallet)
      });

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        validateRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
        ],
        finalizeRemainingAccounts: [
          {
            pubkey: ctx.postAssertionsPda,
            isSigner: false,
            isWritable: false,
          },
          // R-4 looks up the meta pubkey in remaining_accounts. The mock-defi
          // ix's meta[0] = agent.publicKey; pass it so the lookup resolves
          // (then the SPL-owned check at the helper trips).
          {
            pubkey: ctx.agent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail("Expected R-4 DeclarationConsistency to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrDeclarationInconsistent" });
      }
    });
  });

  // ─── 5. TA-12 stable_balance_floor violated ──────────────────────────────

  describe("TA-12 stable_balance_floor: combined USDC+USDT below configured floor", () => {
    it("rejects with ErrStableFloorViolation (6085)", async () => {
      // Deposit 600 USDC (default). Configure floor = 100K USDC — comfortably
      // above the current balance. After the sandwich's fee CPI (~10K micros
      // for a 50 USDC declared amount) runs, combined stable balance is still
      // ~600 USDC = 600M micros, well below the 100K-USDC floor (100B micros).
      const floor = new BN(100_000_000_000); // 100K USDC face value
      const ctx = await freshVault({
        stableBalanceFloor: floor,
        depositAmount: new BN(600_000_000), // 600 USDC
      });

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        validateRemainingAccounts: [],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail("Expected TA-12 stable_balance_floor to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrStableFloorViolation" });
      }
    });

    it("ignores a non-canonical vault-owned USDC account (M3-01 canonical-ATA pin)", async () => {
      // The canonical USDC ATA holds 600 (< floor). A SECOND vault-owned USDC
      // token account (authority == vault, mint == USDC, but NOT the canonical
      // ATA) holds 200K — alone enough to clear the 100K floor. If the floor
      // counted non-canonical accounts, combined (600 + 200K) >= 100K and the
      // sandwich would PASS. The M3-01 canonical-ATA pin counts ONLY the
      // canonical ATA (600), so it must still revert — proving the 200K in the
      // non-canonical account is ignored. Direction is fail-safe: skipping the
      // account makes the sum smaller (stricter), never a bypass.
      const floor = new BN(100_000_000_000); // 100K USDC face value
      const ctx = await freshVault({
        stableBalanceFloor: floor,
        depositAmount: new BN(600_000_000), // 600 USDC in the canonical ATA
      });

      // Fabricate a non-canonical vault-owned USDC token account funded to 200K.
      const nonCanonical = Keypair.generate().publicKey;
      setRawTokenAccount(
        svm,
        nonCanonical,
        DEVNET_USDC_MINT,
        ctx.vault,
        200_000_000_000n,
      );
      // Sanity: the account really holds 200K (so a revert means "ignored", not
      // "empty"), and it is NOT the canonical ATA.
      const bal = getTokenBalance(svm, nonCanonical);
      if (bal !== 200_000_000_000n) {
        throw new Error(`setup: non-canonical balance ${bal} != 200000000000`);
      }
      if (nonCanonical.equals(ctx.vaultUsdcAta)) {
        throw new Error(
          "setup: fabricated account must not be the canonical ATA",
        );
      }

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        finalizeRemainingAccounts: [
          { pubkey: nonCanonical, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail(
          "floor must ignore the non-canonical account and revert (canonical-ATA pin)",
        );
      } catch (err: any) {
        if (err?.message?.startsWith("floor must ignore")) throw err;
        expectSigilError(err, { name: "ErrStableFloorViolation" });
      }
    });

    it("counts the COMBINED USDC+USDT balance across both canonical ATAs (passes above floor)", async () => {
      // Vault holds 60 USDC in the canonical USDC ATA + 60 (USDC-equiv) in the
      // canonical USDT ATA = 120 combined, above the 100 USDC floor. Feeding
      // both canonical ATAs (USDC via the named vaultTokenAccount = Source 1;
      // USDT via Source 3) the floor sums 120 >= 100 and the sandwich PASSES —
      // proving the combined-stablecoin guarantee (change b): floor sees BOTH.
      // Small amounts keep the shared test-mint source from exhausting.
      const floor = new BN(100_000_000); // 100 USDC
      const ctx = await freshVault({
        stableBalanceFloor: floor,
        depositAmount: new BN(60_000_000), // 60 USDC in the canonical ATA
      });
      // Fund the vault's CANONICAL USDT ATA with 60 (raw bytes — the floor reads
      // the token account's own fields, no USDT mint account / deposit needed).
      const usdtAta = getAssociatedTokenAddressSync(
        DEVNET_USDT_MINT,
        ctx.vault,
        true, // vault is a PDA (off-curve)
      );
      setRawTokenAccount(
        svm,
        usdtAta,
        DEVNET_USDT_MINT,
        ctx.vault,
        60_000_000n,
      );

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        finalizeRemainingAccounts: [
          { pubkey: usdtAta, isSigner: false, isWritable: false },
        ],
      };
      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
      } catch (err: any) {
        throw new Error(
          `combined floor should PASS (120K >= 100K) but reverted: ${err?.message ?? err}`,
        );
      }
    });

    it("under-counts and reverts (fail-safe) when the other stablecoin ATA is omitted", async () => {
      // Same 60 USDC + 60 USDT vault + 100 USDC floor, but the USDT ATA is NOT
      // fed to finalize. The floor sees only the 60 USDC (Source 1) → 60 < 100 →
      // reverts. Omission is fail-safe (stricter), never a bypass — and this is
      // exactly why the seal() satisfier (change b) feeds the other ATA.
      const floor = new BN(100_000_000); // 100 USDC
      const ctx = await freshVault({
        stableBalanceFloor: floor,
        depositAmount: new BN(60_000_000), // 60 USDC
      });
      const usdtAta = getAssociatedTokenAddressSync(
        DEVNET_USDT_MINT,
        ctx.vault,
        true,
      );
      setRawTokenAccount(
        svm,
        usdtAta,
        DEVNET_USDT_MINT,
        ctx.vault,
        60_000_000n,
      );

      // usdtAta is deliberately NOT in finalizeRemainingAccounts.
      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
      };
      const validateIx = await buildValidateIx(sandwichOpts);
      const noopIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, noopIx, finalizeIx], ctx.agent);
        expect.fail("omitting the USDT ATA must under-count and revert");
      } catch (err: any) {
        if (err?.message?.startsWith("omitting the USDT")) throw err;
        expectSigilError(err, { name: "ErrStableFloorViolation" });
      }
    });
  });

  // ─── 6. TA-14 per-recipient daily cap exceeded ───────────────────────────

  describe("TA-14 per_recipient_daily_cap_usd: outflow exceeds recipient cap", () => {
    it("rejects with ErrRecipientCapExceeded (6096)", async () => {
      // TA-14 enforcement requires `actual_spend_tracked > 0` AND a recipient
      // resolvable from the DeFi ix's writable token-account metas. We use
      // the mock-defi `drain_via_delegation` CPI to:
      //   - actually decrease the vault USDC ATA balance (drives
      //     actual_spend_tracked > 0 at finalize), AND
      //   - place the recipient ATA (whose owner is in
      //     allowed_destinations) in the DeFi ix's writable metas so TA-14's
      //     walker resolves it.
      //
      // With per_recipient_daily_cap_usd = 1 micro-USDC and a 10 USDC
      // drain, the recipient's rolling 24h outflow (10M micros) exceeds
      // the 1-micro cap → 6096.
      const recipient = Keypair.generate();
      airdropSol(svm, recipient.publicKey, 1 * LAMPORTS_PER_SOL);

      const ctx = await freshVault({
        perRecipientDailyCapUsd: new BN(1), // 1 micro-USDC cap
        allowedDestinations: [recipient.publicKey],
      });
      // M1: the spend must acquire a vault-owned output (else 6112 fires before
      // the TA-14 per-recipient cap we're testing). The USDC still flows to the
      // allowlisted recipient (the swap's input sink), so TA-14 still trips.
      const swap = setupSwapOutput(ctx);

      const recipientUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        recipient.publicKey,
      );

      const drainAmount = new BN(10_000_000); // 10 USDC drain
      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        outputSwapAccount: swap.vaultOutputAta,
        // F-Q1a completeness: the drain ix's declared writables (source vault
        // USDC ATA + destination recipient ATA) must be resolvable in validate's
        // remaining_accounts (the agent fee-payer is auto-appended by
        // buildValidateIx).
        validateRemainingAccounts: [
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: false },
          { pubkey: swap.agentReserve, isSigner: false, isWritable: false },
          { pubkey: swap.vaultOutputAta, isSigner: false, isWritable: false },
        ],
        // TA-14 walks the DeFi ix's metas + looks up the writable token
        // accounts in finalize.remaining_accounts. The recipient ATA must
        // be passed there so the recipient resolution succeeds.
        finalizeRemainingAccounts: [
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const drainIx = buildMockSwapToVaultIx(
        ctx.vaultUsdcAta,
        recipientUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        ctx.agent.publicKey,
        drainAmount,
        new BN(1_000), // tiny acquisition → satisfies the M1 gate
      );
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, drainIx, finalizeIx], ctx.agent);
        expect.fail("Expected TA-14 per-recipient cap to revert");
      } catch (err: any) {
        expectSigilError(err, { name: "ErrRecipientCapExceeded" });
      }
    });
  });

  // ─── M1: defi_ix_count + ProtocolMismatch apply to ALL allowlisted
  //         protocols (is_recognized_defi hardcoding removed) ───────────────
  //
  // Before the M1 `is_recognized_defi` removal, the spending-scan loop in
  // validate_and_authorize.rs only incremented `defi_ix_count` and enforced
  // the `ix.program_id == target_protocol` (ProtocolMismatch) check for FOUR
  // hardcoded program IDs (FLASH_TRADE / JUPITER_LEND / JUPITER_EARN /
  // JUPITER_BORROW). Any OTHER allowlisted protocol (here: MOCK_DEFI, which is
  // exactly such a non-hardcoded but allowlisted program) reached
  // ScanAction::PassedSharedChecks but was NOT counted and NOT mismatch-checked.
  //
  // Consequence (the latent gap these tests pin):
  //   1. The "exactly one DeFi instruction per session" invariant silently did
  //      NOT apply — two MOCK_DEFI instructions in one sandwich both passed.
  //   2. The target_protocol consistency check was skipped — a sandwich could
  //      authorize target=A and execute a different allowlisted program with no
  //      ProtocolMismatch.
  //
  // After the fix (any instruction reaching PassedSharedChecks is treated as a
  // DeFi instruction → counted + mismatch-checked), both behaviors apply to
  // EVERY allowlisted protocol, agnostically. These tests FAIL on the
  // pre-fix code (the bundles erroneously succeed) and PASS after the fix.
  describe("M1: single-DeFi-ix limit applies to all allowlisted protocols", () => {
    it("rejects two DeFi instructions from one allowlisted protocol with TooManyDeFiInstructions (6033)", async () => {
      // MOCK_DEFI is allowlisted (freshVault wires it into policy.protocols)
      // but is NOT one of the 4 hardcoded is_recognized_defi programs — so it
      // is the exact case the pre-fix code failed to count.
      //
      // Two no-op mock-defi instructions between validate and finalize. Both
      // are non-spending no-ops (no balance movement), so nothing else in the
      // sandwich rejects them — the ONLY thing that should stop this bundle is
      // the defi_ix_count limit. amount=0 keeps this on the non-spending-value
      // path's sibling logic but is_spending is driven by amount; we use a
      // non-zero amount so the spending scan (which holds defi_ix_count) runs.
      const ctx = await freshVault();

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(1_000_000), // 1 USDC — drives is_spending = true
        validateRemainingAccounts: [],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const defiIx1 = buildMockDefiNoopIx(ctx.agent.publicKey);
      const defiIx2 = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(
          svm,
          [validateIx, defiIx1, defiIx2, finalizeIx],
          ctx.agent,
        );
        expect.fail(
          "Expected TooManyDeFiInstructions — two DeFi ixs from an allowlisted protocol must be rejected",
        );
      } catch (err: any) {
        expectSigilError(err, { name: "TooManyDeFiInstructions" });
      }
    });

    it("accepts a single DeFi instruction from an allowlisted protocol (regression)", async () => {
      // The fix must NOT break the legitimate single-DeFi-ix sandwich. One
      // no-op mock-defi ix between validate and finalize must still succeed.
      const ctx = await freshVault();

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(1_000_000),
        validateRemainingAccounts: [],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const defiIx = buildMockDefiNoopIx(ctx.agent.publicKey);
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      // Should NOT throw — a single allowlisted DeFi ix is the canonical path.
      sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], ctx.agent);
    });

    it("rejects a DeFi ix whose program != authorized target_protocol with ProtocolMismatch (6034)", async () => {
      // The OTHER half of the M1 fix: the target_protocol consistency check now
      // applies to EVERY allowlisted DeFi ix, not just the 4 former hardcoded
      // programs. Pre-fix, authorizing target=B (a non-hardcoded allowlisted
      // program) while executing a MOCK_DEFI ix slipped through unchecked
      // because MOCK_DEFI wasn't is_recognized_defi. After the fix, the
      // executed MOCK_DEFI ix (program_id != target_protocol) must trip
      // ProtocolMismatch.
      //
      // Setup: allowlist a SECOND program (otherProtocol) alongside MOCK_DEFI,
      // authorize the session against otherProtocol, then execute a MOCK_DEFI
      // no-op. otherProtocol is never executed — it only serves as the
      // authorized-but-mismatched target. Both programs are on the allowlist,
      // so the failure is specifically the target mismatch (not
      // ProtocolNotAllowed).
      const otherProtocol = Keypair.generate().publicKey;
      const ctx = await freshVault({ extraProtocols: [otherProtocol] });

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(1_000_000), // drives is_spending = true
        targetProtocolOverride: otherProtocol, // authorize target = B …
        validateRemainingAccounts: [],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const defiIx = buildMockDefiNoopIx(ctx.agent.publicKey); // … but execute MOCK_DEFI
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], ctx.agent);
        expect.fail(
          "Expected ProtocolMismatch — executed DeFi ix program must equal authorized target_protocol",
        );
      } catch (err: any) {
        expectSigilError(err, { name: "ProtocolMismatch" });
      }
    });
  });

  // ─── F-Q1a: destination COMPLETENESS + sink-scoped allowlist ──────────────
  describe("F-Q1a: completeness fail-closed + sink-scoped skip", () => {
    it("rejects when a writable DeFi destination is withheld from remaining_accounts (DestinationAccountUnresolvable 6105)", async () => {
      // The drain ix surfaces source + destination as writable metas on-chain.
      // We pass the source (and the agent is auto-appended) but WITHHOLD the
      // destination ATA — the guard cannot classify an account it cannot read,
      // so completeness must reject FAIL-CLOSED rather than silently skip it.
      const recipient = Keypair.generate();
      airdropSol(svm, recipient.publicKey, 1 * LAMPORTS_PER_SOL);
      const ctx = await freshVault();
      const recipientUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        recipient.publicKey,
      );

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        // Deliberately omit recipientUsdcAta (the writable destination). Source
        // is present; agent is auto-appended by buildValidateIx.
        validateRemainingAccounts: [
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const drainIx = buildMockDefiDrainIx(
        ctx.vaultUsdcAta,
        recipientUsdcAta,
        ctx.agent.publicKey,
        new BN(10_000_000),
      );
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      try {
        sendVersionedTx(svm, [validateIx, drainIx, finalizeIx], ctx.agent);
        expect.fail(
          "Expected completeness fail-closed on the withheld destination",
        );
      } catch (err: any) {
        expectSigilError(err, { name: "DestinationAccountUnresolvable" });
      }
    });

    it("permits a swap whose writable destination is a NON-allowlisted hop, within caps (sink-scoped skip, swap survives)", async () => {
      // The decidability point: a non-vault token account whose owner is NOT on
      // the allowlist is a transient route hop (AMM pool / DEX-internal). With
      // every writable account resolvable (completeness satisfied), the guard
      // SKIPS the non-allowlisted destination rather than reverting — so the
      // swap survives. Magnitude is bounded by the global cap (here 500K USDC).
      const recipient = Keypair.generate(); // NOT in allowed_destinations
      airdropSol(svm, recipient.publicKey, 1 * LAMPORTS_PER_SOL);
      const ctx = await freshVault(); // empty allowlist + no per-recipient cap/floor
      // M1: a real acquiring swap — the INPUT goes to the non-allowlisted hop
      // (skipped, sink-scoped) AND the vault acquires a vault-owned output, so
      // the swap survives the mandatory output-ownership gate (6112).
      const swap = setupSwapOutput(ctx);
      const recipientUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        recipient.publicKey,
      );

      const sandwichOpts: SandwichOpts = {
        ctx,
        amount: new BN(50_000_000),
        outputSwapAccount: swap.vaultOutputAta,
        // All writable DeFi accounts present (agent auto-appended) → completeness
        // passes; the non-allowlisted recipient (the swap's input hop) is skipped
        // (sink-scoped) while the vault-owned output is acquired.
        validateRemainingAccounts: [
          { pubkey: ctx.vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: false },
          { pubkey: swap.agentReserve, isSigner: false, isWritable: false },
          { pubkey: swap.vaultOutputAta, isSigner: false, isWritable: false },
        ],
      };

      const validateIx = await buildValidateIx(sandwichOpts);
      const drainIx = buildMockSwapToVaultIx(
        ctx.vaultUsdcAta,
        recipientUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        ctx.agent.publicKey,
        new BN(10_000_000), // 10 USDC, far under the 500K daily cap
        new BN(1_000), // tiny acquisition → satisfies the M1 gate
      );
      const finalizeIx = await buildFinalizeIx(sandwichOpts);

      // Must NOT throw — a non-allowlisted hop is skipped, not rejected.
      sendVersionedTx(svm, [validateIx, drainIx, finalizeIx], ctx.agent);
    });
  });
});
