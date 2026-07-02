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
// Strict error helpers assert the EXACT expected error code — see tests/helpers/strict-errors.ts
import { expectSigilError } from "./helpers/strict-errors";
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
  deriveSessionPda,
  createFullVault,
  applyOperatorGrants,
  authorizeAndFinalize,
  sendVersionedTx,
  fundKeypair,
  ensureStablecoinMint,
  setupSwapOutput,
  buildMockSwapToVaultIx,
  TEST_USDC_KEYPAIR,
  calculateFees,
  getTokenBalance,
  FullVaultResult,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";

describe("devnet-fees", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const feeDestinationA = Keypair.generate();
  const feeDestinationB = Keypair.generate();
  // V2: agent_transfer requires an EXPLICITLY allowlisted destination
  // (destination_mode is hardcoded RESTRICTED; an empty allowlist allows
  // NOTHING — policy.rs is_destination_allowed). Test 7's transfer target is
  // allowlisted on vaultA at creation.
  const transferDest = Keypair.generate();

  let mint: PublicKey;
  // Agent-owned USDC ATAs — the inputSink (leg-1 destination) of the acquiring
  // swaps that satisfy the M1 (6112) + require-measurable-outcome (6115) gates.
  let agentAUsdcAta: PublicKey;
  let agentBUsdcAta: PublicKey;
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
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      allowedDestinations: [transferDest.publicKey], // test 7 agent_transfer target
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
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      devFeeRate: 0,
      depositAmount: new BN(1_000_000_000),
    });

    // F-Q6: both OPERATOR grants were QUEUED by createFullVault — one batched
    // wait for the on-chain 600s single-key floor, then apply both.
    await applyOperatorGrants(program, connection, owner, [
      vaultA.operatorGrant,
      vaultB.operatorGrant,
    ]);

    // Agent USDC ATAs — leg-1 inputSink for the acquiring swaps the spending
    // fee tests use to satisfy M1 (6112) + require-measurable-outcome (6115).
    agentAUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        agentA.publicKey,
      )
    ).address;
    agentBUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        agentB.publicKey,
      )
    ).address;

    console.log("  Vault A (devFee=500):", vaultA.vaultPda.toString());
    console.log("  Vault B (devFee=0):", vaultB.vaultPda.toString());
  });

  it("1. protocol fee credited to treasury ATA", async () => {
    const amount = 50_000_000; // 50 USDC
    const { protocolFee } = calculateFees(amount, 0);

    // C-1: fees are charged at FINALIZE on the MEASURED spend. The acquiring
    // swap really spends the full `amount` of stablecoin (inAmount = amount) so
    // actual_spend == amount and the protocol fee = ceil(amount * rate) ==
    // protocolFee. M1 + 6115: outAmount > 0 acquires a vault-owned output so the
    // require-measurable-outcome gate is satisfied. Mirrors the verified LiteSVM
    // pattern (security-exploits.ts "fee at exact boundary").
    const swap = await setupSwapOutput(
      connection,
      payer,
      vaultB.vaultPda,
      agentB.publicKey,
    );

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

    await authorizeAndFinalize({
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
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
      feeDestinationAta: null, // vaultB has devFeeRate=0
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vaultB.vaultTokenAta,
        agentBUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agentB.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000),
      ),
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

    // C-1: the developer fee is charged at FINALIZE on the MEASURED spend. The
    // acquiring swap spends the full `amount` (inAmount = amount) so
    // actual_spend == amount and dev fee = ceil(amount * devRate) == developerFee.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vaultA.vaultPda,
      agentA.publicKey,
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
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vaultA.vaultTokenAta,
        agentAUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agentA.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000),
      ),
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

  it("3. combined fees: protocol to treasury + developer to feeDestination (measured spend)", async () => {
    const amount = 100_000_000; // 100 USDC
    const { protocolFee, developerFee } = calculateFees(amount, 500);
    const totalFees = protocolFee + developerFee;

    // C-1: fees are charged at FINALIZE on the MEASURED spend, so combined fees
    // can only be exercised by a REAL spend (a zero-spend session collects NO
    // fee). The acquiring swap spends the full `amount` (inAmount = amount) so
    // actual_spend == amount; the protocol fee lands in the treasury and the
    // developer fee in the fee destination, and the vault's stablecoin ATA is
    // debited by net_value_out = amount + protocolFee + developerFee.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vaultA.vaultPda,
      agentA.publicKey,
    );

    const treasuryBefore = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestBefore = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    const vaultBefore = await getTokenBalance(connection, vaultA.vaultTokenAta);

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
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vaultA.vaultTokenAta,
        agentAUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agentA.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000), // outAmount>0 → vault-owned output increases (6115 via M1)
      ),
    });

    const treasuryAfter = await getTokenBalance(
      connection,
      vaultA.protocolTreasuryAta,
    );
    const feeDestAfter = await getTokenBalance(
      connection,
      vaultA.feeDestinationAta!,
    );
    const vaultAfter = await getTokenBalance(connection, vaultA.vaultTokenAta);
    // Combined fees landed in their destinations…
    expect(treasuryAfter - treasuryBefore).to.equal(protocolFee);
    expect(feeDestAfter - feeDestBefore).to.equal(developerFee);
    // …and the vault was debited by the spend + both fees (net_value_out).
    expect(vaultBefore - vaultAfter).to.equal(amount + totalFees);
    console.log(`    Combined fees collected: ${totalFees} (spend ${amount})`);
  });

  it("4. fees collected at finalize on measured spend; stats always increment (success param removed)", async () => {
    // C-1: fees are collected at finalize_session on the MEASURED spend (not
    // upfront at validate). With the success param removed (PR #143), every
    // finalize increments stats regardless.
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

    // M1 + 6115: acquiring swap spends the full `amount` (inAmount = amount) so
    // actual_spend == amount; the fees are charged at finalize on that measured
    // spend and asserted below, and totalTransactions increments on finalize.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vaultA.vaultPda,
      agentA.publicKey,
    );

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
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vaultA.protocolTreasuryAta,
      feeDestinationAta: vaultA.feeDestinationAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vaultA.vaultTokenAta,
        agentAUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agentA.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000),
      ),
    });

    // Fees WERE collected at finalize on the measured spend
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

  it("5. dust amount (1 lamport) via agent_transfer rejected: ceiling fees exceed amount", async () => {
    // C-1 relocated the seal-path fee to finalize on the MEASURED spend, so the
    // old dust-overflow-at-validate no longer exists on the seal sandwich (a
    // 1-lamport declared amount with no measurable spend now reverts 6115). The
    // ceiling-fees-exceed-amount Overflow still applies to agent_transfer, which
    // collects fees UPFRONT on the declared amount: ceil(1*200/1M)=1 +
    // ceil(1*500/1M)=1 = 2 > amount of 1 → Overflow on checked_sub. Mirrors the
    // verified LiteSVM coverage in security-exploits.ts ("agent_transfer with
    // amount = 1, devFeeRate=500 → Overflow").
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      transferDest.publicKey,
    );
    const livePolicyA = await program.account.policyConfig.fetch(
      vaultA.policyPda,
    );
    const dustTransferIx = await program.methods
      .agentTransfer(new BN(1), (livePolicyA as any).policyVersion)
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
      .instruction();

    try {
      await sendVersionedTx(connection, [dustTransferIx], agentA);
      expect.fail("should have rejected dust amount");
    } catch (err) {
      expectSigilError(err, { name: "Overflow" });
    }
    console.log(
      "    Dust amount via agent_transfer: ceiling fees exceed amount, rejected",
    );
  });

  it("6. vault.totalFeesCollected tracks developer fees cumulatively", async () => {
    const vault = await program.account.agentVault.fetch(vaultA.vaultPda);
    // C-1: developer fees are charged at finalize on the MEASURED spend. Tests
    // 2, 3, 4 (vaultA, devFee=500) each spent their full declared amount, so
    // total_fees_collected accumulated dev fees:
    //   Test 2: ceil(50M * 500 / 1M)  = 25,000
    //   Test 3: ceil(100M * 500 / 1M) = 50,000
    //   Test 4: ceil(50M * 500 / 1M)  = 25,000  → cumulative ≥ 100,000
    expect(vault.totalFeesCollected.toNumber()).to.be.greaterThan(0);
    console.log(
      `    Cumulative developer fees: ${vault.totalFeesCollected.toNumber()}`,
    );
  });

  it("7. agent_transfer fee collection matches session path", async () => {
    const amount = 100_000_000;
    const { protocolFee, developerFee } = calculateFees(amount, 500);

    // Destination ATA — `transferDest` is allowlisted on vaultA (V2
    // agent_transfer requires an explicitly allowlisted destination owner).
    const dest = transferDest;
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

    // Live policy_version (the apply_agent_grant seating bumped it past 0) +
    // versioned send (a failure surfaces as {Custom:N}, not the .rpc() mask).
    const livePolicyA = await program.account.policyConfig.fetch(
      vaultA.policyPda,
    );
    const transferIx = await program.methods
      .agentTransfer(new BN(amount), (livePolicyA as any).policyVersion)
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
      .instruction();
    await sendVersionedTx(connection, [transferIx], agentA);

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
    // C-1: a REAL measured spend (inAmount = amount) exercises the devFeeRate=0
    // path — the protocol fee is charged at finalize (to the treasury) while the
    // developer fee is 0, so a null feeDestination is fine. M1 + 6115: outAmount>0
    // acquires a vault-owned output so the require-measurable-outcome gate is
    // satisfied and finalize closes the session cleanly.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vaultB.vaultPda,
      agentB.publicKey,
    );

    const sessionPda = deriveSessionPda(
      vaultB.vaultPda,
      agentB.publicKey,
      mint,
      program.programId,
    );

    // feeDestinationTokenAccount=null is fine when devFeeRate=0
    await authorizeAndFinalize({
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
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vaultB.protocolTreasuryAta,
      feeDestinationAta: null, // vaultB has devFeeRate=0
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vaultB.vaultTokenAta,
        agentBUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agentB.publicKey,
        new BN(50_000_000), // C-1: real measured spend == amount (protocol fee only)
        new BN(1_000),
      ),
    });

    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;
    console.log("    devFeeRate=0 + null feeDestination: succeeded");
  });
});
