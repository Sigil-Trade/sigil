/**
 * F-Q6 vault-creation COMPOSITION LEGALITY proofs (LiteSVM, program-level).
 *
 * PURPOSE: settle — empirically, not by reading — which atomic instruction
 * compositions the `@usesigil/kit` `createVault` path MAY legally emit when the
 * first-agent capability requested is OPERATOR (2) on a single-key (EOA, cosign
 * off) vault. `register_agent` alone reverts 6107 for that case
 * (ErrOperatorGrantRequiresTimelock — the current kit default defect), so a
 * timelocked path is required.
 *
 * KEY FINDING PROVEN HERE: `queue_agent_grant` / `apply_agent_grant` is the
 * "seat a BRAND-NEW operator agent" path — BOTH require `!vault.is_agent(agent)`
 * (queue_agent_grant.rs:119, apply_agent_grant.rs:263) and apply PUSHES a fresh
 * AgentEntry (apply_agent_grant.rs:276). Therefore registering the SAME agent as
 * OBSERVER first and THEN queueing an OPERATOR grant for it REVERTS
 * `AgentAlreadyRegistered` (6010) — whether same-tx or split across two txs.
 * The distinct "Observer now, elevate later" path is
 * `queue_agent_permissions_update` -> `apply_agent_permissions_update`
 * (elevates an EXISTING agent 1->2, timelocked by policy.timelock_duration).
 *
 * These tests use the raw program (Anchor IDL, LiteSVM) with atomic
 * VersionedTransactions built from Anchor `.instruction()`s and sent via
 * `sendVersionedTx` — i.e. the exact multi-ix atomic shape the kit builds.
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
  TransactionInstruction,
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
  sendVersionedTx,
  MOCK_DEFI_PROGRAM_ID,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";
import { expectSigilError } from "./helpers/strict-errors";

const CAPABILITY_OBSERVER = 1;
const CAPABILITY_OPERATOR = 2;
/** programs/sigil/src/utils/operator_grant.rs — single-key OPERATOR floor. */
const SINGLE_KEY_OPERATOR_DELAY_FLOOR = 600;
/** policy.timelock_duration used for these vaults (>= MIN_TIMELOCK_DURATION 1800). */
const POLICY_TIMELOCK = 1800;
const DAILY_CAP = new BN(500_000_000);
const MAX_TX = new BN(100_000_000);

