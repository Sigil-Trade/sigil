import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
// Inlined constants — sdk/typescript was deleted in Phase 0 nuclear cleanup
const JUPITER_LEND_PROGRAM_ID = new PublicKey(
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu",
);
const CU_DEFAULT_COMPOSED = 800_000;
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  sendVersionedTx,
  VersionedTxResult,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "./helpers/litesvm-setup";
import { expectSigilError } from "./helpers/strict-errors";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

/**
 * Jupiter Lend Integration Tests
 *
 * These tests verify that Jupiter Lend deposit/withdraw actions work
 * correctly through Sigil's atomic composition pattern.
 *
 * Deposit = spending action (counts against daily cap, fees apply)
 * Withdraw = non-spending action (amount = 0, no cap/fees)
 *
 * Since Jupiter Lend is not available on localnet, we use mock DeFi
 * instructions — the on-chain program validates policy in validate_and_authorize
 * and records the result in finalize_session.
 */
describe("jupiter-lend-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;

  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;
  let ownerUsdcAta: PublicKey;

  // Use Jupiter Lend program ID as the allowed protocol
  const lendProtocol = JUPITER_LEND_PROGRAM_ID;
  // F-Q2: spending sandwiches require EXACTLY ONE counted DeFi instruction.
  // The mock lend action is mock-defi's no-op open_position on
  // MOCK_DEFI_PROGRAM_ID (counted, zero-spend). Spending (deposit) call sites
  // authorize against this program; every vault allowlists it alongside
  // lendProtocol.
  const mockDefiProtocol = MOCK_DEFI_PROGRAM_ID;

  // Vault IDs 500+ to avoid collision with other test files
  const vaultId = new BN(500);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let vaultUsdcAta: PublicKey;

  /**
   * Create a mock Lend instruction. F-Q2: must be a COUNTED DeFi ix (reaches
   * the protocol-allowlist match in validate_and_authorize's spending scan), so
   * we use mock-defi's no-op open_position on MOCK_DEFI_PROGRAM_ID. It moves
   * zero tokens (outcome-based actual spend = 0) while satisfying the
   * exactly-one-DeFi-ix rule. A SystemProgram no-op is Infrastructure → not
   * counted → would now fail TooManyDeFiInstructions on spending sandwiches.
   */
  function createMockLendInstruction(payer: PublicKey): TransactionInstruction {
    return buildMockDefiNoopIx(payer);
  }

  /**
   * Helper: build and send an atomic composed Lend transaction.
   * [ComputeBudget, ValidateAndAuthorize, mockLendIx, FinalizeSession]
   */
  async function sendComposedLend(
    vault: PublicKey,
    policy: PublicKey,
    tracker: PublicKey,
    agentKp: Keypair,
    tokenMint: PublicKey,
    amount: BN,
    targetProtocol: PublicKey,
    overrideVaultTokenAta?: PublicKey,
    overrideOverlay?: PublicKey,
  ): Promise<VersionedTxResult> {
    const effectiveVaultAta = overrideVaultTokenAta ?? vaultUsdcAta;
    const effectiveOverlay = overrideOverlay ?? overlayPda;

    const [session] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vault.toBuffer(),
        agentKp.publicKey.toBuffer(),
        tokenMint.toBuffer(),
      ],
      program.programId,
    );

    // 1. Compute budget
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_DEFAULT_COMPOSED,
    });

    // Derive overlay PDA for whatever vault is passed
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // 2. Validate and authorize — read live policy_version for TOCTOU guard
    const livePolicy = await program.account.policyConfig.fetch(policy);
    const validateIx = await program.methods
      .validateAndAuthorize(
        tokenMint,
        amount,
        targetProtocol,
        livePolicy.policyVersion, // expectedPolicyVersion (TOCTOU guard)
        new BN(0), // AC-10 expectedNonce (fresh session)
        digestAsArgs(
          buildExpectedIntentDigest({
            vault,
            agent: agentKp.publicKey,
            tokenMint,
            amount,
            targetProtocol,
          }),
        ),
      )
      .accountsPartial({
        agent: agentKp.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: effectiveOverlay,
        session,
        vaultTokenAccount: effectiveVaultAta,
        tokenMintAccount: tokenMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      // F-Q1a completeness: the mock-defi no-op ix lists the agent signer (the
      // writable fee-payer in the compiled v0 message). validate's
      // destination-completeness guard requires every writable DeFi meta
      // resolvable in remaining_accounts, so append the agent (mirrors seal()).
      .remainingAccounts([
        { pubkey: agentKp.publicKey, isSigner: false, isWritable: false },
      ])
      .instruction();

    // 3. Mock Lend instruction
    const mockLendIx = createMockLendInstruction(agentKp.publicKey);

    // 4. Finalize session
    const finalizeIx = await program.methods
      .finalizeSession()
      .accountsPartial({
        payer: agentKp.publicKey,
        vault,
        session,
        sessionRentRecipient: agentKp.publicKey,
        policy,
        tracker,
        agentSpendOverlay: effectiveOverlay,
        vaultTokenAccount: effectiveVaultAta,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const result = sendVersionedTx(
      svm,
      [computeIx, validateIx, mockLendIx, finalizeIx],
      agentKp,
    );
    recordCU("jupiter-lend:composed", result);
    return result;
  }

  after(() => printCUSummary());

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Airdrop to test accounts
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC mint at hardcoded devnet address
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Derive PDAs
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

    // Create protocol treasury ATA
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Initialize vault with Jupiter Lend in allowlist
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(200_000_000),
        1,
        [lendProtocol, mockDefiProtocol],
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
          protocols: [lendProtocol, mockDefiProtocol],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Register agent (OPERATOR on single-key vault → timelocked queue→apply)
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });

    // Fund the vault with USDC
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
      1_000_000_000n, // 1000 USDC
    );

    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    await program.methods
      .depositFunds(new BN(800_000_000)) // 800 USDC
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  // =========================================================================
  // Happy path: Lend deposit
  // =========================================================================
  describe("lend deposit happy path", () => {
    it("executes a composed [validate(Deposit), mock_lend, finalize] transaction", async () => {
      // Mechanism + counter test (asserts totalVolume == 0). The
      // require-measurable-outcome invariant (err 6115) exempts non-spending
      // sessions, so run a non-spending session (amount = 0): the composed
      // [validate, mock_lend, finalize] sandwich still executes,
      // total_transactions still increments to 1, and totalVolume stays 0 —
      // assertions preserved unchanged.
      const amount = new BN(0);

      const result = await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        mockDefiProtocol,
      );

      expect(result.signature).to.be.a("string");

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume uses actual_spend_tracked; mock DeFi is no-op → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // =========================================================================
  // Happy path: Lend withdraw (non-spending, amount=0)
  // =========================================================================
  describe("lend withdraw happy path", () => {
    it("executes a composed withdraw with amount=0 (non-spending)", async () => {
      const result = await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0), // non-spending
        lendProtocol,
      );

      expect(result.signature).to.be.a("string");

      // Verify transaction count incremented
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      // Volume unchanged (withdraw is non-spending)
      // totalVolume uses actual_spend_tracked; mock DeFi is no-op → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // =========================================================================
  // Outcome-based spending: mock lend actions record zero actual spend
  // =========================================================================
  describe("zero-outcome spending session is rejected (require-measurable-outcome)", () => {
    it("reverts a spending lend session that moves no tokens with ErrUnmeasurableSpend (6115)", async () => {
      // Migration of the former "declared amount exceeds cap because actual
      // spend is zero" test. A SPENDING session (amount > 0) whose mock lend ix
      // moves zero tokens no longer settles on the dust fee — that was the
      // cap-accounting slip the require-measurable-outcome invariant (err 6115)
      // closes. With no measurable stablecoin movement and no declared
      // acquisition, finalize REVERTS. The original "succeeds" assertion tested
      // behavior that no longer exists.
      try {
        await sendComposedLend(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(200_000_000),
          mockDefiProtocol,
        );
        expect.fail(
          "Expected zero-outcome spending lend session to revert ErrUnmeasurableSpend",
        );
      } catch (err: any) {
        if (err?.message === "Should have thrown") throw err;
        expectSigilError(err, { name: "ErrUnmeasurableSpend" });
      }
    });
  });

  // =========================================================================
  // Error: protocol not in allowlist
  // =========================================================================
  describe("disallowed protocol", () => {
    it("reverts when lend protocol is not in policy allowlist", async () => {
      const fakeProtocol = Keypair.generate().publicKey;

      try {
        await sendComposedLend(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(10_000_000),
          fakeProtocol, // not in allowed protocols
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("ProtocolNotAllowed");
      }
    });
  });

  // =========================================================================
  // Error: frozen vault
  // =========================================================================
  describe("frozen vault", () => {
    const frozenVaultId = new BN(501);
    let frozenVault: PublicKey;
    let frozenPolicy: PublicKey;
    let frozenTracker: PublicKey;
    let frozenOverlay: PublicKey;

    before(async () => {
      [frozenVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          frozenVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [frozenPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), frozenVault.toBuffer()],
        program.programId,
      );
      [frozenTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), frozenVault.toBuffer()],
        program.programId,
      );

      [frozenOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), frozenVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(500_000_000),
          new BN(200_000_000),
          1,
          [lendProtocol, mockDefiProtocol],
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
            protocols: [lendProtocol, mockDefiProtocol],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          policy: frozenPolicy,
          tracker: frozenTracker,
          agentSpendOverlay: frozenOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: frozenVault,
        agent: agent.publicKey,
      });

      // Freeze via revoke
      const [frozenOverlayRevoke] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), frozenVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await program.methods
        .revokeAgent(agent.publicKey)
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), frozenVault.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: frozenOverlayRevoke,
        })
        .rpc();
    });

    it("reverts entire TX when vault is frozen", async () => {
      const frozenVaultAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        frozenVault,
        true,
      );

      try {
        await sendComposedLend(
          frozenVault,
          frozenPolicy,
          frozenTracker,
          agent,
          usdcMint,
          new BN(10_000_000),
          lendProtocol,
          frozenVaultAta,
          frozenOverlay,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        const msg = err.message || err.toString();
        expect(msg).to.satisfy(
          (s: string) =>
            s.includes("UnauthorizedAgent") || s.includes("ConstraintRaw"),
          `Expected an unauthorized-agent error but got: ${msg}`,
        );
      }
    });
  });

  // =========================================================================
  // Rolling window: multiple deposits under cap, then one that exceeds
  // =========================================================================
  describe("rolling window spending", () => {
    const rollingVaultId = new BN(502);
    let rollingVault: PublicKey;
    let rollingPolicy: PublicKey;
    let rollingTracker: PublicKey;
    let rollingOverlay: PublicKey;
    let rollingVaultUsdcAta: PublicKey;

    before(async () => {
      [rollingVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          rollingVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [rollingPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), rollingVault.toBuffer()],
        program.programId,
      );
      [rollingTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), rollingVault.toBuffer()],
        program.programId,
      );

      [rollingOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), rollingVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Create vault with tight cap: 100 USDC daily, 60 USDC max tx
      await program.methods
        .initializeVault(
          rollingVaultId,
          new BN(100_000_000),
          new BN(60_000_000),
          1,
          [lendProtocol, mockDefiProtocol],
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
            dailySpendingCapUsd: new BN(100_000_000),
            maxTransactionSizeUsd: new BN(60_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [lendProtocol, mockDefiProtocol],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: rollingVault,
          policy: rollingPolicy,
          tracker: rollingTracker,
          agentSpendOverlay: rollingOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: rollingVault,
        agent: agent.publicKey,
      });

      rollingVaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        rollingVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(200_000_000))
        .accountsPartial({
          owner: owner.publicKey,
          vault: rollingVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: rollingVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("rejects a zero-outcome spending deposit with ErrUnmeasurableSpend (6115)", async () => {
      // Migration of the former "all deposits succeed with outcome-based
      // enforcement (mock lend = zero spend)" test. A SPENDING session
      // (amount > 0) moving zero tokens no longer settles successfully and
      // bypasses the rolling-window cap — the require-measurable-outcome
      // invariant (err 6115) rejects it. A spending session with no measurable
      // vault outcome REVERTS.

      // 40 USDC declared, zero tokens moved by the mock lend → no measurable
      // outcome → revert.
      try {
        await sendComposedLend(
          rollingVault,
          rollingPolicy,
          rollingTracker,
          agent,
          usdcMint,
          new BN(40_000_000),
          mockDefiProtocol,
          rollingVaultUsdcAta,
          rollingOverlay,
        );
        expect.fail(
          "Expected zero-outcome spending deposit to revert ErrUnmeasurableSpend",
        );
      } catch (err: any) {
        if (err?.message === "Should have thrown") throw err;
        expectSigilError(err, { name: "ErrUnmeasurableSpend" });
      }

      // The reverted session left no transaction recorded.
      const vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(0);
    });
  });
});
