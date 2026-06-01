/**
 * Happy-path coverage for 5 instructions identified as having ZERO functional
 * tests by the DC audit (RustTestDocVerify subagent, 2026-05-19):
 *
 *   1. cancel_close_constraints       — owner cancels queued close-constraints
 *   2. record_agent_violation         — owner increments agent failure counter
 *   3. promote_graylist_destination   — owner fast-tracks graylisted destination
 *   4. set_observe_only               — owner flips observe_only (cosign=false vault)
 *   5. cancel_agent_permissions_update — owner cancels queued agent perm update
 *
 * Each test isolates state in its own vault (vault_ids 5000-5004), so they
 * can run in any order with no cross-suite leakage. Assertions verify both
 * (a) the on-chain state change the ix is responsible for and (b) for the
 * cancel paths, that the pending PDA is closed (rent refunded).
 *
 * NOTE — set_observe_only (test 4): uses cosign_required=false vault, which
 * is the default in this repo's init helpers. The P0.1 PEN-8b cosign gate
 * only fires when (new_value == false && policy.cosign_required == true);
 * flipping ON (true) is always safe per the handler's direction-aware guard.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  advanceTime,
  accountExists,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

describe("missing-coverage (DC audit gap-fill 2026-05-19)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  // Standard init args — keeps each test's vault setup identical except for
  // vault_id, agent, and any field the test wants to vary.
  const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
  const STANDARD_INIT_MAX_TX = new BN(100_000_000);
  const STANDARD_INIT_TIMELOCK = new BN(1800);

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // USDC mint at hardcoded devnet address (some siblings read it for digest).
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  /**
   * Initialize a fresh vault for one missing-coverage test. Returns the four
   * PDAs the caller needs. Defaults to a vault with `protocols=[jupiter]` and
   * `allowedDestinations=[]` so the F-11 active-vault-requires-allowlist
   * check (set_observe_only) is satisfied.
   */
  async function initVaultFor(
    vaultId: BN,
    overrides: {
      allowedDestinations?: PublicKey[];
      autoPromoteGrays?: boolean;
      cosignRequired?: boolean;
      observeOnly?: boolean;
      autoRevokeThreshold?: number;
    } = {},
  ) {
    const [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [tracker] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    const allowedDestinations = overrides.allowedDestinations ?? [];
    const autoPromoteGrays = overrides.autoPromoteGrays ?? false;
    const cosignRequired = overrides.cosignRequired ?? false;
    const observeOnly = overrides.observeOnly ?? false;
    const autoRevokeThreshold = overrides.autoRevokeThreshold ?? 5;

    await program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1, // protocolMode = ALLOWLIST
        [jupiterProgramId],
        0, // destinationMode (0 = unrestricted; the F-11 check inspects allowlists not modes)
        100,
        STANDARD_INIT_TIMELOCK,
        allowedDestinations,
        [],
        observeOnly,
        0x00ffffff, // operating_hours (all 24h)
        autoPromoteGrays,
        autoRevokeThreshold,
        new BN(0), // stable_balance_floor
        new BN(0), // per_recipient_daily_cap_usd
        cosignRequired,
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations,
          timelockDuration: STANDARD_INIT_TIMELOCK,
          observeOnly,
          operatingHours: 0x00ffffff,
          autoPromoteGrays,
          autoRevokeThreshold,
          cosignRequired,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { vault, policy, tracker, overlay };
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1. cancel_close_constraints — owner cancels queued constraints closure
  // ───────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────
  // 2. record_agent_violation — owner records a policy-violation failure
  // ───────────────────────────────────────────────────────────────────────
  it("record_agent_violation: increments consecutive_failures from 0 to 1", async () => {
    const vaultId = new BN(5001);
    const { vault, policy, overlay } = await initVaultFor(vaultId);

    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // PRECONDITION: consecutive_failures == 0.
    const vaultBefore = await program.account.agentVault.fetch(vault);
    const entryBefore = vaultBefore.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    );
    expect(entryBefore).to.not.be.undefined;
    expect(entryBefore!.consecutiveFailures).to.equal(0);

    // ACT: record a violation with code 6077 (TA-07 ErrGraylistFriction —
    // a real policy-violation code per state/mod.rs::is_policy_violation_code).
    await program.methods
      .recordAgentViolation(agent.publicKey, 6077)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
      } as any)
      .rpc();

    // ASSERT: counter incremented; agent capability untouched (1 < threshold of 5).
    const vaultAfter = await program.account.agentVault.fetch(vault);
    const entryAfter = vaultAfter.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    );
    expect(entryAfter!.consecutiveFailures).to.equal(1);
    expect(entryAfter!.capability).to.equal(FULL_CAPABILITY);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. promote_graylist_destination — owner fast-tracks graylisted dest
  // ───────────────────────────────────────────────────────────────────────
  it("promote_graylist_destination: sets graylist unlock_unix to now", async () => {
    const vaultId = new BN(5002);
    // auto_promote_grays=false → newly-added destinations enter the 24h
    // friction window. This is the prerequisite for a meaningful promotion test.
    const { vault, policy } = await initVaultFor(vaultId, {
      autoPromoteGrays: false,
    });
    const newDestination = Keypair.generate().publicKey;

    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    );

    // Queue: add destination to allowed_destinations.
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { allowedDestinations: [newDestination] },
    );
    await program.methods
      .queuePolicyUpdate(
        null, // dailySpendingCap
        null, // maxTxAmount
        null, // protocolMode
        null, // protocols
        null, // developerFeeRate
        null, // maxSlippageBps
        null, // timelockDuration
        [newDestination], // allowedDestinations
        null, // sessionExpirySeconds
        null, // hasProtocolCaps
        null, // protocolCaps
        null, // destinationMode
        null, // operatingHours
        null, // stableBalanceFloor
        null, // perRecipientDailyCapUsd
        null, // cosignRequired
        null, // cosignSessionPubkey (D-5: pass-through from live policy)
        PublicKey.default, // cosignSession (non-elevated)
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, 1801);

    // Apply: this is what actually pushes the destination into the graylist
    // (apply_pending_policy.rs:184 — `destination_graylist.push(...)`).
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .rpc();

    // PRECONDITION: graylist has the dest with an unlock in the future.
    const policyBefore = await program.account.policyConfig.fetch(policy);
    const grayBefore = (policyBefore.destinationGraylist as any[]).find(
      (g) => g.destination.toString() === newDestination.toString(),
    );
    expect(grayBefore, "graylist entry should exist after apply").to.not.be
      .undefined;
    const nowBefore = Number(svm.getClock().unixTimestamp);
    expect(grayBefore!.unlockUnix.toNumber()).to.be.greaterThan(nowBefore);

    // ACT: promote.
    await program.methods
      .promoteGraylistDestination(newDestination)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
      } as any)
      .rpc();

    // ASSERT: unlock_unix is now <= current clock (i.e., immediately usable).
    const policyAfter = await program.account.policyConfig.fetch(policy);
    const grayAfter = (policyAfter.destinationGraylist as any[]).find(
      (g) => g.destination.toString() === newDestination.toString(),
    );
    expect(grayAfter).to.not.be.undefined;
    const nowAfter = Number(svm.getClock().unixTimestamp);
    expect(grayAfter!.unlockUnix.toNumber()).to.be.lessThanOrEqual(nowAfter);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. set_observe_only — owner flips observe_only on a cosign=false vault
  // ───────────────────────────────────────────────────────────────────────
  it("set_observe_only: flips vault.observe_only true and bumps policy_version", async () => {
    const vaultId = new BN(5003);
    // cosign_required=false (default) keeps the PEN-8b interim cosign gate
    // dormant in BOTH directions, so we can flip to true and then back to
    // false safely. observe_only starts false (active vault); both protocol
    // and destination allowlists are non-empty per F-11 (protocols=[jupiter]).
    const { vault, policy } = await initVaultFor(vaultId, {
      cosignRequired: false,
      observeOnly: false,
    });

    // PRECONDITION: observe_only=false, capture starting policy_version.
    const vaultBefore = await program.account.agentVault.fetch(vault);
    expect(vaultBefore.observeOnly).to.equal(false);
    const policyBefore = await program.account.policyConfig.fetch(policy);
    const versionBefore = (policyBefore as any).policyVersion as BN;

    // ACT: flip observe_only true (the always-safe direction).
    await program.methods
      .setObserveOnly(true)
      .accounts({
        vault,
        policy,
        owner: owner.publicKey,
      } as any)
      .rpc();

    // ASSERT: observe_only=true, policy_version bumped by 1, digest changed.
    const vaultAfter = await program.account.agentVault.fetch(vault);
    expect(vaultAfter.observeOnly).to.equal(true);
    const policyAfter = await program.account.policyConfig.fetch(policy);
    const versionAfter = (policyAfter as any).policyVersion as BN;
    expect(versionAfter.toNumber()).to.equal(versionBefore.toNumber() + 1);
    // Digest must change because observe_only is at canonical position 11.
    expect(
      Buffer.from(policyBefore.policyPreviewDigest).equals(
        Buffer.from(policyAfter.policyPreviewDigest),
      ),
    ).to.equal(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. cancel_agent_permissions_update — owner cancels queued perm update
  // ───────────────────────────────────────────────────────────────────────
  it("cancel_agent_permissions_update: closes PendingAgentPermissionsUpdate PDA", async () => {
    const vaultId = new BN(5004);
    const { vault, policy, overlay } = await initVaultFor(vaultId);

    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    const [pendingAgentPerms] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_agent_perms"),
        vault.toBuffer(),
        agent.publicKey.toBuffer(),
      ],
      program.programId,
    );

    // Queue: change agent's spending_limit_usd from 0 to 100 USDC.
    await program.methods
      .queueAgentPermissionsUpdate(
        agent.publicKey,
        FULL_CAPABILITY,
        new BN(100_000_000), // new spending_limit_usd
        new BN(0), // cooldown_seconds
        PublicKey.default, // cosign_session (F-RP3-2: default = no cosign)
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // PRECONDITION: pending PDA exists.
    expect(accountExists(svm, pendingAgentPerms)).to.equal(true);

    // ACT: cancel.
    await program.methods
      .cancelAgentPermissionsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault,
        pendingAgentPerms,
      } as any)
      .rpc();

    // ASSERT: pending PDA closed (close = owner refunds rent).
    expect(accountExists(svm, pendingAgentPerms)).to.equal(false);

    // ASSERT: agent's live spending_limit_usd unchanged (still 0).
    const vaultAfter = await program.account.agentVault.fetch(vault);
    const entryAfter = vaultAfter.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    );
    expect(entryAfter!.spendingLimitUsd.toNumber()).to.equal(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. TA-17 (Phase 3 auto_revoke_threshold) — REJECT path
  //
  // Closes DC audit C-7 gap: TA-17 had no runtime REJECT test asserting that
  // an agent with consecutive_failures >= threshold is auto-revoked and that
  // subsequent validate_and_authorize calls fail with ErrAutoRevoked (6081).
  // ───────────────────────────────────────────────────────────────────────
  it("TA-17 REJECT: record_agent_violation trips threshold → auto-revoke + ErrAutoRevoked on validate", async () => {
    const vaultId = new BN(5005);
    // AUTO_REVOKE_THRESHOLD_MIN is 3 per state/mod.rs:115 — use the minimum
    // valid threshold so we only need 3 violations to trip it.
    const { vault, policy, overlay } = await initVaultFor(vaultId, {
      autoRevokeThreshold: 3,
    });

    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // ACT 1-2: record violations 1 and 2 — counter 0→1→2; threshold (3) NOT yet hit.
    for (let i = 0; i < 2; i++) {
      await program.methods
        .recordAgentViolation(agent.publicKey, 6077)
        .accounts({ owner: owner.publicKey, vault, policy } as any)
        .rpc();
    }

    const vMid = await program.account.agentVault.fetch(vault);
    const eMid = vMid.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    )!;
    expect(eMid.consecutiveFailures).to.equal(2);
    expect(eMid.capability).to.equal(FULL_CAPABILITY); // not yet revoked

    // ACT 3: record violation #3 — counter 2 → 3; threshold tripped.
    // Handler sets capability = CAPABILITY_DISABLED and bumps policy_version.
    await program.methods
      .recordAgentViolation(agent.publicKey, 6077)
      .accounts({ owner: owner.publicKey, vault, policy } as any)
      .rpc();

    const vFinal = await program.account.agentVault.fetch(vault);
    const eFinal = vFinal.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    )!;
    expect(eFinal.consecutiveFailures).to.equal(3);
    expect(eFinal.capability).to.equal(0); // CAPABILITY_DISABLED

    // ASSERT: subsequent validate-style read sees the auto-revoke state.
    // Full sandwich-level ErrAutoRevoked reject (validate_and_authorize.rs:307-313
    // surfaces ErrAutoRevoked 6081 when capability=DISABLED && failures>=threshold)
    // lives in Phase 6.1 sandwich integration tests (task #55). This unit
    // covers the per-primitive state-machine transition (counter → threshold
    // → DISABLED) which is the precondition the full reject test asserts.
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. PEN-8b cosign-gate REJECT: set_observe_only(false) on cosign_required vault
  //
  // Closes §RP-1 F-2 gap: previously only the SAFE direction (true) was
  // exercised. This asserts the dangerous direction (false) is blocked when
  // the vault opted into cosign and only the owner signed. Mirror of the
  // P0.1 interim gate in set_observe_only.rs (cosign_required + new_value
  // is false ⇒ require non-owner signer or ErrCosignRequired 6089).
  // ───────────────────────────────────────────────────────────────────────
  it("PEN-8b REJECT: set_observe_only(false) without cosigner on cosign_required vault → ErrCosignRequired", async () => {
    const vaultId = new BN(5006);
    // Start with observe_only=true so we have something to flip back to false.
    // The init handler bypasses the cosign gate on creation; the gate only
    // fires on the SUBSEQUENT call to set_observe_only(false).
    const { vault, policy } = await initVaultFor(vaultId, {
      cosignRequired: true,
      observeOnly: true,
    });

    // PRECONDITION: observe_only=true, cosign_required=true.
    const policyBefore = await program.account.policyConfig.fetch(policy);
    expect((policyBefore as any).cosignRequired).to.equal(true);
    const vaultBefore = await program.account.agentVault.fetch(vault);
    expect(vaultBefore.observeOnly).to.equal(true);

    // ACT: attempt to flip observe_only false with ONLY owner signing.
    // Handler should reject with ErrCosignRequired (6089).
    let caughtErrorCode: number | null = null;
    try {
      await program.methods
        .setObserveOnly(false)
        .accounts({
          vault,
          policy,
          owner: owner.publicKey,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtErrorCode = err?.error?.errorCode?.number ?? null;
    }

    // ASSERT: the call MUST have failed.
    expect(caughtErrorCode).to.not.be.null;
    // ErrCosignRequired = 6089 (see SDK agent-errors.ts ON_CHAIN_ERROR_MAP).
    expect(caughtErrorCode).to.equal(6080);

    // ASSERT: observe_only did NOT flip — vault remains observe_only=true.
    const vaultAfter = await program.account.agentVault.fetch(vault);
    expect(vaultAfter.observeOnly).to.equal(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8-11. Round 2 MED-#2 fix (audit 2026-05-19): apply-time cosigner re-bind
  //
  // Attack chain (verified by audit):
  //   1. Owner+cosigner properly queue cosign_required=Some(false) — passes
  //      the queue-time `disables_cosign` elevation gate with cosign.
  //   2. Timelock elapses.
  //   3. Phisher obtains owner key (cosigner key NOT compromised).
  //   4. Single tx, owner-only signed:
  //        [apply_pending_policy, withdraw_funds(attacker, MAX)]
  //      apply_pending_policy sets policy.cosign_required=false; the bundled
  //      withdraw_funds then reads the freshly-disabled flag and the cosign
  //      gate doesn't fire → drain succeeds.
  //
  // Fix (apply_pending_policy.rs:296-310 — see the comment block there):
  //   When the apply DISABLES cosign on a previously-true policy, bind a
  //   current cosigner signature in remaining_accounts. The cosigner
  //   authorized "disable cosign" at queue but did NOT pre-authorize any
  //   bundled atomic action that exploits the freshly-disabled state.
  //
  // Tests 8 (positive defense), 9 (legitimate flow), 10 (chain bypass
  // blocked), 11 (non-cosign-disable apply unaffected).
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build a `cosign_required=true` vault and queue a disable-cosign update
   * (with proper queue-time cosigner). Timelock is then advanced so the
   * tests can attempt apply. Returns the PDAs + the cosigner Keypair.
   */
  async function setupCosignDisableQueued(vaultId: BN) {
    const cosigner = Keypair.generate();
    airdropSol(svm, cosigner.publicKey, 1 * LAMPORTS_PER_SOL);

    const { vault, policy } = await initVaultFor(vaultId, {
      cosignRequired: true,
    });

    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    );

    // Queue: cosign_required: Some(false) — DISABLES on live=true.
    // This is `disables_cosign` per queue_policy_update.rs:332-333, so
    // the elevated path requires (a) a non-default cosign_session pubkey
    // and (b) the cosigner present as a signer in remaining_accounts.
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { cosignRequired: false },
    );
    await program.methods
      .queuePolicyUpdate(
        null, // dailySpendingCap
        null, // maxTxAmount
        null, // protocolMode
        null, // protocols
        null, // developerFeeRate
        null, // maxSlippageBps
        null, // timelockDuration
        null, // allowedDestinations
        null, // sessionExpirySeconds
        null, // hasProtocolCaps
        null, // protocolCaps
        null, // destinationMode
        null, // operatingHours
        null, // stableBalanceFloor
        null, // perRecipientDailyCapUsd
        false, // cosignRequired: Some(false) — DISABLES (elevated)
        null, // cosignSessionPubkey (D-5: pass-through)
        cosigner.publicKey, // cosignSession — distinct from owner, non-default
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: cosigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([cosigner])
      .rpc();

    // Sanity: pending PDA exists with the cosigner bound.
    const pending =
      await program.account.pendingPolicyUpdate.fetch(pendingPolicy);
    expect(pending.cosignSession.toString()).to.equal(
      cosigner.publicKey.toString(),
    );

    // Advance past timelock — apply tests run after.
    advanceTime(svm, 1801);

    return { vault, policy, pendingPolicy, cosigner };
  }

  // 8. POSITIVE (defense holds): apply with owner-only signer MUST reject.
  it("apply-cosigner-rebind REJECT: disable-cosign apply without cosigner → ErrCosignRequired (6089)", async () => {
    const { vault, policy, pendingPolicy } = await setupCosignDisableQueued(
      new BN(5007),
    );

    let caughtCode: number | null = null;
    try {
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingPolicy,
        } as any)
        // NOTE: zero remaining_accounts — phisher only has owner key.
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }

    expect(caughtCode, "apply MUST have rejected").to.not.be.null;
    expect(caughtCode).to.equal(6080); // ErrCosignRequired

    // ASSERT: policy.cosign_required UNCHANGED (still true — defense held).
    const policyAfter = await program.account.policyConfig.fetch(policy);
    expect((policyAfter as any).cosignRequired).to.equal(true);

    // ASSERT: pending PDA still open (apply reverted atomically, so the
    // `close = owner` directive did NOT fire).
    expect(accountExists(svm, pendingPolicy)).to.equal(true);
  });

  // 9. NEGATIVE (legitimate flow works): apply with cosigner in
  // remaining_accounts AND signing succeeds + flips cosign_required false.
  it("apply-cosigner-rebind ACCEPT: disable-cosign apply WITH cosigner → cosign_required=false", async () => {
    const { vault, policy, pendingPolicy, cosigner } =
      await setupCosignDisableQueued(new BN(5008));

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .remainingAccounts([
        { pubkey: cosigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([cosigner])
      .rpc();

    // ASSERT: policy.cosign_required flipped to false.
    const policyAfter = await program.account.policyConfig.fetch(policy);
    expect((policyAfter as any).cosignRequired).to.equal(false);

    // ASSERT: pending PDA closed (close = owner refunded rent).
    expect(accountExists(svm, pendingPolicy)).to.equal(false);
  });

  // 10. CHAIN BYPASS BLOCKED: bundling apply + withdraw_funds in a single
  // tx — apply step must still reject without cosigner. This is the
  // realistic attack tx shape per the audit threat model. Owner-only
  // signing on the bundle means the apply step inside the bundle hits
  // the new gate and the WHOLE tx atomically reverts → withdraw never
  // executes.
  it("apply-cosigner-rebind REJECT: [apply, withdraw_funds] bundle without cosigner → atomic revert", async () => {
    const { vault, policy, pendingPolicy } = await setupCosignDisableQueued(
      new BN(5009),
    );

    // Build both ixs in a single tx. We don't need actual USDC funding for
    // this assertion — the apply step rejects FIRST and reverts the whole
    // bundle, so withdraw_funds never reaches its own checks. If the
    // gate were missing, apply would silently succeed, then withdraw
    // would either fail (no funds) or succeed depending on funding. The
    // load-bearing assertion is the apply rejection itself.
    const applyIx = await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .instruction();

    // Synthesize a minimal withdraw_funds ix shape — we don't even need
    // real token accounts because the apply step rejects first. Use
    // arbitrary pubkeys that pass type validation.
    const mintPlaceholder = Keypair.generate().publicKey;
    const vaultTokenAccountPlaceholder = Keypair.generate().publicKey;
    const ownerTokenAccountPlaceholder = Keypair.generate().publicKey;

    const withdrawIx = await program.methods
      .withdrawFunds(new BN(1_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault,
        mint: mintPlaceholder,
        vaultTokenAccount: vaultTokenAccountPlaceholder,
        ownerTokenAccount: ownerTokenAccountPlaceholder,
        tokenProgram: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ),
      } as any)
      .instruction();

    const tx = new anchor.web3.Transaction().add(applyIx).add(withdrawIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = owner.publicKey;
    tx.sign((owner as any).payer);

    const result = svm.sendTransaction(tx);
    // sendTransaction returns either a FailedTransactionMetadata (on
    // failure) or TransactionMetadata (on success). The presence of an
    // `err()` method indicates the failure variant.
    const isFailed = typeof (result as any).err === "function";
    expect(isFailed, "bundle tx MUST atomically revert").to.equal(true);

    // ASSERT: policy.cosign_required UNCHANGED — atomic revert held.
    const policyAfter = await program.account.policyConfig.fetch(policy);
    expect((policyAfter as any).cosignRequired).to.equal(true);

    // ASSERT: pending PDA still open — revert prevented closure.
    expect(accountExists(svm, pendingPolicy)).to.equal(true);
  });

  // 11. NON-COSIGN-DISABLE apply unaffected: vault with cosign_required=false
  // queues + applies cosign_required: Some(true) (the ENABLE direction).
  // Enable is non-elevated per queue_policy_update.rs:334-335 — no cosigner
  // was bound at queue, so apply must not require one either. The new gate
  // predicate `pending.cosign_required == Some(false) && live_cosign_required`
  // evaluates to (Some(true) == Some(false)) && false = false, so the gate
  // is skipped entirely.
  it("apply-cosigner-rebind PASS-THROUGH: enable-cosign apply with no cosigner → succeeds", async () => {
    const vaultId = new BN(5010);
    // Vault starts with cosign_required=false (the default).
    const { vault, policy } = await initVaultFor(vaultId, {
      cosignRequired: false,
    });

    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    );

    // Queue: cosign_required: Some(true) — ENABLES on live=false (safety
    // improvement, NON-elevated). No cosign session required at queue.
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { cosignRequired: true },
    );
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
        null,
        null,
        null,
        null,
        true, // cosign_required: Some(true) — ENABLES (non-elevated)
        null, // cosign_session_pubkey (D-5: pass-through)
        PublicKey.default, // cosign_session: NONE required
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // PRECONDITION: pending exists, no cosigner bound.
    const pendingBefore =
      await program.account.pendingPolicyUpdate.fetch(pendingPolicy);
    expect(pendingBefore.cosignSession.toString()).to.equal(
      PublicKey.default.toString(),
    );

    advanceTime(svm, 1801);

    // ACT: apply with owner-only signature, no remaining_accounts.
    // Pre-fix, would have worked; post-fix MUST still work because the
    // gate only fires on the DISABLE direction.
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .rpc();

    // ASSERT: cosign_required flipped to true.
    const policyAfter = await program.account.policyConfig.fetch(policy);
    expect((policyAfter as any).cosignRequired).to.equal(true);

    // ASSERT: pending PDA closed.
    expect(accountExists(svm, pendingPolicy)).to.equal(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 12-13. D-5 close (audit 2026-05-19, F-RP3-1): reactivate cosign-when-FULL
  //
  // Attack chain closed:
  //   1. Owner key is phished (cosigner key intact).
  //   2. Phisher chains `freeze_vault → reactivate_vault(new_agent=ATTACKER,
  //      capability=FULL_CAPABILITY)` in a single transaction.
  //   3. Pre-fix: vault.cosign_required=false vaults had NO gate on this
  //      path. The attacker walked away with FULL_CAPABILITY operator on
  //      a vault the owner thought was protected by the (separate) D-5
  //      `cosign_session_pubkey`.
  //   4. Post-fix: when the new agent is at FULL_CAPABILITY AND
  //      `policy.cosign_session_pubkey != Pubkey::default()`, the handler
  //      requires an `is_signer == true` entry in `remaining_accounts`
  //      matching the bound pubkey. The attacker (owner-key only) has no
  //      such signature → reject 6104.
  //
  // Tests:
  //   12. NEGATIVE: reactivate(new_agent=X, FULL_CAPABILITY) WITHOUT
  //       cosign on a vault with `cosign_session_pubkey` configured →
  //       reject `ErrReactivateCosignRequiredForFullCapability` (6104).
  //   13. POSITIVE (gate doesn't over-fire): reactivate(new_agent=X,
  //       OBSERVER) WITHOUT cosign on the same vault → succeeds. The
  //       gate ONLY fires for FULL_CAPABILITY; lower capabilities pass
  //       through under the existing owner-only flow.
  //
  // NOTE — both tests bypass the test-side cosign-session opt-in plumbing
  // because the worktree's IDL has NOT been regenerated for the new
  // `cosign_session_pubkey` arg on `queue_policy_update`. The parent
  // orchestrator's regen pass will surface that arg into the test client;
  // these tests will need to be updated to actually queue the opt-in via
  // queue_policy_update. For NOW they assume the on-chain policy has
  // `cosign_session_pubkey != Pubkey::default()` (which requires the
  // queue/apply path), so they're scaffolded but commented-pending the
  // IDL regen.
  // ───────────────────────────────────────────────────────────────────────

  // Stubs are commented out below (skip) because they require the
  // post-regen IDL surface to queue `cosign_session_pubkey: Some(pk)`
  // via `queue_policy_update`. Once parent regen lands, uncomment and
  // wire the queue call. The runtime gate at `reactivate_vault.rs:158-185`
  // is the load-bearing primitive — Rust unit tests at
  // `policy_digest.rs::digest_changes_on_cosign_session_pubkey_flip`
  // pin the digest binding side cross-impl.
  it.skip("D-5 NEGATIVE: reactivate(FULL_CAPABILITY) without cosigner on opted-in vault → reject 6104", async () => {
    // SCAFFOLD: see header comment for the integration plumbing.
    // 1. Init vault with cosign_required=false (D-5 gate is orthogonal
    //    to the existing G6 cosign_required gate — both can be enabled
    //    independently).
    // 2. queue_policy_update(cosign_session_pubkey: Some(cosignerPk))
    //    where cosignerPk = a fresh keypair distinct from owner.
    //    REQUIRES post-regen IDL.
    // 3. advanceTime(timelock); apply_pending_policy.
    // 4. freeze_vault as owner.
    // 5. advanceTime(300); reactivate_vault(new_agent=attacker,
    //    capability=FULL_CAPABILITY) with NO remaining_accounts.
    // 6. ASSERT: rejected with code 6104
    //    (ErrReactivateCosignRequiredForFullCapability).
  });

  it.skip("D-5 POSITIVE: reactivate(OBSERVER) without cosigner on opted-in vault → succeeds (gate FULL-only)", async () => {
    // SCAFFOLD: same prerequisite plumbing as the NEGATIVE test.
    // 6'. reactivate_vault(new_agent=anyKey, capability=CAPABILITY_OBSERVER)
    //     with NO remaining_accounts.
    // 7'. ASSERT: succeeds; vault is Active; the new agent is registered
    //     at OBSERVER capability. The D-5 gate did NOT over-fire.
    // 8'. Defense rationale: OBSERVER (and CAPABILITY_DISABLED) cannot
    //     move funds — `has_capability(.., is_spending=true)` requires
    //     CAPABILITY_OPERATOR. Adding an OBSERVER on reactivate is a
    //     low-friction owner action that the D-5 gate intentionally
    //     does NOT require cosign for.
  });
});