describe("F-Q6 — vault-creation composition legality (kit createVault paths)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: Keypair;
  const feeDestination = Keypair.generate();

  function pdasFor(vault: PublicKey) {
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
    const [pendingAgentGrant] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_grant"), vault.toBuffer()],
      program.programId,
    );
    const [auditSuccess] = PublicKey.findProgramAddressSync(
      [Buffer.from("audit_success"), vault.toBuffer()],
      program.programId,
    );
    return { policy, tracker, overlay, pendingAgentGrant, auditSuccess };
  }

  function vaultPdaFor(vaultId: BN): PublicKey {
    const [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    return vault;
  }

  function pendingAgentPermsPda(vault: PublicKey, agent: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_agent_perms"), vault.toBuffer(), agent.toBuffer()],
      program.programId,
    );
    return pda;
  }

  /**
   * Build the `initialize_vault` instruction for a fresh single-key vault.
   * `observeOnly=true` needs no allowlist; `observeOnly=false` requires a
   * non-empty `protocols` allowlist (F-11). createdAtSlot defaults to 0 —
   * valid because these tests only ever advanceTime (never advance the slot).
   */
  function initVaultIx(
    vaultId: BN,
    opts: { observeOnly: boolean; protocols?: PublicKey[] },
  ): Promise<TransactionInstruction> {
    const vault = vaultPdaFor(vaultId);
    const { policy, tracker, overlay } = pdasFor(vault);
    const protocols = opts.protocols ?? [];
    return program.methods
      .initializeVault(
        vaultId,
        DAILY_CAP,
        MAX_TX,
        1, // protocolMode = ALLOWLIST
        protocols,
        0, // developerFeeRate
        100, // maxSlippageBps
        new BN(POLICY_TIMELOCK),
        [], // allowedDestinations
        [], // protocolCaps
        opts.observeOnly,
        0x00ffffff, // operatingHours
        false, // autoPromoteGrays
        5, // autoRevokeThreshold
        new BN(0), // stableBalanceFloor
        new BN(0), // perRecipientDailyCapUsd
        false, // cosignRequired (single-key EOA)
        initVaultPreviewDigest({
          dailySpendingCapUsd: DAILY_CAP,
          maxTransactionSizeUsd: MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols,
          allowedDestinations: [],
          timelockDuration: new BN(POLICY_TIMELOCK),
          observeOnly: opts.observeOnly,
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
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
  }

  function registerAgentIx(
    vault: PublicKey,
    agent: PublicKey,
    capability: number,
    spendingLimitUsd: BN,
  ): Promise<TransactionInstruction> {
    const { policy, overlay, auditSuccess } = pdasFor(vault);
    return program.methods
      .registerAgent(agent, capability, spendingLimitUsd)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
      } as any)
      .instruction();
  }

  function queueAgentGrantIx(
    vault: PublicKey,
    agent: PublicKey,
    spendingLimitUsd: BN,
  ): Promise<TransactionInstruction> {
    const { policy, pendingAgentGrant, auditSuccess } = pdasFor(vault);
    return program.methods
      .queueAgentGrant(agent, CAPABILITY_OPERATOR, spendingLimitUsd)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingAgentGrant,
        auditLogSuccess: auditSuccess,
        slotHashesSysvar: SYSVAR_SLOT_HASHES_PUBKEY,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
  }

  function applyAgentGrantIx(
    vault: PublicKey,
  ): Promise<TransactionInstruction> {
    const { policy, overlay, pendingAgentGrant, auditSuccess } = pdasFor(vault);
    return program.methods
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
      .instruction();
  }

  function queueAgentPermsIx(
    vault: PublicKey,
    agent: PublicKey,
    newCapability: number,
    spendingLimitUsd: BN,
  ): Promise<TransactionInstruction> {
    const { policy } = pdasFor(vault);
    return program.methods
      .queueAgentPermissionsUpdate(
        agent,
        newCapability,
        spendingLimitUsd,
        new BN(0), // cooldownSeconds
        PublicKey.default, // cosignSession — non-elevated (cosign off)
      )
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms: pendingAgentPermsPda(vault, agent),
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
  }

  function applyAgentPermsIx(
    vault: PublicKey,
    agent: PublicKey,
  ): Promise<TransactionInstruction> {
    const { policy, overlay, auditSuccess } = pdasFor(vault);
    // Committed-IDL workaround (mirrors f1-timelock-1b.ts): audit_log_success +
    // slot_hashes sysvar are trailing remaining accounts — the committed Anchor
    // IDL for apply_agent_permissions_update lags the on-chain struct.
    return program.methods
      .applyAgentPermissionsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pendingAgentPerms: pendingAgentPermsPda(vault, agent),
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
      .instruction();
  }

  async function agentCapability(
    vault: PublicKey,
    agent: PublicKey,
  ): Promise<number | undefined> {
    const v: any = await program.account.agentVault.fetch(vault);
    const entry = (
      v.agents as ReadonlyArray<{ pubkey: PublicKey; capability: number }>
    ).find((a) => a.pubkey.toBase58() === agent.toBase58());
    return entry?.capability;
  }

  async function agentCount(vault: PublicKey): Promise<number> {
    const v: any = await program.account.agentVault.fetch(vault);
    return (v.agents as ReadonlyArray<unknown>).length;
  }

  function expectRevert(fn: () => void, name: any, code: number): void {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(
      caught,
      `expected revert ${name} (${code}) but call succeeded`,
    ).to.not.equal(undefined);
    expectSigilError(caught, { name, code });
  }

  before(() => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = Keypair.generate();
    airdropSol(svm, owner.publicKey, 1000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  // ── LEGAL Option 1 — "queued seat": [init, queue_agent_grant] atomic ────────
  // The team lead's cited devnet history (InitializeVault -> QueueAgentGrant ->
  // ApplyAgentGrant). Agent is NOT on the vault until apply (~10 min).
  it("Option 1 [init, queue_agent_grant] SAME-TX → SUCCESS; agent seated OPERATOR only after 600s + apply", async () => {
    const vaultId = new BN(7001);
    const vault = vaultPdaFor(vaultId);
    const { pendingAgentGrant } = pdasFor(vault);
    const agent = Keypair.generate().publicKey;

    // Atomic init + queue in ONE versioned tx (answers the same-tx legality Q).
    sendVersionedTx(
      svm,
      [
        await initVaultIx(vaultId, { observeOnly: true }),
        await queueAgentGrantIx(vault, agent, new BN(0)),
      ],
      owner,
    );

    // Agent NOT yet seated; a PendingAgentGrant exists with the 600s floor.
    expect(await agentCount(vault)).to.equal(0);
    const pending: any =
      await program.account.pendingAgentGrant.fetch(pendingAgentGrant);
    expect(pending.agent.toBase58()).to.equal(agent.toBase58());
    expect(pending.capability).to.equal(CAPABILITY_OPERATOR);
    expect(new BN(pending.minDelaySeconds).toNumber()).to.equal(
      SINGLE_KEY_OPERATOR_DELAY_FLOOR,
    );

    // Mature past the 600s floor, then apply → OPERATOR seated.
    advanceTime(svm, SINGLE_KEY_OPERATOR_DELAY_FLOOR + 1);
    sendVersionedTx(svm, [await applyAgentGrantIx(vault)], owner);
    expect(await agentCapability(vault, agent)).to.equal(CAPABILITY_OPERATOR);
  });

  // ── Option 1 apply BEFORE maturation → REVERTS (the delay is real) ──────────
  // The kit surfaces `operatorGrant.appliesAfterUnix`; this proves apply is
  // genuinely gated until then (companion to the after-maturation success above).
  it("Option 1 apply_agent_grant BEFORE the 600s floor elapses → REVERTS TimelockNotExpired (6022)", async () => {
    const vaultId = new BN(7007);
    const vault = vaultPdaFor(vaultId);
    const agent = Keypair.generate().publicKey;

    sendVersionedTx(
      svm,
      [
        await initVaultIx(vaultId, { observeOnly: true }),
        await queueAgentGrantIx(vault, agent, new BN(0)),
      ],
      owner,
    );

    // Apply immediately (0s elapsed, well under the 600s floor) → reverts.
    // Pre-build the ix so the expectRevert closure stays synchronous.
    const applyIx = await applyAgentGrantIx(vault);
    expectRevert(
      () => sendVersionedTx(svm, [applyIx], owner),
      "TimelockNotExpired",
      6022,
    );

    // Still unseated; the grant is untouched and remains applyable post-floor.
    expect(await agentCount(vault)).to.equal(0);
  });

  // ── ILLEGAL (prescribed design) — register(OBSERVER)+queue_grant(same agent) ─
  it("[init, register(OBSERVER), queue_agent_grant(same agent)] SAME-TX → REVERTS AgentAlreadyRegistered (6010)", async () => {
    const vaultId = new BN(7002);
    const vault = vaultPdaFor(vaultId);
    const agent = Keypair.generate().publicKey;

    const initIx = await initVaultIx(vaultId, { observeOnly: true });
    const regIx = await registerAgentIx(
      vault,
      agent,
      CAPABILITY_OBSERVER,
      new BN(0),
    );
    const queueIx = await queueAgentGrantIx(vault, agent, new BN(0));

    expectRevert(
      () => sendVersionedTx(svm, [initIx, regIx, queueIx], owner),
      "AgentAlreadyRegistered",
      6010,
    );
  });

  // ── ILLEGAL (prescribed two-tx fallback) — same is_agent conflict ───────────
  it("two-tx fallback: register(OBSERVER) then a SEPARATE queue_agent_grant(same agent) → REVERTS 6010", async () => {
    const vaultId = new BN(7003);
    const vault = vaultPdaFor(vaultId);
    const agent = Keypair.generate().publicKey;

    // tx1: init + register the agent as OBSERVER (succeeds).
    sendVersionedTx(
      svm,
      [
        await initVaultIx(vaultId, { observeOnly: true }),
        await registerAgentIx(vault, agent, CAPABILITY_OBSERVER, new BN(0)),
      ],
      owner,
    );
    expect(await agentCapability(vault, agent)).to.equal(CAPABILITY_OBSERVER);

    // tx2: queue an OPERATOR grant for the SAME (now-registered) agent → 6010.
    const queueIx = await queueAgentGrantIx(vault, agent, new BN(0));
    expectRevert(
      () => sendVersionedTx(svm, [queueIx], owner),
      "AgentAlreadyRegistered",
      6010,
    );
  });

  // ── LEGAL Option 2 — "Observer now, elevate later" via perms-update ─────────
  it("Option 2 [init, register(OBSERVER), queue_agent_permissions_update(->OPERATOR)] SAME-TX → SUCCESS; observer now, operator after timelock", async () => {
    const vaultId = new BN(7004);
    const vault = vaultPdaFor(vaultId);
    const agent = Keypair.generate().publicKey;

    sendVersionedTx(
      svm,
      [
        await initVaultIx(vaultId, { observeOnly: true }),
        await registerAgentIx(vault, agent, CAPABILITY_OBSERVER, new BN(0)),
        await queueAgentPermsIx(
          vault,
          agent,
          CAPABILITY_OPERATOR,
          new BN(50_000_000),
        ),
      ],
      owner,
    );

    // Observer capability immediately; a PendingAgentPermissionsUpdate to 2.
    expect(await agentCapability(vault, agent)).to.equal(CAPABILITY_OBSERVER);
    const pendingPerms: any =
      await program.account.pendingAgentPermissionsUpdate.fetch(
        pendingAgentPermsPda(vault, agent),
      );
    expect(pendingPerms.newCapability).to.equal(CAPABILITY_OPERATOR);

    // Mature past policy.timelock_duration, then apply → OPERATOR.
    advanceTime(svm, POLICY_TIMELOCK + 1);
    sendVersionedTx(svm, [await applyAgentPermsIx(vault, agent)], owner);
    expect(await agentCapability(vault, agent)).to.equal(CAPABILITY_OPERATOR);
  });

  // ── REGRESSION — the CURRENT kit default [init, register(OPERATOR)] reverts ──
  it("[init, register(OPERATOR)] SAME-TX on single-key → REVERTS ErrOperatorGrantRequiresTimelock (6107) [the defect]", async () => {
    const vaultId = new BN(7005);
    const vault = vaultPdaFor(vaultId);
    const agent = Keypair.generate().publicKey;

    const initIx = await initVaultIx(vaultId, { observeOnly: true });
    const regIx = await registerAgentIx(
      vault,
      agent,
      CAPABILITY_OPERATOR,
      new BN(0),
    );
    expectRevert(
      () => sendVersionedTx(svm, [initIx, regIx], owner),
      "ErrOperatorGrantRequiresTimelock",
      6107,
    );
  });

  // ── LEGAL Option 1 on a REAL active vault (observeOnly=false + allowlist) ────
  it("Option 1 [init(active, allowlist), queue_agent_grant] SAME-TX → SUCCESS (not just observe-only)", async () => {
    const vaultId = new BN(7006);
    const vault = vaultPdaFor(vaultId);
    const { pendingAgentGrant } = pdasFor(vault);
    const agent = Keypair.generate().publicKey;

    sendVersionedTx(
      svm,
      [
        await initVaultIx(vaultId, {
          observeOnly: false,
          protocols: [MOCK_DEFI_PROGRAM_ID],
        }),
        await queueAgentGrantIx(vault, agent, new BN(50_000_000)),
      ],
      owner,
    );

    const pending: any =
      await program.account.pendingAgentGrant.fetch(pendingAgentGrant);
    expect(pending.capability).to.equal(CAPABILITY_OPERATOR);
    expect(new BN(pending.minDelaySeconds).toNumber()).to.equal(
      SINGLE_KEY_OPERATOR_DELAY_FLOOR,
    );
  });
});
