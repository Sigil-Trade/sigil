/**
 * CH-1 close (Bucket-3 audit 2026-05-23) — F-10 freshness on the two
 * TIMELOCKED-ADMIN pending PDA families.
 *
 * Background:
 *   - The 4 NON-admin pending PDAs (policy, agent_perms, constraints,
 *     close_constraints) have MIN_TIMELOCK_DURATION = 1800s (30 min)
 *     and use `MAX_APPLY_AGE_SLOTS = 216_000` (~24h) as their F-10
 *     freshness ceiling.
 *   - PendingAgentGrant + PendingOwnershipTransfer have
 *     `DEFAULT_MIN_DELAY = 172_800s (48h)`. The 216_000-slot ceiling
 *     would reject legitimate apply attempts that come AFTER the 48h
 *     timelock matures.
 *   - CH-1 adds `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000` (~78h)
 *     so these two admin PDAs get an F-10 ceiling that absorbs the 48h
 *     timelock + 24h owner-grace + 6h network-clock-skew margin.
 *
 * This suite asserts:
 *   1. Stale `pending_agent_grant` (slot delta >= 700_000) rejects with
 *      `QueuedUpdateExpired` (6061) — the Drift-April-2026 durable-nonce
 *      pre-signed replay class.
 *   2. Stale `pending_ownership_transfer` rejects identically — proves
 *      the cap applies to both admin families uniformly.
 *   3. Fresh `pending_agent_grant` within the 700_000-slot window (with
 *      timelock satisfied) applies successfully — proves CH-1 does NOT
 *      regress the legitimate 48h-elapsed path.
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

// Mirrors PendingAgentGrant::DEFAULT_MIN_DELAY (48h) — see
// state/pending_agent_grant.rs.
const PENDING_AGENT_GRANT_DELAY = 172_800;

// Mirrors PendingOwnershipTransfer::DEFAULT_MIN_DELAY (48h) — see
// state/pending_ownership_transfer.rs.
const PENDING_OWNERSHIP_DELAY = 172_800;

// CH-1 constant — must match the on-chain
// state::MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN constant. The test
// duplicates the value here so the Rust constant and the TS expectations
// are reviewed together when either side drifts.
const MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN = 700_000;

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// CAPABILITY_OPERATOR — required for queue_agent_grant by handler design
// (register_agent rejects OPERATOR; the queue/apply path is the only way
// to land an OPERATOR-class agent).
const CAPABILITY_OPERATOR = 2;

describe("f10-timelocked-admin (CH-1 Bucket-3 2026-05-23)", () => {
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

  /**
   * Initialise a fresh vault. Mirrors the `initVault` helper in
   * ownership-transfer.ts / pen-cross-1-absorption.ts — kept local so this
   * suite is self-contained and does not couple to the other suites'
   * helper shape.
   */
  async function initVault(vaultId: BN) {
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
    const [pendingAgentGrant] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_grant"), vault.toBuffer()],
      program.programId,
    );
    const [pendingOwner] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_owner"), vault.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1, // protocolMode = ALLOWLIST
        [jupiterProgramId],
        0,
        100,
        STANDARD_INIT_TIMELOCK,
        [],
        [],
        false, // observeOnly
        0x00ffffff,
        false, // autoPromoteGrays
        5, // autoRevokeThreshold
        new BN(0),
        new BN(0),
        false, // cosignRequired — keep this suite on the simple path; the
        // F-10 invariant is independent of the cosign gate.
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: STANDARD_INIT_TIMELOCK,
          // PEN-CROSS-2: bind the LiteSVM clock's CURRENT slot — prior
          // tests in the same `before` block may have advanced past 0.
          createdAtSlot: Number(svm.getClock().slot),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          cosignRequired: false,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        auditLogRejected: auditRejected,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return {
      vault,
      policy,
      tracker,
      overlay,
      auditSuccess,
      pendingAgentGrant,
      pendingOwner,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. F-10 fires on stale pending_agent_grant after slot warp past
  //    MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN
  // ─────────────────────────────────────────────────────────────────────────
  it("F-10 fires on stale pending_agent_grant after slot warp past MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN", async () => {
    const { vault, policy, overlay, auditSuccess, pendingAgentGrant } =
      await initVault(new BN(91000));
    const agent = Keypair.generate();

    await program.methods
      .queueAgentGrant(agent.publicKey, CAPABILITY_OPERATOR, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Capture the slot at queue time, then warp both unix-time (to satisfy
    // the 48h timelock) AND slot (past the 700_000-slot freshness ceiling)
    // so the apply enters the F-10 reject path INSTEAD of the timelock
    // reject path. The slot warp is the load-bearing assertion: the cap
    // is supposed to surface BEFORE the timelock check.
    const queuedAtSlot = Number(svm.getClock().slot);
    advanceTime(svm, PENDING_AGENT_GRANT_DELAY + 1); // timelock OK
    advancePastSlot(
      svm,
      queuedAtSlot + MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN + 10,
    );

    try {
      await program.methods
        .applyAgentGrant()
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingAgentGrant,
          agentSpendOverlay: overlay,
          auditLogSuccess: auditSuccess,
          slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        } as any)
        .rpc();
      expect.fail(
        "apply_agent_grant MUST reject when slot delta exceeds " +
          "MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN",
      );
    } catch (err: any) {
      expectSigilError(err, { name: "QueuedUpdateExpired" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. F-10 fires on stale pending_ownership_transfer
  // ─────────────────────────────────────────────────────────────────────────
  it("F-10 fires on stale pending_ownership_transfer after slot warp", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(91001),
    );

    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 2 * LAMPORTS_PER_SOL);

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Same warp pattern as the agent_grant test: satisfy the 48h timelock
    // via unix-time advance, then push slot past the 700_000-slot ceiling
    // so F-10 (not TimelockNotReady) is the rejecting check.
    const queuedAtSlot = Number(svm.getClock().slot);
    advanceTime(svm, PENDING_OWNERSHIP_DELAY + 1);
    advancePastSlot(
      svm,
      queuedAtSlot + MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN + 10,
    );

    try {
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: newOwner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newOwner])
        .rpc();
      expect.fail(
        "accept_ownership_transfer MUST reject when slot delta exceeds " +
          "MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN",
      );
    } catch (err: any) {
      expectSigilError(err, { name: "QueuedUpdateExpired" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. F-10 passes when apply is within window (legitimate 48h+ window
  //    inside the 700_000-slot ceiling)
  // ─────────────────────────────────────────────────────────────────────────
  it("F-10 passes when apply is within window (48h-equivalent slot count) — apply_agent_grant lands", async () => {
    const { vault, policy, overlay, auditSuccess, pendingAgentGrant } =
      await initVault(new BN(91002));
    const agent = Keypair.generate();

    await program.methods
      .queueAgentGrant(agent.publicKey, CAPABILITY_OPERATOR, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // 48h worth of slots at 400ms/slot = 432_000 slots. Inside the
    // 700_000-slot ceiling — proves CH-1 does NOT regress the legitimate
    // path.
    const queuedAtSlot = Number(svm.getClock().slot);
    advanceTime(svm, PENDING_AGENT_GRANT_DELAY + 1);
    advancePastSlot(svm, queuedAtSlot + 432_000);

    await program.methods
      .applyAgentGrant()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .rpc();

    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.agents).to.have.lengthOf(1);
    expect(vaultState.agents[0].pubkey.toString()).to.equal(
      agent.publicKey.toString(),
    );
    expect(vaultState.agents[0].capability).to.equal(CAPABILITY_OPERATOR);
  });
});
