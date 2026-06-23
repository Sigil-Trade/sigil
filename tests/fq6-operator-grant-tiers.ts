/**
 * F-Q6 (2026-06-02) — OPERATOR-grant authorization tiering: behavior RED-proofs.
 *
 * Core principle (LOCKED): an OPERATOR-class agent grant may be seated INSTANTLY
 * via `register_agent` ONLY if the vault carries >= 2 authorization factors AND
 * no grant delay is configured; otherwise it MUST route through the timelocked
 * `queue_agent_grant` -> `apply_agent_grant` path (the time-delay substitutes for
 * the missing 2nd factor). Three tiers (programs/sigil/src/utils/operator_grant.rs):
 *
 *   - SingleKey   (owner_type==0, no BOUND cosigner) -> 1 factor  -> ALWAYS delayed,
 *                  floored at SINGLE_KEY_OPERATOR_DELAY_FLOOR (600s).
 *   - CosignBound (cosign_required && cosign_session_pubkey != default) -> 2 factors
 *                  -> instant at delay 0 (the BOUND cosigner must sign inline, C-1).
 *   - Multisig    (owner_type==1) -> N factors -> instant at delay 0.
 *
 * The owner knob `policy.operator_grant_delay_seconds` (default 0, settable ONLY
 * via the timelocked `queue_policy_update`) raises the delay; a configured delay
 * routes even cosign/multisig through the queue path.
 *
 * HONEST POSTURE (documented, not hidden): at the default delay of 0 a leaked
 * single owner key CANNOT instantly seat an OPERATOR on a single-key vault — the
 * 600s floor is the missing-2nd-factor substitute — but a cosign-BOUND or
 * multisig vault at delay 0 CAN seat instantly (its 2nd factor is the inline
 * cosigner / the multisig threshold). The delay is an OPT-IN mitigation for the
 * 2-factor tiers, not a default defense.
 *
 * Tier-LOGIC unit coverage lives in operator_grant.rs (11 pure-fn tests:
 * classify / effective-delay / instant-eligibility across every tier). THIS file
 * is the on-chain BEHAVIOR proof — that `register_agent` / `queue_agent_grant` /
 * `apply_agent_grant` / `queue_policy_update` actually enforce those decisions.
 *
 * ISC-62 (multisig instant) is V1-UNREACHABLE on-chain and is an `it.skip` with
 * the rationale below — there is no signable path to invoke an owner-op as a
 * keyless Squads vault PDA (owner: Signer + reject_cpi!()).
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
} from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  advanceTime,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
import {
  expectSigilError,
  SigilErrorName,
  SigilErrorCodeFor,
} from "./helpers/strict-errors";

const CAPABILITY_OBSERVER = 1;
const CAPABILITY_OPERATOR = 2;
/** programs/sigil/src/utils/operator_grant.rs — single-key OPERATOR floor. */
const SINGLE_KEY_OPERATOR_DELAY_FLOOR = 600;
/** The vault's policy timelock_duration (>= MIN_TIMELOCK_DURATION = 1800). */
const POLICY_TIMELOCK = 1800;

