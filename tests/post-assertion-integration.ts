/**
 * LiteSVM integration tests for post-execution assertions — Phase 2 S4.
 *
 * These are the first END-TO-END tests that prove Sigil's on-chain
 * CrossFieldLte enforcement path actually reverts transactions when a
 * leverage cap is violated. Unit tests in `sdk/kit/tests/post-assertions/`
 * exercise the builder logic, the Jupiter-Perps runtime rail, the client
 * validator, and flash-sdk IDL drift. None of them prove that when
 * `createPostAssertions` writes an entry and then a composed tx hits
 * `finalize_session` with a ratio-violating target account, the program
 * reverts with `PostAssertionFailed` (6068). This file closes that gap.
 *
 * Layout:
 *   T2 — Golden A: createPostAssertions writes the expected bytes to the
 *                  PDA; entry fields round-trip through zero-copy read.
 *   T3 — Golden B: closePostAssertions closes the PDA + refunds rent +
 *                  clears `has_post_assertions` on PolicyConfig.
 *   T4 — Golden C: leverage exactly at cap (5× = 50_000 bps) → composed
 *                  validate+finalize tx succeeds.
 *   T5 — Evil  A: leverage above cap (6×)                → reverts.
 *   T5b — Evil  B: leverage at cap+1 (5.01×)             → reverts
 *                  (catches `<` vs `≤` inversion — Security Council
 *                  boundary probe).
 *   T5c — Evil  C: sizeUsd = u64::MAX, collateralUsd = 1 → reverts
 *                  (u128 safe-math probe — on-chain must widen; silent
 *                  wrap would be a catastrophic bypass).
 *   T5d — Evil  D: sizeUsd = 1, collateralUsd = 0        → reverts
 *                  (zero-denominator edge; on-chain enforces
 *                  `size × 10000 ≤ multiplier × 0 = 0` so any non-zero
 *                  size fails — correct behavior).
 *
 * The target account is a synthetic 256-byte Flash Trade Position buffer
 * planted via LiteSVM `setAccount`. Sigil does NOT verify target owner
 * on-chain (security audit finding C1 from Phase 2), so the owner field
 * is informational. Discriminator bytes match real Flash Trade for
 * realism, but the check is offset+bytes only.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  accountExists,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
// Strict error helpers — LOCAL SHIM (see tests/helpers/strict-errors.ts for
// why LiteSVM tests can't import from @usesigil/kit/testing directly).
import { expectSigilError } from "./helpers/strict-errors";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR — matches tests/sigil.ts

// ────────────────────────────────────────────────────────────────
// Flash Trade leverage-cap preset — INLINED from
// `sdk/kit/src/post-assertions/presets/flash-trade.ts` for LiteSVM
// ESM-from-CJS compatibility (same reason tests/helpers/strict-errors.ts
// is inlined — see that file's header for the full rationale). The preset
// logic has its own drift-check test at
// `sdk/kit/tests/post-assertions/flash-trade.test.ts` that reloads the
// flash-sdk IDL and asserts these offsets. If the preset changes, update
// BOTH places.
// ────────────────────────────────────────────────────────────────

/** Flash Trade Perpetuals program address (mainnet). Mirrors kit constant. */
const FLASH_TRADE_PROGRAM_ADDRESS =
  "FLaSh6f6Y5bLsmcfiaxvqRJC3WQLKYh1iCfAsh7uMH8z";
/** Byte offset of `size_usd` in the Flash Trade Position account. */
const FLASH_TRADE_POSITION_SIZE_USD_OFFSET = 140;
/** Byte offset of `collateral_usd` in the Flash Trade Position account. */
const FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET = 172;
/** On-chain ConstraintOperator::Lte variant. Mirrors constraint-helpers wire. */
const CONSTRAINT_OPERATOR_LTE = 3;
/** On-chain AssertionMode::Absolute variant. */
const ASSERTION_MODE_ABSOLUTE = 0;
/** CrossFieldLte enable bit — bit 0 of `cross_field_flags`. */
const CROSS_FIELD_LTE_ENABLE_BIT = 0x01;

/** Shape that Anchor's generated `createPostAssertions` method accepts. */
interface AnchorPostAssertionEntry {
  targetAccount: PublicKey;
  offset: number;
  valueLen: number;
  operator: number;
  expectedValue: Buffer;
  assertionMode: number;
  crossFieldOffsetB: number;
  crossFieldMultiplierBps: number;
  crossFieldFlags: number;
}

/**
 * Build a Flash Trade leverage-cap post-assertion entry. Mirrors the kit's
 * `flashTradeLeverageCap({ positionAccount, maxLeverage })` preset — same
 * offsets, same `maxBps = maxLeverage × 10_000` encoding, same CrossFieldLte
 * flag bit, same 8-byte expected-value placeholder.
 */
