/**
 * M1 — reorder-disarm cosign evasion (LiteSVM coverage).
 *
 * The verified-build gate (validate_and_authorize.rs::enforce_verified_build_if_armed)
 * and per-protocol caps (finalize_session.rs `get_protocol_cap`) are both looked
 * up BY INDEX in `policy.protocols` / `policy.protocol_hashes` / `policy.protocol_caps`.
 * Before this fix, the `queue_policy_update` elevation classifier decided whether
 * a cosigner was required by SET MEMBERSHIP + LENGTH (`expands_protocols`) and by
 * POSITIONAL comparison (`disarms_build_hash`, `weakens_protocol_caps_predicate`).
 * A pure PERMUTATION of the same protocol set (protocol P moved index i→j) with
 * `protocol_hashes: None` / `protocol_caps: None` (the arrays pass through
 * positionally unchanged) tripped NONE of those detectors — yet after apply P
 * sits at index j whose hash/cap slot belongs to a DIFFERENT protocol, silently
 * DISARMING P's build gate (or weakening its cap) on a cosign-required vault with
 * the owner key ALONE.
 *
 * The fix makes the weakening detectors IDENTITY-based
 * (`disarms_build_hash_by_identity`, `weakens_protocol_caps_by_identity`) and adds
 * a belt-and-suspenders `reorders_armed_protocols` trigger. This file proves:
 *   (a) owner-alone reorder that disarms an armed hash → rejected (ErrCosignRequired)
 *   (b) the SAME reorder WITH the bound cosigner (queue→approve→apply) → succeeds
 *   (c) a benign reorder on a vault with NO armed hashes/caps → owner-alone OK
 *   (d) same-order re-pin (nonzero→nonzero) stays non-elevated → owner-alone OK
 *       (no over-gating / no regression of the existing arm/disarm/re-pin path)
 *   (e) owner-alone reorder that weakens an armed per-protocol cap → rejected
 *
 * Queue-time only: the elevation classifier lives entirely in
 * `queue_policy_update`, so these tests never run a validate/finalize sandwich —
 * the two allowlisted protocols can be arbitrary pubkeys, and the pinned build
 * hash can be any non-zero 32 bytes (never recomputed against a real ELF here).
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
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import { fetchAndComputeQueueDigest } from "./helpers/policy-digest";
import {
  createTestEnv,
  airdropSol,
  advanceTime,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
import { expectSigilError } from "./helpers/strict-errors";

const MAX_ALLOWED_PROTOCOLS = 10;
const TIMELOCK = new BN(1800);

// Two arbitrary allowlisted protocols. P is the one we ARM; A is unarmed. The
// exploit reorders [P, A] → [A, P], moving P onto A's (zero-hash / weaker-cap)
// slot at runtime-lookup index. (Arbitrary pubkeys — no validate sandwich runs.)
const protoP = Keypair.generate().publicKey;
const protoA = Keypair.generate().publicKey;

// An arbitrary NON-ZERO pinned build hash. Never recomputed against an ELF here
// (no validate sandwich is run); only its zero/non-zero identity matters to the
// elevation classifier.
const HASH_P = Buffer.alloc(32, 0xab);
const HASH_P2 = Buffer.alloc(32, 0xcd); // a DIFFERENT non-zero hash (re-pin)
const ZERO32 = Buffer.alloc(32);

/** Full 10-entry protocol_hashes IX arg (number[][]) from index-aligned buffers. */
function hashArray(perProtocol: Buffer[]): number[][] {
  const arr: number[][] = [];
  for (let i = 0; i < MAX_ALLOWED_PROTOCOLS; i++) {
    arr.push(Array.from(perProtocol[i] ?? ZERO32));
  }
  return arr;
}

interface VaultPdas {
  vaultId: BN;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  overlayPda: PublicKey;
  pendingPolicyPda: PublicKey;
}

