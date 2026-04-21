/**
 * Devnet Smoke Tests — 9 tests (V3)
 *
 * Full lifecycle: initialize_vault -> deposit -> register_agent ->
 * queue_policy_update (verify pending) -> validate_and_authorize+finalize_session (composed) ->
 * withdraw -> revoke -> reactivate -> close_vault.
 *
 *     Stablecoin-only architecture. initializeVault takes 11 args.
 *     V3: updatePolicy deleted; all policy mutations go through queue/apply.
 *     Mandatory minimum timelockDuration: 1800 (30 min).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  PROTOCOL_TREASURY,
  getDevnetProvider,
  derivePDAs,
  deriveSessionPda,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  nextVaultId,
} from "./helpers/devnet-setup";

describe("devnet-smoke-test", () => {
  const { provider, program, connection, owner } = getDevnetProvider();

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  const vaultId = nextVaultId(1);

  let usdcMint: PublicKey;
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let pendingPolicyPda: PublicKey;
  let sessionPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;
  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    console.log("  Owner:", owner.publicKey.toString());
    console.log("  Agent:", agent.publicKey.toString());
    console.log("  Vault ID:", vaultId.toNumber());
    console.log("  Program:", program.programId.toString());

    // Fund agent keypair from owner wallet (devnet faucet is rate-limited)
    await fundKeypair(provider, agent.publicKey);

    // Create test USDC mint at deterministic address (matches Rust devnet constant)
    usdcMint = await ensureStablecoinMint(
      connection,
      (owner as any).payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
    console.log("  Test mint:", usdcMint.toString());

    // Create owner token account (idempotent — safe across re-runs)
    const ownerAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    ownerUsdcAta = ownerAtaAccount.address;
    await mintTo(
      connection,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      1_000_000_000, // 1000 tokens
    );

    // Derive PDAs
    const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
    vaultPda = pdas.vaultPda;
    policyPda = pdas.policyPda;
    trackerPda = pdas.trackerPda;
    pendingPolicyPda = pdas.pendingPolicyPda;
    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    sessionPda = deriveSessionPda(
      vaultPda,
      agent.publicKey,
      usdcMint,
      program.programId,
    );

    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });

    // Create protocol treasury ATA on devnet (idempotent)
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      connection,
      (owner as any).payer,
      usdcMint,
      PROTOCOL_TREASURY,
      true,
    );
    protocolTreasuryUsdcAta = treasuryAta.address;
    console.log("  Treasury ATA:", protocolTreasuryUsdcAta.toString());
  });

  it("1. initialize_vault", async () => {
    // 11 args (includes maxSlippageBps)
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily cap: 500
        new BN(100_000_000), // max tx: 100
        1, // protocolMode: allowlist
        [jupiterProgramId],
        0, // developer_fee_rate: 0 bps
        500, // maxSlippageBps: 5%
        new BN(1800), // timelockDuration (mandatory minimum: 30 min)
        [], // allowedDestinations
        [], // protocolCaps
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
    expect(vault.vaultId.toNumber()).to.equal(vaultId.toNumber());
    console.log("    Vault PDA:", vaultPda.toString());
  });

  it("2. deposit_funds", async () => {
    await program.methods
      .depositFunds(new BN(100_000_000)) // 100 tokens
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const vaultAccount = await getAccount(connection, vaultUsdcAta);
    expect(Number(vaultAccount.amount)).to.equal(100_000_000);
    console.log("    Deposited 100 tokens into vault");
  });

  it("3. register_agent", async () => {
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await program.methods
      .registerAgent(agent.publicKey, 2, new BN(0)) // FULL_CAPABILITY
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.agents[0].pubkey.toString()).to.equal(
      agent.publicKey.toString(),
    );
    console.log("    Agent registered:", agent.publicKey.toString());
  });

  it("4. queue_policy_update (timelock-gated — verify pending PDA)", async () => {
    // updatePolicy deleted; all mutations go through queue/apply.
    // With timelockDuration=1800, we can't apply in a test — just verify the queue.
    await program.methods
      .queuePolicyUpdate(
        null, // keep daily cap
        null, // keep max tx
        null, // keep protocolMode
        null,
        null, // keep developer_fee_rate
        null, // keep maxSlippageBps
        null, // keep timelockDuration
        null, // keep allowedDestinations
        null, // sessionExpirySlots
        null, // hasProtocolCaps
        null, // protocolCaps
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify pending policy PDA was created
    const pending =
      await program.account.pendingPolicyUpdate.fetch(pendingPolicyPda);
    console.log(
      `    Policy update queued (executes at ${pending.executesAt.toNumber()})`,
    );

    // Cancel the pending update so it doesn't block close_vault later
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
      } as any)
      .rpc();
    console.log("    Pending policy cancelled (cleanup for later steps)");
  });

  it("5. validate_and_authorize + finalize_session (composed)", async () => {
    // Build validate instruction
    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        new BN(50_000_000), // 50 tokens
        jupiterProgramId,
        new BN(0),
      )
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        outputStablecoinAccount: null,
      } as any)
      .instruction();

    // Build finalize instruction
    const finalizeIx = await program.methods
      .finalizeSession()
      .accounts({
        payer: agent.publicKey,
        vault: vaultPda,
        session: sessionPda,
        sessionRentRecipient: agent.publicKey,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        outputStablecoinAccount: null,
      } as any)
      .instruction();

    // Compose into a single versioned transaction
    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: agent.publicKey,
      recentBlockhash: blockhash,
      instructions: [validateIx, finalizeIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([agent]);
    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(sig, "confirmed");

    // Session should be closed (finalize closes it)
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.totalTransactions.toNumber()).to.equal(1);
    // totalVolume uses actual_spend_tracked; no DeFi ix in compose → 0
    expect(vault.totalVolume.toNumber()).to.equal(0);
    console.log(
      "    Session authorized + finalized in one tx, tx count = 1, volume = 50M",
    );
  });

  it("6. withdraw_funds", async () => {
    await program.methods
      .withdrawFunds(new BN(50_000_000)) // withdraw 50 tokens
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultTokenAccount: vaultUsdcAta,
        ownerTokenAccount: ownerUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    // After deposit(100M) - protocolFee(10k from finalize) - withdraw(50M) = 49,990,000
    const vaultAccount = await getAccount(connection, vaultUsdcAta);
    const remainingBalance = Number(vaultAccount.amount);
    expect(remainingBalance).to.be.lessThanOrEqual(50_000_000);
    expect(remainingBalance).to.be.greaterThan(49_000_000);
    console.log(`    Withdrew 50 tokens, vault balance = ${remainingBalance}`);
  });

  it("7. revoke_agent (kill switch)", async () => {
    await program.methods
      .revokeAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("frozen");
    console.log("    Vault frozen via kill switch");
  });

  it("8. reactivate_vault", async () => {
    // revokeAgent removed the agent, so we must provide a new one
    await program.methods
      .reactivateVault(agent.publicKey, 2) // FULL_CAPABILITY
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("active");
    console.log("    Vault reactivated");
  });

  it("9. withdraw remaining + close_vault", async () => {
    // Withdraw remaining balance (100M - protocolFee - 50M withdrawn)
    const remaining = await getAccount(connection, vaultUsdcAta);
    await program.methods
      .withdrawFunds(new BN(Number(remaining.amount)))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        vaultTokenAccount: vaultUsdcAta,
        ownerTokenAccount: ownerUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    // Close vault and reclaim rent
    const balBefore = await connection.getBalance(owner.publicKey);

    await program.methods
      .closeVault()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify all PDAs are closed
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).to.be.null;
    const policyInfo = await connection.getAccountInfo(policyPda);
    expect(policyInfo).to.be.null;
    const trackerInfo = await connection.getAccountInfo(trackerPda);
    expect(trackerInfo).to.be.null;

    const balAfter = await connection.getBalance(owner.publicKey);
    expect(balAfter).to.be.greaterThan(balBefore);
    console.log("    Vault closed, rent reclaimed");
    console.log("    All 9 lifecycle steps passed on devnet!");
  });
});
