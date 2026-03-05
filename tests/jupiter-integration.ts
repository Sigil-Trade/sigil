import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Phalnx } from "../target/types/phalnx";
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
import {
  JUPITER_PROGRAM_ID,
  deserializeInstruction,
} from "../sdk/typescript/src/integrations/jupiter";
import { CU_JUPITER_SWAP } from "../sdk/typescript/src/priority-fees";
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
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

/**
 * Jupiter Integration Tests
 *
 * These tests verify that Jupiter swap instructions can be correctly composed
 * into Phalnx's atomic [validate, ...defi, finalize] transactions.
 *
 * Since the on-chain program does not inspect DeFi instruction contents — it
 * only validates policy in validate_and_authorize and records the result in
 * finalize_session — we use a no-op TransactionInstruction as a mock swap.
 */
describe("jupiter-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Phalnx>;

  // Test actors
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  // Token mints
  let usdcMint: PublicKey;
  let solMint: PublicKey; // disallowed token for testing

  // Jupiter protocol ID used as the "allowed protocol" in policy
  const jupiterProtocol = JUPITER_PROGRAM_ID;

  // Vault for happy-path tests
  const vaultId = new BN(100);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  // Token accounts
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  /**
   * Create a mock DeFi instruction that mimics what Jupiter would produce.
   * Uses SystemProgram as the program ID since the real Jupiter program
   * doesn't exist on localnet. The on-chain Phalnx program doesn't
   * inspect the DeFi instruction — it only validates policy in
   * validate_and_authorize and records the result in finalize_session.
   *
   * We use a no-op SystemProgram transfer (0 lamports to self) so the
   * runtime can actually execute it.
   */
  function createMockSwapInstruction(payer: PublicKey): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: payer,
      lamports: 0,
    });
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
      units: CU_JUPITER_SWAP,
    });

    // 2. Validate and authorize
    const validateIx = await program.methods
      .validateAndAuthorize(
        { swap: {} },
        tokenMint,
        amount,
        targetProtocol,
        null,
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

    // 3. Mock DeFi instruction (would be Jupiter swap in production)
    const mockSwapIx = createMockSwapInstruction(agentKp.publicKey);

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
        new BN(500_000_000), // daily cap
        new BN(200_000_000), // max tx size
        1, // protocolMode: 1 = allowlist
        [jupiterProtocol], // protocols
        0, // max leverage (0 = disabled)
        1, // max concurrent positions
        0, // developer fee rate (0 = none)
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
      .registerAgent(agent.publicKey, FULL_PERMISSIONS)
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
      const amount = new BN(50_000_000); // 50 USDC

      const sig = await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        jupiterProtocol,
      );

      expect(sig.signature).to.be.a("string");

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(50_000_000);
    });

    it("records multiple composed swaps correctly", async () => {
      const amount = new BN(30_000_000); // 30 USDC

      await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        amount,
        jupiterProtocol,
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      expect(vault.totalVolume.toNumber()).to.equal(80_000_000); // 50 + 30
    });
  });

  // =========================================================================
  // Error: daily cap exceeded
  // =========================================================================
  describe("daily cap exceeded", () => {
    it("reverts entire atomic TX when amount exceeds remaining daily budget", async () => {
      // Already spent 80 USDC (50 + 30). Cap is 500 USDC. Max tx = 200 USDC.
      // First spend 200 USDC twice more (80+200+200 = 480, under 500 cap)
      await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        jupiterProtocol,
      );
      await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(200_000_000),
        jupiterProtocol,
      );

      // Now at 480 spent. Try 50 USDC — total would be 530 > 500 cap
      const [session] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      try {
        await sendComposedSwap(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          usdcMint,
          new BN(50_000_000),
          jupiterProtocol,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("DailyCapExceeded");
      }

      // Verify session was NOT created (atomic revert)
      try {
        await program.account.sessionAuthority.fetch(session);
        expect.fail("Session should not exist after revert");
      } catch (err: any) {
        // LiteSVM proxy returns "Account does not exist"; Anchor provider
        // returns "Could not find". Both confirm the session PDA was closed.
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }
    });
  });

  // =========================================================================
  // Error: disallowed token
  // =========================================================================
  describe("disallowed token", () => {
    it("reverts when token is not in policy allowlist", async () => {
      // Create vault ATA for solMint so Anchor account validation passes,
      // allowing the handler's TokenNotRegistered check to fire.
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
          true,
          vaultSolAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // Non-stablecoin token without output_stablecoin_account → InvalidTokenAccount
        expect(err.message || err.toString()).to.satisfy(
          (s: string) =>
            s.includes("InvalidTokenAccount") ||
            s.includes("TokenNotRegistered"),
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

      // Create and freeze vault
      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(500_000_000),
          new BN(200_000_000),
          0, // protocolMode
          [jupiterProtocol], // protocols
          0,
          1,
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
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
        .rpc();

      // Freeze it
      await program.methods
        .revokeAgent(agent.publicKey)
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
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

      // Create vault with tight cap: 100 USDC daily, 60 USDC max tx
      await program.methods
        .initializeVault(
          rollingVaultId,
          new BN(100_000_000), // 100 USDC daily cap
          new BN(60_000_000), // 60 USDC max tx
          0, // protocolMode
          [jupiterProtocol], // protocols
          0,
          1,
          0, // developer fee rate
          100, // maxSlippageBps
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
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accountsPartial({ owner: owner.publicKey, vault: rollingVault })
        .rpc();

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

    it("allows multiple swaps under cap, then rejects when exceeded", async () => {
      // Verify agent is registered
      const vaultState = await program.account.agentVault.fetch(rollingVault);
      expect(vaultState.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
        "Agent should be registered for rolling window vault",
      );

      // Swap 1: 40 USDC (total: 40 / 100)
      await sendComposedSwap(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        jupiterProtocol,
        true,
        rollingVaultUsdcAta,
      );

      let vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(1);

      // Swap 2: 40 USDC (total: 80 / 100)
      await sendComposedSwap(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        jupiterProtocol,
        true,
        rollingVaultUsdcAta,
      );

      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);

      // Swap 3: 30 USDC (total: 110 > 100 cap) — should fail
      try {
        await sendComposedSwap(
          rollingVault,
          rollingPolicy,
          rollingTracker,
          agent,
          usdcMint,
          new BN(30_000_000),
          jupiterProtocol,
          true,
          rollingVaultUsdcAta,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("DailyCapExceeded");
      }

      // Verify state wasn't modified by the failed tx
      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
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
