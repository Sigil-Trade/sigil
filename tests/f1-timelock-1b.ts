/**
 * F-1 fix (timelock-brick close, 2026-06-30) — Option 1b.
 *
 * THE BUG:
 *   `policy.timelock_duration` had a floor (MIN_TIMELOCK_DURATION = 1800s) but
 *   no ceiling. `apply_pending_policy` gated the apply on
 *   `clock.slot - anchor_slot < MAX_APPLY_AGE_SLOTS` (216_000 slots ≈ 24h at
 *   the 400ms slot floor). A timelock near/over ~24h therefore matured only
 *   AFTER the slot freshness window had already closed → the pending policy
 *   update could NEVER apply (a tier-2 liveness brick). The shipped 24h
 *   production preset (`sdk/kit presets.ts` = 86_400s) sat at that brick edge.
 *
 * THE FIX (Option 1b):
 *   1. The policy-apply freshness window now uses the WIDER
 *      `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN` (700_000 slots ≈ 78h) — the same
 *      window the PendingAgentGrant + PendingOwnershipTransfer admin families
 *      already use for their 48h timelock. Every pending policy is timelocked
 *      (`queue_policy_update` requires `timelock_duration > 0`), so the whole
 *      policy-apply path uses it unconditionally.
 *   2. `MAX_TIMELOCK_DURATION = 172_800s (48h)` caps the timelock so it always
 *      matures inside that window (compile-time assert ties the two together),
 *      enforced at EVERY write site (initialize_vault, queue_policy_update, and
 *      the apply-time re-check). New error `TimelockTooLong` (6118).
 *
 * THIS SUITE ASSERTS:
 *   1. queue with timelock > 48h           → TimelockTooLong (queue write site)
 *   2. init with timelock > 48h            → TimelockTooLong (init write site)
 *   3. KEY: a vault with the 86_400s (24h production-preset) timelock can queue
 *      a pending policy update, advance PAST maturity AND past the OLD
 *      216_000-slot window, and STILL apply — proving the brick is closed and
 *      the production preset is now floor-safe (it would have rejected
 *      QueuedUpdateExpired under the old narrow window).
 *   4. a vault at exactly 48h (172_800s) applies a pending update at maturity,
 *      well past the old window, inside the 700_000-slot ceiling.
 *   5. queue timelock == 48h (boundary) is ACCEPTED (the cap is inclusive) and
 *      the new 48h timelock lands in the live policy.
 *   6. the MIN floor still rejects timelock < 1800s (TimelockTooShort) — the
 *      ceiling addition did not disturb the existing floor.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import { fetchAndComputeQueueDigest } from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  advanceTime,
  advancePastSlot,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
import { expectSigilError } from "./helpers/strict-errors";

// Mirror of the on-chain state::MAX_TIMELOCK_DURATION (48h). Duplicated here so
// the Rust constant and the TS expectations are reviewed together on drift.
const MAX_TIMELOCK_DURATION = 172_800;

// Mirror of state::MIN_TIMELOCK_DURATION (30 min).
const MIN_TIMELOCK_DURATION = 1800;

// Mirror of state::MAX_APPLY_AGE_SLOTS (the OLD narrow window the policy-apply
// path used to use). The KEY test warps PAST this to prove the brick is closed.
const OLD_MAX_APPLY_AGE_SLOTS = 216_000;

// Mirror of state::MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN (the wider window the
// policy-apply path now uses).
const MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000;

// The shipped 24h production-preset timelock (sdk/kit presets.ts).
const PRODUCTION_PRESET_TIMELOCK = 86_400;

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);

// Per-agent 2-bit capability values (state/agent.rs).
const CAPABILITY_VIEWER = 1; // OBSERVER
const CAPABILITY_OPERATOR = 2;

describe("f1-timelock-1b (F-1 timelock-brick close 2026-06-30)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 1000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  function derivePdas(vaultId: BN) {
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
    const [auditSuccess] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), vault.toBuffer()],
      program.programId,
    );
    const [auditRejected] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_rejected"), vault.toBuffer()],
      program.programId,
    );
    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.toBuffer()],
      program.programId,
    );
    return {
      vault,
      policy,
      tracker,
      overlay,
      auditSuccess,
      auditRejected,
      pendingPolicy,
    };
  }

  /**
   * Send `initialize_vault` with a parameterized timelock. Returns the RPC
   * promise so callers can either await success or assert rejection.
   */
  function sendInitVault(vaultId: BN, timelockSeconds: number) {
    const pdas = derivePdas(vaultId);
    const timelock = new BN(timelockSeconds);
    return program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1, // protocolMode = ALLOWLIST
        [jupiterProgramId],
        0,
        100,
        timelock,
        [],
        [],
        false, // observeOnly
        0x00ffffff,
        false, // autoPromoteGrays
        5, // autoRevokeThreshold
        new BN(0),
        new BN(0),
        false, // cosignRequired
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: timelock,
          createdAtSlot: Number(svm.getClock().slot),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          cosignRequired: false,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vault,
        policy: pdas.policy,
        tracker: pdas.tracker,
        agentSpendOverlay: pdas.overlay,
        auditLogSuccess: pdas.auditSuccess,
        auditLogRejected: pdas.auditRejected,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async function initVault(vaultId: BN, timelockSeconds: number) {
    await sendInitVault(vaultId, timelockSeconds);
    return derivePdas(vaultId);
  }

  /**
   * Queue a NON-ELEVATED policy update that lowers the daily cap (tightening is
   * never an elevation trigger — only raises are), keeping the apply on the
   * simple no-cosign path. Returns the slot the queue landed at.
   */
  async function queueLowerCap(
    vault: PublicKey,
    policy: PublicKey,
    pendingPolicy: PublicKey,
    newDailyCap: BN,
  ): Promise<number> {
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { dailySpendingCapUsd: newDailyCap },
    );
    await program.methods
      .queuePolicyUpdate(
        newDailyCap, // [0] daily_spending_cap_usd (LOWER → non-elevated)
        null,
        null,
        null,
        null,
        null,
        null, // [6] timelock_duration (pass-through)
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
        null /* protocol_hashes */,
        PublicKey.default, // cosign_session — non-elevated
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
    return Number(svm.getClock().slot);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1. queue with timelock > 48h → TimelockTooLong (queue write site)
  // ───────────────────────────────────────────────────────────────────────
  it("queue_policy_update rejects timelock > MAX_TIMELOCK_DURATION (TimelockTooLong)", async () => {
    const { vault, policy, pendingPolicy } = await initVault(
      new BN(81000),
      MIN_TIMELOCK_DURATION,
    );

    const tooLong = new BN(MAX_TIMELOCK_DURATION + 1); // 172_801s
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { timelockDuration: tooLong },
    );

    try {
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          tooLong, // [6] timelock_duration > 48h
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
          PublicKey.default,
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
      expect.fail("queue_policy_update MUST reject a timelock > 48h");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooLong" });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. init with timelock > 48h → TimelockTooLong (init write site)
  // ───────────────────────────────────────────────────────────────────────
  it("initialize_vault rejects timelock > MAX_TIMELOCK_DURATION (TimelockTooLong)", async () => {
    try {
      await initVault(new BN(81001), MAX_TIMELOCK_DURATION + 1);
      expect.fail("initialize_vault MUST reject a timelock > 48h");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooLong" });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. KEY TEST: 86_400s (production preset) pending update matures and
  //    applies PAST the old 216_000-slot window — brick closed, preset
  //    floor-safe.
  // ───────────────────────────────────────────────────────────────────────
  it("KEY: a 24h (86_400s) production-preset timelock applies past the OLD window — brick closed", async () => {
    const { vault, policy, pendingPolicy } = await initVault(
      new BN(81002),
      PRODUCTION_PRESET_TIMELOCK,
    );

    const newCap = new BN(400_000_000); // lower → non-elevated
    const queuedAtSlot = await queueLowerCap(
      vault,
      policy,
      pendingPolicy,
      newCap,
    );

    // Maturity is governed by the LIVE timelock (86_400s). Advance unix time
    // past it so `is_ready` holds.
    advanceTime(svm, PRODUCTION_PRESET_TIMELOCK + 1);

    // Warp the slot PAST the old 216_000-slot window but well within the new
    // 700_000-slot ceiling. Under the OLD code this is the brick:
    // 216_050 >= 216_000 would reject QueuedUpdateExpired BEFORE the timelock
    // could ever apply. Under the F-1 fix it is fresh.
    const targetSlot = queuedAtSlot + OLD_MAX_APPLY_AGE_SLOTS + 50;
    expect(targetSlot - queuedAtSlot).to.be.greaterThan(
      OLD_MAX_APPLY_AGE_SLOTS,
    );
    expect(targetSlot - queuedAtSlot).to.be.lessThan(
      MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN,
    );
    advancePastSlot(svm, targetSlot);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .rpc();

    const policyState = await program.account.policyConfig.fetch(policy);
    expect(policyState.dailySpendingCapUsd.toString()).to.equal(
      newCap.toString(),
    );
    // The live timelock is unchanged (the update only lowered the cap) and is
    // still the 24h preset — confirming the vault remains in the brick-prone
    // regime yet now applies cleanly.
    expect(policyState.timelockDuration.toString()).to.equal(
      String(PRODUCTION_PRESET_TIMELOCK),
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. 48h (172_800s) pending update applies at maturity within the window.
  // ───────────────────────────────────────────────────────────────────────
  it("a 48h (172_800s) timelock applies at maturity inside the 700_000-slot window", async () => {
    const { vault, policy, pendingPolicy } = await initVault(
      new BN(81003),
      MAX_TIMELOCK_DURATION,
    );

    const newCap = new BN(450_000_000); // lower → non-elevated
    const queuedAtSlot = await queueLowerCap(
      vault,
      policy,
      pendingPolicy,
      newCap,
    );

    advanceTime(svm, MAX_TIMELOCK_DURATION + 1);

    // 48h at the 400ms slot floor ≈ 432_000 slots — far past the old 216k
    // window, comfortably inside the new 700k ceiling.
    const targetSlot = queuedAtSlot + 432_000 + 50;
    expect(targetSlot - queuedAtSlot).to.be.lessThan(
      MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN,
    );
    advancePastSlot(svm, targetSlot);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .rpc();

    const policyState = await program.account.policyConfig.fetch(policy);
    expect(policyState.dailySpendingCapUsd.toString()).to.equal(
      newCap.toString(),
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. queue timelock == 48h (boundary) is ACCEPTED (cap is inclusive) and the
  //    new 48h timelock lands in the live policy.
  // ───────────────────────────────────────────────────────────────────────
  it("queue_policy_update accepts timelock == MAX_TIMELOCK_DURATION (inclusive ceiling) and applies it", async () => {
    const { vault, policy, pendingPolicy } = await initVault(
      new BN(81004),
      MIN_TIMELOCK_DURATION,
    );

    const exactly48h = new BN(MAX_TIMELOCK_DURATION);
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { timelockDuration: exactly48h },
    );

    await program.methods
      .queuePolicyUpdate(
        null,
        null,
        null,
        null,
        null,
        null,
        exactly48h, // [6] timelock_duration == 48h (boundary, allowed)
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
        PublicKey.default,
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
    const queuedAtSlot = Number(svm.getClock().slot);

    // Maturity governed by the LIVE timelock (still 1800s at this point — the
    // new value only takes effect on apply).
    advanceTime(svm, MIN_TIMELOCK_DURATION + 1);
    advancePastSlot(svm, queuedAtSlot + 100);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingPolicy,
      } as any)
      .rpc();

    const policyState = await program.account.policyConfig.fetch(policy);
    expect(policyState.timelockDuration.toString()).to.equal(
      String(MAX_TIMELOCK_DURATION),
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. MIN floor still rejects timelock < 1800s (TimelockTooShort).
  // ───────────────────────────────────────────────────────────────────────
  it("queue_policy_update still rejects timelock < MIN_TIMELOCK_DURATION (TimelockTooShort)", async () => {
    const { vault, policy, pendingPolicy } = await initVault(
      new BN(81005),
      MIN_TIMELOCK_DURATION,
    );

    const tooShort = new BN(MIN_TIMELOCK_DURATION - 1); // 1799s
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      policy,
      vault,
      { timelockDuration: tooShort },
    );

    try {
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          tooShort, // [6] timelock_duration < 1800
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
          PublicKey.default,
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
      expect.fail("queue_policy_update MUST reject a timelock < 1800s");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooShort" });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. SIBLING brick-close: apply_agent_permissions_update matures on the SAME
  //    policy.timelock_duration field, and F-1 moved it onto the wider window
  //    too. A 24h (86_400s) production-preset vault can re-permission an agent
  //    PAST the old 216_000-slot window — proving the sibling brick is closed
  //    (under the old narrow window this apply would QueuedUpdateExpired, the
  //    same brick F-1 closes for the policy path).
  // ───────────────────────────────────────────────────────────────────────
  it("SIBLING: agent re-permissioning on a 24h-preset vault applies past the OLD window — perms brick closed", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(81006),
      PRODUCTION_PRESET_TIMELOCK,
    );

    // Register an OBSERVER agent (register_agent cannot seat OPERATOR directly;
    // the timelocked perms-update path is the elevation route).
    const agent = Keypair.generate();
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_VIEWER, new BN(0))
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

    // Queue an Observer→OPERATOR re-permission. Non-elevated here: the vault is
    // not cosign_required, and the F-Q6 single-key OPERATOR floor is satisfied
    // by policy.timelock_duration (>= MIN). cosign_session = default.
    await program.methods
      .queueAgentPermissionsUpdate(
        agent.publicKey,
        CAPABILITY_OPERATOR,
        new BN(50_000_000),
        new BN(0), // cooldown_seconds
        PublicKey.default, // cosign_session — non-elevated
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Maturity is governed by policy.timelock_duration (86_400s). Advance unix
    // time past it, then warp the slot PAST the old 216_000-slot window but
    // within the new 700_000-slot ceiling — the brick-close proof.
    const queuedAtSlot = Number(svm.getClock().slot);
    advanceTime(svm, PRODUCTION_PRESET_TIMELOCK + 1);

    const targetSlot = queuedAtSlot + OLD_MAX_APPLY_AGE_SLOTS + 50;
    expect(targetSlot - queuedAtSlot).to.be.greaterThan(
      OLD_MAX_APPLY_AGE_SLOTS,
    );
    expect(targetSlot - queuedAtSlot).to.be.lessThan(
      MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN,
    );
    advancePastSlot(svm, targetSlot);

    // Committed-IDL workaround: audit_log_success + slot_hashes sysvar are passed
    // as trailing remaining accounts (see audit-log-coverage.ts / m1-03).
    await program.methods
      .applyAgentPermissionsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms,
        agentSpendOverlay: overlay,
      } as any)
      .remainingAccounts([
        { pubkey: auditSuccess, isSigner: false, isWritable: true },
        {
          pubkey: SYSVAR_SLOT_HASHES_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
      ])
      .rpc();

    const v = await program.account.agentVault.fetch(vault);
    const entry = v.agents.find(
      (a: any) => a.pubkey.toString() === agent.publicKey.toString(),
    );
    expect(entry, "agent entry must exist").to.not.be.undefined;
    expect(entry!.capability).to.equal(CAPABILITY_OPERATOR);
  });
});