describe("F-Q6 — OPERATOR-grant authorization tiering (per-tier behavior)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();

  /** Derive every PDA the OPERATOR-grant paths touch for a given vault. */
  function pdasFor(vaultPda: PublicKey) {
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [pendingAgentGrant] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_grant"), vaultPda.toBuffer()],
      program.programId,
    );
    const [pendingPolicy] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vaultPda.toBuffer()],
      program.programId,
    );
    const [auditSuccess] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), vaultPda.toBuffer()],
      program.programId,
    );
    return { policy, overlay, pendingAgentGrant, pendingPolicy, auditSuccess };
  }

  /**
   * Fresh vault per test (destructive grant paths; isolation prevents
   * test-ordering coupling). `cosignRequired` is the only knob exposed; the
   * vault starts at owner_type=0 (EOA) with operator_grant_delay_seconds=0.
   */
  async function freshVault(
    vaultIdNum: number,
    opts: { cosignRequired?: boolean } = {},
  ) {
    const cosignRequired = opts.cosignRequired ?? false;
    const vaultId = new BN(vaultIdNum);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const { policy, overlay, pendingAgentGrant, pendingPolicy, auditSuccess } =
      pdasFor(vaultPda);
    const [tracker] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        [],
        0,
        100,
        new BN(POLICY_TIMELOCK),
        [],
        [],
        true, // observeOnly — no protocols/destinations needed for grant tests
        0x00ffffff, // operatingHours — all 24h
        false, // autoPromoteGrays
        5, // autoRevokeThreshold — must be in [3, 20]
        new BN(0), // stableBalanceFloor
        new BN(0), // perRecipientDailyCapUsd
        cosignRequired, // cosignRequired (G6) — param
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [],
          allowedDestinations: [],
          timelockDuration: new BN(POLICY_TIMELOCK),
          observeOnly: true,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          cosignRequired,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy,
        tracker,
        agentSpendOverlay: overlay,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return {
      vaultPda,
      policy,
      overlay,
      pendingAgentGrant,
      pendingPolicy,
      auditSuccess,
    };
  }

  /**
   * Issue a `queue_policy_update` (owner-only, non-elevated) with the given
   * cosign_session_pubkey / operator_grant_delay_seconds overrides, advancing
   * past the policy timelock and applying — UNLESS `applyAfter` is false, in
   * which case the pending update is left un-applied (for the timelock RED-proof).
   * Returns the pendingPolicy PDA so callers can drive `apply_pending_policy`.
   */
  async function queuePolicyUpdate(
    v: { vaultPda: PublicKey; policy: PublicKey; pendingPolicy: PublicKey },
    override: {
      cosignRequired?: boolean;
      cosignSessionPubkey?: PublicKey;
      operatorGrantDelaySeconds?: number;
    },
    applyAfter = true,
  ) {
    const queueDigest = await fetchAndComputeQueueDigest(
      program,
      v.policy,
      v.vaultPda,
      {
        cosignRequired: override.cosignRequired ?? null,
        cosignSessionPubkey: override.cosignSessionPubkey ?? null,
        operatorGrantDelaySeconds: override.operatorGrantDelaySeconds ?? null,
      },
    );
    await program.methods
      .queuePolicyUpdate(
        null, // 1 daily_spending_cap_usd
        null, // 2 max_transaction_size_usd
        null, // 3 max_slippage_bps
        null, // 4 developer_fee_rate
        null, // 5 protocol_mode
        null, // 6 protocols
        null, // 7 destination_mode
        null, // 8 allowed_destinations
        null, // 9 timelock_duration
        null, // 10 session_expiry_seconds
        null, // 11 operating_hours
        null, // 12 auto_promote_grays
        null, // 13 auto_revoke_threshold
        null, // 14 stable_balance_floor
        null, // 15 per_recipient_daily_cap_usd
        override.cosignRequired ?? null, // 16 cosign_required (enable cosign + bind atomically)
        override.cosignSessionPubkey ?? null, // 17 cosign_session_pubkey
        override.operatorGrantDelaySeconds != null
          ? new BN(override.operatorGrantDelaySeconds)
          : null,
        null /* protocol_hashes (PR-C) */, // 18 operator_grant_delay_seconds
        PublicKey.default, // 19 cosign_session — non-elevated (no inline cosigner)
        queueDigest, // 20 expected_digest
      )
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policy,
        pendingPolicy: v.pendingPolicy,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    if (!applyAfter) return;
    advanceTime(svm, POLICY_TIMELOCK + 1);
    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policy,
        pendingPolicy: v.pendingPolicy,
      } as any)
      .rpc();
  }

  /** Build a `register_agent` rpc promise (optionally with an inline cosigner). */
  function registerAgentRpc(
    v: {
      vaultPda: PublicKey;
      policy: PublicKey;
      overlay: PublicKey;
      auditSuccess: PublicKey;
    },
    agent: PublicKey,
    capability: number,
    cosigner?: { keypair?: Keypair; pubkey: PublicKey; isSigner: boolean },
  ): Promise<string> {
    let m = program.methods
      .registerAgent(agent, capability, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policy,
        agentSpendOverlay: v.overlay,
        auditLogSuccess: v.auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any);
    if (cosigner) {
      m = m.remainingAccounts([
        {
          pubkey: cosigner.pubkey,
          isSigner: cosigner.isSigner,
          isWritable: false,
        },
      ]);
      if (cosigner.keypair && cosigner.isSigner)
        m = m.signers([cosigner.keypair]);
    }
    return m.rpc();
  }

  /** queue_agent_grant (OPERATOR) — owner-only. */
  function queueAgentGrantRpc(
    v: {
      vaultPda: PublicKey;
      policy: PublicKey;
      pendingAgentGrant: PublicKey;
      auditSuccess: PublicKey;
    },
    agent: PublicKey,
  ): Promise<string> {
    return program.methods
      .queueAgentGrant(agent, CAPABILITY_OPERATOR, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policy,
        pending: v.pendingAgentGrant,
        auditLogSuccess: v.auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  /** apply_agent_grant — owner-only. */
  function applyAgentGrantRpc(v: {
    vaultPda: PublicKey;
    policy: PublicKey;
    pendingAgentGrant: PublicKey;
    overlay: PublicKey;
    auditSuccess: PublicKey;
  }): Promise<string> {
    return program.methods
      .applyAgentGrant()
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policy,
        pending: v.pendingAgentGrant,
        agentSpendOverlay: v.overlay,
        auditLogSuccess: v.auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .rpc();
  }

  /** Assert a promise rejects with a specific Sigil error (and that it rejects). */
  async function expectRevert<N extends SigilErrorName>(
    promise: Promise<unknown>,
    expected: { name: N; code?: SigilErrorCodeFor<N> },
  ): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(
      caught,
      `expected revert ${expected.name} (${expected.code ?? "?"}) but the call succeeded`,
    ).to.not.equal(undefined);
    expectSigilError(caught, expected);
  }

  /** Read the live agent set as [pubkey -> capability]. */
  async function agentCapability(
    vaultPda: PublicKey,
    agent: PublicKey,
  ): Promise<number | undefined> {
    const vault: any = await program.account.agentVault.fetch(vaultPda);
    const entry = (
      vault.agents as ReadonlyArray<{ pubkey: PublicKey; capability: number }>
    ).find((a) => a.pubkey.toBase58() === agent.toBase58());
    return entry?.capability;
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;
    airdropSol(svm, owner.publicKey, 500 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  // ── ISC-59 — SingleKey: OPERATOR grants are ALWAYS delayed ────────────────

  it("ISC-59a SingleKey: instant register_agent(OPERATOR) → ErrOperatorGrantRequiresTimelock (6107)", async () => {
    const v = await freshVault(6201);
    const agent = Keypair.generate().publicKey;
    await expectRevert(registerAgentRpc(v, agent, CAPABILITY_OPERATOR), {
      name: "ErrOperatorGrantRequiresTimelock",
      code: 6107,
    });
    // The agent must NOT have been seated.
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  it("ISC-59a' SingleKey: instant register_agent(OBSERVER) → SUCCEEDS (only OPERATOR is gated)", async () => {
    const v = await freshVault(6202);
    const agent = Keypair.generate().publicKey;
    await registerAgentRpc(v, agent, CAPABILITY_OBSERVER);
    expect(await agentCapability(v.vaultPda, agent)).to.equal(
      CAPABILITY_OBSERVER,
    );
  });

  it("ISC-59b SingleKey: queue → advance past the 600s floor → apply → OPERATOR seated", async () => {
    const v = await freshVault(6203);
    const agent = Keypair.generate().publicKey;
    await queueAgentGrantRpc(v, agent);
    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY_FLOOR + 1);
    await applyAgentGrantRpc(v);
    expect(await agentCapability(v.vaultPda, agent)).to.equal(
      CAPABILITY_OPERATOR,
    );
  });

  it("ISC-59c SingleKey: apply BEFORE the 600s floor elapses → TimelockNotExpired (6022) [the delay is real]", async () => {
    const v = await freshVault(6204);
    const agent = Keypair.generate().publicKey;
    await queueAgentGrantRpc(v, agent);
    // One second short of the floor.
    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY_FLOOR - 1);
    await expectRevert(applyAgentGrantRpc(v), {
      name: "TimelockNotExpired",
      code: 6022,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  // ── ISC-60 — CosignBound: instant with the BOUND cosigner ─────────────────

  it("ISC-60 CosignBound (delay 0): instant register_agent(OPERATOR) WITH the bound cosigner → seated, no queue", async () => {
    const v = await freshVault(6210);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const agent = Keypair.generate().publicKey;
    await registerAgentRpc(v, agent, CAPABILITY_OPERATOR, {
      keypair: cosigner,
      pubkey: cosigner.publicKey,
      isSigner: true,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(
      CAPABILITY_OPERATOR,
    );
  });

  // ── ISC-61 — CosignBound C-1: the inline signer MUST be the BOUND cosigner ─

  it("ISC-61a CosignBound: instant OPERATOR with NO cosigner → ErrCosignRequired (6080)", async () => {
    const v = await freshVault(6211);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const agent = Keypair.generate().publicKey;
    await expectRevert(registerAgentRpc(v, agent, CAPABILITY_OPERATOR), {
      name: "ErrCosignRequired",
      code: 6080,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  it("ISC-61b CosignBound: instant OPERATOR with a WRONG (unbound) signer → ErrCosignRequired (6080)", async () => {
    const v = await freshVault(6212);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const wrong = Keypair.generate();
    const agent = Keypair.generate().publicKey;
    await expectRevert(
      registerAgentRpc(v, agent, CAPABILITY_OPERATOR, {
        keypair: wrong,
        pubkey: wrong.publicKey,
        isSigner: true,
      }),
      { name: "ErrCosignRequired", code: 6080 },
    );
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  it("ISC-61c CosignBound: bound cosigner present but NOT a signer → ErrCosignRequired (6080)", async () => {
    const v = await freshVault(6213);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const agent = Keypair.generate().publicKey;
    // bound pubkey in remaining_accounts but isSigner=false → C-1 (is_signer && key==bound) fails.
    await expectRevert(
      registerAgentRpc(v, agent, CAPABILITY_OPERATOR, {
        pubkey: cosigner.publicKey,
        isSigner: false,
      }),
      { name: "ErrCosignRequired", code: 6080 },
    );
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  // ── M-2 (audit 2026-06-11): end-to-end coverage of has_bound_cosigner ───────
  //    The ISC-61 tests above exercise the OPERATOR arm's pre-existing inline
  //    pin. These exercise the NEW has_bound_cosigner helper via the
  //    register_agent OBSERVER cosign arm (register_agent.rs ~176) — a
  //    representative of the 10 owner lanes M-2 upgraded. They prove the bound
  //    identity-pin rejects a wrong signer AND accepts the bound one (not
  //    over-strict / not bricked).

  it("M-2 CosignBound OBSERVER: register with NO cosigner → ErrCosignRequired (6080)", async () => {
    const v = await freshVault(6290);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const agent = Keypair.generate().publicKey;
    await expectRevert(registerAgentRpc(v, agent, CAPABILITY_OBSERVER), {
      name: "ErrCosignRequired",
      code: 6080,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  it("M-2 CosignBound OBSERVER: register with a WRONG (unbound) signer → ErrCosignRequired (6080)", async () => {
    const v = await freshVault(6291);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const wrong = Keypair.generate();
    const agent = Keypair.generate().publicKey;
    // has_bound_cosigner: a throwaway signer != the bound cosign_session_pubkey
    // is rejected — the C-1 weakness M-2 closes for the owner lanes.
    await expectRevert(
      registerAgentRpc(v, agent, CAPABILITY_OBSERVER, {
        keypair: wrong,
        pubkey: wrong.publicKey,
        isSigner: true,
      }),
      { name: "ErrCosignRequired", code: 6080 },
    );
    expect(await agentCapability(v.vaultPda, agent)).to.equal(undefined);
  });

  it("M-2 CosignBound OBSERVER: register WITH the bound cosigner → seated (not over-strict / not bricked)", async () => {
    const v = await freshVault(6292);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    const agent = Keypair.generate().publicKey;
    await registerAgentRpc(v, agent, CAPABILITY_OBSERVER, {
      keypair: cosigner,
      pubkey: cosigner.publicKey,
      isSigner: true,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(
      CAPABILITY_OBSERVER,
    );
  });

  // ISC-61d DELETED (take-over hardening 2026-06-16): the {cosign_required=true,
  // UNBOUND} state it exercised is now UNREACHABLE — initialize_vault rejects
  // cosign_required=true (ErrCosignRequired) and has_bound_cosigner fails closed
  // when unbound. The SingleKey operator tier remains covered by the cosign-OFF
  // (default) tests above. (Init-time rejection is asserted in missing-coverage.)

  // ── ISC-62 — Multisig instant: V1-UNREACHABLE on-chain ────────────────────

  it.skip("ISC-62 Multisig-owner (owner_type==1): instant OPERATOR — V1-UNREACHABLE on-chain", () => {
    // A multisig-owned vault sets owner_type=1 only via
    // accept_ownership_transfer_multisig, which records a KEYLESS Squads vault
    // PDA as the owner. Every owner-op (register_agent / queue_agent_grant)
    // requires `owner: Signer` AND `reject_cpi!()` — a keyless PDA can satisfy
    // neither (it "signs" only via Squads CPI, which reject_cpi! blocks). There
    // is therefore NO signable path to invoke register_agent as a multisig
    // owner in V1, so the Multisig instant arm cannot be exercised on-chain.
    //
    // The TIER LOGIC is proven by the pure-fn unit tests in
    // programs/sigil/src/utils/operator_grant.rs:
    //   - classify_multisig_owner_is_multisig_regardless_of_cosign
    //   - two_factor_tiers_instant_only_at_zero_delay (covers Multisig)
    // Re-enable this on-chain proof if/when a multisig-callable owner-op path
    // (UncheckedAccount + Squads program-ownership + threshold) is added.
  });

  // ── ISC-63 — A configured delay is itself timelocked (lowering is delayed) ─

  it("ISC-63a CosignBound + configured delay>0: instant OPERATOR even WITH bound cosigner → 6107", async () => {
    const v = await freshVault(6220);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    await queuePolicyUpdate(v, { operatorGrantDelaySeconds: 3600 });
    const agent = Keypair.generate().publicKey;
    await expectRevert(
      registerAgentRpc(v, agent, CAPABILITY_OPERATOR, {
        keypair: cosigner,
        pubkey: cosigner.publicKey,
        isSigner: true,
      }),
      { name: "ErrOperatorGrantRequiresTimelock", code: 6107 },
    );
  });

  it("ISC-63b Lowering operator_grant_delay_seconds: apply_pending_policy BEFORE the timelock → TimelockNotExpired (6022)", async () => {
    const v = await freshVault(6221);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    await queuePolicyUpdate(v, { operatorGrantDelaySeconds: 3600 });
    // Queue the LOWER (3600 -> 0) but do NOT advance past the policy timelock.
    await queuePolicyUpdate(v, { operatorGrantDelaySeconds: 0 }, false);
    await expectRevert(
      program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: v.vaultPda,
          policy: v.policy,
          pendingPolicy: v.pendingPolicy,
        } as any)
        .rpc(),
      { name: "TimelockNotExpired", code: 6022 },
    );
  });

  it("ISC-63c After the policy timelock elapses: delay lowered to 0 → instant OPERATOR with bound cosigner succeeds", async () => {
    const v = await freshVault(6222);
    const cosigner = Keypair.generate();
    await queuePolicyUpdate(v, {
      cosignRequired: true,
      cosignSessionPubkey: cosigner.publicKey,
    });
    await queuePolicyUpdate(v, { operatorGrantDelaySeconds: 3600 });
    // Lower back to 0 THROUGH the timelock (applyAfter=true advances + applies).
    await queuePolicyUpdate(v, { operatorGrantDelaySeconds: 0 });
    const agent = Keypair.generate().publicKey;
    await registerAgentRpc(v, agent, CAPABILITY_OPERATOR, {
      keypair: cosigner,
      pubkey: cosigner.publicKey,
      isSigner: true,
    });
    expect(await agentCapability(v.vaultPda, agent)).to.equal(
      CAPABILITY_OPERATOR,
    );
  });

  // ── ISC-64 — owner_type fail-safe ─────────────────────────────────────────

  it("ISC-64 An un-transitioned vault keeps owner_type=0 → SingleKey → instant OPERATOR rejected (fail-safe to the delay)", async () => {
    const v = await freshVault(6230);
    const vault: any = await program.account.agentVault.fetch(v.vaultPda);
    // Never went through accept_ownership_transfer_multisig → owner_type stays 0.
    expect(vault.ownerType).to.equal(0);
    const agent = Keypair.generate().publicKey;
    await expectRevert(registerAgentRpc(v, agent, CAPABILITY_OPERATOR), {
      name: "ErrOperatorGrantRequiresTimelock",
      code: 6107,
    });
    // The corrupt/out-of-range owner_type case (owner_type > 1 → InvalidOwnerType
    // 6109) is unreachable via instructions (program-set to {0,1}) and is proven
    // by operator_grant.rs::classify_unknown_owner_type_fails_safe_to_non_multisig
    // plus the read-site `require!(owner_type <= OWNER_TYPE_MULTISIG)` in
    // register_agent.rs.
  });
});
