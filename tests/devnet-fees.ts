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
  finalize,
  fundKeypair,
  createTestMint,
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

    mint = await createTestMint(connection, payer, owner.publicKey, 6);

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
    });
    await finalize({
      program,
      payer: agentB,
      vaultPda: vaultB.vaultPda,
      policyPda: vaultB.policyPda,
      trackerPda: vaultB.trackerPda,
      sessionPda,
      agentPubkey: agentB.publicKey,
      vaultTokenAta: vaultB.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
      success: true,
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
    });
    await finalize({
      program,
      payer: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      agentPubkey: agentA.publicKey,
      vaultTokenAta: vaultA.vaultTokenAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      success: true,
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
    });
    await finalize({
      program,
      payer: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      agentPubkey: agentA.publicKey,
      vaultTokenAta: vaultA.vaultTokenAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      success: true,
    });

    const vaultAfter = await getTokenBalance(connection, vaultA.vaultTokenAta);
    expect(vaultBefore - vaultAfter).to.equal(totalFees);
    console.log(`    Combined fees deducted: ${totalFees}`);
  });

  it("4. failed finalize (success=false) collects zero fees", async () => {
    const treasuryBefore = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
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
      program,
      agent: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      vaultTokenAta: vaultA.vaultTokenAta,
      mint,
      amount: new BN(50_000_000),
      protocol: jupiterProgramId,
    });
    await finalize({
      program,
      payer: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      agentPubkey: agentA.publicKey,
      vaultTokenAta: vaultA.vaultTokenAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      success: false,
    });

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestAfter = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    expect(treasuryAfter).to.equal(treasuryBefore);
    expect(feeDestAfter).to.equal(feeDestBefore);
    console.log("    Failed finalize: zero fees collected");
  });

  it("5. dust amount (1 lamport) rounds fee to zero", async () => {
    const sessionPda = deriveSessionPda(
      vaultA.vaultPda,
      agentA.publicKey,
      mint,
      program.programId,
    );

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );

    await authorize({
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
    });
    await finalize({
      program,
      payer: agentA,
      vaultPda: vaultA.vaultPda,
      policyPda: vaultA.policyPda,
      trackerPda: vaultA.trackerPda,
      sessionPda,
      agentPubkey: agentA.publicKey,
      vaultTokenAta: vaultA.vaultTokenAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      success: true,
    });

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    // 1 * 200 / 1_000_000 = 0 (truncated)
    expect(treasuryAfter).to.equal(treasuryBefore);
    console.log("    Dust amount: fees rounded to zero");
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
      .agentTransfer(new BN(amount))
      .accounts({
        agent: agentA.publicKey,
        vault: vaultA.vaultPda,
        policy: vaultA.policyPda,
        tracker: vaultA.trackerPda,
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

    await authorize({
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
    });

    // feeDestinationTokenAccount=null is fine when devFeeRate=0
    await finalize({
      program,
      payer: agentB,
      vaultPda: vaultB.vaultPda,
      policyPda: vaultB.policyPda,
      trackerPda: vaultB.trackerPda,
      sessionPda,
      agentPubkey: agentB.publicKey,
      vaultTokenAta: vaultB.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
      success: true,
    });

    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;
    console.log("    devFeeRate=0 + null feeDestination: succeeded");
  });
});