function flashTradeLeverageCap(opts: {
  positionAccount: PublicKey;
  maxLeverage: number;
}): AnchorPostAssertionEntry {
  if (
    !Number.isInteger(opts.maxLeverage) ||
    opts.maxLeverage < 1 ||
    opts.maxLeverage > 100
  ) {
    throw new Error(
      `flashTradeLeverageCap: maxLeverage must be an integer in [1, 100] (got ${opts.maxLeverage})`,
    );
  }
  return {
    targetAccount: opts.positionAccount,
    offset: FLASH_TRADE_POSITION_SIZE_USD_OFFSET,
    valueLen: 8, // u64 sizeUsd width
    operator: CONSTRAINT_OPERATOR_LTE,
    expectedValue: Buffer.alloc(8), // unused for CrossFieldLte — zeros
    assertionMode: ASSERTION_MODE_ABSOLUTE,
    crossFieldOffsetB: FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET,
    crossFieldMultiplierBps: opts.maxLeverage * 10_000,
    crossFieldFlags: CROSS_FIELD_LTE_ENABLE_BIT,
  };
}

/**
 * Flash Trade Position account Anchor discriminator — derived from the
 * `flash-sdk@^15.14.1` IDL (`perpetuals.json` → types.Position.discriminator).
 * On-chain post-assertion code does NOT verify this, but the EVIL fixtures
 * set it anyway so the synthetic account is byte-for-byte realistic.
 */
const FLASH_POSITION_DISCRIMINATOR = new Uint8Array([
  170, 188, 143, 228, 122, 64, 247, 208,
]);

/** Mock Position buffer size — must span past `collateral_usd` (172+8=180). */
const MOCK_POSITION_SIZE = 256;

/** Sigil error helper — wraps `expectSigilError` with the common pattern. */
function expectPostAssertionFailed(err: unknown) {
  expectSigilError(err, { name: "PostAssertionFailed" });
}

