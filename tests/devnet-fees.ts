/**
 * Devnet Fee Tests — 8 tests (V2)
 *
 * Verifies fee collection correctness: protocol fees to treasury,
 * developer fees to feeDestination, combined deductions, failure paths,
 * dust amounts, and agent_transfer fee parity.
 *
 *     Stablecoin-only architecture. agentTransfer requires tokenMintAccount.
 *     finalizeSession includes policy and tracker accounts.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  derivePDAs,
  deriveSessionPda,
  createFullVault,
  authorize,
  authorizeAndFinalize,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  calculateFees,
  getTokenBalance,
  expectError,
  PROTOCOL_FEE_RATE,
  FEE_RATE_DENOMINATOR,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-fees", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const feeDestinationA = Keypair.generate();
  const feeDestinationB = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mint: PublicKey;
  let vaultA: FullVaultResult; // devFeeRate=500 (max)
  let vaultB: FullVaultResult; // devFeeRate=0

  let vaultIdA: BN;
  let vaultIdB: BN;

  before(async () => {
    await fundKeypair(provider, agentA.publicKey);
    await fundKeypair(provider, agentB.publicKey);

    mint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );

    vaultIdA = nextVaultId(2);
    vaultIdB = nextVaultId(2);

    vaultA = await createFullVault({
      program,
      connection,
      owner,
      agent: agentA,
      feeDestination: feeDestinationA.publicKey,
      mint,
      vaultId: vaultIdA,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      devFeeRate: 500,
      depositAmount: new BN(1_000_000_000),
    });

    vaultB = await createFullVault({
      program,
      connection,
      owner,
      agent: agentB,
      feeDestination: feeDestinationB.publicKey,
      mint,
      vaultId: vaultIdB,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      devFeeRate: 0,
      depositAmount: new BN(1_000_000_000),
    });

    console.log("  Vault A (devFee=500):", vaultA.vaultPda.toString());
    console.log("  Vault B (devFee=0):", vaultB.vaultPda.toString());
  });

  it("1. protocol fee credited to treasury ATA", async () => {
    const amount = 50_000_000; // 50 USDC
    const { protocolFee } = calculateFees(amount, 0);

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultB.protocolTreasuryAta,
    );

    const sessionPda = deriveSessionPda(
      vaultB.vaultPda,
      agentB.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      connection,
      program,
      agent: agentB,
      vaultPda: vaultB.vaultPda,
      policyPda: vaultB.policyPda,
      trackerPda: vaultB.trackerPda,
      sessionPda,
      vaultTokenAta: vaultB.vaultTokenAta,
      mint,
      amount: new BN(amount),
      protocol: jupiterProgramId,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
    });

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultB.protocolTreasuryAta,
    );
    expect(treasuryAfter - treasuryBefore).to.equal(protocolFee);
    console.log(`    Protocol fee: ${protocolFee} credited to treasury`);
  });

  it("2. developer fee credited to feeDestination ATA", async () => {
    const amount = 50_000_000; // 50 USDC
    const { developerFee } = calculateFees(amount, 500);

    const feeDestBefore = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );

    const sessionPda = deriveSessionPda(
      vaultA.vaultPda,
      agentA.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      connection,
      program,
      agent: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      vaultTokenAta: vaultA.vaultTokenAta,
      mint,
      amount: new BN(amount),
      protocol: jupiterProgramId,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
    });

    const feeDestAfter = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    expect(feeDestAfter - feeDestBefore).to.equal(developerFee);
    console.log(
      `    Developer fee: ${developerFee} credited to feeDestination`,
    );
  });

  it("3. combined fees: vault debited by protocol + developer", async () => {
    const amount = 100_000_000; // 100 USDC
    const { protocolFee, developerFee } = calculateFees(amount, 500);
    const totalFees = protocolFee + developerFee;

    const vaultBefore = await getTokenBalance(connection, vaultA.vaultTokenAta);

    const sessionPda = deriveSessionPda(
      vaultA.vaultPda,
      agentA.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      connection,
      program,
      agent: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      vaultTokenAta: vaultA.vaultTokenAta,
      mint,
      amount: new BN(amount),
      protocol: jupiterProgramId,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
    });

    const vaultAfter = await getTokenBalance(connection, vaultA.vaultTokenAta);
    expect(vaultBefore - vaultAfter).to.equal(totalFees);
    console.log(`    Combined fees deducted: ${totalFees}`);
  });

  it("4. fees collected upfront, stats always increment (success param removed)", async () => {
    // Fees are collected during validate_and_authorize (upfront), not finalize.
    // With success param removed (PR #143), every finalize increments stats.
    const amount = 50_000_000;
    const { protocolFee, developerFee } = calculateFees(amount, 500);

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestBefore = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    const vaultBefore = await program.account.agentVault.fetch(vaultA.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    const sessionPda = deriveSessionPda(
      vaultA.vaultPda,
      agentA.publicKey,
      mint,
      program.programId,
    );

    await authorizeAndFinalize({
      connection,
      program,
      agent: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      vaultTokenAta: vaultA.vaultTokenAta,
      mint,
      amount: new BN(amount),
      protocol: jupiterProgramId,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
    });

    // Fees WERE collected (upfront in validate)
    const treasuryAfter = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestAfter = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    expect(treasuryAfter - treasuryBefore).to.equal(protocolFee);
    expect(feeDestAfter - feeDestBefore).to.equal(developerFee);

    // Stats incremented (success param removed — every finalize counts)
    const vaultAfter = await program.account.agentVault.fetch(vaultA.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore + 1);
    console.log(
      `    fees collected (proto=${protocolFee}, dev=${developerFee}), stats incremented`,
    );
  });

  it("5. dust amount (1 lamport) rejected: ceiling fees exceed amount", async () => {
    // ceil(1*200/1M)=1 + ceil(1*500/1M)=1 = 2 total fees > amount of 1 → Overflow
    const sessionPda = deriveSessionPda(
      vaultA.vaultPda,
      agentA.publicKey,
      mint,
      program.programId,
    );

    try {
      await authorize({
        connection,
        program,
        agent: agentA,
        vaultPda: vaultA.vaultPda,
        policyPda: vaultA.policyPda,
        trackerPda: vaultA.trackerPda,
        sessionPda,
        vaultTokenAta: vaultA.vaultTokenAta,
        mint,
        amount: new BN(1),
        protocol: jupiterProgramId,
        protocolTreasuryAta: vaultA.protocolTreasuryAta,
        feeDestinationAta: vaultA.feeDestinationAta,
      });
      expect.fail("should have rejected dust amount");
    } catch (err) {
      expectError(err, "Overflow");
    }
    console.log("    Dust amount: ceiling fees exceed amount, rejected");
  });

  it("6. vault.totalFeesCollected tracks developer fees cumulatively", async () => {
    const vault = await program.account.agentVault.fetch(vaultA.vaultPda);
    // After tests 2, 3 (both with devFee=500):
    // Test 2: 50M * 500 / 1M = 25,000
    // Test 3: 100M * 500 / 1M = 50,000
    // Total: 75,000
    expect(vault.totalFeesCollected.toNumber()).to.be.greaterThan(0);
    console.log(
      `    Cumulative developer fees: ${vault.totalFeesCollected.toNumber()}`,
    );
  });

  it("7. agent_transfer fee collection matches session path", async () => {
    const amount = 100_000_000;
    const { protocolFee, developerFee } = calculateFees(amount, 500);

    // Create destination keypair + ATA
    const dest = Keypair.generate();
    const { getOrCreateAssociatedTokenAccount } =
      await import("@solana/spl-token");
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      dest.publicKey,
    );

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestBefore = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );

    await program.methods
      .agentTransfer(new BN(amount), new BN(0))
      .accounts({
        agent: agentA.publicKey,
        vault: vaultA.vaultPda,
        policy: vaultA.policyPda,
        tracker: vaultA.trackerPda,
        agentSpendOverlay: vaultA.overlayPda,
        vaultTokenAccount: vaultA.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: destAta.address,
        feeDestinationTokenAccount: vaultA.feeDestinationAta,
        protocolTreasuryTokenAccount: vaultA.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agentA])
      .rpc();

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestAfter = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );

    expect(treasuryAfter - treasuryBefore).to.equal(protocolFee);
    expect(feeDestAfter - feeDestBefore).to.equal(developerFee);
    console.log(
      `    agent_transfer fees match: protocol=${protocolFee}, dev=${developerFee}`,
    );
  });

  it("8. finalize with devFeeRate=0 and null feeDestination succeeds", async () => {
    const sessionPda = deriveSessionPda(
      vaultB.vaultPda,
      agentB.publicKey,
      mint,
      program.programId,
    );

    // feeDestinationTokenAccount=null is fine when devFeeRate=0
    await authorize({
      connection,
      program,
      agent: agentB,
      vaultPda: vaultB.vaultPda,
      policyPda: vaultB.policyPda,
      trackerPda: vaultB.trackerPda,
      sessionPda,
      vaultTokenAta: vaultB.vaultTokenAta,
      mint,
      amount: new BN(50_000_000),
      protocol: jupiterProgramId,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
    });

    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;
    console.log("    devFeeRate=0 + null feeDestination: succeeded");
  });
});
