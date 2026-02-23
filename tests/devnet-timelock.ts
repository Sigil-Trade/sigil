/**
 * Devnet Timelock Tests — 4 tests (V2)
 *
 * Timelock policy governance: queue, apply (after delay), cancel,
 * and early-apply rejection.
 *
 * Uses timelockDuration=5 (5 seconds) for fast testing.
 *
 * V2: No makeAllowedToken, no allowedTokens in policy, no tracker in
 *     updatePolicy/applyPendingPolicy accounts. Tokens via OracleRegistry.
 *     queuePolicyUpdate takes 10 optional args matching updatePolicy V2.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  deriveSessionPda,
  deriveOracleRegistryPda,
  initializeOracleRegistry,
  makeOracleEntry,
  createFullVault,
  authorizeAndFinalize,
  fundKeypair,
  createTestMint,
  sleep,
  expectError,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-timelock", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mint: PublicKey;
  let oracleRegistryPda: PublicKey;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    mint = await createTestMint(connection, payer, owner.publicKey, 6);

    // Initialize oracle registry with mint as stablecoin
    oracleRegistryPda = await initializeOracleRegistry(program, owner, [
      makeOracleEntry(mint),
    ]);
  });

  /** Create a vault with timelock enabled */
  async function createTimelockVault(timelockDuration: number = 5) {
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

  it("1. update_policy blocked when timelock > 0 (TimelockActive)", async () => {
    const vault = await createTimelockVault();

    try {
      await program.methods
        .updatePolicy(
          new BN(999_000_000), // try to change daily cap
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TimelockActive", "timelock");
    }
    console.log("    Direct update_policy blocked when timelock active");
  });

  it("2. queue + apply after timelock expires", async () => {
    const vault = await createTimelockVault(5);
    const newDailyCap = new BN(999_000_000);

    // Queue policy change (V2: 10 optional args, no allowedTokens)
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
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify pending policy exists
    const pending = await program.account.pendingPolicyUpdate.fetch(
      vault.pendingPolicyPda,
    );
    expect(pending.dailySpendingCapUsd!.toNumber()).to.equal(
      newDailyCap.toNumber(),
    );
    console.log(
      `    Queued: executes at ${pending.executesAt.toNumber()}`,
    );

    // Wait for timelock to expire (5s + 2s buffer)
    await sleep(7000);

    // Apply (V2: no tracker in accounts)
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();

    // Verify policy changed
    const policy = await program.account.policyConfig.fetch(vault.policyPda);
    expect(policy.dailySpendingCapUsd.toNumber()).to.equal(
      newDailyCap.toNumber(),
    );

    // Pending PDA should be closed
    const pendingInfo = await connection.getAccountInfo(
      vault.pendingPolicyPda,
    );
    expect(pendingInfo).to.be.null;
    console.log("    Queue + apply succeeded after timelock expiry");
  });

  it("3. apply before timelock expires fails (TimelockNotExpired)", async () => {
    const vault = await createTimelockVault(60); // 60 seconds — won't expire during test

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
      expectError(err, "TimelockNotExpired", "not expired");
    }

    // Clean up — cancel the pending update
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
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
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();

    // Pending PDA closed
    const pendingInfo = await connection.getAccountInfo(
      vault.pendingPolicyPda,
    );
    expect(pendingInfo).to.be.null;

    // Original policy unchanged
    const policy = await program.account.policyConfig.fetch(vault.policyPda);
    expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);
    console.log("    cancel_pending_policy: PDA closed, policy unchanged");
  });
});
