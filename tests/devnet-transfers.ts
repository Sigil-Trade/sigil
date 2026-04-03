/**
 * Devnet Transfer Tests — 6 tests (V2)
 *
 * Exercises agent_transfer: destination allowlist enforcement,
 * fee correctness, access control, and spending cap interaction.
 *
 *     Stablecoin-only architecture. agentTransfer requires tokenMintAccount.
 *     Removed per-token max_tx_base test (V1 concept not in V2).
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  createFullVault,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  getTokenBalance,
  calculateFees,
  expectError,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-transfers", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;
  const attacker = Keypair.generate();

  const destA = Keypair.generate();
  const destB = Keypair.generate();

  let mint: PublicKey;
  let destAAta: PublicKey;
  let destBAta: PublicKey;

  // Vault with allowlist = [destA]
  let vaultAllowlist: FullVaultResult;
  // Vault with empty allowlist (any dest)
  let vaultAnyDest: FullVaultResult;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    await fundKeypair(provider, attacker.publicKey);

    mint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );

    // Create destination ATAs
    const ataA = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      destA.publicKey,
    );
    destAAta = ataA.address;
    const ataB = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      destB.publicKey,
    );
    destBAta = ataB.address;

    // Vault with destination allowlist
    vaultAllowlist = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(6),
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      allowedDestinations: [destA.publicKey],
      devFeeRate: 500,
      depositAmount: new BN(1_000_000_000),
    });

    // Vault with empty allowlist (any destination)
    vaultAnyDest = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(6),
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      allowedDestinations: [],
      depositAmount: new BN(1_000_000_000),
    });

    console.log("  Vault (allowlist):", vaultAllowlist.vaultPda.toString());
    console.log("  Vault (any dest):", vaultAnyDest.vaultPda.toString());
  });

  it("1. agent_transfer to allowed destination succeeds", async () => {
    const amount = 10_000_000; // 10 USDC
    const destBefore = await getTokenBalance(connection, destAAta);

    await program.methods
      .agentTransfer(new BN(amount), new BN(0))
      .accounts({
        agent: agent.publicKey,
        vault: vaultAllowlist.vaultPda,
        policy: vaultAllowlist.policyPda,
        tracker: vaultAllowlist.trackerPda,
        agentSpendOverlay: vaultAllowlist.overlayPda,
        vaultTokenAccount: vaultAllowlist.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: destAAta,
        feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
        protocolTreasuryTokenAccount: vaultAllowlist.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agent])
      .rpc();

    const destAfter = await getTokenBalance(connection, destAAta);
    const { netAmount } = calculateFees(amount, 500);
    expect(destAfter - destBefore).to.equal(netAmount);
    console.log(`    Transfer to allowed destination: net=${netAmount}`);
  });

  it("2. agent_transfer to non-allowed destination fails", async () => {
    try {
      await program.methods
        .agentTransfer(new BN(10_000_000), new BN(0))
        .accounts({
          agent: agent.publicKey,
          vault: vaultAllowlist.vaultPda,
          policy: vaultAllowlist.policyPda,
          tracker: vaultAllowlist.trackerPda,
          agentSpendOverlay: vaultAllowlist.overlayPda,
          vaultTokenAccount: vaultAllowlist.vaultTokenAta,
          tokenMintAccount: mint,
          destinationTokenAccount: destBAta, // destB not in allowlist
          feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
          protocolTreasuryTokenAccount: vaultAllowlist.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "DestinationNotAllowed", "not in allowed");
    }
    console.log("    Non-allowed destination correctly rejected");
  });

  it("3. empty allowlist means any destination works", async () => {
    const randomDest = Keypair.generate();
    const randomDestAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      randomDest.publicKey,
    );

    await program.methods
      .agentTransfer(new BN(10_000_000), new BN(0))
      .accounts({
        agent: agent.publicKey,
        vault: vaultAnyDest.vaultPda,
        policy: vaultAnyDest.policyPda,
        tracker: vaultAnyDest.trackerPda,
        agentSpendOverlay: vaultAnyDest.overlayPda,
        vaultTokenAccount: vaultAnyDest.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: randomDestAta.address,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: vaultAnyDest.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agent])
      .rpc();

    const balance = await getTokenBalance(connection, randomDestAta.address);
    expect(balance).to.be.greaterThan(0);
    console.log("    Empty allowlist: any destination accepted");
  });

  it("4. agent_transfer developer + protocol fees correct", async () => {
    const amount = 100_000_000; // 100 USDC
    const { protocolFee, developerFee, netAmount } = calculateFees(amount, 500);

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultAllowlist.protocolTreasuryAta,
    );
    const feeDestBefore = await getTokenBalance(
      connection,
      vaultAllowlist.feeDestinationAta!,
    );
    const destBefore = await getTokenBalance(connection, destAAta);

    await program.methods
      .agentTransfer(new BN(amount), new BN(0))
      .accounts({
        agent: agent.publicKey,
        vault: vaultAllowlist.vaultPda,
        policy: vaultAllowlist.policyPda,
        tracker: vaultAllowlist.trackerPda,
        agentSpendOverlay: vaultAllowlist.overlayPda,
        vaultTokenAccount: vaultAllowlist.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: destAAta,
        feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
        protocolTreasuryTokenAccount: vaultAllowlist.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agent])
      .rpc();

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultAllowlist.protocolTreasuryAta,
    );
    const feeDestAfter = await getTokenBalance(
      connection,
      vaultAllowlist.feeDestinationAta!,
    );
    const destAfter = await getTokenBalance(connection, destAAta);

    expect(treasuryAfter - treasuryBefore).to.equal(protocolFee);
    expect(feeDestAfter - feeDestBefore).to.equal(developerFee);
    expect(destAfter - destBefore).to.equal(netAmount);
    console.log(
      `    Fees verified: protocol=${protocolFee}, dev=${developerFee}, net=${netAmount}`,
    );
  });

  it("5. non-agent cannot call agent_transfer", async () => {
    try {
      await program.methods
        .agentTransfer(new BN(10_000_000), new BN(0))
        .accounts({
          agent: attacker.publicKey,
          vault: vaultAllowlist.vaultPda,
          policy: vaultAllowlist.policyPda,
          tracker: vaultAllowlist.trackerPda,
          agentSpendOverlay: vaultAllowlist.overlayPda,
          vaultTokenAccount: vaultAllowlist.vaultTokenAta,
          tokenMintAccount: mint,
          destinationTokenAccount: destAAta,
          feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
          protocolTreasuryTokenAccount: vaultAllowlist.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "UnauthorizedAgent", "unauthorized", "constraint");
    }
    console.log("    Non-agent agent_transfer rejected");
  });

  it("6. agent_transfer respects daily spending cap", async () => {
    // Create vault with 200 USDC cap
    const smallCapVault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(6),
      dailyCap: new BN(200_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      allowedDestinations: [],
      depositAmount: new BN(1_000_000_000),
    });

    // Transfer 200 USDC (at cap)
    await program.methods
      .agentTransfer(new BN(200_000_000), new BN(0))
      .accounts({
        agent: agent.publicKey,
        vault: smallCapVault.vaultPda,
        policy: smallCapVault.policyPda,
        tracker: smallCapVault.trackerPda,
        agentSpendOverlay: smallCapVault.overlayPda,
        vaultTokenAccount: smallCapVault.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: destAAta,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: smallCapVault.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agent])
      .rpc();

    // 1 more should fail
    try {
      await program.methods
        .agentTransfer(new BN(1_000_000), new BN(0))
        .accounts({
          agent: agent.publicKey,
          vault: smallCapVault.vaultPda,
          policy: smallCapVault.policyPda,
          tracker: smallCapVault.trackerPda,
          agentSpendOverlay: smallCapVault.overlayPda,
          vaultTokenAccount: smallCapVault.vaultTokenAta,
          tokenMintAccount: mint,
          destinationTokenAccount: destAAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: smallCapVault.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "SpendingCapExceeded", "cap");
    }
    console.log("    agent_transfer respects daily cap");
  });
});
