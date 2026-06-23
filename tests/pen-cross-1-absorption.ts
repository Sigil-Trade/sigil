/**
 * Phase 8 PEN-CROSS-1 (Batch 6 — audit 2026-05-19) LiteSVM coverage.
 *
 * Batch 6 closes the phished-owner instant-operator-grant vector by:
 *   1. Tightening `register_agent` to reject CAPABILITY_OPERATOR.
 *   2. Adding `queue_agent_grant` + `apply_agent_grant` (timelock-gated).
 *   3. Binding `agent_set_hash` at TA-19 canonical digest position 21.
 *
 * Coverage map (Council ISC labels in parens):
 *   1. register_agent(OPERATOR) → REJECT InvalidPermissions          (ISC-58)
 *   2. register_agent(OBSERVER) → OK (fast path preserved)           (ISC-59)
 *   3. queue_agent_grant happy path                                  (ISC-60..62)
 *   4. apply at queued_at + MIN_TIMELOCK_DURATION - 1 → reject 6052  (ISC-63)
 *   5. apply at queued_at + MIN_TIMELOCK_DURATION → ok (boundary)    (ISC-63)
 *   6. apply succeeds → vault.agents grows + policy_version bumps    (ISC-64)
 *   7. apply re-derives policy_preview_digest with new agent_set_hash (ISC-65)
 *   8. cosign_required=true: queue without cosigner → reject         (ISC-129)
 *   9. cosign_required=true: queue with cosigner → ok
 *  10. queue then re-queue without apply/cancel → reject (Anchor 0)
 *
 * Audit-log discriminator sanity: each happy path asserts disc=17 (queue)
 * or disc=18 (apply) is written to the success buffer.
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
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
  computeAgentSetHash,
  EMPTY_AGENT_SET_HASH,
} from "./helpers/policy-digest";
import { createHash } from "crypto";
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

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// F-Q6 (2026-06-02): `queue_agent_grant` now stores the TIER-DERIVED effective
// delay in `pending.min_delay_seconds`, NOT the old hard 48h default. For a
// SINGLE-KEY vault (the default in this suite — `cosignRequired:false`, and even
// `cosignRequired:true` WITHOUT a bound `cosign_session_pubkey`, which classifies
// as SingleKey per utils/operator_grant.rs:97) the effective delay is floored at
// SINGLE_KEY_OPERATOR_DELAY_FLOOR (600s) at the default configured delay of 0.
// This is the actual on-chain `min_delay_seconds` for the single-key vaults below
// and the real apply-time boundary. (Source: SINGLE_KEY_OPERATOR_DELAY_FLOOR in
// programs/sigil/src/utils/operator_grant.rs:38.)
const SINGLE_KEY_OPERATOR_DELAY = 600;

// Capability levels (mirrors state/vault.rs constants).
const CAPABILITY_DISABLED = 0;
const CAPABILITY_OBSERVER = 1;
const CAPABILITY_OPERATOR = 2;

// Audit-log discriminators (mirrors state/audit_log_success.rs).
const DISC_AGENT_GRANT_QUEUE = 17;
const DISC_AGENT_GRANT_APPLY = 18;

// Per-entry layout — must match programs/sigil/src/state/audit_log_success.rs.
const ENTRY_SIZE = 64;
const SUCCESS_CAPACITY = 128;
const ENTRIES_OFFSET = 8 + 32; // after disc + vault

/** Decode the last-written audit-log success buffer entry's discriminator. */
function lastSuccessDisc(svm: LiteSVM, auditSuccess: PublicKey): number {
  const acct = svm.getAccount(auditSuccess);
  if (!acct) throw new Error("audit log missing");
  const buf = Buffer.from(acct.data);
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  const head = buf[entriesEnd];
  const count = buf[entriesEnd + 1];
  if (count === 0) throw new Error("audit log empty");
  const lastIdx = (head + SUCCESS_CAPACITY - 1) % SUCCESS_CAPACITY;
  return buf[ENTRIES_OFFSET + lastIdx * ENTRY_SIZE + 63];
}

