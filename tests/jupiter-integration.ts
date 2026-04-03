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
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

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

  // Vault for happy-path tests
  const vaultId = new BN(100);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
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
   * doesn't exist on localnet. The on-chain Sigil program doesn't
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
    const validateIx = await program.methods
      .validateAndAuthorize(
        { swap: {} },
        tokenMint,
        amount,
        targetProtocol,
        null,
        new BN(0),
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
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: program.programId,
        outputStablecoinAccount: program.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // 3. Mock DeFi instruction (would be Jupiter swap in production)
    const mockSwapIx = createMockSwapInstruction(agentKp.publicKey);

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
        agentSpendOverlay: overlayForVault,
        vaultTokenAccount: effectiveVaultAta,
        outputStablecoinAccount: program.programId,
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
        new BN(500_000_000), // daily cap
        new BN(200_000_000), // max tx size
        1, // protocolMode: 1 = allowlist
        [jupiterProtocol], // protocols
        0, // max leverage (0 = disabled)
        1, // max concurrent positions
        0, // developer fee rate (0 = none)
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
      .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
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
      // totalVolume uses actual_spend_tracked; mock DeFi is no-op → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
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
      // Mock DeFi no-ops: cumulative actual spend = 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // =========================================================================
  // Outcome-based spending: mock swaps record zero actual spend
  // =========================================================================
  describe("outcome-based spending with mock swaps", () => {
    it("succeeds when declared amount exceeds cap because actual spend is zero (outcome-based)", async () => {
      // Outcome-based enforcement (Phase 1): finalize_session measures the
      // actual stablecoin balance delta, not the declared amount. Mock swap
      // instructions don't move tokens, so actual_spend = 0 and the cap check
      // is never triggered. Cap enforcement with real token movement is tested
      // via Rust unit tests and devnet E2E with real DeFi programs.

      // Already spent 80 USDC in declared amounts from happy path tests.
      // With outcome-based: tracker has 0 recorded spend (mock swaps).
      // Send more swaps — all succeed because actual_spend = 0.
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

      // This would exceed the 500 USDC cap if spending were declaration-based,
      // but succeeds because outcome-based enforcement measures zero actual spend.
      await sendComposedSwap(
        vaultPda,
        policyPda,
        trackerPda,
        agent,
        usdcMint,
        new BN(50_000_000),
        jupiterProtocol,
      );

      // Verify vault recorded all transactions (finalize succeeds with actual_spend=0)
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.be.greaterThanOrEqual(5);

      // Fee drain fix: tracker now records protocol fees even when actual_spend=0.
      // The key invariant: totalVolume = 0 (no real DeFi spend occurred).
      expect(vault.totalVolume.toNumber()).to.equal(0);
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
          0, // protocolMode
          [jupiterProtocol], // protocols
          0,
          1,
          0, // developer fee rate
          100, // maxSlippageBps
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
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accountsPartial({
          owner: owner.publicKey,
          vault: frozenVault,
          agentSpendOverlay: frozenOverlay,
        })
        .rpc();

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
          new BN(100_000_000), // 100 USDC daily cap
          new BN(60_000_000), // 60 USDC max tx
          0, // protocolMode
          [jupiterProtocol], // protocols
          0,
          1,
          0, // developer fee rate
          100, // maxSlippageBps
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
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accountsPartial({
          owner: owner.publicKey,
          vault: rollingVault,
          agentSpendOverlay: rollingOverlay,
        })
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

    it("all swaps succeed with outcome-based enforcement (mock swaps = zero spend)", async () => {
      // Outcome-based enforcement: finalize_session measures actual stablecoin
      // balance delta. Mock swaps don't move tokens → actual_spend = 0 →
      // cap check skipped. All swaps succeed regardless of declared amounts.

      // Verify agent is registered
      const vaultState = await program.account.agentVault.fetch(rollingVault);
      expect(vaultState.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
        "Agent should be registered for rolling window vault",
      );

      // Swap 1: 40 USDC declared (actual spend = 0)
      await sendComposedSwap(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        jupiterProtocol,
        rollingVaultUsdcAta,
      );

      let vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(1);

      // Swap 2: 40 USDC declared (actual spend = 0)
      await sendComposedSwap(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(40_000_000),
        jupiterProtocol,
        rollingVaultUsdcAta,
      );

      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(2);

      // Swap 3: 30 USDC declared — would exceed 100 cap if declaration-based,
      // but succeeds because outcome-based enforcement sees zero actual spend.
      await sendComposedSwap(
        rollingVault,
        rollingPolicy,
        rollingTracker,
        agent,
        usdcMint,
        new BN(30_000_000),
        jupiterProtocol,
        rollingVaultUsdcAta,
      );

      // All 3 TXs succeeded
      vault = await program.account.agentVault.fetch(rollingVault);
      expect(vault.totalTransactions.toNumber()).to.equal(3);
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