describe("M1 reorder-disarm cosign evasion", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();
  const cosigner = Keypair.generate();

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, cosigner.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);
  });

  function derivePdas(vaultId: BN): VaultPdas {
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    const [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vaultPda.toBuffer()],
      program.programId,
    );
    return {
      vaultId,
      vaultPda,
      policyPda,
      trackerPda,
      overlayPda,
      pendingPolicyPda,
    };
  }

  /** Initialize a vault with the given allowlist (+ optional per-protocol caps). */
  async function initVault(
    vaultId: BN,
    protocols: PublicKey[],
    protocolCaps: BN[] = [],
  ): Promise<VaultPdas> {
    const vp = derivePdas(vaultId);
    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000), // daily
        new BN(500_000_000), // max tx
        1, // protocol_mode = ALLOWLIST
        protocols,
        0, // developer_fee_rate
        5000, // max_slippage_bps
        TIMELOCK,
        [], // allowed_destinations
        protocolCaps, // protocol_caps
        false, // observe_only
        0x00ffffff, // operating_hours
        false, // auto_promote_grays
        5, // auto_revoke_threshold
        new BN(0), // stable_balance_floor
        new BN(0), // per_recipient_daily_cap_usd
        false, // cosign_required (cannot enable at init)
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(1_000_000_000),
          maxTransactionSizeUsd: new BN(500_000_000),
          maxSlippageBps: 5000,
          protocolMode: 1,
          protocols,
          allowedDestinations: [],
          timelockDuration: TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          protocolCaps,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: vp.vaultPda,
        policy: vp.policyPda,
        tracker: vp.trackerPda,
        agentSpendOverlay: vp.overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    return vp;
  }

  interface QueueFields {
    protocols?: PublicKey[] | null;
    hasProtocolCaps?: boolean | null;
    protocolCaps?: BN[] | null;
    cosignRequired?: boolean | null;
    cosignSessionPubkey?: PublicKey | null;
    protocolHashes?: number[][] | null;
  }

  function queue(
    vp: VaultPdas,
    fields: QueueFields,
    cosignSession: PublicKey,
    digest: number[],
  ) {
    return program.methods
      .queuePolicyUpdate(
        null, // daily_spending_cap_usd
        null, // max_transaction_amount_usd
        null, // protocol_mode
        fields.protocols ?? null, // protocols
        null, // developer_fee_rate
        null, // max_slippage_bps
        null, // timelock_duration
        null, // allowed_destinations
        null, // session_expiry_seconds
        fields.hasProtocolCaps ?? null, // has_protocol_caps
        fields.protocolCaps ?? null, // protocol_caps
        null, // destination_mode
        null, // operating_hours
        null, // stable_balance_floor
        null, // per_recipient_daily_cap_usd
        fields.cosignRequired ?? null, // cosign_required
        fields.cosignSessionPubkey ?? null, // cosign_session_pubkey
        null, // operator_grant_delay_seconds
        fields.protocolHashes ?? null, // protocol_hashes
        cosignSession, // cosign_session
        digest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vp.vaultPda,
        policy: vp.policyPda,
        pendingPolicy: vp.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  function applyOwner(vp: VaultPdas) {
    return program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vp.vaultPda,
        policy: vp.policyPda,
        pendingPolicy: vp.pendingPolicyPda,
      } as any)
      .rpc();
  }

  function approve(vp: VaultPdas) {
    return program.methods
      .approvePendingPolicy()
      .accounts({
        cosigner: cosigner.publicKey,
        vault: vp.vaultPda,
        policy: vp.policyPda,
        pendingPolicy: vp.pendingPolicyPda,
      } as any)
      .signers([cosigner])
      .rpc();
  }

  // ─── Shared cosign-armed vault (id 21): protocols [P, A], P armed, cosign on ──
  let v1: VaultPdas;

  before(async () => {
    v1 = await initVault(new BN(21), [protoP, protoA]);

    // Arm P's build hash at index 0 (non-elevated: arming is tightening).
    {
      const digest = await fetchAndComputeQueueDigest(
        program,
        v1.policyPda,
        v1.vaultPda,
        { protocolHashes: [HASH_P, ZERO32] },
      );
      await queue(
        v1,
        { protocolHashes: hashArray([HASH_P, ZERO32]) },
        PublicKey.default,
        digest,
      );
      advanceTime(svm, TIMELOCK.toNumber() + 1);
      await applyOwner(v1);
    }

    // Enable cosign_required + bind the cosigner (both non-elevated at this point
    // because live cosign_required is still false → no rotate gate).
    {
      const digest = await fetchAndComputeQueueDigest(
        program,
        v1.policyPda,
        v1.vaultPda,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
      );
      await queue(
        v1,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
        PublicKey.default,
        digest,
      );
      advanceTime(svm, TIMELOCK.toNumber() + 1);
      await applyOwner(v1);
    }

    const policy = await program.account.policyConfig.fetch(v1.policyPda);
    expect(policy.cosignRequired).to.equal(true);
    expect(
      Buffer.from(policy.protocolHashes[0]).equals(HASH_P),
      "P armed at index 0",
    ).to.equal(true);
    expect(
      Buffer.from(policy.protocolHashes[1]).equals(ZERO32),
      "A unarmed at index 1",
    ).to.equal(true);
  });

  it("(a) owner-alone reorder that disarms an armed hash → ErrCosignRequired", async () => {
    // Reorder [P, A] → [A, P], protocol_hashes:None. P moves to index 1 (A's
    // zero-hash slot) → identity disarm + reorders_armed_protocols → elevated.
    const digest = await fetchAndComputeQueueDigest(
      program,
      v1.policyPda,
      v1.vaultPda,
      { protocols: [protoA, protoP] },
    );
    try {
      await queue(
        v1,
        { protocols: [protoA, protoP] },
        PublicKey.default, // owner-alone (no bound cosigner)
        digest,
      );
      expect.fail("expected ErrCosignRequired (reorder-disarm is elevated)");
    } catch (err) {
      expectSigilError(err, { name: "ErrCosignRequired" });
    }

    // Rejected at queue → order + arming unchanged.
    const policy = await program.account.policyConfig.fetch(v1.policyPda);
    expect(policy.protocols[0].equals(protoP), "P still index 0").to.equal(
      true,
    );
    expect(
      Buffer.from(policy.protocolHashes[0]).equals(HASH_P),
      "P still armed",
    ).to.equal(true);
  });

  it("(d) same-order re-pin (nonzero→nonzero) stays non-elevated → owner-alone OK", async () => {
    // Re-pinning P's hash to a DIFFERENT non-zero value in the SAME order is
    // tightening/neutral; it must NOT trip the new identity/reorder triggers.
    const digest = await fetchAndComputeQueueDigest(
      program,
      v1.policyPda,
      v1.vaultPda,
      { protocolHashes: [HASH_P2, ZERO32] },
    );
    await queue(
      v1,
      { protocolHashes: hashArray([HASH_P2, ZERO32]) },
      PublicKey.default, // owner-alone — must be accepted (non-elevated)
      digest,
    );
    advanceTime(svm, TIMELOCK.toNumber() + 1);
    await applyOwner(v1);

    const policy = await program.account.policyConfig.fetch(v1.policyPda);
    expect(
      Buffer.from(policy.protocolHashes[0]).equals(HASH_P2),
      "P re-pinned in place",
    ).to.equal(true);
  });

  it("(b) the SAME reorder WITH the bound cosigner (queue→approve→apply) → succeeds", async () => {
    const digest = await fetchAndComputeQueueDigest(
      program,
      v1.policyPda,
      v1.vaultPda,
      { protocols: [protoA, protoP] },
    );
    // Queue WITH the bound cosigner pubkey — accepted (records the binding).
    await queue(
      v1,
      { protocols: [protoA, protoP] },
      cosigner.publicKey,
      digest,
    );
    advanceTime(svm, TIMELOCK.toNumber() + 1);
    // Bound cosigner approves out-of-band, then apply lands the reorder.
    await approve(v1);
    await applyOwner(v1);

    const policy = await program.account.policyConfig.fetch(v1.policyPda);
    expect(policy.protocols[0].equals(protoA), "A now index 0").to.equal(true);
    expect(policy.protocols[1].equals(protoP), "P now index 1").to.equal(true);
  });

  it("(c) benign reorder on a vault with NO armed hashes/caps → owner-alone OK", async () => {
    // Fresh cosign vault, nothing armed. A pure reorder is NOT a weakening, so
    // it must remain non-elevated (no over-gating).
    const v2 = await initVault(new BN(22), [protoP, protoA]);
    // Enable cosign so the ONLY thing that could block the reorder is the new
    // triggers — and they must not fire (nothing armed).
    {
      const digest = await fetchAndComputeQueueDigest(
        program,
        v2.policyPda,
        v2.vaultPda,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
      );
      await queue(
        v2,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
        PublicKey.default,
        digest,
      );
      advanceTime(svm, TIMELOCK.toNumber() + 1);
      await applyOwner(v2);
    }

    const digest = await fetchAndComputeQueueDigest(
      program,
      v2.policyPda,
      v2.vaultPda,
      { protocols: [protoA, protoP] },
    );
    await queue(
      v2,
      { protocols: [protoA, protoP] },
      PublicKey.default, // owner-alone — must be accepted (non-elevated)
      digest,
    );
    advanceTime(svm, TIMELOCK.toNumber() + 1);
    await applyOwner(v2);

    const policy = await program.account.policyConfig.fetch(v2.policyPda);
    expect(policy.protocols[0].equals(protoA), "reorder applied").to.equal(
      true,
    );
  });

  it("(e) owner-alone reorder that weakens an armed per-protocol cap → ErrCosignRequired", async () => {
    // Vault with per-protocol caps armed: P=$100, A=$200. Reorder [P, A] → [A, P]
    // (protocol_caps:None) rebinds P onto A's larger cap by identity → weakening.
    const capP = new BN(100_000_000);
    const capA = new BN(200_000_000);
    const v3 = await initVault(new BN(23), [protoP, protoA], [capP, capA]);
    // Enable cosign + bind cosigner (non-elevated at this point).
    {
      const digest = await fetchAndComputeQueueDigest(
        program,
        v3.policyPda,
        v3.vaultPda,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
      );
      await queue(
        v3,
        { cosignRequired: true, cosignSessionPubkey: cosigner.publicKey },
        PublicKey.default,
        digest,
      );
      advanceTime(svm, TIMELOCK.toNumber() + 1);
      await applyOwner(v3);
    }

    const digest = await fetchAndComputeQueueDigest(
      program,
      v3.policyPda,
      v3.vaultPda,
      { protocols: [protoA, protoP] },
    );
    try {
      await queue(
        v3,
        { protocols: [protoA, protoP] },
        PublicKey.default, // owner-alone
        digest,
      );
      expect.fail("expected ErrCosignRequired (reorder weakens an armed cap)");
    } catch (err) {
      expectSigilError(err, { name: "ErrCosignRequired" });
    }

    const policy = await program.account.policyConfig.fetch(v3.policyPda);
    expect(policy.protocols[0].equals(protoP), "P order unchanged").to.equal(
      true,
    );
  });
});
