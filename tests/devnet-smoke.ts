/**
 * Devnet Smoke Tests — 10 tests (V2)
 *
 * Full lifecycle: initialize_vault -> deposit -> register_agent ->
 * update_policy -> validate_and_authorize -> finalize_session ->
 * withdraw -> revoke -> reactivate -> close_vault.
 *
 * V2: No makeAllowedToken, no trackerTier. initializeVault takes 10 args.
 *     updatePolicy takes 10 optional args, no tracker in accounts.
 *     validate_and_authorize requires oracleRegistry + tokenMintAccount.
 *     finalizeSession has no tracker account.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../target/types/agent_shield";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
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
  deriveOracleRegistryPda,
  initializeOracleRegistry,
  makeOracleEntry,
  fundKeypair,
  createTestMint,
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
  let sessionPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;
  let oracleRegistryPda: PublicKey;

  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    console.log("  Owner:", owner.publicKey.toString());
    console.log("  Agent:", agent.publicKey.toString());
    console.log("  Vault ID:", vaultId.toNumber());
    console.log("  Program:", program.programId.toString());

    // Fund agent keypair from owner wallet (devnet faucet is rate-limited)
    await fundKeypair(provider, agent.publicKey);

    // Create a test SPL token mint
    usdcMint = await createTestMint(
      connection,
      (owner as any).payer,
      owner.publicKey,
      6,
    );
    console.log("  Test mint:", usdcMint.toString());

    // Initialize oracle registry with mint as stablecoin
    oracleRegistryPda = await initializeOracleRegistry(program, owner, [
      makeOracleEntry(usdcMint),
    ]);

    // Create owner token account and mint tokens
    ownerUsdcAta = await createAssociatedTokenAccount(
      connection,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
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
    // V2: 10 args (no allowedTokens, no trackerTier)
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily cap: 500
        new BN(100_000_000), // max tx: 100
        1, // protocolMode: allowlist
        [jupiterProgramId],
        new BN(0) as any, // max_leverage_bps
        3, // max_concurrent_positions
        0, // developer_fee_rate: 0 bps
        new BN(0), // timelockDuration
        [], // allowedDestinations
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
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
    await program.methods
      .registerAgent(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.agent.toString()).to.equal(agent.publicKey.toString());
    console.log("    Agent registered:", agent.publicKey.toString());
  });

  it("4. update_policy", async () => {
    // V2: 10 optional args, no tracker in accounts
    await program.methods
      .updatePolicy(
        null, // keep daily cap
        null, // keep max tx
        null, // keep protocolMode
        null, // keep protocols
        new BN(5000) as any, // set leverage to 50x
        null, // keep can_open_positions
        null, // keep max_concurrent_positions
        null, // keep developer_fee_rate
        null, // keep timelockDuration
        null, // keep allowedDestinations
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
      } as any)
      .rpc();

    const policy = await program.account.policyConfig.fetch(policyPda);
    expect(policy.maxLeverageBps).to.equal(5000);
    console.log("    Policy updated: max_leverage_bps = 5000");
  });

  it("5. validate_and_authorize", async () => {
    // V2: requires oracleRegistry + tokenMintAccount
    await program.methods
      .validateAndAuthorize(
        { swap: {} },
        usdcMint,
        new BN(50_000_000), // 50 tokens
        jupiterProgramId,
        null,
      )
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        oracleRegistry: oracleRegistryPda,
        session: sessionPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([agent])
      .rpc();

    const session = await program.account.sessionAuthority.fetch(sessionPda);
    expect(session.authorized).to.equal(true);
    expect(session.authorizedAmount.toNumber()).to.equal(50_000_000);
    console.log("    Session authorized for 50 tokens");
  });

  it("6. finalize_session", async () => {
    // V2: no tracker in accounts
    await program.methods
      .finalizeSession(true)
      .accounts({
        payer: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        session: sessionPda,
        sessionRentRecipient: agent.publicKey,
        vaultTokenAccount: vaultUsdcAta,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([agent])
      .rpc();

    // Session should be closed
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.totalTransactions.toNumber()).to.equal(1);
    expect(vault.totalVolume.toNumber()).to.equal(50_000_000);
    console.log("    Session finalized, tx count = 1, volume = 50M");
  });

  it("7. withdraw_funds", async () => {
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

  it("8. revoke_agent (kill switch)", async () => {
    await program.methods
      .revokeAgent()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("frozen");
    console.log("    Vault frozen via kill switch");
  });

  it("9. reactivate_vault", async () => {
    // revokeAgent clears the agent, so we must provide a new one
    await program.methods
      .reactivateVault(agent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .rpc();

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("active");
    console.log("    Vault reactivated");
  });

  it("10. withdraw remaining + close_vault", async () => {
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
    console.log("    All 10 lifecycle steps passed on devnet!");
  });
});
