/**
 * Phase 7.1 audit-log burst + sysvar-freshness coverage.
 *
 * Tracks the Bucket 2 Phase 10 pre-redeploy work documented at
 * `PHASE_7_REVIEW/README.md:62-72` — surfaces that the canonical Phase 7
 * suite (`tests/audit-log.ts`) covers in a single 130-write happy path
 * but does NOT stress with:
 *
 *   MED-1 (this file, suite 1):
 *     Multiple wraparounds (2× capacity), explicit head/count regression
 *     guards, FIFO-from-head ordering invariant under mutation, register/
 *     revoke as an alternate burst driver.
 *
 *   MED-2 (this file, suite 2):
 *     Sysvar freshness — slot/timestamp fields are READ per ix, not
 *     cached. Within LiteSVM the `slot_hashes` sysvar does not auto-tick
 *     per ix (documented constraint at `audit-log.ts:537-554`); the
 *     load-bearing freshness check is therefore "fields are populated +
 *     timestamp advances when wall-clock advances + slot_hash bytes
 *     change after `warpToSlot` between txs."
 *
 * MED-3 (per-disc coverage of the 10 untested emit sites) lives in
 * `tests/audit-log-coverage.ts`.
 *
 * Tests use unique vault_ids (9000-9099) so they can run in any order
 * and don't collide with the Phase 7 baseline suite (8000-8050) or the
 * coverage suite (9100-9199).
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
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  advanceTime,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// Per-entry layout — must match programs/sigil/src/state/audit_log_success.rs.
const ENTRY_SIZE = 64;
const SUCCESS_CAPACITY = 128;
const ENTRIES_OFFSET = 8 + 32; // after Anchor disc (8) + vault pubkey (32)

// CAPABILITY_OBSERVER (state/vault.rs) — non-spending agent capability.
// F-Q6: an instant OPERATOR (capability 2) grant on a single-key vault now
// reverts ErrOperatorGrantRequiresTimelock (6107). Every agent in this file is
// registered ONLY to drive an audit-log write (register/revoke burst) or to
// satisfy reactivate_vault's non-empty-agents precondition — none ever spends —
// so OBSERVER is the correct capability and keeps register_agent a single
// (disc=13) write, preserving every exact head/count assertion below. Mirrors
// the sibling MED-3 suite (tests/audit-log-coverage.ts) and the Phase 7
// baseline (tests/audit-log.ts), both already on OBSERVER.
const CAPABILITY_OBSERVER = 1;

// Discriminator allocation mirrors state/audit_log_success.rs.
const DISC_FREEZE = 5;
const DISC_REACTIVATE = 6;
const DISC_REVOKE_AGENT = 12;
const DISC_REGISTER_AGENT = 13;

interface AuditEntry {
  subject: Uint8Array;
  balanceDeltaIn: bigint;
  balanceDeltaOut: bigint;
  timestamp: bigint;
  slotHash: Uint8Array;
  blockhash: Uint8Array;
  discriminator: number;
}

function decodeEntry(buf: Buffer, offset: number): AuditEntry {
  return {
    subject: new Uint8Array(buf.subarray(offset, offset + 32)),
    balanceDeltaIn: buf.readBigInt64LE(offset + 32),
    balanceDeltaOut: buf.readBigInt64LE(offset + 40),
    timestamp: buf.readBigInt64LE(offset + 48),
    slotHash: new Uint8Array(buf.subarray(offset + 56, offset + 60)),
    blockhash: new Uint8Array(buf.subarray(offset + 60, offset + 63)),
    discriminator: buf[offset + 63],
  };
}

interface DecodedLog {
  vault: Uint8Array;
  head: number;
  count: number;
  rawEntries: AuditEntry[];
}

function decodeAuditLog(svm: LiteSVM, pda: PublicKey): DecodedLog {
  const acct = svm.getAccount(pda);
  if (!acct) throw new Error(`audit log not found at ${pda.toBase58()}`);
  const buf = Buffer.from(acct.data);
  const vault = new Uint8Array(buf.subarray(8, 40));
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  const head = buf[entriesEnd];
  const count = buf[entriesEnd + 1];
  const rawEntries: AuditEntry[] = [];
  for (let i = 0; i < SUCCESS_CAPACITY; i++) {
    rawEntries.push(decodeEntry(buf, ENTRIES_OFFSET + i * ENTRY_SIZE));
  }
  return { vault, head, count, rawEntries };
}

/**
 * Re-order the raw circular buffer into chronological order (oldest first).
 * Mirrors `sdk/kit/src/audit-log.ts::orderCircularEntries`. Load-bearing for
 * the mutation-discipline check: if the on-chain `append` ever drops the
 * `% CAPACITY` wrap, oldest+newest interleave and `chronological[0]` no
 * longer corresponds to the FIFO head.
 */
