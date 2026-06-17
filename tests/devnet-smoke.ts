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
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  PROTOCOL_TREASURY,
  getDevnetProvider,
  derivePDAs,
  deriveSessionPda,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  nextVaultId,
  sendInitVault,
  sendVersionedTx,
  queueOperatorGrant,
  applyOperatorGrants,
  waitForClusterTime,
  buildMockDefiNoopIx,
  buildQueueDigest,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";
import { expectSigilError } from "./helpers/strict-errors";

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
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    // PEN-CROSS-2: the owner-signed preview digest must bind the EXACT slot
    // initialize_vault executes in (else PolicyPreviewMismatch 6071 on a live
    // clock) — sendInitVault binds + retries.
    await sendInitVault(connection, (owner as any).payer, (createdAtSlot) =>
      program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [MOCK_DEFI_PROGRAM_ID],
          0,
          500,
          new BN(1800),
          [],
          [],
          false, // observeOnly (Phase 2 TA-19)
          0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
          false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
          5, // auto_revoke_threshold (TA-17 Phase 3 — default)
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — disabled)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — disabled)
          false, // cosign_required (G6 audit 2026-05-18 — not opted in)
          initVaultPreviewDigest({
            dailySpendingCapUsd: new BN(500_000_000),
            maxTransactionSizeUsd: new BN(100_000_000),
            maxSlippageBps: 500,
            protocolMode: 1,
            protocols: [MOCK_DEFI_PROGRAM_ID],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
            createdAtSlot,
          }),
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
        .instruction(),
    );

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

  it("3. register_agent (OPERATOR via queue → 600s floor → apply)", async () => {
    // F-Q6: an instant registerAgent(OPERATOR) on a single-key vault reverts
    // (ErrOperatorGrantRequiresTimelock 6107). The lawful devnet path is
    // queue_agent_grant → wait out the on-chain 600s floor → apply_agent_grant.
    const grant = await queueOperatorGrant(
      program,
      connection,
      owner,
      vaultPda,
      agent.publicKey,
      2, // FULL_CAPABILITY (OPERATOR)
    );
    expect(grant.minDelaySeconds).to.equal(600);
    console.log(
      `    OPERATOR grant queued (delay ${grant.minDelaySeconds}s) — waiting it out...`,
    );

    await applyOperatorGrants(program, connection, owner, [grant]);

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.agents[0].pubkey.toString()).to.equal(
      agent.publicKey.toString(),
    );
    console.log("    Agent registered:", agent.publicKey.toString());
  });

  it("4. queue_policy_update (timelock-gated — verify pending PDA)", async () => {
    // updatePolicy deleted; all mutations go through queue/apply.
    // With timelockDuration=1800, we can't apply in a test — just verify the queue.
    // queue_policy_update requires the correctly-merged post-change digest
    // (here: all-null overrides = the live policy re-encoded), else 6071.
    const queueDigest = await buildQueueDigest(program, policyPda, vaultPda);
    await program.methods
      .queuePolicyUpdate(
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
        null,
        null, // destinationMode,
        null, // operating_hours (TA-05 Phase 3)
        null, // stable_balance_floor (TA-12 Phase 5)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5)
        null, // cosign_required (G6 audit 2026-05-18)
        null,
        null, // cosign_session_pubkey (D-5 Phase 10a-B7)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        queueDigest,
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
    // Live policy_version — apply_agent_grant (test 3) bumped it past 0.
    const livePolicy = await program.account.policyConfig.fetch(policyPda);

    // Build validate instruction. F-Q1a: the tx fee payer (agent) is
    // compiled-writable in every instruction of the message, so it must be
    // resolvable from validate's remaining_accounts (else 6105).
    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        new BN(50_000_000), // 50 tokens
        MOCK_DEFI_PROGRAM_ID,
        (livePolicy as any).policyVersion,
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount: new BN(50_000_000),
            targetProtocol: MOCK_DEFI_PROGRAM_ID,
          }),
        ),
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
        outputSwapAccount: null,
      } as any)
      .remainingAccounts([
        { pubkey: agent.publicKey, isSigner: false, isWritable: false },
      ])
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
        outputSwapAccount: null,
      } as any)
      .instruction();

    // Compose [validate, mock-defi noop, finalize] — F-Q2 requires EXACTLY
    // one counted DeFi instruction in the sandwich. The noop moves no tokens,
    // so finalize measures actual_spend == 0.
    await sendVersionedTx(
      connection,
      [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
      agent,
    );

    // Session should be closed (finalize closes it)
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.totalTransactions.toNumber()).to.equal(1);
    // totalVolume uses actual_spend_tracked; the noop moves nothing → 0
    expect(vault.totalVolume.toNumber()).to.equal(0);
    console.log(
      "    Session authorized + finalized in one tx, tx count = 1, volume = 0",
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

  it("8. reactivate_vault (after 5-min anti-thrash cooldown)", async () => {
    // reactivate_vault.rs:127-134 enforces a 300s anti-thrash cooldown from the
    // freeze (test 7's revoke) — ErrReactivateCooldownActive (6097) until it
    // elapses. Devnet has no clock cheatcodes, so wait it out against the
    // cluster clock, reading frozen_at_timestamp from chain for the exact
    // deadline. The cooldown check precedes the F-Q6 capability gate, so this
    // wait is also what makes the 6107 assertion below reachable.
    const REACTIVATE_COOLDOWN_SECONDS = 300;
    const frozen = await program.account.agentVault.fetch(vaultPda);
    const frozenAt = Number((frozen as any).frozenAtTimestamp);
    console.log(
      `    Frozen at ${frozenAt}; waiting out the ${REACTIVATE_COOLDOWN_SECONDS}s reactivate cooldown...`,
    );
    await waitForClusterTime(
      connection,
      frozenAt + REACTIVATE_COOLDOWN_SECONDS + 3,
      "reactivate-cooldown",
    );

    // Cooldown clear. F-Q6 (reactivate_vault.rs:185-200): re-seating an OPERATOR
    // (capability 2) during reactivate is the same instant-grant vector as
    // register_agent — it MUST revert 6107 on a single-key vault. Assert the
    // gate holds on the live cluster, then reactivate with Observer.
    const reactivateOperatorIx = await program.methods
      .reactivateVault(agent.publicKey, 2) // FULL_CAPABILITY — forbidden
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .instruction();
    try {
      await sendVersionedTx(
        connection,
        [reactivateOperatorIx],
        (owner as any).payer,
      );
      expect.fail("instant OPERATOR re-grant should have been rejected");
    } catch (err) {
      expectSigilError(err, { name: "ErrOperatorGrantRequiresTimelock" });
    }

    const reactivateObserverIx = await program.methods
      .reactivateVault(agent.publicKey, 1) // Observer — instant-eligible
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      } as any)
      .instruction();
    await sendVersionedTx(
      connection,
      [reactivateObserverIx],
      (owner as any).payer,
    );

    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(JSON.stringify(vault.status)).to.include("active");
    console.log(
      "    Instant OPERATOR re-grant rejected (6107); reactivated with Observer",
    );
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
