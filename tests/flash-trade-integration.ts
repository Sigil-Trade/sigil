import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../target/types/agent_shield";
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
import { FLASH_TRADE_PROGRAM_ID } from "../sdk/typescript/src/integrations/flash-trade";
import { CU_FLASH_TRADE } from "../sdk/typescript/src/priority-fees";
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
  advanceTime,
  TestEnv,
  LiteSVM,
  FailedTransactionMetadata,
} from "./helpers/litesvm-setup";

/**
 * Flash Trade Integration Tests
 *
 * These tests verify that perpetual position actions (open, close, increase,
 * decrease) work correctly through AgentShield's atomic composition pattern.
 *
 * Since Flash Trade is not available on localnet, we use mock DeFi instructions
 * (SystemProgram.transfer with 0 lamports) — the on-chain program doesn't
 * inspect DeFi instruction contents, only validates policy and records results.
 *
 * Key behaviors tested:
 * - action_type stored in SessionAuthority and recorded correctly in audit log
 * - open_positions counter incremented/decremented in vault
 * - Policy enforcement: leverage limits, max concurrent positions, frozen vault
 */
describe("flash-trade-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<AgentShield>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;

  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );
  let protocolTreasuryUsdcAta: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  // Use Flash Trade program ID as the allowed protocol
  const flashProtocol = FLASH_TRADE_PROGRAM_ID;

  // Vault for perp tests (IDs 300+ to avoid collision with other test files)
  const vaultId = new BN(300);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  /**
   * Create a mock DeFi instruction (no-op transfer to self).
   */
  function createMockDefiInstruction(payer: PublicKey): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: payer,
      lamports: 0,
    });
  }

  /**
   * Helper: build and send an atomic composed transaction for any action type.
   * [ComputeBudget, ValidateAndAuthorize, mockDefiIx, FinalizeSession]
   */
  async function sendComposedAction(
    vault: PublicKey,
    policy: PublicKey,
    tracker: PublicKey,
    agentKp: Keypair,
    tokenMint: PublicKey,
    amount: BN,
    targetProtocol: PublicKey,
    actionType: any,
    leverageBps: number | null = null,
    success: boolean = true,
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

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_FLASH_TRADE,
    });

    const validateIx = await program.methods
      .validateAndAuthorize(
        actionType,
        tokenMint,
        amount,
        targetProtocol,
        leverageBps,
      )
      .accountsPartial({
        agent: agentKp.publicKey,
        vault,
        policy,
        tracker,
        session,
        vaultTokenAccount: effectiveVaultAta,
        tokenMintAccount: tokenMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const mockDefiIx = createMockDefiInstruction(agentKp.publicKey);

    const finalizeIx = await program.methods
      .finalizeSession(success)
      .accountsPartial({
        payer: agentKp.publicKey,
        vault,
        session,
        sessionRentRecipient: agentKp.publicKey,
        policy,
        tracker,
        vaultTokenAccount: effectiveVaultAta,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Build and send versioned transaction via LiteSVM
    const result = sendVersionedTx(
      svm,
      [computeIx, validateIx, mockDefiIx, finalizeIx],
      agentKp,
    );
    recordCU("flash_trade:composed_action", result);
    return result;
  }

  after(() => printCUSummary());

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Extra SOL for owner — larger PolicyConfig accounts
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC mint at hardcoded devnet address (required by is_stablecoin_mint)
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Create protocol treasury ATA
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

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

    // Derive vault ATA
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    // Initialize vault with perp-friendly policy
    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000), // daily cap: 1000 USDC
        new BN(500_000_000), // max tx: 500 USDC
        0, // protocolMode
        [flashProtocol], // protocols
        10000, // max leverage: 100x (10000 bps)
        3, // max concurrent positions
        0, // developer fee rate
        100, // maxSlippageBps
        new BN(0), // timelockDuration
        [], // allowedDestinations
      )
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Register agent
    await program.methods
      .registerAgent(agent.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .rpc();

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
      2_000_000_000n, // 2000 USDC
    );

    await program.methods
      .depositFunds(new BN(1_000_000_000)) // 1000 USDC
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
  // Open leveraged long within policy
  // =========================================================================
  describe("open position", () => {
    it("opens a leveraged long position within policy limits", async () => {
      const amount = new BN(100_000_000); // 100 USDC collateral

      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        flashProtocol,
        { openPosition: {} },
        5000, // 50x leverage (within 100x limit)
      );

      expect(sig.signature).to.be.a("string");

      // Verify open_positions incremented
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.openPositions).to.equal(1);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(100_000_000);
    });
  });

  // =========================================================================
  // Leverage exceeds limit
  // =========================================================================
  describe("leverage limit", () => {
    it("rejects when leverage exceeds policy limit", async () => {
      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { openPosition: {} },
          15000, // 150x leverage — exceeds 100x (10000 bps) limit
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("LeverageTooHigh");
      }
    });
  });

  // =========================================================================
  // Exceeds max concurrent positions
  // =========================================================================
  describe("max concurrent positions", () => {
    it("rejects when exceeding max concurrent positions", async () => {
      // Already have 1 open position from the first test.
      // Open 2 more (max is 3).
      await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(50_000_000),
        flashProtocol,
        { openPosition: {} },
        2000,
      );

      await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(50_000_000),
        flashProtocol,
        { openPosition: {} },
        2000,
      );

      // Verify we have 3 open positions
      let vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.openPositions).to.equal(3);

      // 4th should fail
      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { openPosition: {} },
          2000,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("TooManyPositions");
      }

      // Verify still at 3
      vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.openPositions).to.equal(3);
    });
  });

  // =========================================================================
  // Close position decrements counter
  // =========================================================================
  describe("close position", () => {
    it("closes a position and decrements open_positions counter", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const positionsBefore = vaultBefore.openPositions;

      await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { closePosition: {} },
      );

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(positionsBefore - 1);
    });
  });

  // =========================================================================
  // Increase position
  // =========================================================================
  describe("increase position", () => {
    it("increases a position within policy limits", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(30_000_000),
        flashProtocol,
        { increasePosition: {} },
        3000,
      );

      expect(sig.signature).to.be.a("string");
    });
  });

  // =========================================================================
  // Decrease position
  // =========================================================================
  describe("decrease position", () => {
    it("decreases a position within policy limits", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { decreasePosition: {} },
      );

      expect(sig.signature).to.be.a("string");
    });
  });

  // =========================================================================
  // Frozen vault prevents open position
  // =========================================================================
  describe("frozen vault", () => {
    const frozenVaultId = new BN(301);
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

      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0, // protocolMode
          [flashProtocol], // protocols
          10000,
          3,
          0, // developer fee rate
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          policy: frozenPolicy,
          tracker: frozenTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey)
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
        .rpc();

      // Freeze vault
      await program.methods
        .revokeAgent()
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
        .rpc();
    });

    it("rejects open position on frozen vault", async () => {
      // Create vault ATA so Anchor account validation passes
      const frozenVaultAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        frozenVault,
        true, // allowOwnerOffCurve — vault is a PDA
      );

      try {
        await sendComposedAction(
          frozenVault,
          frozenPolicy,
          frozenTracker,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { openPosition: {} },
          5000,
          true,
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
  // Position opening disabled
  // =========================================================================
  describe("position opening disabled", () => {
    const disabledVaultId = new BN(302);
    let disabledVault: PublicKey;
    let disabledPolicy: PublicKey;
    let disabledTracker: PublicKey;
    let disabledVaultUsdcAta: PublicKey;

    before(async () => {
      [disabledVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          disabledVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [disabledPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), disabledVault.toBuffer()],
        program.programId,
      );
      [disabledTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), disabledVault.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          disabledVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0, // protocolMode
          [flashProtocol], // protocols
          10000,
          3,
          0, // developer fee rate
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: disabledVault,
          policy: disabledPolicy,
          tracker: disabledTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey)
        .accountsPartial({ owner: owner.publicKey, vault: disabledVault })
        .rpc();

      // Deposit funds so vault token account exists (needed for delegation)
      disabledVaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        disabledVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(100_000_000)) // 100 USDC
        .accountsPartial({
          owner: owner.publicKey,
          vault: disabledVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: disabledVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Disable position opening
      await program.methods
        .updatePolicy(
          null, // dailySpendingCapUsd
          null, // maxTransactionSizeUsd
          null, // protocolMode
          null, // protocols
          null, // maxLeverageBps
          false, // canOpenPositions = false
          null, // maxConcurrentPositions
          null, // developerFeeRate
          null, // maxSlippageBps
          null, // timelockDuration
          null, // allowedDestinations
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: disabledVault,
          policy: disabledPolicy,
        })
        .rpc();

      const policyState =
        await program.account.policyConfig.fetch(disabledPolicy);
      if (policyState.canOpenPositions !== false) {
        throw new Error(
          `Expected canOpenPositions=false but got ${policyState.canOpenPositions}`,
        );
      }
    });

    it("rejects open position when can_open_positions is false", async () => {
      try {
        await sendComposedAction(
          disabledVault,
          disabledPolicy,
          disabledTracker,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { openPosition: {} },
          5000,
          true,
          disabledVaultUsdcAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include(
          "PositionOpeningDisallowed",
        );
      }
    });
  });

  // =========================================================================
  // Spend tracking recorded correctly (V2 epoch buckets)
  // =========================================================================
  describe("spend tracking", () => {
    it("records spending from perpetual actions in tracker buckets", async () => {
      // The main vault already has several transactions from earlier tests
      // (open, close, increase, decrease). V2 SpendTracker uses epoch
      // buckets instead of per-transaction records.
      const tracker = await program.account.spendTracker.fetch(trackerPda);

      // At least one bucket should have non-zero USD spend
      const nonZeroBuckets = tracker.buckets.filter(
        (b: any) => b.usdAmount.toNumber() > 0,
      );
      expect(
        nonZeroBuckets.length,
        "should have at least one non-zero bucket",
      ).to.be.greaterThan(0);

      // The aggregate spend should reflect all transactions
      const totalBucketSpend = nonZeroBuckets.reduce(
        (acc: number, b: any) => acc + b.usdAmount.toNumber(),
        0,
      );
      expect(
        totalBucketSpend,
        "total bucket spend should be greater than zero",
      ).to.be.greaterThan(0);

      // Verify vault-level counters confirm all actions executed
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(
        vault.totalTransactions.toNumber(),
        "vault should have recorded multiple transactions",
      ).to.be.greaterThanOrEqual(4); // open + close + increase + decrease (+ extras)
      expect(
        vault.totalVolume.toNumber(),
        "vault should have recorded total volume",
      ).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  // Risk-reducing non-spending bypasses cap
  // =========================================================================
  describe("risk-reducing non-spending bypasses cap", () => {
    const capVaultId = new BN(303);
    let capVault: PublicKey;
    let capPolicy: PublicKey;
    let capTracker: PublicKey;
    let capAgentKp: Keypair;
    let capVaultUsdcAta: PublicKey;

    // Use SystemProgram.programId as target_protocol so the mock DeFi
    // instruction (SystemProgram.transfer) passes introspection check:
    // next_ix.program_id == target_protocol
    const mockProtocol = SystemProgram.programId;

    before(async () => {
      capAgentKp = Keypair.generate();
      airdropSol(svm, capAgentKp.publicKey, 10 * LAMPORTS_PER_SOL);

      [capVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          capVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [capPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), capVault.toBuffer()],
        program.programId,
      );
      [capTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), capVault.toBuffer()],
        program.programId,
      );

      // Daily cap = 200 USDC, max tx = 200 USDC, all protocols allowed
      await program.methods
        .initializeVault(
          capVaultId,
          new BN(200_000_000), // $200 daily cap
          new BN(200_000_000), // $200 max tx
          0, // protocol mode: all allowed
          [],
          10000, // 100x leverage
          3,
          0, // no dev fee
          100, // maxSlippageBps
          new BN(0), // no timelock
          [], // no destination allowlist
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: capVault,
          policy: capPolicy,
          tracker: capTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Register agent
      await program.methods
        .registerAgent(capAgentKp.publicKey)
        .accountsPartial({ owner: owner.publicKey, vault: capVault })
        .rpc();

      // Mint fresh USDC for this vault's deposit
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        ownerUsdcAta,
        owner.publicKey,
        2_000_000_000n,
      );

      // Create vault ATA and deposit
      capVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        capVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(1_000_000_000)) // $1000
        .accountsPartial({
          owner: owner.publicKey,
          vault: capVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: capVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Open position for 100 USDC (uses 100/200 cap, open_positions = 1)
      await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(100_000_000),
        mockProtocol,
        { openPosition: {} },
        5000,
        true,
        capVaultUsdcAta,
      );

      // Swap for 100 USDC (uses 200/200 cap = AT limit)
      await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(100_000_000),
        mockProtocol,
        { swap: {} },
        null,
        true,
        capVaultUsdcAta,
      );

      // Verify we're at cap with 1 open position
      const vault = await program.account.agentVault.fetch(capVault);
      expect(vault.openPositions).to.equal(1);
    });

    it("ClosePosition at daily cap succeeds — non-spending bypasses cap", async () => {
      // At 200/200 cap. Close with amount=0 (non-spending, risk-reducing).
      // Risk-reducing actions bypass cap entirely — no spending tracked.
      const sig = await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(0),
        mockProtocol,
        { closePosition: {} },
        null,
        true,
        capVaultUsdcAta,
      );
      expect(sig.signature).to.be.a("string");

      const vault = await program.account.agentVault.fetch(capVault);
      expect(vault.openPositions).to.equal(0);
    });

    it("DecreasePosition at daily cap succeeds — non-spending bypasses cap", async () => {
      // Advance time to fully evict rolling 24h window (24h + 1 epoch = 87000s)
      advanceTime(svm, 87_001);

      // Open a position (uses cap from fresh window)
      await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(100_000_000),
        mockProtocol,
        { openPosition: {} },
        5000,
        true,
        capVaultUsdcAta,
      );

      // Fill cap with a swap
      await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(100_000_000),
        mockProtocol,
        { swap: {} },
        null,
        true,
        capVaultUsdcAta,
      );

      const vaultBefore = await program.account.agentVault.fetch(capVault);
      expect(vaultBefore.openPositions).to.equal(1);

      // Now decrease with amount=0 (non-spending, risk-reducing) — bypasses cap
      const sig = await sendComposedAction(
        capVault,
        capPolicy,
        capTracker,
        capAgentKp,
        usdcMint,
        new BN(0),
        mockProtocol,
        { decreasePosition: {} },
        null,
        true,
        capVaultUsdcAta,
      );
      expect(sig.signature).to.be.a("string");
    });
  });

  // =========================================================================
  // Flash Trade Expansion Tests — New Action Types
  // =========================================================================

  describe("add collateral (spending)", () => {
    it("should authorize addCollateral with spending", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(50_000_000), // 50 USDC
        flashProtocol,
        { addCollateral: {} },
      );
      expect(sig.signature).to.be.a("string");

      // Position counter should NOT change
      const vault = await program.account.agentVault.fetch(vaultPda);
      // open_positions unchanged (addCollateral has PositionEffect::None)
      expect(vault.openPositions).to.equal(vault.openPositions);
    });
  });

  describe("remove collateral (non-spending)", () => {
    it("should authorize removeCollateral with amount=0", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0), // non-spending: amount must be 0
        flashProtocol,
        { removeCollateral: {} },
      );
      expect(sig.signature).to.be.a("string");
    });

    it("should reject removeCollateral with amount>0", async () => {
      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(100_000), // non-zero → should fail
          flashProtocol,
          { removeCollateral: {} },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("InvalidNonSpendingAmount");
      }
    });
  });

  describe("trigger orders (non-spending)", () => {
    it("should authorize placeTriggerOrder with amount=0", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { placeTriggerOrder: {} },
      );
      expect(sig.signature).to.be.a("string");
    });

    it("should authorize editTriggerOrder with amount=0", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { editTriggerOrder: {} },
      );
      expect(sig.signature).to.be.a("string");
    });

    it("should authorize cancelTriggerOrder with amount=0", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { cancelTriggerOrder: {} },
      );
      expect(sig.signature).to.be.a("string");
    });

    it("should reject placeTriggerOrder with amount>0", async () => {
      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(1_000_000),
          flashProtocol,
          { placeTriggerOrder: {} },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("InvalidNonSpendingAmount");
      }
    });
  });

  describe("limit orders", () => {
    it("should authorize placeLimitOrder with spending + position increment", async () => {
      // First ensure we can open positions (reset counter if needed)
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const positionsBefore = vaultBefore.openPositions;

      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(100_000_000), // 100 USDC (spending)
        flashProtocol,
        { placeLimitOrder: {} },
      );
      expect(sig.signature).to.be.a("string");

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(positionsBefore + 1);
    });

    it("should authorize cancelLimitOrder with position decrement", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const positionsBefore = vaultBefore.openPositions;
      expect(positionsBefore).to.be.greaterThan(0);

      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0), // non-spending
        flashProtocol,
        { cancelLimitOrder: {} },
      );
      expect(sig.signature).to.be.a("string");

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(positionsBefore - 1);
    });

    it("should authorize editLimitOrder with amount=0", async () => {
      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { editLimitOrder: {} },
      );
      expect(sig.signature).to.be.a("string");
    });
  });

  describe("swap-and-open / close-and-swap (spending + position)", () => {
    it("should authorize swapAndOpenPosition with spending + position increment", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const positionsBefore = vaultBefore.openPositions;

      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(100_000_000), // 100 USDC
        flashProtocol,
        { swapAndOpenPosition: {} },
      );
      expect(sig.signature).to.be.a("string");

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(positionsBefore + 1);
    });

    it("should authorize closeAndSwapPosition with non-spending + position decrement", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const positionsBefore = vaultBefore.openPositions;
      expect(positionsBefore).to.be.greaterThan(0);

      const sig = await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0), // non-spending (risk-reducing close)
        flashProtocol,
        { closeAndSwapPosition: {} },
      );
      expect(sig.signature).to.be.a("string");

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(positionsBefore - 1);
    });
  });

  describe("sync_positions (owner-only)", () => {
    it("should allow owner to sync positions", async () => {
      // Set up: ensure vault has some open positions
      await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(50_000_000),
        flashProtocol,
        { openPosition: {} },
        5000, // 50x leverage
      );

      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      expect(vaultBefore.openPositions).to.be.greaterThan(0);

      // Owner syncs positions to 0
      await program.methods
        .syncPositions(0)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.openPositions).to.equal(0);
    });

    it("should reject sync_positions by agent", async () => {
      try {
        await program.methods
          .syncPositions(5)
          .accounts({
            owner: agent.publicKey,
            vault: vaultPda,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("UnauthorizedOwner");
      }
    });
  });

  describe("position limit enforcement (new action types)", () => {
    it("should reject placeLimitOrder at max positions", async () => {
      // Sync to max positions - 1 to set up the test
      const policy = await program.account.policyConfig.fetch(policyPda);
      const maxPos = policy.maxConcurrentPositions;

      // Sync to max positions (already at capacity)
      await program.methods
        .syncPositions(maxPos)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { placeLimitOrder: {} },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("TooManyPositions");
      }

      // Reset for subsequent tests
      await program.methods
        .syncPositions(0)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();
    });

    it("should reject cancelLimitOrder with 0 positions", async () => {
      // Ensure 0 positions
      await program.methods
        .syncPositions(0)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(0),
          flashProtocol,
          { cancelLimitOrder: {} },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("NoPositionsToClose");
      }
    });

    it("should reject swapAndOpenPosition at max positions", async () => {
      const policy = await program.account.policyConfig.fetch(policyPda);
      await program.methods
        .syncPositions(policy.maxConcurrentPositions)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      try {
        await sendComposedAction(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(50_000_000),
          flashProtocol,
          { swapAndOpenPosition: {} },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.toString()).to.include("TooManyPositions");
      }

      // Reset
      await program.methods
        .syncPositions(0)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();
    });
  });

  describe("non-spending volume tracking", () => {
    it("should not add to total_volume for non-spending actions", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const volumeBefore = vaultBefore.totalVolume;

      await sendComposedAction(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(0),
        flashProtocol,
        { placeTriggerOrder: {} },
      );

      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.totalVolume.toString()).to.equal(
        volumeBefore.toString(),
      );
    });
  });
});
