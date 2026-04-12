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
} from "./helpers/litesvm-setup";

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
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );
  let protocolTreasuryUsdcAta: PublicKey;
  let ownerUsdcAta: PublicKey;

  // Use Jupiter Lend program ID as the allowed protocol
  const lendProtocol = JUPITER_LEND_PROGRAM_ID;

  // Vault IDs 500+ to avoid collision with other test files
  const vaultId = new BN(500);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let vaultUsdcAta: PublicKey;

  /**
   * Create a mock Lend instruction (no-op transfer to self).
   */
  function createMockLendInstruction(payer: PublicKey): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: payer,
      lamports: 0,
    });
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

    // 2. Validate and authorize
    const validateIx = await program.methods
      .validateAndAuthorize(
        tokenMint,
        amount,
        targetProtocol,
        new BN(0), // expectedPolicyVersion
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
        agentSpendOverlay: overlay,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
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
        agentSpendOverlay: overlay,
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
        new BN(500_000_000), // daily cap: 500 USDC
        new BN(200_000_000), // max tx: 200 USDC
        1, // protocolMode: allowlist
        [lendProtocol], // protocols
        0, // max leverage (disabled)
        1, // max concurrent positions
        0, // developer fee rate
        100, // maxSlippageBps
        new BN(1800), // timelockDuration
        [], // allowedDestinations
        [], // protocolCaps
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

    // Register agent
    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
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
      const amount = new BN(100_000_000); // 100 USDC

      const result = await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        lendProtocol,
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
  describe("outcome-based spending with mock lend", () => {
    it("succeeds when declared amount exceeds cap because actual spend is zero", async () => {
      // Outcome-based enforcement (Phase 1): finalize_session measures
      // actual stablecoin balance delta. Mock lend instructions don't move
      // tokens, so actual_spend = 0 and the cap check is never triggered.
      await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        lendProtocol,
      );

      await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        lendProtocol,
      );

      // Would exceed 500 USDC cap if declaration-based, but succeeds
      // because outcome-based enforcement sees zero actual spend.
      await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(1_000_000),
        lendProtocol,
      );

      // Verify all TXs succeeded
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.be.greaterThanOrEqual(5);
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
          0,
          [lendProtocol],
          0,
          1,
          0,
          100,
          new BN(1800),
          [],
          [], // protocolCaps
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

      await program.methods
        .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          agentSpendOverlay: frozenOverlay,
        })
        .rpc();

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
          new BN(100_000_000), // 100 USDC daily cap
          new BN(60_000_000), // 60 USDC max tx
          0,
          [lendProtocol],
          0,
          1,
          0,
          100,
          new BN(1800),
          [],
          [], // protocolCaps
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

      await program.methods
        .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
        .accountsPartial({
          owner: owner.publicKey,
          vault: rollingVault,
          agentSpendOverlay: rollingOverlay,
        })
        .rpc();

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

    it("all deposits succeed with outcome-based enforcement (mock lend = zero spend)", async () => {
      // Outcome-based enforcement: mock lend instructions don't move tokens,
      // so actual_spend = 0 and all deposits succeed regardless of declared amount.

      // Deposit 1: 40 USDC declared (actual spend = 0)
      await sendComposedLend(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        lendProtocol,
        rollingVaultUsdcAta,
        rollingOverlay,
      );

      let vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(1);

      // Deposit 2: 40 USDC declared (actual spend = 0)
      await sendComposedLend(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        lendProtocol,
        rollingVaultUsdcAta,
        rollingOverlay,
      );

      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);

      // Deposit 3: 30 USDC — would exceed 100 cap if declaration-based,
      // but succeeds because outcome-based enforcement sees zero actual spend.
      await sendComposedLend(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(30_000_000),
        lendProtocol,
        rollingVaultUsdcAta,
        rollingOverlay,
      );

      // All 3 TXs succeeded
      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(3);
    });
  });
});
