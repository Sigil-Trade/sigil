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
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  FLASH_TRADE_PROGRAM_ID,
} from "../sdk/typescript/src/integrations/flash-trade";
import {
  createTestEnv,
  airdropSol,
  createMintHelper,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  sendVersionedTx,
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
  const protocolTreasury = new PublicKey("ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT");
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
  let oracleRegistryPda: PublicKey;

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
    overrideVaultTokenAta?: PublicKey
  ): Promise<string> {
    const effectiveVaultAta = overrideVaultTokenAta ?? vaultUsdcAta;

    const [session] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vault.toBuffer(),
        agentKp.publicKey.toBuffer(),
        tokenMint.toBuffer(),
      ],
      program.programId
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    const validateIx = await program.methods
      .validateAndAuthorize(
        actionType,
        tokenMint,
        amount,
        targetProtocol,
        leverageBps
      )
      .accountsPartial({
        agent: agentKp.publicKey,
        vault,
        policy,
        tracker,
        oracleRegistry: oracleRegistryPda,
        session,
        vaultTokenAccount: effectiveVaultAta,
        tokenMintAccount: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const mockDefiIx = createMockDefiInstruction(agentKp.publicKey);

    const finalizeIx = await program.methods
      .finalizeSession(success)
      .accountsPartial({
        payer: agentKp.publicKey,
        vault,
        policy,
        session,
        sessionRentRecipient: agentKp.publicKey,
        vaultTokenAccount: effectiveVaultAta,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Build and send versioned transaction via LiteSVM
    return sendVersionedTx(
      svm,
      [computeIx, validateIx, mockDefiIx, finalizeIx],
      agentKp
    );
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Extra SOL for owner — larger PolicyConfig accounts
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC-like mint
    usdcMint = createMintHelper(
      svm,
      (owner as any).payer,
      owner.publicKey,
      6
    );

    // Create protocol treasury ATA
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true
    );

    // Derive oracle registry PDA and initialize it
    [oracleRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_registry")],
      program.programId
    );

    await program.methods
      .initializeOracleRegistry([
        { mint: usdcMint, oracleFeed: PublicKey.default, isStablecoin: true, fallbackFeed: PublicKey.default },
      ])
      .accounts({
        authority: owner.publicKey,
        oracleRegistry: oracleRegistryPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Derive PDAs
    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId
    );

    // Derive vault ATA
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    // Initialize vault with perp-friendly policy
    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000), // daily cap: 1000 USDC
        new BN(500_000_000),   // max tx: 500 USDC
        0,                     // protocolMode
        [flashProtocol],       // protocols
        10000, // max leverage: 100x (10000 bps)
        3,     // max concurrent positions
        0,     // developer fee rate
        new BN(0), // timelockDuration
        [],    // allowedDestinations
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
      owner.publicKey
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      2_000_000_000n // 2000 USDC
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
        5000 // 50x leverage (within 100x limit)
      );

      expect(sig).to.be.a("string");

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
          15000 // 150x leverage — exceeds 100x (10000 bps) limit
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
        vaultPda, policyPda, trackerPda, agent, usdcMint,
        new BN(50_000_000), flashProtocol,
        { openPosition: {} }, 2000
      );

      await sendComposedAction(
        vaultPda, policyPda, trackerPda, agent, usdcMint,
        new BN(50_000_000), flashProtocol,
        { openPosition: {} }, 2000
      );

      // Verify we have 3 open positions
      let vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.openPositions).to.equal(3);

      // 4th should fail
      try {
        await sendComposedAction(
          vaultPda, policyPda, trackerPda, agent, usdcMint,
          new BN(50_000_000), flashProtocol,
          { openPosition: {} }, 2000
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
        new BN(100_000_000),
        flashProtocol,
        { closePosition: {} }
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
        3000
      );

      expect(sig).to.be.a("string");
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
        new BN(20_000_000),
        flashProtocol,
        { decreasePosition: {} }
      );

      expect(sig).to.be.a("string");
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
        program.programId
      );
      [frozenPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), frozenVault.toBuffer()],
        program.programId
      );
      [frozenTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), frozenVault.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0,                   // protocolMode
          [flashProtocol],     // protocols
          10000,
          3,
          0, // developer fee rate
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
          frozenVaultAta
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // revoke_agent clears the agent key, so is_agent() constraint fails
        // before the handler's VaultNotActive check can run.
        const msg = err.message || err.toString();
        expect(msg).to.satisfy(
          (s: string) =>
            s.includes("UnauthorizedAgent") ||
            s.includes("ConstraintRaw"),
          `Expected an unauthorized-agent error but got: ${msg}`
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
        program.programId
      );
      [disabledPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), disabledVault.toBuffer()],
        program.programId
      );
      [disabledTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), disabledVault.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(
          disabledVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0,                   // protocolMode
          [flashProtocol],     // protocols
          10000,
          3,
          0, // developer fee rate
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
        usdcMint, disabledVault, true
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
          null,  // maxConcurrentPositions
          null,  // developerFeeRate
          null,  // timelockDuration
          null   // allowedDestinations
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: disabledVault,
          policy: disabledPolicy,
        })
        .rpc();

      const policyState = await program.account.policyConfig.fetch(disabledPolicy);
      if (policyState.canOpenPositions !== false) {
        throw new Error(
          `Expected canOpenPositions=false but got ${policyState.canOpenPositions}`
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
          disabledVaultUsdcAta
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include(
          "PositionOpeningDisallowed"
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
        (b: any) => b.usdAmount.toNumber() > 0
      );
      expect(
        nonZeroBuckets.length,
        "should have at least one non-zero bucket"
      ).to.be.greaterThan(0);

      // The aggregate spend should reflect all transactions
      const totalBucketSpend = nonZeroBuckets.reduce(
        (acc: number, b: any) => acc + b.usdAmount.toNumber(),
        0
      );
      expect(
        totalBucketSpend,
        "total bucket spend should be greater than zero"
      ).to.be.greaterThan(0);

      // Verify vault-level counters confirm all actions executed
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(
        vault.totalTransactions.toNumber(),
        "vault should have recorded multiple transactions"
      ).to.be.greaterThanOrEqual(4); // open + close + increase + decrease (+ extras)
      expect(
        vault.totalVolume.toNumber(),
        "vault should have recorded total volume"
      ).to.be.greaterThan(0);
    });
  });
});
