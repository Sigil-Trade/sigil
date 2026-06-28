import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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
const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const CU_JUPITER_SWAP = 600_000;

interface JupiterSerializedInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

function deserializeInstruction(
  ix: JupiterSerializedInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}
import {
  createTestEnv,
  airdropSol,
  createMintHelper,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  sendVersionedTx,
  VersionedTxResult,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
  FailedTransactionMetadata,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "./helpers/litesvm-setup";
import { expectSigilError } from "./helpers/strict-errors";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

/**
 * Jupiter Integration Tests
 *
 * These tests verify that Jupiter swap instructions can be correctly composed
 * into Sigil's atomic [validate, ...defi, finalize] transactions.
 *
 * Since the on-chain program does not inspect DeFi instruction contents — it
 * only validates policy in validate_and_authorize and records the result in
 * finalize_session — we use a no-op TransactionInstruction as a mock swap.
 */
describe("jupiter-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  // Test actors
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  // Token mints
  let usdcMint: PublicKey;
  let solMint: PublicKey; // disallowed token for testing

  // Jupiter protocol ID used as the "allowed protocol" in policy
  const jupiterProtocol = JUPITER_PROGRAM_ID;
  // F-Q2: spending sandwiches now require EXACTLY ONE counted DeFi instruction.
  // The mock swap must therefore be a real, allowlisted, counted DeFi ix —
  // mock-defi's no-op open_position on MOCK_DEFI_PROGRAM_ID. Both the executed
  // ix AND the authorized target_protocol must be this program (else
  // ProtocolMismatch); the vault allowlists it alongside jupiterProtocol.
  const mockDefiProtocol = MOCK_DEFI_PROGRAM_ID;

  // Vault for happy-path tests
  const vaultId = new BN(100);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  // Token accounts
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  /**
   * Create a mock DeFi instruction that mimics what Jupiter would produce.
   * Uses SystemProgram as the program ID since the real Jupiter program
   * doesn't exist on localnet. The on-chain Sigil program doesn't
   * inspect the DeFi instruction — it only validates policy in
   * validate_and_authorize and records the result in finalize_session.
   *
   * F-Q2: the middle ix must be a COUNTED DeFi instruction (one that reaches
   * the protocol-allowlist match in validate_and_authorize's spending scan),
   * so we use mock-defi's no-op open_position on MOCK_DEFI_PROGRAM_ID. It moves
   * zero tokens (preserving the outcome-based premise that actual spend = 0)
   * while satisfying the exactly-one-DeFi-ix rule. A SystemProgram no-op is
   * Infrastructure → not counted → would now fail TooManyDeFiInstructions.
   */
  function createMockSwapInstruction(payer: PublicKey): TransactionInstruction {
    return buildMockDefiNoopIx(payer);
  }

  /**
   * Helper: build and send an atomic composed transaction via LiteSVM.
   * [ComputeBudget, ValidateAndAuthorize, mockSwapIx, FinalizeSession]
   */
  async function sendComposedSwap(
    vault: PublicKey,
    policy: PublicKey,
    tracker: PublicKey,
    agentKp: Keypair,
    tokenMint: PublicKey,
    amount: BN,
    targetProtocol: PublicKey,
    overrideVaultTokenAta?: PublicKey,
  ): Promise<VersionedTxResult> {
    const effectiveVaultAta = overrideVaultTokenAta ?? vaultUsdcAta;

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
      units: CU_JUPITER_SWAP,
    });

    // Derive overlay PDA for this vault
    const [overlayForVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // 2. Validate and authorize
    // Fetch live policy version for expected_policy_version arg (TOCTOU guard)
    const livePolicy = await program.account.policyConfig.fetch(policy);
    const validateIx = await program.methods
      .validateAndAuthorize(
        tokenMint,
        amount,
        targetProtocol,
        livePolicy.policyVersion,
        new BN(0),
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
        session,
        agentSpendOverlay: overlayForVault,
        vaultTokenAccount: effectiveVaultAta,
        tokenMintAccount: tokenMint,
        outputStablecoinAccount: program.programId,
        outputSwapAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      // F-Q1a completeness: the mock-defi no-op ix lists the agent signer, and
      // the agent is the writable fee-payer in the compiled v0 message. validate's
      // destination-completeness guard reads writability from the compiled message
      // and requires every writable DeFi meta resolvable in remaining_accounts,
      // so the agent must be appended (mirrors seal()).
      .remainingAccounts([
        { pubkey: agentKp.publicKey, isSigner: false, isWritable: false },
      ])
      .instruction();

    // 3. Mock DeFi instruction (would be Jupiter swap in production)
    const mockSwapIx = createMockSwapInstruction(agentKp.publicKey);

    // 4. Finalize session
    const finalizeIx = await program.methods
      .finalizeSession()
      .accountsPartial({
        // C-1 fix: relocated fee accounts (protocol treasury + dev fee dest).
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        payer: agentKp.publicKey,
        vault,
        session,
        sessionRentRecipient: agentKp.publicKey,
        policy,
        tracker,
        agentSpendOverlay: overlayForVault,
        vaultTokenAccount: effectiveVaultAta,
        outputStablecoinAccount: program.programId,
        outputSwapAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Build and send versioned transaction via LiteSVM
    const result = sendVersionedTx(
      svm,
      [computeIx, validateIx, mockSwapIx, finalizeIx],
      agentKp,
    );
    recordCU("jupiter:composed_swap", result);
    return result;
  }

  after(() => printCUSummary());

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Airdrop to test accounts — extra SOL for owner (larger PolicyConfig accounts)
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC mint at hardcoded devnet address (required by is_stablecoin_mint)
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Create disallowed token mint
    solMint = createMintHelper(svm, (owner as any).payer, owner.publicKey, 9);

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

    // Create protocol treasury ATA (needed for fee transfers)
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Initialize vault
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(200_000_000),
        1,
        [jupiterProtocol, mockDefiProtocol],
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
          protocols: [jupiterProtocol, mockDefiProtocol],
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

    // Register agent (OPERATOR on single-key vault → timelocked queue→apply, F-Q6)
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

    // Derive vault ATA and deposit
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    await program.methods
      .depositFunds(new BN(500_000_000)) // 500 USDC
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
  // Happy path: composed Jupiter swap
  // =========================================================================
  describe("composed swap happy path", () => {
    it("executes a composed [validate, mock_swap, finalize] transaction", async () => {
      // This test exercises the composed-sandwich MECHANISM and the
      // total_transactions counter — not a measurable spend (it asserts
      // totalVolume == 0). The require-measurable-outcome invariant (err 6115)
      // exempts non-spending sessions, so run a non-spending session (amount =
      // 0): the [validate, mock_defi, finalize] sandwich still executes,
      // total_transactions still increments to 1, and totalVolume stays 0 — all
      // assertions below are preserved unchanged.
      const amount = new BN(0);

      const sig = await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        mockDefiProtocol,
      );

      expect(sig.signature).to.be.a("string");

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume uses actual_spend_tracked; mock DeFi is no-op → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });

    it("records multiple composed swaps correctly", async () => {
      // Mechanism + counter test (asserts totalVolume == 0). Non-spending
      // session (amount = 0) is exempt from the require-measurable-outcome
      // invariant; total_transactions still advances to 2 and totalVolume stays
      // 0, preserving both assertions.
      const amount = new BN(0);

      await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        mockDefiProtocol,
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      // Mock DeFi no-ops: cumulative actual spend = 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // =========================================================================
  // Outcome-based spending: mock swaps record zero actual spend
  // =========================================================================
  describe("zero-outcome spending session is rejected (require-measurable-outcome)", () => {
    it("reverts a spending session that moves no tokens with ErrUnmeasurableSpend (6115)", async () => {
      // Migration of the former "declared amount exceeds cap because actual
      // spend is zero (outcome-based)" test. Its premise — a SPENDING session
      // (amount > 0) whose mock swap moves zero tokens settles successfully and
      // never binds the cap — is exactly the cap-accounting slip the
      // require-measurable-outcome invariant (err 6115) closes. A spending
      // session that produces no measurable vault outcome (no stablecoin
      // movement AND no declared acquisition) now REVERTS. The original
      // assertion ("succeeds") tested behavior that no longer exists; the
      // faithful migration asserts the new behavior for that exact input.
      try {
        await sendComposedSwap(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(200_000_000),
          mockDefiProtocol,
        );
        expect.fail(
          "Expected zero-outcome spending session to revert ErrUnmeasurableSpend",
        );
      } catch (err: any) {
        if (err?.message === "Should have thrown") throw err;
        expectSigilError(err, { name: "ErrUnmeasurableSpend" });
      }
    });
  });

  // =========================================================================
  // Error: disallowed token
  // =========================================================================
  describe("disallowed token", () => {
    it("reverts when token is not in policy allowlist", async () => {
      // Create vault ATA for solMint so Anchor account validation passes,
      // allowing the handler's UnsupportedToken check to fire.
      const vaultSolAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        solMint,
        vaultPda,
        true, // allowOwnerOffCurve — vault is a PDA
      );
      try {
        await sendComposedSwap(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          solMint, // not registered as allowed token
          new BN(1_000_000),
          jupiterProtocol,
          vaultSolAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // Non-stablecoin token without output_stablecoin_account → InvalidTokenAccount
        expect(err.message || err.toString()).to.satisfy(
          (s: string) =>
            s.includes("InvalidTokenAccount") || s.includes("UnsupportedToken"),
        );
      }
    });
  });

  // =========================================================================
  // Error: disallowed protocol
  // =========================================================================
  describe("disallowed protocol", () => {
    it("reverts when protocol is not in policy allowlist", async () => {
      const fakeProtocol = Keypair.generate().publicKey;

      try {
        await sendComposedSwap(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(1_000_000),
          fakeProtocol, // not in allowed_protocols
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
    const frozenVaultId = new BN(101);
    let frozenVault: PublicKey;
    let frozenPolicy: PublicKey;
    let frozenTracker: PublicKey;

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

      const [frozenOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), frozenVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Create and freeze vault
      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(500_000_000),
          new BN(200_000_000),
          1,
          [jupiterProtocol, mockDefiProtocol],
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
            protocols: [jupiterProtocol, mockDefiProtocol],
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

      // Freeze it
      await program.methods
        .revokeAgent(agent.publicKey)
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          agentSpendOverlay: frozenOverlay,
        })
        .rpc();

      // Verify frozen immediately
      const checkVault = await program.account.agentVault.fetch(frozenVault);
      if (!checkVault.status.hasOwnProperty("frozen")) {
        throw new Error(
          `Vault 101 should be frozen but is: ${JSON.stringify(checkVault.status)}`,
        );
      }
    });

    it("reverts entire TX when vault is frozen", async () => {
      // Verify vault is actually frozen before testing
      const vaultState = await program.account.agentVault.fetch(frozenVault);
      expect(vaultState.status).to.have.property("frozen");

      // Create vault ATA so Anchor account validation passes
      const frozenVaultAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        frozenVault,
        true, // allowOwnerOffCurve — vault is a PDA
      );

      try {
        await sendComposedSwap(
          frozenVault,
          frozenPolicy,
          frozenTracker,
          agent,
          usdcMint,
          new BN(1_000_000),
          jupiterProtocol,
          frozenVaultAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // revoke_agent clears the agent key, so is_agent() constraint fails
        // before the handler's VaultNotActive check can run.
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
  // Rolling window: multiple swaps under cap, then one that exceeds
  // =========================================================================
  describe("rolling window spending", () => {
    const rollingVaultId = new BN(102);
    let rollingVault: PublicKey;
    let rollingPolicy: PublicKey;
    let rollingTracker: PublicKey;
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

      const [rollingOverlay] = PublicKey.findProgramAddressSync(
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
          [jupiterProtocol, mockDefiProtocol],
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
            protocols: [jupiterProtocol, mockDefiProtocol],
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

      // Deposit USDC into rolling vault (needed for protocol fee transfers)
      rollingVaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        rollingVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(200_000_000)) // 200 USDC
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

    it("rejects a zero-outcome spending swap with ErrUnmeasurableSpend (6115)", async () => {
      // Migration of the former "all swaps succeed with outcome-based
      // enforcement (mock swaps = zero spend)" test. The premise that a
      // SPENDING session (amount > 0) moving zero tokens settles successfully —
      // never binding the rolling-window cap — is the cap-accounting slip the
      // require-measurable-outcome invariant (err 6115) now closes. A spending
      // session with no measurable vault outcome REVERTS instead.

      // Verify agent is registered (setup precondition unchanged).
      const vaultState = await program.account.agentVault.fetch(rollingVault);
      expect(vaultState.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
        "Agent should be registered for rolling window vault",
      );

      // 40 USDC declared, zero tokens moved by the mock swap → no measurable
      // outcome → revert.
      try {
        await sendComposedSwap(
          rollingVault,
          rollingPolicy,
          rollingTracker,
          agent,
          usdcMint,
          new BN(40_000_000),
          mockDefiProtocol,
          rollingVaultUsdcAta,
        );
        expect.fail(
          "Expected zero-outcome spending swap to revert ErrUnmeasurableSpend",
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

  // =========================================================================
  // deserializeInstruction utility
  // =========================================================================
  describe("deserializeInstruction", () => {
    it("correctly deserializes a Jupiter serialized instruction", () => {
      const data = Buffer.from([1, 2, 3, 4]);
      const key1 = Keypair.generate().publicKey;
      const key2 = Keypair.generate().publicKey;

      const serialized = {
        programId: jupiterProtocol.toBase58(),
        accounts: [
          { pubkey: key1.toBase58(), isSigner: true, isWritable: true },
          { pubkey: key2.toBase58(), isSigner: false, isWritable: false },
        ],
        data: data.toString("base64"),
      };

      const ix = deserializeInstruction(serialized);

      expect(ix.programId.toBase58()).to.equal(jupiterProtocol.toBase58());
      expect(ix.keys.length).to.equal(2);
      expect(ix.keys[0].pubkey.toBase58()).to.equal(key1.toBase58());
      expect(ix.keys[0].isSigner).to.equal(true);
      expect(ix.keys[0].isWritable).to.equal(true);
      expect(ix.keys[1].pubkey.toBase58()).to.equal(key2.toBase58());
      expect(ix.keys[1].isSigner).to.equal(false);
      expect(ix.keys[1].isWritable).to.equal(false);
      expect(Buffer.compare(ix.data, data)).to.equal(0);
    });
  });
});
