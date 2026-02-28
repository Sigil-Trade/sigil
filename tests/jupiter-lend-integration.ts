import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../target/types/agent_shield";
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
import { JUPITER_LEND_PROGRAM_ID } from "../sdk/typescript/src/integrations/jupiter-lend";
import { CU_DEFAULT_COMPOSED } from "../sdk/typescript/src/priority-fees";
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

/**
 * Jupiter Lend Integration Tests
 *
 * These tests verify that Jupiter Lend deposit/withdraw actions work
 * correctly through AgentShield's atomic composition pattern.
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

  // Use Jupiter Lend program ID as the allowed protocol
  const lendProtocol = JUPITER_LEND_PROGRAM_ID;

  // Vault IDs 500+ to avoid collision with other test files
  const vaultId = new BN(500);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
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
    actionType: any,
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

    // 1. Compute budget
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_DEFAULT_COMPOSED,
    });

    // 2. Validate and authorize
    const validateIx = await program.methods
      .validateAndAuthorize(
        actionType,
        tokenMint,
        amount,
        targetProtocol,
        null, // no leverage for lend
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

    // 3. Mock Lend instruction
    const mockLendIx = createMockLendInstruction(agentKp.publicKey);

    // 4. Finalize session
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
        { deposit: {} },
      );

      expect(result.signature).to.be.a("string");

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(100_000_000);
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
        { withdraw: {} },
      );

      expect(result.signature).to.be.a("string");

      // Verify transaction count incremented
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      // Volume unchanged (withdraw is non-spending)
      expect(vault.totalVolume.toNumber()).to.equal(100_000_000);
    });
  });

  // =========================================================================
  // Error: deposit exceeds daily cap
  // =========================================================================
  describe("deposit exceeds daily cap", () => {
    it("reverts when deposit amount + prior spending > cap", async () => {
      // Already spent 100 USDC (from happy path deposit). Cap is 500 USDC.
      // Deposit 200 USDC twice more (100+200+200 = 500, exactly at cap)
      await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        lendProtocol,
        { deposit: {} },
      );

      await sendComposedLend(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        lendProtocol,
        { deposit: {} },
      );

      // Now at 500 spent. Try 1 USDC — total would be 501 > 500 cap
      try {
        await sendComposedLend(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(1_000_000),
          lendProtocol,
          { deposit: {} },
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("DailyCapExceeded");
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
          { deposit: {} },
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
          new BN(500_000_000),
          new BN(200_000_000),
          0,
          [lendProtocol],
          0,
          1,
          0,
          100,
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

      // Freeze via revoke
      await program.methods
        .revokeAgent()
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
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
          { deposit: {} },
          true,
          frozenVaultAta,
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
          new BN(0),
          [],
        )
        .accountsPartial({
          owner: owner.publicKey,
          vault: rollingVault,
          policy: rollingPolicy,
          tracker: rollingTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey)
        .accountsPartial({ owner: owner.publicKey, vault: rollingVault })
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

    it("allows multiple deposits under cap, then rejects when exceeded", async () => {
      // Deposit 1: 40 USDC (total: 40 / 100)
      await sendComposedLend(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        lendProtocol,
        { deposit: {} },
        true,
        rollingVaultUsdcAta,
      );

      let vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(1);

      // Deposit 2: 40 USDC (total: 80 / 100)
      await sendComposedLend(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        lendProtocol,
        { deposit: {} },
        true,
        rollingVaultUsdcAta,
      );

      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);

      // Deposit 3: 30 USDC (total: 110 > 100 cap) — should fail
      try {
        await sendComposedLend(
          rollingVault,
          rollingPolicy,
          rollingTracker,
          agent,
          usdcMint,
          new BN(30_000_000),
          lendProtocol,
          { deposit: {} },
          true,
          rollingVaultUsdcAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("DailyCapExceeded");
      }

      // Verify state was not modified by failed tx
      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
    });
  });
});
