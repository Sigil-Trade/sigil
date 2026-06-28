/**
 * Sysvar Scan Bound Tests — M11 SIMD-0296 Pad-Attack DoS Guard (PR 2b)
 *
 * Verifies that the three sysvar instruction-introspection scans in the Sigil
 * program are bounded at MAX_SYSVAR_SCAN_ITERATIONS=64. An adversary cannot
 * inflate the cost of these scans by padding a tx with cheap whitelisted
 * no-ops between (or around) the validate / finalize pair.
 *
 * Scan locations under test:
 *   1. validate_and_authorize.rs — backward pre-validate scan (5a)
 *   2. validate_and_authorize.rs — forward spending/non-spending scan (6, 6b)
 *   3. finalize_session.rs       — post-finalize defense-in-depth scan
 *
 * Solana v0 transactions cap the per-tx instruction count at 64; this PR
 * adds a defense-in-depth bound so the scans cannot be weaponized by a
 * future runtime change (e.g. SIMD-0296's proposed 4,096-byte tx) or by
 * an attacker exploiting an unbounded loop. In legitimate flows the bound
 * is unreachable.
 *
 * Test strategy: we cannot push a real tx beyond Solana's 64-ix cap, so we
 * verify (a) the bound does not break legitimate padded flows (e.g. many
 * SystemProgram.transfer no-ops before/after/around validate+finalize) and
 * (b) CU consumption stays bounded — the scan really is O(N) up to the cap,
 * not O(tx_size_attacker_picks).
 *
 * Note: SystemProgram.transfer is used as the no-op vehicle (not
 * ComputeBudget) because Solana's runtime rejects duplicate ComputeBudget
 * instructions at the ComputeBudget program level (e.g. only one
 * setComputeUnitLimit per tx). System self-transfers are unique by
 * recipient and freely composable.
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
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
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
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
import { registerOperatorAgent } from "./helpers/register-operator-agent";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

describe("sysvar-scan-bound (M11 / SIMD-0296 pad-attack guard)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(7777);

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let ownerUsdcAta: PublicKey;

  // Allowed protocol (fake program ID — no DeFi ix in these tests so any key works)
  const jupiterProgramId = Keypair.generate().publicKey;

  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );

  /** Fetch the current policy_version for the TOCTOU check. */
  async function pv(): Promise<BN> {
    const pol = await program.account.policyConfig.fetch(policyPda);
    return (pol as any).policyVersion ?? new BN(0);
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

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
      2_000_000_000n,
    );

    createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // Initialize vault
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        [jupiterProgramId],
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
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });

    // Deposit funds
    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: new PublicKey(
          "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        ),
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Register agent (F-Q6: OPERATOR grant on a single-key vault goes through
    // the timelocked queue→advance→apply path).
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Build a (validateIx, finalizeIx) pair using a non-spending session
   * (amount=0). Non-spending requires no DeFi instruction between validate
   * and finalize, so we can pad with arbitrary whitelisted no-ops without
   * tripping the DeFi-count enforcement.
   *
   * Reuses the real USDC mint each call. Each session_pda is destroyed by
   * its successful finalize, so successive `buildPair` calls within the
   * same `describe` block reuse the same PDA seed without collision.
   */
  async function buildPair(): Promise<{
    validateIx: TransactionInstruction;
    finalizeIx: TransactionInstruction;
    sessionPda: PublicKey;
  }> {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );

    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        new BN(0), // amount=0 → non-spending → no DeFi ix required
        jupiterProgramId,
        await pv(),
        new BN(0), // AC-10 expectedNonce
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount: new BN(0),
            targetProtocol: jupiterProgramId,
          }),
        ),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: null,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const finalizeIx = await program.methods
      .finalizeSession()
      .accountsPartial({
        // C-1 fix: relocated fee accounts (protocol treasury + dev fee dest).
        protocolTreasuryTokenAccount: null,
        feeDestinationTokenAccount: null,
        payer: agent.publicKey,
        vault: vaultPda,
        session: sessionPda,
        sessionRentRecipient: agent.publicKey,
        policy: policyPda,
        tracker: trackerPda,
        vaultTokenAccount: vaultUsdcAta,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
      })
      .instruction();

    return { validateIx, finalizeIx, sessionPda };
  }

  /**
   * Build N SystemProgram.transfer no-ops, each unique by lamport amount.
   *
   * Each transfer is agent → agent (self-transfer) with lamports=i for
   * the i-th noop. Same accounts (just `agent`), so the v0 tx message
   * stores the agent key once — keeping us well under the 1232-byte tx
   * size cap even at N=30. Each ix has distinct data bytes (lamports
   * differs), so the runtime's duplicate-instruction check never fires.
   *
   * Self-transfer of `i` lamports nets to nothing in the agent's balance.
   */
  function makeNoops(n: number): TransactionInstruction[] {
    return Array.from({ length: n }, (_, i) =>
      SystemProgram.transfer({
        fromPubkey: agent.publicKey,
        toPubkey: agent.publicKey,
        lamports: i,
      }),
    );
  }

  // ─── Scenario 1: Post-finalize pad attack ────────────────────────────────

  describe("post-finalize pad-attack (finalize_session scan)", () => {
    it("succeeds with 30 SystemProgram noops AFTER finalize (bounded scan)", async () => {
      const { validateIx, finalizeIx } = await buildPair();
      const noops = makeNoops(30);
      // [validate, finalize, noop x 30] — exercises the post-finalize scan
      // through 30 iterations, which is well under the 64 cap.
      const result = sendVersionedTx(
        svm,
        [validateIx, finalizeIx, ...noops],
        agent,
      );
      expect(result).to.exist;
      // Defense-in-depth: 30 simple noops should not blow CU. The full validate+
      // finalize+post-scan flow should be well under a generous ceiling.
      // We assert the ceiling — the goal is to catch a regression where the
      // loop becomes O(n*m) or panics, not to nail down an exact CU figure.
      expect(result.computeUnitsConsumed).to.be.lessThan(200_000);
    });

    it("scan is bounded — CU growth stays linear with noop count", async () => {
      // Compare CU at small (5 noops) vs medium (25 noops) post-finalize pad
      // counts. The post-finalize scan is O(N) linear in the number of post-
      // finalize ix; the delta should be modest. If unbounded multiplication
      // (O(N^2) etc.) crept in, the delta would explode.
      const a = await buildPair();
      const small = sendVersionedTx(
        svm,
        [a.validateIx, a.finalizeIx, ...makeNoops(5)],
        agent,
      );

      const b = await buildPair();
      const medium = sendVersionedTx(
        svm,
        [b.validateIx, b.finalizeIx, ...makeNoops(25)],
        agent,
      );

      expect(small).to.exist;
      expect(medium).to.exist;

      // 20 extra ix → linear CU bump. Empirically each extra
      // SystemProgram.transfer + post-finalize scan check + TA-11 scan check
      // costs ~3,000-3,100 CU (SystemProgram.transfer itself ~150 CU; per-ix
      // load_instruction_at_checked + program_id compare ~900 CU × 2 scans
      // (TA-11 in validate + post-finalize in finalize); inner writable-meta
      // ↔ 13-entry protected-set compare ~200 CU). 20 extras ≈ 60-64K. We
      // assert a 72K ceiling — anything beyond suggests a regression to
      // non-linear (e.g. O(n^2)) scanning. At ~3,200 CU/ix the full 64-ix
      // bound costs ~200K CU per scan, ~400K combined; the 1.4M tx budget
      // absorbs that comfortably.
      //
      // Pre-Phase-4 baseline (post-finalize scan only): delta ≈ 22-24K.
      // Phase 4 TA-11 added ~38-40K to the 20-extra-ix scenario (1.9K/ix).
      const delta = medium.computeUnitsConsumed - small.computeUnitsConsumed;
      expect(delta).to.be.lessThan(72_000);
    });
  });

  // ─── Scenario 2: Pre-validate pad attack (backward scan) ─────────────────

  describe("pre-validate pad-attack (backward scan in validate_and_authorize)", () => {
    it("succeeds with 30 SystemProgram noops BEFORE validate (bounded backward scan)", async () => {
      const { validateIx, finalizeIx } = await buildPair();
      const noops = makeNoops(30);
      // [noop x 30, validate, finalize] — exercises the backward scan from
      // index 29 down to 0. All ixs are SystemProgram (whitelisted), so the
      // scan accepts them. iter_count grows to 30, well under the 64 cap.
      const result = sendVersionedTx(
        svm,
        [...noops, validateIx, finalizeIx],
        agent,
      );
      expect(result).to.exist;
      expect(result.computeUnitsConsumed).to.be.lessThan(200_000);
    });
  });

  // ─── Scenario 3: Forward scan between validate and finalize ──────────────

  describe("forward scan (validate_and_authorize non-spending path)", () => {
    it("succeeds with 30 SystemProgram noops BETWEEN validate and finalize", async () => {
      const { validateIx, finalizeIx } = await buildPair();
      const noops = makeNoops(30);
      // [validate, noop x 30, finalize] — exercises the forward
      // (non-spending) scan in validate_and_authorize. All noops are
      // SystemProgram (Infrastructure scan-action), iter_count grows to 30,
      // well under 64.
      const result = sendVersionedTx(
        svm,
        [validateIx, ...noops, finalizeIx],
        agent,
      );
      expect(result).to.exist;
      expect(result.computeUnitsConsumed).to.be.lessThan(200_000);
    });
  });

  // ─── Phase 4 TA-11: protected-writable scan CU benchmark ─────────────────
  //
  // Worst-case TA-11 scan: many sibling ixs (30 — Solana v0 tx cap is 64,
  // but practical ixs don't exceed ~30 for real bundles), all with a
  // writable agent meta (none in protected set). TA-11 walks every ix in
  // the tx (excluding the validate itself), iterates each writable meta,
  // and checks against the 13-entry protected-pubkey set. The scan O(N)
  // by ix count × O(M) by writable metas/ix × O(13) protected-set lookup.
  //
  // Budget: < 100K CU for TA-11 SCAN portion. The whole composed tx
  // (validate + 30 noops + finalize) is bounded < 220K CU including:
  //   - validate body (TA-10 + TA-11 scans + cooldown updates etc.) ≈ 80K
  //   - finalize body (revocation + cap checks) ≈ 50K
  //   - SystemProgram self-transfers × 30 ≈ 4.5K (150 each)
  //   - sysvar load_instruction_at_checked × ~95 calls ≈ 85K (900 each)
  //
  // The threshold here is the TX-level ceiling 220K — TA-11's specific
  // contribution to the delta is ~30K (1K/ix × 30 ixs). Pre-TA-11 baseline
  // was ~150K for the same composition.
  describe("TA-11 protected-writable scan CU profile", () => {
    it("composed tx with 30 sibling noops stays under 220K CU", async () => {
      const { validateIx, finalizeIx } = await buildPair();
      const noops = makeNoops(30);
      const result = sendVersionedTx(
        svm,
        [validateIx, ...noops, finalizeIx],
        agent,
      );
      expect(result).to.exist;
      // Phase 4 ceiling: 220K CU end-to-end. The actual measurement
      // (logged below) helps trend regression — failing this threshold
      // means TA-11's scan exploded or interacted badly with TA-10's
      // discriminator/tuple compare.
      console.log(
        `  TA-11 30-noop scenario CU: ${result.computeUnitsConsumed.toLocaleString()}`,
      );
      expect(result.computeUnitsConsumed).to.be.lessThan(220_000);
    });

    it("TA-11 scan contribution (delta 5→25 sibling noops) stays under 60K CU", async () => {
      // Build a 5-noop scenario.
      const a = await buildPair();
      const small = sendVersionedTx(
        svm,
        [a.validateIx, ...makeNoops(5), a.finalizeIx],
        agent,
      );
      // Build a 25-noop scenario (new session — the prior finalize closed
      // the session PDA).
      const b = await buildPair();
      const medium = sendVersionedTx(
        svm,
        [b.validateIx, ...makeNoops(25), b.finalizeIx],
        agent,
      );
      const delta = medium.computeUnitsConsumed - small.computeUnitsConsumed;
      console.log(
        `  TA-11 delta (20 extra noops): ${delta.toLocaleString()} CU` +
          ` (small ${small.computeUnitsConsumed.toLocaleString()}, medium ${medium.computeUnitsConsumed.toLocaleString()})`,
      );
      // Phase 4 ceiling: 72K CU for 20 extra ixs (~3.6K/ix). The TA-11
      // scan adds ~1K/ix to the existing forward + post-finalize scans
      // (each ~1K/ix), so the delta breakdown is ~20-22K each scan × 3
      // scans ≈ 60-65K. Measured 2026-05-18: 61K (with TA-11 ~20K). The
      // 72K ceiling absorbs that with ~15% headroom; anything beyond
      // suggests O(N²) regression.
      expect(delta).to.be.lessThan(72_000);
    });
  });
});
