/**
 * Devnet Session Tests — 6 tests (V2)
 *
 * Session expiration is the #1 thing LiteSVM cannot replicate.
 * On devnet, 20 slots = ~8-12 real seconds.
 *
 *     Stablecoin-only architecture.
 *     finalizeSession includes policy and tracker accounts.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  derivePDAs,
  deriveSessionPda,
  createFullVault,
  authorize,
  finalize,
  fundKeypair,
  sleep,
  waitForSlot,
  expectError,
  FullVaultResult,
  PROTOCOL_TREASURY,
} from "./helpers/devnet-setup";

describe("devnet-sessions", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const thirdParty = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let vault: FullVaultResult;
  let vaultId: BN;
  let mintBVaultAta: PublicKey;
  let mintBTreasuryAta: PublicKey;

  before(async () => {
    // Fund agent and third party from owner
    await fundKeypair(provider, agent.publicKey);
    await fundKeypair(provider, thirdParty.publicKey);

    // Create two test mints
    mintA = await createMint(connection, payer, owner.publicKey, null, 6);
    mintB = await createMint(connection, payer, owner.publicKey, null, 6);

    vaultId = nextVaultId(3);

    vault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint: mintA,
      vaultId,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(100_000_000),
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(500_000_000),
    });

    // Create vault ATA + deposit for mintB too
    mintBVaultAta = anchor.utils.token.associatedAddress({
      mint: mintB,
      owner: vault.vaultPda,
    });
    const ownerMintBAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      owner.publicKey,
    );
    const ownerMintBAta = ownerMintBAtaAccount.address;
    await mintTo(
      connection,
      payer,
      mintB,
      ownerMintBAta,
      owner.publicKey,
      500_000_000,
    );
    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        mint: mintB,
        ownerTokenAccount: ownerMintBAta,
        vaultTokenAccount: mintBVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Create protocol treasury ATA for mintB (needed for mintB finalize)
    const mintBTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      PROTOCOL_TREASURY,
      true,
    );
    mintBTreasuryAta = mintBTreasuryAccount.address;

    console.log("  Session tests vault:", vault.vaultPda.toString());
  });

  it("1. session expires after ~20 slots and finalize forces success=false", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Get session expiry slot
    const session = await program.account.sessionAuthority.fetch(sessionPda);
    const expiresAtSlot = session.expiresAtSlot.toNumber();
    console.log(`    Session expires at slot ${expiresAtSlot}`);

    // Wait for expiration
    await waitForSlot(connection, expiresAtSlot + 1);

    const vaultBefore = await program.account.agentVault.fetch(vault.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    // Finalize — expired session forces success=false even if we pass true
    // V2: no tracker in finalize accounts
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: true,
    });

    // Session closed
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    // totalTransactions should NOT increment (expired = forced failure)
    const vaultAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore);
    console.log(
      "    Expired session finalized as failure — no stats increment",
    );
  });

  it("2. permissionless cleanup of expired session", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Wait for expiration
    const session = await program.account.sessionAuthority.fetch(sessionPda);
    await waitForSlot(connection, session.expiresAtSlot.toNumber() + 1);

    // Third party (not agent) calls finalize — should succeed on expired session
    await finalize({
      program,
      payer: thirdParty,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: false,
    });

    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;
    console.log("    Third-party cleanup of expired session succeeded");
  });

  it("3. non-expired session cannot be finalized by non-agent", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Immediately try finalize from third party (non-agent, non-expired)
    try {
      await finalize({
        program,
        payer: thirdParty,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda,
        agentPubkey: agent.publicKey,
        vaultTokenAta: vault.vaultTokenAta,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        success: true,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "UnauthorizedAgent", "unauthorized");
    }

    // Clean up — finalize properly with agent
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: false,
    });
    console.log("    Non-agent finalize of active session correctly rejected");
  });

  it("4. concurrent sessions for different token mints succeed", async () => {
    const sessionPdaA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    const sessionPdaB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintB,
      program.programId,
    );

    // Authorize session on mintA
    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Authorize session on mintB — different PDA seeds, should coexist
    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaB,
      vaultTokenAta: mintBVaultAta,
      mint: mintB,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Both sessions exist
    const sessionA = await program.account.sessionAuthority.fetch(sessionPdaA);
    const sessionB = await program.account.sessionAuthority.fetch(sessionPdaB);
    expect(sessionA.authorized).to.equal(true);
    expect(sessionB.authorized).to.equal(true);

    // Finalize both — each uses the correct treasury ATA for its mint
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaA,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: true,
    });
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaB,
      agentPubkey: agent.publicKey,
      vaultTokenAta: mintBVaultAta,
      feeDestinationAta: null,
      protocolTreasuryAta: mintBTreasuryAta,
      success: true,
    });

    expect(await connection.getAccountInfo(sessionPdaA)).to.be.null;
    expect(await connection.getAccountInfo(sessionPdaB)).to.be.null;
    console.log("    Concurrent sessions for different mints succeeded");
  });

  it("5. double-authorize same token mint fails", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Try authorizing again for same mint without finalize
    try {
      await authorize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(10_000_000),
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "already in use", "already been processed", "0x0");
    }

    // Clean up
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: false,
    });
    console.log("    Double-authorize correctly rejected");
  });

  it("6. immediate finalize within slot window succeeds", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    const vaultBefore = await program.account.agentVault.fetch(vault.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // Immediately finalize (within slot window)
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: true,
    });

    const vaultAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore + 1);
    console.log("    Immediate finalize succeeded — tx count incremented");
  });
});
