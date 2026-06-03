/**
 * Devnet Timelock Tests — 4 tests (V3)
 *
 * Timelock policy governance: queue, verify pending, early-apply rejection, cancel.
 *
 * Uses timelockDuration=1800 (30 min minimum, mandatory for all vaults).
 *
 * V3: updatePolicy deleted; all mutations go through queue/apply.
 *     Mandatory minimum timelockDuration: 1800.
 *     Test 1 verifies updatePolicy instruction no longer exists.
 */
// Strict error helpers — see MEMORY/WORK/20260420-201121_test-assertion-precision-council/
import { expectSigilError } from "@usesigil/kit/testing";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  deriveSessionPda,
  createFullVault,
  authorizeAndFinalize,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  sleep,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-timelock", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mint: PublicKey;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    mint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
  });

  /** Create a vault with timelock enabled (minimum 1800s) */
  async function createTimelockVault(timelockDuration: number = 1800) {
    return createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(8),
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      timelockDuration: new BN(timelockDuration),
      depositAmount: new BN(500_000_000),
    });
  }

  it("1. updatePolicy instruction no longer exists (deleted in TOCTOU fix)", async () => {
    // The updatePolicy instruction was removed — all policy mutations now go
    // through queuePolicyUpdate + applyPendingPolicy. Verify at the TypeScript level.
    expect((program.methods as any).updatePolicy).to.be.undefined;
    console.log("    updatePolicy correctly absent from program methods");
  });

  it("2. queue_policy_update creates pending PDA with correct values", async () => {
    const vault = await createTimelockVault(1800);
    const newDailyCap = new BN(999_000_000);

    // Queue policy change (12 args — includes sessionExpirySeconds)
    await program.methods
      .queuePolicyUpdate(
        newDailyCap,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null, // destinationMode,
        null, // operating_hours (TA-05 Phase 3)
        null, // stable_balance_floor (TA-12 Phase 5)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5)
        null, // cosign_required (G6 audit 2026-05-18)
        null,
        null, // cosign_session_pubkey (D-5 Phase 10a-B7)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        new Array(32).fill(0), // newPolicyPreviewDigest (Phase 2 TA-19 placeholder)
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify pending policy exists with expected values
    const pending = await program.account.pendingPolicyUpdate.fetch(
      vault.pendingPolicyPda,
    );
    expect(pending.dailySpendingCapUsd!.toNumber()).to.equal(
      newDailyCap.toNumber(),
    );
    console.log(`    Queued: executes at ${pending.executesAt.toNumber()}`);

    // Clean up — cancel so the vault can be reused
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();
    console.log("    Queue verified + cancelled");
  });

  it("3. apply before timelock expires fails (TimelockNotExpired)", async () => {
    const vault = await createTimelockVault(1800); // 1800 seconds — won't expire during test

    // Queue
    await program.methods
      .queuePolicyUpdate(
        new BN(888_000_000),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null, // destinationMode,
        null, // operating_hours (TA-05 Phase 3)
        null, // stable_balance_floor (TA-12 Phase 5)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5)
        null, // cosign_required (G6 audit 2026-05-18)
        null,
        null, // cosign_session_pubkey (D-5 Phase 10a-B7)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        new Array(32).fill(0), // newPolicyPreviewDigest (Phase 2 TA-19 placeholder)
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Immediately try apply (V2: no tracker in accounts)
    try {
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          pendingPolicy: vault.pendingPolicyPda,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockNotExpired" });
    }

    // Clean up — cancel the pending update
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();
    console.log("    Apply before expiry correctly rejected");
  });

  it("4. cancel_pending_policy removes queued change", async () => {
    const vault = await createTimelockVault();

    // Queue
    await program.methods
      .queuePolicyUpdate(
        new BN(777_000_000),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null, // destinationMode,
        null, // operating_hours (TA-05 Phase 3)
        null, // stable_balance_floor (TA-12 Phase 5)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5)
        null, // cosign_required (G6 audit 2026-05-18)
        null,
        null, // cosign_session_pubkey (D-5 Phase 10a-B7)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        new Array(32).fill(0), // newPolicyPreviewDigest (Phase 2 TA-19 placeholder)
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Cancel
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();

    // Pending PDA closed
    const pendingInfo = await connection.getAccountInfo(vault.pendingPolicyPda);
    expect(pendingInfo).to.be.null;

    // Original policy unchanged
    const policy = await program.account.policyConfig.fetch(vault.policyPda);
    expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);
    console.log("    cancel_pending_policy: PDA closed, policy unchanged");
  });
});