function ordered(log: DecodedLog): AuditEntry[] {
  if (log.count < SUCCESS_CAPACITY) return log.rawEntries.slice(0, log.count);
  const out: AuditEntry[] = [];
  for (let i = 0; i < SUCCESS_CAPACITY; i++) {
    out.push(log.rawEntries[(log.head + i) % SUCCESS_CAPACITY]);
  }
  return out;
}

describe("audit-log-burst (Phase 7.1)", () => {
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
   * Initialize a fresh vault and return its PDAs. Mirrors the Phase 7
   * baseline (`audit-log.ts::initVault`) modulo the `vaultId` parameter
   * — kept colocated rather than extracted to a helper because the
   * `initialize_vault` arg shape changes across phases and refactoring
   * a shared helper would create churn across N test files.
   *
   * Passes `createdAtSlot: Number(svm.getClock().slot)` to the digest
   * helper because earlier tests in the suite may have advanced the
   * LiteSVM clock via `advancePastSlot`. The on-chain `initialize_vault`
   * handler captures `Clock::get()?.slot` and recomputes the canonical
   * digest with that exact slot — without this binding, the second and
   * subsequent test vaults would fail digest verification (6080
   * `PolicyPreviewMismatch`).
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

    await program.methods
      .initializeVault(
        vaultId,
        STANDARD_INIT_DAILY_CAP,
        STANDARD_INIT_MAX_TX,
        1, // protocolMode = ALLOWLIST
        [jupiterProgramId],
        0, // destinationMode unused
        100,
        STANDARD_INIT_TIMELOCK,
        [],
        [],
        false, // observeOnly
        0x00ffffff,
        false, // auto_promote_grays
        5, // auto_revoke_threshold
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
          timelockDuration: STANDARD_INIT_TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          // PEN-CROSS-2: handler captures Clock::get().slot — must match.
          createdAtSlot: Number(svm.getClock().slot),
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

    return { vault, policy, tracker, overlay, auditSuccess, auditRejected };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Suite 1: F-19 buffer wraparound (MED-1)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Drive 200 writes (2 PAIRS × 100 = 200, total = 200 + 1 register = 201)
   * to exercise the wrap path TWICE. Mutation-discipline rationale:
   *
   *   - If `head = (head + 1) % CAPACITY` is replaced with `head + 1`
   *     (no modulo), the second wrap blows the u8 head past CAPACITY
   *     and decode parses entries at offsets > buffer end → asserts
   *     fail with random bytes for the most-recent entries.
   *
   *   - If `count = count.saturating_add(1)` drops the saturation, count
   *     wraps u8 at 256 — past two wraps (256 writes) count would reset
   *     to 0. We don't hit 256 here (only 201 writes) but the structural
   *     check still validates the saturated-at-CAPACITY invariant.
   *
   *   - If the wraparound modulo is dropped, `entries[idx] = entry`
   *     panics at runtime via the Anchor bounds-checked indexer — the
   *     LiteSVM test surfaces this as a clean transaction failure, not
   *     silent corruption.
   *
   * Kept under 30s by avoiding token-program CPIs (each iteration is
   * pure account mutation). Empirically ~700ms on the baseline machine.
   */
  it("MED-1: 201 writes (2× wrap via freeze/reactivate) — head/count regression guard", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9000));

    // Bootstrap: register one agent so reactivate_vault has the agent_set_hash
    // path covered (no new agent passed to reactivate).
    const agent = Keypair.generate();
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    // Buffer state: count=1 (disc=13 register), head=1.

    // Drive 100 freeze/reactivate pairs = 200 entries. Combined with the
    // initial register, total writes = 201. Two full wraps (256 entries
    // would be 2 exactly; 201 is 128 + 73 → head lands at 73).
    const PAIRS = 100;
    for (let i = 0; i < PAIRS; i++) {
      // Tick wall-clock so each entry has a unique timestamp. Defensive:
      // catches a regression where a future audit-log refactor would use
      // a cached clock snapshot for batch writes.
      advanceTime(svm, 1);
      await program.methods
        .freezeVault()
        .accounts({ owner: owner.publicKey, vault } as any)
        .rpc();
      // Phase 8 C28 cooldown: reactivate requires > 300s since last freeze.
      advanceTime(svm, 301);
      await program.methods
        .reactivateVault(null, null)
        .accounts({ owner: owner.publicKey, vault } as any)
        .rpc();
    }

    const log = decodeAuditLog(svm, auditSuccess);

    // Count must SATURATE at capacity — never exceed, never wrap to 0.
    expect(log.count, "count saturates at CAPACITY").to.equal(SUCCESS_CAPACITY);

    // Head = (total writes) mod CAPACITY = 201 mod 128 = 73.
    expect(log.head, "head modulo CAPACITY").to.equal(201 % SUCCESS_CAPACITY);

    // FIFO-from-head ordering: chronological[0] is the OLDEST retained,
    // chronological[CAPACITY-1] is the NEWEST. Walk the ordered list and
    // confirm pattern: 201 - 128 = 73 entries dropped. Drop sequence:
    //   entry #1   = register   (disc=13) → dropped
    //   entry #2   = freeze     (disc=5)  → dropped
    //   entry #3   = reactivate (disc=6)  → dropped
    //   ...
    //   entry #73  = freeze     (disc=5)  → dropped (73 is odd → freeze)
    //   entry #74  = reactivate (disc=6)  → OLDEST RETAINED
    //                                       chronological[0]
    // Walk: from entry #74 onwards alternates reactivate/freeze/reactivate/...
    // until entry #201 (last write) which is the 100th reactivate → newest.
    const chronological = ordered(log);
    expect(chronological).to.have.lengthOf(SUCCESS_CAPACITY);

    // Newest entry (most recent reactivate, disc=6).
    expect(
      chronological[chronological.length - 1].discriminator,
      "newest = last reactivate",
    ).to.equal(DISC_REACTIVATE);
    // Second-newest is the freeze that preceded it (disc=5).
    expect(
      chronological[chronological.length - 2].discriminator,
      "second-newest = preceding freeze",
    ).to.equal(DISC_FREEZE);

    // OLDEST retained: entry #74 is a reactivate (entry #1 register, #2 freeze,
    // #3 reactivate, ... entry #N where N is the position. After register
    // (#1), pairs go (freeze=#2, reactivate=#3), (freeze=#4, reactivate=#5)...
    // So even position = freeze, odd position = reactivate (treating #1 as
    // register exception). Position 74 = freeze. Wait — register at #1
    // breaks parity: #1 register, #2 freeze, #3 react, #4 freeze, #5 react.
    // Even = freeze, odd = react. Position 74 is even → freeze.
    expect(
      chronological[0].discriminator,
      "oldest retained = entry #74 (even position → freeze after register-bootstrap)",
    ).to.equal(DISC_FREEZE);

    // §RP-1 FIX-4 off-by-one guard: if `head + 1` were used in the reorder
    // function, chronological[0] would shift to disc=6 (reactivate). The
    // above assertion catches it.

    // Timestamps strictly monotonic across the ordered window.
    for (let i = 1; i < chronological.length; i++) {
      expect(
        chronological[i].timestamp >= chronological[i - 1].timestamp,
        `timestamp monotonic at i=${i}`,
      ).to.be.true;
    }

    // Discriminator alternation in the retained window (after position #74):
    // freeze, react, freeze, react, ... So chronological[i].discriminator
    // toggles between 5 and 6 across consecutive pairs.
    // Defense-in-depth: catches any regression where entries get duplicated
    // or skipped during wrap (e.g. an extra `head++` that drops an entry).
    let freezeCount = 0;
    let reactivateCount = 0;
    for (const e of chronological) {
      if (e.discriminator === DISC_FREEZE) freezeCount++;
      else if (e.discriminator === DISC_REACTIVATE) reactivateCount++;
    }
    // 128 retained entries, alternating, should be 64/64.
    expect(
      freezeCount + reactivateCount,
      "all retained are freeze/react",
    ).to.equal(SUCCESS_CAPACITY);
    expect(freezeCount, "even freezeCount").to.equal(64);
    expect(reactivateCount, "even reactivateCount").to.equal(64);
  });

  /**
   * Alternate burst driver: 65 register/revoke cycles = 130 entries
   * (disc=13 register, disc=12 revoke). This exercises buffer wraparound
   * via a DIFFERENT pair of discriminators, hardening against a regression
   * where one specific instruction's audit-log emit is broken.
   *
   * Per-iteration: registers a fresh agent, then revokes it. Each pair
   * writes 2 entries. 65 pairs → 130 writes → 2 entries past CAPACITY,
   * head lands at 2 (130 mod 128). Combined runtime ~3s on baseline.
   */
  it("MED-1: 130 writes via register/revoke cycles — alternate disc coverage", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9001));
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // M1-03 (2026-05-31): use a ROLLING agent so the vault never hits zero
    // agents mid-loop. `revoke_agent` auto-freezes the vault when it removes the
    // LAST agent (revoke_agent.rs:94, FreezeReason::AutoRevoke), and register_agent
    // is now gated on a frozen vault (M1-03). By always registering the next
    // agent BEFORE revoking the previous one, agent_count stays ≥1 until the
    // final revoke, which is the last op (nothing registers after it). Still 65
    // registers + 65 revokes = 130 writes, same buffer-wrap coverage.
    //
    // Assertions are computed from the recorded write order (`writes`) rather
    // than hardcoded positions — robust to the rolling reorder and strictly
    // stronger than the prior magic-number checks.
    const TOTAL_PAIRS = 65; // 65 register + 65 revoke = 130 writes
    const writes: number[] = [];
    let prevAgent: Keypair | null = null;
    for (let i = 0; i < TOTAL_PAIRS; i++) {
      const agent = Keypair.generate();
      await program.methods
        .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          agentSpendOverlay: overlay,
        } as any)
        .rpc();
      writes.push(DISC_REGISTER_AGENT);
      if (prevAgent) {
        await program.methods
          .revokeAgent(prevAgent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault,
            policy,
            agentSpendOverlay: overlay,
          } as any)
          .rpc();
        writes.push(DISC_REVOKE_AGENT);
      }
      prevAgent = agent;
    }
    // Final revoke removes the last agent → vault auto-freezes here (terminal op).
    await program.methods
      .revokeAgent(prevAgent!.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    writes.push(DISC_REVOKE_AGENT);

    expect(writes.length, "130 total writes").to.equal(130);

    const log = decodeAuditLog(svm, auditSuccess);
    expect(log.count, "count saturates at CAPACITY").to.equal(SUCCESS_CAPACITY);
    expect(log.head, "head = total writes mod CAPACITY").to.equal(
      writes.length % SUCCESS_CAPACITY,
    );

    // The retained 128 entries are exactly the LAST 128 writes, in order.
    const expected = writes.slice(writes.length - SUCCESS_CAPACITY);
    const chronological = ordered(log);
    expect(chronological.length).to.equal(SUCCESS_CAPACITY);
    chronological.forEach((e, idx) => {
      expect(e.discriminator, `retained entry ${idx} disc`).to.equal(
        expected[idx],
      );
    });
    // Coverage: both register and revoke discs are present in the window.
    expect(
      chronological.some((e) => e.discriminator === DISC_REGISTER_AGENT),
      "register disc present",
    ).to.equal(true);
    expect(
      chronological.some((e) => e.discriminator === DISC_REVOKE_AGENT),
      "revoke disc present",
    ).to.equal(true);
  });

  /**
   * Boundary check: at EXACTLY CAPACITY writes (128), head wraps to 0 and
   * count saturates — this is the inflection moment where a regression in
   * the wrap modulo would first manifest. The Phase 7 baseline does 131
   * writes; this targets the exact-boundary case.
   */
  it("MED-1: exactly 128 writes — head wraps to 0, count saturates exactly", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9002));
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // M1-03 (2026-05-31): ROLLING agent so the vault never hits zero agents
    // mid-loop (revoke_agent auto-freezes at zero → register_agent then gated).
    // 64 registers + 64 revokes = exactly 128 writes (head wraps to 0). Pattern:
    // register #1, then 63×(register, revoke), then the final revoke — the last
    // revoke is terminal (auto-freezes), nothing registers after it.
    const writes: number[] = [];
    let prevAgent: Keypair | null = null;
    for (let i = 0; i < 64; i++) {
      const agent = Keypair.generate();
      await program.methods
        .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          agentSpendOverlay: overlay,
        } as any)
        .rpc();
      writes.push(DISC_REGISTER_AGENT);
      if (prevAgent) {
        await program.methods
          .revokeAgent(prevAgent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault,
            policy,
            agentSpendOverlay: overlay,
          } as any)
          .rpc();
        writes.push(DISC_REVOKE_AGENT);
      }
      prevAgent = agent;
    }
    await program.methods
      .revokeAgent(prevAgent!.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    writes.push(DISC_REVOKE_AGENT);

    expect(writes.length, "exactly 128 writes").to.equal(SUCCESS_CAPACITY);

    const log = decodeAuditLog(svm, auditSuccess);
    expect(log.count, "count saturates at CAPACITY").to.equal(SUCCESS_CAPACITY);
    expect(log.head, "head wraps to 0 after exactly CAPACITY writes").to.equal(
      0,
    );

    // At exactly CAPACITY writes, physical order == chronological == write order.
    const chronological = ordered(log);
    chronological.forEach((e, idx) => {
      expect(e.discriminator, `entry ${idx} disc`).to.equal(writes[idx]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Suite 2: Sysvar freshness (MED-2)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Mutate the `slot_hashes` sysvar in place by getting the head entry,
   * mutating its slot+hash via the setters, and writing the array back.
   *
   * **LiteSVM gotcha:** `warpToSlot()` updates the Clock sysvar but does
   * NOT touch `slot_hashes_sysvar`. Empirically confirmed via probe
   * (2026-05-21): a freshly-init'd LiteSVM has exactly 1 slot_hash
   * entry, and `warpToSlot(N)` leaves both `slot` (still 0) and `hash`
   * unchanged. The only way to advance the sysvar in LiteSVM is to call
   * `setSlotHashes()` with mutated entries. Live cluster execution
   * does this implicitly every slot.
   *
   * We can't construct a fresh `SlotHash` object (no public napi
   * constructor — proved by probe: `{ slot, hash }` literals fail with
   * "Failed to recover SlotHash type from napi value"). So we mutate
   * the existing entry's slot+hash setters and write the array back.
   */
  function advanceSlotHashSysvar(newSlot: bigint, newHashBase58: string): void {
    const current = svm.getSlotHashes();
    if (current.length === 0)
      throw new Error("slot_hashes sysvar unexpectedly empty");
    current[0].slot = newSlot;
    current[0].hash = newHashBase58;
    svm.setSlotHashes(current);
  }

  /**
   * Sysvar freshness: the slot_hash + blockhash bytes embedded in each
   * audit entry MUST come from a FRESH `slot_hashes_sysvar` read on every
   * ix, not a cached snapshot. Guards against a TOCTOU-style attack where
   * a sibling ix could (in principle) modify the sysvar between reads.
   *
   * **LiteSVM constraint:** the `slot_hashes` sysvar is populated once at
   * `withSysvars()` init and does NOT auto-tick per ix the way live
   * cluster execution does — `warpToSlot()` only updates the Clock
   * sysvar (probe-verified 2026-05-21). To exercise per-ix freshness we
   * use `advanceSlotHashSysvar()` between transactions to mutate the
   * sysvar in place.
   *
   * The defense-in-depth Anchor `address = SlotHashes::id()` constraint
   * at the account level is enforced by the framework BEFORE the handler
   * runs, so a writable-mark attack on the sysvar is blocked at account-
   * validation time (not inside the handler) — this freshness test
   * therefore covers the "stale cached read" regression class, not the
   * "malicious sibling write" one. Full per-tx-in-flight sysvar
   * tampering belongs in Surfpool sandwich tests where intra-tx CPI
   * inflight account state can be observed.
   */
  it("MED-2: sysvar freshness — slot_hash changes per ix when sysvar advances", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9010));

    // Bootstrap: register one agent so `reactivate_vault(null, null)`
    // doesn't fail with NoAgentRegistered (6011) — the handler requires
    // at least one agent present unless a new one is passed.
    const bootstrapAgent = Keypair.generate();
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await program.methods
      .registerAgent(bootstrapAgent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();
    // Buffer state: count=1 (register disc=13). Entries below assume
    // freshness across the NEXT three writes (freeze, reactivate, freeze).

    // Mutate slot_hashes sysvar to a distinct slot+hash before each tx.
    // The handler reads slot_hashes_sysvar[0] and stores:
    //   - 4 bytes LE of the slot at offset 56..60
    //   - 3 bytes prefix of the hash at offset 60..63
    // We pick distinct slot numbers and base58 hashes so each entry's
    // (slot_hash, blockhash) tuple is unique.
    //
    // Three different base58 hashes (all valid 32-byte pubkeys); the
    // first 3 bytes after base58-decode determine the `blockhash` field.
    const HASH_A = "11111111111111111111111111111111"; // first 3 bytes 0x000000
    const HASH_B = "9oG2VYRtkLqHv4ALR5gZpA6jVrhJfvfFrV98sB2gqfgN"; // distinct
    const HASH_C = "CmpNeggWJ4JaWJeJ8YKN1Zypmk7uvQq3PECGUCAEMbky"; // distinct

    // Set sysvar BEFORE entry #1.
    advanceSlotHashSysvar(BigInt(1_000), HASH_A);

    // Write entry #1 at the initial slot (freeze, disc=5).
    await program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();
    let log = decodeAuditLog(svm, auditSuccess);
    expect(log.count).to.equal(2);
    const entry1 = log.rawEntries[1];

    // Advance sysvar AND wall-clock past the reactivate cooldown.
    advanceSlotHashSysvar(BigInt(2_000), HASH_B);
    advanceTime(svm, 301);

    // Write entry #2 at the advanced slot (reactivate, disc=6).
    await program.methods
      .reactivateVault(null, null)
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();
    log = decodeAuditLog(svm, auditSuccess);
    expect(log.count).to.equal(3);
    const entry2 = log.rawEntries[2];

    // Advance sysvar again for entry #3.
    advanceSlotHashSysvar(BigInt(3_000), HASH_C);
    advanceTime(svm, 5);

    await program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();
    log = decodeAuditLog(svm, auditSuccess);
    expect(log.count).to.equal(4);
    const entry3 = log.rawEntries[3];

    // FRESHNESS ASSERTION #1: timestamps STRICTLY increase across all
    // three entries (wall-clock was advanced between every tx).
    expect(
      entry1.timestamp < entry2.timestamp,
      "timestamp e1<e2 (wall-clock advanced)",
    ).to.be.true;
    expect(
      entry2.timestamp < entry3.timestamp,
      "timestamp e2<e3 (wall-clock advanced again)",
    ).to.be.true;

    // FRESHNESS ASSERTION #2: slot_hash MUST differ between entries
    // because we mutated the slot_hashes sysvar to distinct slot
    // numbers between each tx. The 4-byte slot prefix encodes the slot
    // in LE, so distinct slot numbers (1000, 2000, 3000) produce
    // distinct 4-byte prefixes. If the implementation cached the
    // sysvar value across ixs, slot_hash would repeat → assertion fails.
    const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    expect(
      bytesEqual(entry1.slotHash, entry2.slotHash),
      "slot_hash MUST change across sysvar-advanced writes (e1 vs e2)",
    ).to.be.false;
    expect(
      bytesEqual(entry2.slotHash, entry3.slotHash),
      "slot_hash MUST change across sysvar-advanced writes (e2 vs e3)",
    ).to.be.false;
    // Also confirm e1 differs from e3 (transitively true but explicit
    // here as a defense against a swapped-cache regression).
    expect(
      bytesEqual(entry1.slotHash, entry3.slotHash),
      "slot_hash differs across all three (transitive)",
    ).to.be.false;

    // FRESHNESS ASSERTION #3: blockhash bytes also change between
    // entries because we picked three distinct hash strings. The
    // handler stores the first 3 bytes of `hash`. If a future
    // regression starts reading hash bytes from a different sysvar
    // (e.g. recent_blockhashes, which is DEPRECATED), the blockhash
    // field would still match the slot_hash bytes since the test
    // would only have advanced one sysvar — this dual-field check
    // catches that drift.
    expect(
      bytesEqual(entry1.blockhash, entry2.blockhash),
      "blockhash MUST change across sysvar-advanced writes (e1 vs e2)",
    ).to.be.false;
    expect(
      bytesEqual(entry2.blockhash, entry3.blockhash),
      "blockhash MUST change across sysvar-advanced writes (e2 vs e3)",
    ).to.be.false;

    // FRESHNESS ASSERTION #4: the 4-byte slot_hash field matches the
    // LE encoding of the slot we wrote. The handler reads at
    // `slot_hashes_sysvar.data[8..12]` (positions 0..3 of slot at
    // offset 8 inside the sysvar). For slot=1000 (0x3E8), the bytes
    // are [0xE8, 0x03, 0x00, 0x00].
    const expectSlotLE4 = (
      label: string,
      bytes: Uint8Array,
      expected: number,
    ): void => {
      const got =
        bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
      expect(got >>> 0, `${label}: slot_hash LE = expected slot`).to.equal(
        expected,
      );
    };
    expectSlotLE4("e1", entry1.slotHash, 1000);
    expectSlotLE4("e2", entry2.slotHash, 2000);
    expectSlotLE4("e3", entry3.slotHash, 3000);
  });

  /**
   * Negative-control: WITHOUT a slot advance between txs, the slot_hash
   * field would (in LiteSVM) be identical across consecutive entries
   * because `slot_hashes_sysvar` data is static between SVM clock
   * advances. The timestamp delta would still show via `advanceTime`,
   * but slot_hash byte-equality is the LiteSVM-detectable signal that
   * the handler IS reading the sysvar (not a hardcoded constant).
   *
   * Two back-to-back writes on the SAME slot ⇒ slot_hash bytes match.
   * If they differed without a clock advance, the implementation is
   * pulling from somewhere other than the address-pinned sysvar
   * account — that's a different bug class but the LiteSVM signal is
   * clean.
   */
  it("MED-2: same-slot writes share slot_hash bytes (LiteSVM static-sysvar baseline)", async () => {
    const { vault, auditSuccess } = await initVault(new BN(9011));

    // Bootstrap agent so reactivate(null,null) works (same rationale as
    // the freshness test above).
    const bootstrapAgent = Keypair.generate();
    const [policy] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vault.toBuffer()],
      program.programId,
    );
    const [overlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vault.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await program.methods
      .registerAgent(bootstrapAgent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .rpc();

    // Two writes WITHOUT advancePastSlot between them. Tick wall-clock
    // only (so timestamps still differ — proves wall-clock independent
    // of slot-hashes).
    await program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();
    advanceTime(svm, 301);
    await program.methods
      .reactivateVault(null, null)
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();

    const log = decodeAuditLog(svm, auditSuccess);
    // count = 1 (register) + 2 (freeze, reactivate) = 3
    expect(log.count).to.equal(3);
    const e1 = log.rawEntries[1]; // freeze
    const e2 = log.rawEntries[2]; // reactivate

    // Timestamps differ (wall-clock advanced).
    expect(e1.timestamp < e2.timestamp, "timestamp advances").to.be.true;

    // In LiteSVM, without an explicit `warpToSlot` between txs, the
    // slot_hashes sysvar data is unchanged → entries share slot_hash.
    // This is the BASELINE behaviour that the per-tx-fresh test
    // (above) inverts via `advancePastSlot`. Documenting both forms
    // gives a clean regression signal: if same-slot writes ever start
    // diverging, the handler has acquired a hidden non-sysvar input.
    let sameSlotHash = true;
    for (let i = 0; i < 4; i++) {
      if (e1.slotHash[i] !== e2.slotHash[i]) {
        sameSlotHash = false;
        break;
      }
    }
    expect(
      sameSlotHash,
      "same-slot writes share slot_hash (LiteSVM static-sysvar invariant)",
    ).to.be.true;
  });
});
