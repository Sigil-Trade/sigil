/**
 * Devnet Transfer Tests — 6 tests (V2)
 *
 * Exercises agent_transfer: destination allowlist enforcement,
 * fee correctness, access control, and spending cap interaction.
 *
 *     Stablecoin-only architecture. agentTransfer requires tokenMintAccount.
 *     Removed per-token max_tx_base test (V1 concept not in V2).
 */
// Strict error helpers — see MEMORY/WORK/20260420-201121_test-assertion-precision-council/
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
  createFullVault,
  applyOperatorGrants,
  sendVersionedTx,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  getTokenBalance,
  calculateFees,
  FullVaultResult,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";

describe("devnet-transfers", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
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
  // Vault with a small (200 USDC) daily cap — test 6
  let smallCapVault: FullVaultResult;

  /**
   * agent_transfer with the LIVE policy_version (the apply_agent_grant
   * seating bumped it past 0) via the unmasked versioned sender — a failure
   * surfaces as {Custom:N} the strict expect-helpers can parse, not the
   * anchor × web3.js "Unknown action 'undefined'" repaint.
   */
  async function sendAgentTransfer(opts: {
    signer: Keypair;
    vault: FullVaultResult;
    destinationTokenAccount: PublicKey;
    amount: BN;
    feeDestinationTokenAccount?: PublicKey | null;
  }): Promise<void> {
    const livePolicy = await program.account.policyConfig.fetch(
      opts.vault.policyPda,
    );
    const ix = await program.methods
      .agentTransfer(opts.amount, (livePolicy as any).policyVersion)
      .accounts({
        agent: opts.signer.publicKey,
        vault: opts.vault.vaultPda,
        policy: opts.vault.policyPda,
        tracker: opts.vault.trackerPda,
        agentSpendOverlay: opts.vault.overlayPda,
        vaultTokenAccount: opts.vault.vaultTokenAta,
        tokenMintAccount: mint,
        destinationTokenAccount: opts.destinationTokenAccount,
        feeDestinationTokenAccount: opts.feeDestinationTokenAccount ?? null,
        protocolTreasuryTokenAccount: opts.vault.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await sendVersionedTx(connection, [ix], opts.signer);
  }

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
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
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
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      allowedDestinations: [],
      depositAmount: new BN(1_000_000_000),
    });

    // Small-cap vault for test 6 — created HERE so its OPERATOR grant shares
    // the single batched 600s wait below instead of paying its own.
    smallCapVault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(6),
      dailyCap: new BN(200_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      // Test 6 transfers to destA at the cap; V2 agent_transfer requires the
      // destination to be explicitly allowlisted (RESTRICTED mode).
      allowedDestinations: [destA.publicKey],
      depositAmount: new BN(1_000_000_000),
    });

    // F-Q6: all three OPERATOR grants were QUEUED by createFullVault — one
    // batched wait for the on-chain 600s single-key floor, then apply all.
    await applyOperatorGrants(program, connection, owner, [
      vaultAllowlist.operatorGrant,
      vaultAnyDest.operatorGrant,
      smallCapVault.operatorGrant,
    ]);

    console.log("  Vault (allowlist):", vaultAllowlist.vaultPda.toString());
    console.log("  Vault (any dest):", vaultAnyDest.vaultPda.toString());
    console.log("  Vault (small cap):", smallCapVault.vaultPda.toString());
  });

  it("1. agent_transfer to allowed destination succeeds", async () => {
    const amount = 10_000_000; // 10 USDC
    const destBefore = await getTokenBalance(connection, destAAta);

    await sendAgentTransfer({
      signer: agent,
      vault: vaultAllowlist,
      destinationTokenAccount: destAAta,
      amount: new BN(amount),
      feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
    });

    const destAfter = await getTokenBalance(connection, destAAta);
    const { netAmount } = calculateFees(amount, 500);
    expect(destAfter - destBefore).to.equal(netAmount);
    console.log(`    Transfer to allowed destination: net=${netAmount}`);
  });

  it("2. agent_transfer to non-allowed destination fails", async () => {
    try {
      await sendAgentTransfer({
        signer: agent,
        vault: vaultAllowlist,
        destinationTokenAccount: destBAta, // destB not in allowlist
        amount: new BN(10_000_000),
        feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "DestinationNotAllowed" });
    }
    console.log("    Non-allowed destination correctly rejected");
  });

  it("3. empty allowlist blocks every agent_transfer destination", async () => {
    // V2 semantic change (was "empty allowlist means any destination works"):
    // destination_mode is hardcoded RESTRICTED and the permissive OPEN_WITH_CAP
    // path was deleted (initialize_vault.rs:314-315). policy.is_destination_allowed
    // (policy.rs:424-428) is therefore `allowed_destinations.contains(owner)` —
    // an EMPTY allowlist allows NOTHING. agent_transfer to any destination on a
    // no-allowlist vault must revert DestinationNotAllowed (6024). This is a
    // strictly TIGHTER guarantee than the old permissive behavior.
    const randomDest = Keypair.generate();
    const randomDestAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      randomDest.publicKey,
    );

    try {
      await sendAgentTransfer({
        signer: agent,
        vault: vaultAnyDest, // allowedDestinations: []
        destinationTokenAccount: randomDestAta.address,
        amount: new BN(10_000_000),
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "DestinationNotAllowed" });
    }
    console.log("    Empty allowlist: all agent_transfer destinations blocked");
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

    await sendAgentTransfer({
      signer: agent,
      vault: vaultAllowlist,
      destinationTokenAccount: destAAta,
      amount: new BN(amount),
      feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
    });

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
      await sendAgentTransfer({
        signer: attacker,
        vault: vaultAllowlist,
        destinationTokenAccount: destAAta,
        amount: new BN(10_000_000),
        feeDestinationTokenAccount: vaultAllowlist.feeDestinationAta,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "UnauthorizedAgent" });
    }
    console.log("    Non-agent agent_transfer rejected");
  });

  it("6. agent_transfer respects daily spending cap", async () => {
    // smallCapVault (200 USDC cap) was created + operator-seated in before().
    // Transfer 200 USDC (at cap)
    await sendAgentTransfer({
      signer: agent,
      vault: smallCapVault,
      destinationTokenAccount: destAAta,
      amount: new BN(200_000_000),
    });

    // 1 more should fail
    try {
      await sendAgentTransfer({
        signer: agent,
        vault: smallCapVault,
        destinationTokenAccount: destAAta,
        amount: new BN(1_000_000),
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "SpendingCapExceeded" });
    }
    console.log("    agent_transfer respects daily cap");
  });
});