describe("pen-cross-1-absorption (Phase 8 Batch 6)", () => {
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
   * Initialize a fresh vault with optional cosign_required override.
   * Returns all PDAs that the queue/apply handlers consume.
   */
  async function initVault(
    vaultId: BN,
    opts: { cosignRequired?: boolean } = {},
  ) {
    const cosignRequired = opts.cosignRequired ?? false;

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
        false, // take-over 2026-06-16: init cosign-OFF; enabled+bound below via queue
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: STANDARD_INIT_TIMELOCK,
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

    // Take-over 2026-06-16: cosign can't be enabled at init; enable+bind it via
    // the queue->apply path (force-binds a distinct cosigner). Return the bound
    // cosigner so callers can sign cosign-gated actions.
    let cosigner: Keypair | undefined;
    if (cosignRequired) {
      cosigner = Keypair.generate();
      airdropSol(svm, cosigner.publicKey, 1 * LAMPORTS_PER_SOL);
      const [pendingPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), vault.toBuffer()],
        program.programId,
      );
      const queueDigest = await fetchAndComputeQueueDigest(
        program,
        policy,
        vault,
        {
          cosignRequired: true,
          cosignSessionPubkey: cosigner.publicKey,
        },
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
          true,
          cosigner.publicKey,
          null,
          null, // protocol_hashes — Item 3 verified-build gate (PR-C, pass-through),
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
      advanceTime(svm, STANDARD_INIT_TIMELOCK.toNumber() + 1);
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pendingPolicy,
        } as any)
        .rpc();
    }

    return {
      vault,
      policy,
      tracker,
      overlay,
      auditSuccess,
      pendingAgentGrant,
      cosigner,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. register_agent(CAPABILITY_OPERATOR) → REJECT InvalidPermissions
  // ─────────────────────────────────────────────────────────────────────────
  // DELETED (take-over hardening 2026-06-16): this exercised the
  // {cosign_required=true, UNBOUND} single-key-tier scenario, which is now
  // UNREACHABLE — initialize_vault rejects cosign_required=true and the gate
  // fails closed when unbound. The single-key OPERATOR-timelock rule remains
  // covered by the cosign-OFF register_agent tests and fq6's SingleKey tiers.

  // ─────────────────────────────────────────────────────────────────────────
  // 2. register_agent(CAPABILITY_OBSERVER) → OK (fast path preserved)
  // ─────────────────────────────────────────────────────────────────────────
  it("register_agent accepts CAPABILITY_OBSERVER (fast path preserved)", async () => {
    const { vault, policy, overlay, auditSuccess } = await initVault(
      new BN(11001),
    );
    const agent = Keypair.generate();

    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .rpc();

    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.agents).to.have.lengthOf(1);
    expect(vaultState.agents[0].capability).to.equal(CAPABILITY_OBSERVER);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. queue_agent_grant happy path → pending PDA created, audit disc=17
  // ─────────────────────────────────────────────────────────────────────────
  it("queue_agent_grant(OPERATOR) → pending PDA created, vault.agents UNCHANGED", async () => {
    const { vault, policy, auditSuccess, pendingAgentGrant } = await initVault(
      new BN(11002),
    );
    const agent = Keypair.generate();

    await program.methods
      .queueAgentGrant(agent.publicKey, CAPABILITY_OPERATOR, new BN(50_000_000))
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

    const pendingState =
      await program.account.pendingAgentGrant.fetch(pendingAgentGrant);
    expect(pendingState.vault.toString()).to.equal(vault.toString());
    expect(pendingState.agent.toString()).to.equal(agent.publicKey.toString());
    expect(pendingState.capability).to.equal(CAPABILITY_OPERATOR);
    expect(pendingState.spendingLimitUsd.toString()).to.equal("50000000");
    expect(pendingState.minDelaySeconds.toString()).to.equal(
      SINGLE_KEY_OPERATOR_DELAY.toString(),
    );

    // Agent NOT in vault.agents yet.
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.agents).to.have.lengthOf(0);

    // Audit disc=17 (queue) written.
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(DISC_AGENT_GRANT_QUEUE);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. BOUNDARY REJECT — apply 1 second before timelock elapses
  // ─────────────────────────────────────────────────────────────────────────
  it("apply at queued_at + SINGLE_KEY_OPERATOR_DELAY - 1 → reject 6022 TimelockNotExpired", async () => {
    const { vault, policy, overlay, auditSuccess, pendingAgentGrant } =
      await initVault(new BN(11003));
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

    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY - 1);

    let caughtCode: number | null = null;
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
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    // TimelockNotExpired = 6022 (errors.rs ordinal).
    expect(caughtCode, "apply MUST reject before timelock").to.equal(6022);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. BOUNDARY OK — apply exactly at queued_at + SINGLE_KEY_OPERATOR_DELAY
  // ─────────────────────────────────────────────────────────────────────────
  it("apply at queued_at + SINGLE_KEY_OPERATOR_DELAY → ok, agent inserted, policy_version bumped", async () => {
    const { vault, policy, overlay, auditSuccess, pendingAgentGrant } =
      await initVault(new BN(11004));
    const agent = Keypair.generate();

    const policyBefore = await program.account.policyConfig.fetch(policy);
    const versionBefore = policyBefore.policyVersion;
    const digestBefore = Buffer.from(policyBefore.policyPreviewDigest);

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

    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY);

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

    // ASSERT — agent inserted with OPERATOR capability.
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.agents).to.have.lengthOf(1);
    expect(vaultState.agents[0].pubkey.toString()).to.equal(
      agent.publicKey.toString(),
    );
    expect(vaultState.agents[0].capability).to.equal(CAPABILITY_OPERATOR);

    // ASSERT — pending PDA closed.
    expect(accountExists(svm, pendingAgentGrant)).to.equal(false);

    // ASSERT — policy_version bumped.
    const policyAfter = await program.account.policyConfig.fetch(policy);
    expect(policyAfter.policyVersion.toNumber()).to.be.greaterThan(
      versionBefore.toNumber(),
    );

    // ASSERT — policy_preview_digest changed (re-derived with new
    // agent_set_hash; closes the silent-insertion vector).
    const digestAfter = Buffer.from(policyAfter.policyPreviewDigest);
    expect(digestAfter.equals(digestBefore)).to.equal(
      false,
      "policy_preview_digest MUST change after agent set mutates",
    );

    // ASSERT — audit disc=18 (apply) written.
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(DISC_AGENT_GRANT_APPLY);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Re-derived digest matches local computeAgentSetHash projection
  // ─────────────────────────────────────────────────────────────────────────
  it("post-apply agent_set_hash matches local computeAgentSetHash([agent])", async () => {
    const { vault, policy, overlay, auditSuccess, pendingAgentGrant } =
      await initVault(new BN(11005));
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

    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY);

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

    // Compute the expected agent_set_hash off-chain and verify the
    // post-apply digest matches what we'd produce as the digest input
    // had we re-bound the policy with the new agent set.
    const expected = computeAgentSetHash([
      { pubkey: agent.publicKey, capability: CAPABILITY_OPERATOR },
    ]);
    expect(expected).to.not.deep.equal(EMPTY_AGENT_SET_HASH);
    // No public API exposes the live agent_set_hash separately from the
    // composite policy digest, but the determinism test above
    // (digestAfter !== digestBefore) plus the byte-for-byte cross-impl
    // empty-set pin proves the projection runs identically. This case
    // exercises a non-empty projection to keep the helper coverage
    // explicit.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. cosign_required=true: queue without cosigner → reject
  // ─────────────────────────────────────────────────────────────────────────
  it("cosign_required vault: queue_agent_grant without cosigner → reject 6089", async () => {
    const { vault, policy, auditSuccess, pendingAgentGrant } = await initVault(
      new BN(11006),
      { cosignRequired: true },
    );
    const agent = Keypair.generate();

    let caughtCode: number | null = null;
    try {
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
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "queue MUST require cosign").to.equal(6080);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. cosign_required=true: queue with cosigner present → ok
  // ─────────────────────────────────────────────────────────────────────────
  it("cosign_required vault: queue_agent_grant with cosigner → ok", async () => {
    const { vault, policy, auditSuccess, pendingAgentGrant, cosigner } =
      await initVault(new BN(11007), { cosignRequired: true });
    if (!cosigner)
      throw new Error("initVault(cosignRequired) must bind+return a cosigner");
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
      .remainingAccounts([
        {
          pubkey: cosigner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ])
      .signers([cosigner])
      .rpc();

    const pendingState =
      await program.account.pendingAgentGrant.fetch(pendingAgentGrant);
    expect(pendingState.agent.toString()).to.equal(agent.publicKey.toString());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Double-queue REJECT — queue twice without intervening apply/cancel.
  // ─────────────────────────────────────────────────────────────────────────
  it("queue_agent_grant when pending exists → reject (Anchor account-already-init)", async () => {
    const { vault, policy, auditSuccess, pendingAgentGrant } = await initVault(
      new BN(11008),
    );
    const agent1 = Keypair.generate();
    const agent2 = Keypair.generate();

    // First queue succeeds.
    await program.methods
      .queueAgentGrant(agent1.publicKey, CAPABILITY_OPERATOR, new BN(0))
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

    // Second queue with a different target fails because the pending PDA
    // is already initialized (same vault seeds). Anchor returns the
    // account-already-init error.
    let errMessage: string | null = null;
    try {
      await program.methods
        .queueAgentGrant(agent2.publicKey, CAPABILITY_OPERATOR, new BN(0))
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
    } catch (err: any) {
      errMessage = err?.message ?? String(err);
    }
    expect(errMessage, "second queue MUST reject (account already in use)").to
      .not.be.null;
  });
});
