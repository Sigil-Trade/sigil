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
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  JUPITER_PROGRAM_ID,
  deserializeInstruction,
} from "../sdk/typescript/src/integrations/jupiter";

/**
 * Jupiter Integration Tests
 *
 * These tests verify that Jupiter swap instructions can be correctly composed
 * into AgentShield's atomic [validate, ...defi, finalize] transactions.
 *
 * Since the on-chain program does not inspect DeFi instruction contents — it
 * only validates policy in validate_and_authorize and records the result in
 * finalize_session — we use a no-op TransactionInstruction as a mock swap.
 */
describe("jupiter-integration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentShield as Program<AgentShield>;
  const connection = provider.connection;

  // Test actors
  const owner = provider.wallet as anchor.Wallet;
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
  const protocolTreasury = new PublicKey("ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT");
  let protocolTreasuryUsdcAta: PublicKey;

  // Token accounts
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  /**
   * Create a mock DeFi instruction that mimics what Jupiter would produce.
   * Uses SystemProgram as the program ID since the real Jupiter program
   * doesn't exist on localnet. The on-chain AgentShield program doesn't
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
   * Helper: build and send an atomic composed transaction.
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
    overrideVaultTokenAta?: PublicKey
  ): Promise<string> {
    const [session] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), vault.toBuffer(), agentKp.publicKey.toBuffer()],
      program.programId
    );

    // 1. Compute budget
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000,
    });

    // 2. Validate and authorize
    const validateIx = await program.methods
      .validateAndAuthorize({ swap: {} }, tokenMint, amount, targetProtocol, null)
      .accountsPartial({
        agent: agentKp.publicKey,
        vault,
        policy,
        tracker,
        session,
        systemProgram: SystemProgram.programId,
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
        policy,
        tracker,
        session,
        sessionRentRecipient: agentKp.publicKey,
        vaultTokenAccount: overrideVaultTokenAta ?? vaultUsdcAta,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Build versioned transaction
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const messageV0 = new TransactionMessage({
      payerKey: agentKp.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeIx, validateIx, mockSwapIx, finalizeIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([agentKp]);

    // Simulate first to get error logs (sendRawTransaction loses them)
    const simResult = await connection.simulateTransaction(tx, {
      commitment: "confirmed",
    });

    if (simResult.value.err) {
      const logs = simResult.value.logs || [];
      const errMsg = logs.join(" ");
      throw new Error(`SimulationFailed: ${JSON.stringify(simResult.value.err)} Logs: ${errMsg}`);
    }

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }

  before(async () => {
    // Airdrop to test accounts
    await Promise.all([
      connection.requestAirdrop(agent.publicKey, 10 * LAMPORTS_PER_SOL),
      connection.requestAirdrop(feeDestination.publicKey, 2 * LAMPORTS_PER_SOL),
    ]).then((sigs) =>
      Promise.all(sigs.map((sig) => connection.confirmTransaction(sig)))
    );

    // Create USDC-like mint (6 decimals)
    usdcMint = await createMint(
      connection,
      (owner as any).payer,
      owner.publicKey,
      null,
      6
    );

    // Create disallowed token mint
    solMint = await createMint(
      connection,
      (owner as any).payer,
      owner.publicKey,
      null,
      9
    );

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

    // Create protocol treasury ATA (needed for fee transfers)
    // Protocol treasury is an off-curve address, so we need allowOwnerOffCurve=true
    protocolTreasuryUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      protocolTreasury,
      true, // allowOwnerOffCurve
    );
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      (owner as any).payer.publicKey,
      protocolTreasuryUsdcAta,
      protocolTreasury,
      usdcMint,
    );
    const ataTx = new Transaction().add(createAtaIx);
    await provider.sendAndConfirm(ataTx);

    // Initialize vault with:
    //   daily cap = 500 USDC (500_000_000 lamports)
    //   max tx size = 200 USDC (200_000_000 lamports)
    //   allowed tokens = [usdcMint]
    //   allowed protocols = [jupiterProtocol]
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily cap
        new BN(200_000_000), // max tx size
        [usdcMint],          // allowed tokens
        [jupiterProtocol],   // allowed protocols
        0,                   // max leverage (0 = disabled)
        1,                   // max concurrent positions
        0                    // developer fee rate (0 = none)
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
    ownerUsdcAta = await createAssociatedTokenAccount(
      connection,
      (owner as any).payer,
      usdcMint,
      owner.publicKey
    );
    await mintTo(
      connection,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      1_000_000_000 // 1000 USDC
    );

    // Derive vault ATA and deposit
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

    const depositSig = await program.methods
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

    // Wait for confirmed commitment — Anchor's default "processed" commitment
    // can race with simulateTransaction's "confirmed" commitment, causing
    // AccountNotInitialized (3012) when the ATA isn't visible yet.
    await connection.confirmTransaction(depositSig, "confirmed");
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
        jupiterProtocol
      );

      expect(sig).to.be.a("string");

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(50_000_000);

      // Verify spend tracker
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.rollingSpends.length).to.be.greaterThanOrEqual(1);
      expect(tracker.recentTransactions.length).to.equal(1);
      expect(tracker.recentTransactions[0].success).to.equal(true);
      expect(tracker.recentTransactions[0].amount.toNumber()).to.equal(50_000_000);
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
        jupiterProtocol
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      expect(vault.totalVolume.toNumber()).to.equal(80_000_000); // 50 + 30

      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.recentTransactions.length).to.equal(2);
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
        vaultPda, policyPda, trackerPda, agent,
        usdcMint, new BN(200_000_000), jupiterProtocol
      );
      await sendComposedSwap(
        vaultPda, policyPda, trackerPda, agent,
        usdcMint, new BN(200_000_000), jupiterProtocol
      );

      // Now at 480 spent. Try 50 USDC — total would be 530 > 500 cap
      const [session] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), vaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      try {
        await sendComposedSwap(
          vaultPda, policyPda, trackerPda, agent,
          usdcMint, new BN(50_000_000), jupiterProtocol
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
        expect(err.toString()).to.include("Account does not exist");
      }
    });
  });

  // =========================================================================
  // Error: disallowed token
  // =========================================================================
  describe("disallowed token", () => {
    it("reverts when token is not in policy allowlist", async () => {
      try {
        await sendComposedSwap(
          vaultPda,
          policyPda,
          trackerPda,
          agent,
          solMint, // not in allowed_tokens
          new BN(1_000_000),
          jupiterProtocol
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("TokenNotAllowed");
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
          fakeProtocol // not in allowed_protocols
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

      // Create and freeze vault
      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(500_000_000),
          new BN(200_000_000),
          [usdcMint],
          [jupiterProtocol],
          0,
          1,
          0 // developer fee rate
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

      // Freeze it
      const revokeSig = await program.methods
        .revokeAgent()
        .accountsPartial({ owner: owner.publicKey, vault: frozenVault })
        .rpc();

      // Wait for confirmation
      await connection.confirmTransaction(revokeSig, "confirmed");

      // Verify frozen immediately
      const checkVault = await program.account.agentVault.fetch(frozenVault);
      if (!JSON.stringify(checkVault.status).includes("frozen")) {
        throw new Error(`Vault 101 should be frozen but is: ${JSON.stringify(checkVault.status)}`);
      }
    });

    it("reverts entire TX when vault is frozen", async () => {
      // Verify vault is actually frozen before testing
      const vaultState = await program.account.agentVault.fetch(frozenVault);
      expect(JSON.stringify(vaultState.status)).to.include("frozen");

      try {
        await sendComposedSwap(
          frozenVault,
          frozenPolicy,
          frozenTracker,
          agent,
          usdcMint,
          new BN(1_000_000),
          jupiterProtocol
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // revokeAgent clears the agent key, so the constraint check fails
        // with UnauthorizedAgent before the handler's VaultNotActive check
        const msg = err.message || err.toString();
        expect(msg).to.satisfy(
          (s: string) => s.includes("VaultNotActive") || s.includes("UnauthorizedAgent"),
          "Expected VaultNotActive or UnauthorizedAgent"
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
        program.programId
      );
      [rollingPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), rollingVault.toBuffer()],
        program.programId
      );
      [rollingTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), rollingVault.toBuffer()],
        program.programId
      );

      // Create vault with tight cap: 100 USDC daily, 60 USDC max tx
      await program.methods
        .initializeVault(
          rollingVaultId,
          new BN(100_000_000), // 100 USDC daily cap
          new BN(60_000_000),  // 60 USDC max tx
          [usdcMint],
          [jupiterProtocol],
          0,
          1,
          0 // developer fee rate
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

      // Deposit USDC into rolling vault (needed for protocol fee transfers)
      rollingVaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, rollingVault, true);
      const depositSig = await program.methods
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

      // Wait for confirmed commitment — Anchor's default "processed" commitment
      // can race with simulateTransaction's "confirmed" commitment, causing
      // AccountNotInitialized (3012) when the ATA isn't visible yet at the
      // higher commitment level.
      await connection.confirmTransaction(depositSig, "confirmed");
    });

    it("allows multiple swaps under cap, then rejects when exceeded", async () => {
      // Verify agent is registered
      const vaultState = await program.account.agentVault.fetch(rollingVault);
      expect(vaultState.agent.toString()).to.equal(
        agent.publicKey.toString(),
        "Agent should be registered for rolling window vault"
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
        rollingVaultUsdcAta
      );

      let tracker = await program.account.spendTracker.fetch(rollingTracker);
      expect(tracker.recentTransactions.length).to.equal(1);

      // Small delay to avoid blockhash expiry on rapid sequential sends
      await new Promise((r) => setTimeout(r, 500));

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
        rollingVaultUsdcAta
      );

      tracker = await program.account.spendTracker.fetch(rollingTracker);
      expect(tracker.recentTransactions.length).to.equal(2);

      // Small delay before final attempt
      await new Promise((r) => setTimeout(r, 500));

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
          rollingVaultUsdcAta
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.message || err.toString()).to.include("DailyCapExceeded");
      }

      // Verify state wasn't modified by the failed tx
      tracker = await program.account.spendTracker.fetch(rollingTracker);
      expect(tracker.recentTransactions.length).to.equal(2);

      const vault = await program.account.agentVault.fetch(rollingVault);
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