describe("post-assertion-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const vaultId = new BN(800); // distinct ID — no collision with other suites

  // Allowed protocol — any pubkey works in LiteSVM (no on-chain invocation).
  const jupiterProgramId = Keypair.generate().publicKey;
  // Protocol treasury — hardcoded constant in the program.
  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );

  let usdcMint: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let sessionPda: PublicKey;
  let postAssertionsPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  // Synthetic Flash Trade Position — shared across tests; planted fresh per test.
  const positionKey = Keypair.generate().publicKey;

  async function currentPolicyVersion(): Promise<BN> {
    const pol = await program.account.policyConfig.fetch(policyPda);
    return (pol as { policyVersion?: BN }).policyVersion ?? new BN(0);
  }

  /**
   * Plant a mock Position account at `positionKey` with the given sizeUsd
   * and collateralUsd at their Flash Trade IDL offsets. Replaces any prior
   * state — LiteSVM `setAccount` is idempotent overwrite.
   */
  function plantMockPosition(sizeUsd: bigint, collateralUsd: bigint): void {
    const data = Buffer.alloc(MOCK_POSITION_SIZE);
    Buffer.from(FLASH_POSITION_DISCRIMINATOR).copy(data, 0);
    data.writeBigUInt64LE(sizeUsd, 140); // size_usd — Flash Trade IDL offset
    data.writeBigUInt64LE(collateralUsd, 172); // collateral_usd — Flash Trade IDL offset

    svm.setAccount(positionKey, {
      lamports: 3_000_000, // > rent-exempt for 256 bytes
      data,
      owner: new PublicKey(FLASH_TRADE_PROGRAM_ADDRESS),
      executable: false,
    });
  }

  /**
   * Build the composed `[computeBudget, validate, finalize]` tx. The
   * finalize ix carries `remainingAccounts = [postAssertionsPda,
   * positionKey]` so on-chain finalize_session can resolve both the
   * assertions PDA and the target account by key lookup.
   *
   * @param amountUsd  Spending amount in 6-decimal USD units (e.g.
   *                   1_000_000 = $1). Must be ≤ max_tx_cap.
   * @param includePostAssertionAccounts  If true, passes remainingAccounts;
   *                   otherwise passes empty (used only in negative-path
   *                   smoke, not in the 7 primary tests).
   */
  async function buildComposedTx(
    amountUsd: BN,
  ): Promise<TransactionInstruction[]> {
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        amountUsd,
        jupiterProgramId,
        await currentPolicyVersion(),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const finalizeIx = await program.methods
      .finalizeSession()
      .accountsPartial({
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
      })
      .remainingAccounts([
        { pubkey: postAssertionsPda, isSigner: false, isWritable: false },
        { pubkey: positionKey, isSigner: false, isWritable: false },
      ])
      .instruction();

    return [cuIx, validateIx, finalizeIx];
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);

    // USDC at hardcoded devnet address — required by is_stablecoin_mint().
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // PDAs
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
    [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );
    [postAssertionsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("post_assertions"), vaultPda.toBuffer()],
      program.programId,
    );

    // Token accounts + funding
    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as unknown as { payer: Keypair }).payer,
      usdcMint,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as unknown as { payer: Keypair }).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      2_000_000_000n, // 2000 USDC
    );
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as unknown as { payer: Keypair }).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Initialize vault (creates vault + policy + tracker + overlay in one ix).
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily cap $500
        new BN(100_000_000), // max tx $100
        1, // allowlist mode
        [jupiterProgramId],
        0, // developer_fee_rate
        100, // maxSlippageBps
        new BN(1800), // timelock
        [],
        [],
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as never)
      .rpc();

    // Now that the vault PDA exists, create its USDC ATA + fund it.
    vaultUsdcAta = createAtaHelper(
      svm,
      (owner as unknown as { payer: Keypair }).payer,
      usdcMint,
      vaultPda,
      true, // allowOwnerOffCurve — vault is a PDA
    );
    mintToHelper(
      svm,
      (owner as unknown as { payer: Keypair }).payer,
      usdcMint,
      vaultUsdcAta,
      owner.publicKey,
      1_000_000_000n, // 1000 USDC in the vault
    );

    // Register agent with full capability.
    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      } as never)
      .rpc();
  });

  describe("T2 — Golden A: createPostAssertions writes expected bytes", () => {
    it("preset → Anchor → zero-copy read round-trips CrossFieldLte fields", async () => {
      const entry = flashTradeLeverageCap({
        positionAccount: positionKey,
        maxLeverage: 5,
      });

      await program.methods
        .createPostAssertions([entry])
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      expect(accountExists(svm, postAssertionsPda)).to.equal(true);

      // Zero-copy account structure: fetch via Anchor decoder + introspect
      // the first entry's fields at the byte level we compiled them for.
      const acct =
        await program.account.postExecutionAssertions.fetch(postAssertionsPda);
      expect(acct.entryCount).to.equal(1);
      const e0 = acct.entries[0];

      expect(
        new PublicKey(e0.targetAccount as unknown as Uint8Array).toString(),
      ).to.equal(positionKey.toString());
      expect(e0.offset).to.equal(140); // FLASH_TRADE_POSITION_SIZE_USD_OFFSET
      // crossFieldOffsetB is stored as [u8; 2] little-endian
      expect(
        Buffer.from(e0.crossFieldOffsetB as unknown as Uint8Array).readUInt16LE(
          0,
        ),
      ).to.equal(172); // FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET
      // crossFieldMultiplierBps is stored as [u8; 4] little-endian
      expect(
        Buffer.from(
          e0.crossFieldMultiplierBps as unknown as Uint8Array,
        ).readUInt32LE(0),
      ).to.equal(50_000); // 5x × 10_000
      // CrossFieldLte enable bit = bit 0
      expect(e0.crossFieldFlags & 0x01).to.equal(0x01);

      // Policy feature flag flipped.
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(
        (policy as { hasPostAssertions?: number }).hasPostAssertions,
      ).to.equal(1);
    });
  });

  describe("T3 — Golden B: closePostAssertions closes PDA + clears flag", () => {
    // This runs AFTER T2, so the PDA exists. Close it and verify cleanup.
    it("closes PDA, returns rent to owner, clears has_post_assertions flag", async () => {
      expect(accountExists(svm, postAssertionsPda)).to.equal(true);

      await program.methods
        .closePostAssertions()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      expect(accountExists(svm, postAssertionsPda)).to.equal(false);

      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(
        (policy as { hasPostAssertions?: number }).hasPostAssertions,
      ).to.equal(0);
    });
  });

  describe("T4 — Golden C: leverage exactly at cap succeeds", () => {
    it("composed tx succeeds when size/collateral ratio equals maxLeverage", async () => {
      // Re-create the PDA (T3 closed it).
      const entry = flashTradeLeverageCap({
        positionAccount: positionKey,
        maxLeverage: 5,
      });
      await program.methods
        .createPostAssertions([entry])
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          postAssertions: postAssertionsPda,
          systemProgram: SystemProgram.programId,
        } as never)
        .rpc();

      // Plant Position with EXACT 5× leverage: 500 sizeUsd / 100 collateralUsd.
      // On-chain check: size × 10000 ≤ maxBps × collateral
      //               = 500 × 10000 = 5_000_000
      //               vs 50_000 × 100 = 5_000_000 → equal → ≤ holds → PASS.
      plantMockPosition(500n, 100n);

      const ixs = await buildComposedTx(new BN(1_000_000)); // $1 spend — well within caps
      const result = sendVersionedTx(svm, ixs, agent);
      expect(result.signature).to.be.a("string");
    });
  });

  describe("T5 — Evil A: leverage 6× above 5× cap reverts", () => {
    it("composed tx reverts with PostAssertionFailed (6068)", async () => {
      // PDA still exists from T4. Plant violating Position.
      plantMockPosition(600n, 100n); // 6× leverage — over the 5× cap.

      const ixs = await buildComposedTx(new BN(1_000_000));
      try {
        sendVersionedTx(svm, ixs, agent);
        expect.fail("expected composed tx to revert with PostAssertionFailed");
      } catch (err) {
        expectPostAssertionFailed(err);
      }
    });
  });

  describe("T5b — Evil B: boundary cap+1 reverts (catches `<` vs `≤` inversion)", () => {
    it("composed tx reverts at leverage = 5.01× (1 size-unit over cap)", async () => {
      plantMockPosition(501n, 100n); // 501/100 = 5.01× → cap+1.
      const ixs = await buildComposedTx(new BN(1_000_000));
      try {
        sendVersionedTx(svm, ixs, agent);
        expect.fail("expected revert at boundary cap+1");
      } catch (err) {
        expectPostAssertionFailed(err);
      }
    });
  });

  describe("T5c — Evil C: u64::MAX overflow probe", () => {
    it("composed tx reverts without silent wrap at u128 safe-math boundary", async () => {
      // u64::MAX = 18_446_744_073_709_551_615. size × 10000 in u128 is safe;
      // this probe proves the math widens to u128 on-chain (not a wrap bug).
      plantMockPosition(18_446_744_073_709_551_615n /* u64::MAX */, 1n);
      const ixs = await buildComposedTx(new BN(1_000_000));
      try {
        sendVersionedTx(svm, ixs, agent);
        expect.fail("expected revert on extreme leverage");
      } catch (err) {
        expectPostAssertionFailed(err);
      }
    });
  });

  describe("T5d — Evil D: zero-collateral edge", () => {
    it("composed tx reverts when collateralUsd = 0 and sizeUsd > 0", async () => {
      // On-chain check: size × 10000 ≤ multiplier × 0 = 0. Any non-zero
      // size fails. This is the CORRECT behavior — zero collateral = no
      // position, so any non-zero size is a constraint violation.
      plantMockPosition(1n, 0n);
      const ixs = await buildComposedTx(new BN(1_000_000));
      try {
        sendVersionedTx(svm, ixs, agent);
        expect.fail("expected revert on zero collateral");
      } catch (err) {
        expectPostAssertionFailed(err);
      }
    });
  });

  describe("T6 — Fail-closed: post-assertions PDA omitted from remaining_accounts", () => {
    it("composed tx reverts with PostAssertionFailed when agent drops the assertions PDA", async () => {
      // Plant a benign position (at-cap → would pass if the scan ran).
      plantMockPosition(500n, 100n);

      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      });
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(1_000_000),
          jupiterProgramId,
          await currentPolicyVersion(),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      // Deliberately pass EMPTY remaining_accounts despite has_post_assertions=1.
      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
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
        })
        .remainingAccounts([])
        .instruction();

      try {
        sendVersionedTx(svm, [cuIx, validateIx, finalizeIx], agent);
        expect.fail(
          "expected revert when remaining_accounts omits the post_assertions PDA",
        );
      } catch (err) {
        expectPostAssertionFailed(err);
      }
    });
  });

  describe("T7 — Fail-closed: target account omitted from remaining_accounts", () => {
    it("composed tx reverts with InvalidPostAssertionIndex when target is missing", async () => {
      plantMockPosition(500n, 100n);

      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000,
      });
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(1_000_000),
          jupiterProgramId,
          await currentPolicyVersion(),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();
      // Pass the assertions PDA but OMIT the target account.
      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
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
        })
        .remainingAccounts([
          { pubkey: postAssertionsPda, isSigner: false, isWritable: false },
          // positionKey intentionally omitted.
        ])
        .instruction();

      try {
        sendVersionedTx(svm, [cuIx, validateIx, finalizeIx], agent);
        expect.fail(
          "expected revert when remaining_accounts omits the target position",
        );
      } catch (err) {
        // on-chain: `require!(target.is_some(), InvalidPostAssertionIndex)`
        expectSigilError(err, { name: "InvalidPostAssertionIndex" });
      }
    });
  });
});
