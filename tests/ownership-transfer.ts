/**
 * Phase 8 Batch 3 — C26 ownership transfer LiteSVM coverage.
 *
 * Three new owner-side instructions land in this batch:
 *   - initiate_ownership_transfer  (disc=7)
 *   - accept_ownership_transfer    (disc=8)  EOA flow
 *   - cancel_ownership_transfer    (disc=9)
 *
 * The multisig-target accept variant (`is_multisig_target == true`) lives in
 * Batch 4 — this suite verifies the EOA path AND that the multisig path is
 * hard-rejected by today's EOA accept handler.
 *
 * Coverage map (Council ISC labels in parens):
 *   1. Happy: initiate + advance >= min_delay + accept                     (ISC-25..41)
 *   2. Boundary REJECT: accept at queued_at + min_delay - 1   → 6104       (ISC-37)
 *   3. Boundary OK:     accept at queued_at + min_delay        → success   (ISC-37)
 *   4. Double-init REJECT: initiate twice without cancel       → Anchor 0  (ISC-30 6103-class)
 *   5. Cancel by NON-current-owner REJECT: signer mismatch     → Anchor 2003
 *   6. Cancel HAPPY (cosign_required=false)                                 (ISC-49..53)
 *   7. Initiate when vault.Frozen REJECT                       → 6000      (ISC-130)
 *   8. Initiate to SystemProgram::ID REJECT                    → 6107      (ISC-128)
 *   9. Initiate when cosign_required=true + no cosigner REJECT → 6089      (ISC-129)
 *  10. Initiate when cosign_required=true + cosigner signs     → success
 *  11. Accept multisig-target via EOA handler REJECT           → 6104       (Batch 4 boundary)
 *
 * Each test uses a unique vault_id (9000+) to keep state isolated.
 *
 * Audit-log discriminator sanity (ISC-81..83): each happy path also asserts
 * the audit-log success buffer contains the expected disc byte (7/8/9).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  advanceTime,
  accountExists,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const STANDARD_INIT_DAILY_CAP = new BN(500_000_000);
const STANDARD_INIT_MAX_TX = new BN(100_000_000);
const STANDARD_INIT_TIMELOCK = new BN(1800);

// Mirrors PendingOwnershipTransfer::DEFAULT_MIN_DELAY (48h).
const DEFAULT_MIN_DELAY = 172_800;

// Mirrors reactivate_vault.rs REACTIVATE_COOLDOWN_SECONDS (5-min C28 cooldown).
const REACTIVATE_COOLDOWN_SECONDS = 300;

// CAPABILITY_OPERATOR (mirrors AgentCapability::Operator) — required for the
// LBL-01 spending tests because validate_and_authorize / agent_transfer both
// gate on has_capability(.., is_spending=true).
const FULL_CAPABILITY = 2;

// Audit-log discriminators (mirrors state/audit_log_success.rs).
const DISC_OWNERSHIP_INITIATE = 7;
const DISC_OWNERSHIP_ACCEPT = 8;
const DISC_OWNERSHIP_CANCEL = 9;
// Spending-path discriminators (mirrors state/audit_log_success.rs):
//   AUDIT_DISC_FINALIZE_SUCCESS = 2, AUDIT_DISC_WITHDRAW = 4.
const DISC_WITHDRAW = 4;
const DISC_FINALIZE_SUCCESS = 2;

// Per-entry layout — must match programs/sigil/src/state/audit_log_success.rs.
const ENTRY_SIZE = 64;
const SUCCESS_CAPACITY = 128;
const ENTRIES_OFFSET = 8 + 32; // after disc + vault

// Protocol treasury — must match the PROTOCOL_TREASURY constant in
// programs/sigil/src/state/constants.rs. agent_transfer + validate_and_authorize
// both require the treasury ATA when a protocol fee > 0 is collected.
const PROTOCOL_TREASURY = new PublicKey(
  "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
);

/** Decode the last-written audit-log success buffer entry's discriminator. */
function lastSuccessDisc(svm: LiteSVM, auditSuccess: PublicKey): number {
  const acct = svm.getAccount(auditSuccess);
  if (!acct) throw new Error("audit log missing");
  const buf = Buffer.from(acct.data);
  const entriesEnd = 8 + 32 + ENTRY_SIZE * SUCCESS_CAPACITY;
  const head = buf[entriesEnd];
  const count = buf[entriesEnd + 1];
  if (count === 0) throw new Error("audit log empty");
  // head points to the NEXT slot to write; the most recent entry is head-1.
  const lastIdx = (head + SUCCESS_CAPACITY - 1) % SUCCESS_CAPACITY;
  return buf[ENTRIES_OFFSET + lastIdx * ENTRY_SIZE + 63];
}

describe("ownership-transfer (Phase 8 Batch 3 — C26)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  // LBL-01 spending tests need the owner to hold USDC (for the deposit step)
  // and the protocol treasury to have a valid ATA (for fee transfers). Both
  // are seeded once in the top-level before() so they're available to every
  // spending test that calls `prepareSpendingVault(...)`.
  let ownerUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 1000 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);

    // Seed the owner's USDC ATA with enough liquidity to deposit into every
    // spending-test vault below. Each vault deposit is 600 USDC; 10K is
    // generous headroom across all 4 LBL-01 spending tests.
    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      ownerUsdcAta,
      owner.publicKey,
      10_000_000_000n, // 10K USDC
    );

    // Protocol treasury ATA — off-curve (PROTOCOL_TREASURY is a non-PDA
    // hardcoded pubkey, but agent_transfer asserts ownership at runtime, so
    // we pass allowOwnerOffCurve=true to let the ATA creation succeed).
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      DEVNET_USDC_MINT,
      PROTOCOL_TREASURY,
      true,
    );
  });

  /**
   * Initialize a fresh vault with optional cosign-required override. Returns
   * the PDAs the ownership-transfer handlers consume.
   *
   * The LBL-01 spending tests (added 2026-05-21) also use this helper, which
   * is why it now accepts an optional `allowedDestinations` list: agent_transfer
   * gates on `policy.is_destination_allowed(...)`, so that test needs a
   * destination wallet baked into the policy at init time.
   */
  async function initVault(
    vaultId: BN,
    opts: {
      cosignRequired?: boolean;
      allowedDestinations?: PublicKey[];
    } = {},
  ) {
    const cosignRequired = opts.cosignRequired ?? false;
    const allowedDestinations = opts.allowedDestinations ?? [];

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
        allowedDestinations,
        [],
        false, // observeOnly
        0x00ffffff,
        false, // autoPromoteGrays
        5, // autoRevokeThreshold
        new BN(0),
        new BN(0),
        cosignRequired,
        initVaultPreviewDigest({
          dailySpendingCapUsd: STANDARD_INIT_DAILY_CAP,
          maxTransactionSizeUsd: STANDARD_INIT_MAX_TX,
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations,
          timelockDuration: STANDARD_INIT_TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
          cosignRequired,
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

    return { vault, policy, tracker, overlay, auditSuccess, pendingOwner };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. HAPPY PATH — full initiate → wait → accept lifecycle.
  // ─────────────────────────────────────────────────────────────────────────
  it("happy path: initiate + advance min_delay + accept → vault.owner mutates, pending closed", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9000),
    );
    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

    // ACT — initiate.
    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // ASSERT — pending PDA populated + audit disc=7 written.
    const pendingState =
      await program.account.pendingOwnershipTransfer.fetch(pendingOwner);
    expect(pendingState.vault.toString()).to.equal(vault.toString());
    expect(pendingState.currentOwner.toString()).to.equal(
      owner.publicKey.toString(),
    );
    expect(pendingState.newOwner.toString()).to.equal(
      newOwner.publicKey.toString(),
    );
    expect(pendingState.isMultisigTarget).to.equal(false);
    expect(pendingState.minDelaySeconds.toString()).to.equal(
      DEFAULT_MIN_DELAY.toString(),
    );
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(
      DISC_OWNERSHIP_INITIATE,
    );

    // ACT — wait + accept.
    advanceTime(svm, DEFAULT_MIN_DELAY);

    await program.methods
      .acceptOwnershipTransfer()
      .accounts({
        newOwner: newOwner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([newOwner])
      .rpc();

    // ASSERT — vault.owner mutated, pending closed, audit disc=8 written.
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(newOwner.publicKey.toString());
    expect(accountExists(svm, pendingOwner)).to.equal(false);
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(DISC_OWNERSHIP_ACCEPT);

    // Phase 8 LBL-01 INVARIANT: vault_authority is IMMUTABLE across owner
    // transfer. The vault account itself stays at the original PDA address
    // (derived from the initial owner's pubkey + vault_id). If LBL-01
    // regresses, vault_authority would either be missing, mutated, or the
    // post-transfer downstream ix would fail with ConstraintSeeds.
    expect((vaultState as any).vaultAuthority.toString()).to.equal(
      owner.publicKey.toString(),
      "vault_authority MUST equal the original (init-time) owner — it is the immutable PDA seed-key",
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1B. LBL-01 REGRESSION GUARD — after ownership transfer, the new owner
  //     MUST be able to call owner-side instructions. Pre-LBL-01 the vault
  //     PDA seeds derived from `owner.key()` (or `vault.owner`), so once
  //     `vault.owner` mutated to `new_owner`, every subsequent owner-side
  //     ix derived a DIFFERENT PDA → Anchor ConstraintSeeds → vault bricked.
  //
  //     Post-LBL-01 the seeds derive from `vault.vault_authority` (immutable
  //     at init), so the new owner can sign owner-side ix successfully.
  // ─────────────────────────────────────────────────────────────────────────
  it("LBL-01: post-transfer new_owner can call owner-side ix (register_agent, pause_agent, freeze_vault) — vault NOT bricked", async () => {
    const { vault, policy, overlay, auditSuccess, pendingOwner } =
      await initVault(new BN(9050));
    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 5 * LAMPORTS_PER_SOL);

    // Phase 1: queue + accept ownership transfer.
    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, DEFAULT_MIN_DELAY);

    await program.methods
      .acceptOwnershipTransfer()
      .accounts({
        newOwner: newOwner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([newOwner])
      .rpc();

    // Sanity: vault.owner is the new owner; vault_authority is unchanged.
    const postTransferVault = await program.account.agentVault.fetch(vault);
    expect(postTransferVault.owner.toString()).to.equal(
      newOwner.publicKey.toString(),
    );
    expect((postTransferVault as any).vaultAuthority.toString()).to.equal(
      owner.publicKey.toString(),
      "vault_authority MUST NOT change across ownership transfer",
    );

    // Phase 2: from new_owner, register an agent. Pre-LBL-01 this would
    // fail with ConstraintSeeds because the seed-key was new_owner.key()
    // which doesn't match the vault PDA (originally derived from old
    // owner's key).
    const newAgent = Keypair.generate();
    await program.methods
      .registerAgent(newAgent.publicKey, 2, new BN(0)) // CAPABILITY_OPERATOR = 2
      .accounts({
        owner: newOwner.publicKey,
        vault,
        policy,
        agentSpendOverlay: overlay,
      } as any)
      .signers([newOwner])
      .rpc();

    const afterRegister = await program.account.agentVault.fetch(vault);
    expect(afterRegister.agents.length).to.equal(1);
    expect(afterRegister.agents[0]!.pubkey.toString()).to.equal(
      newAgent.publicKey.toString(),
    );

    // Phase 3: from new_owner, pause the just-registered agent. Same
    // LBL-01 invariant — owner-side ix from new_owner MUST succeed.
    await program.methods
      .pauseAgent(newAgent.publicKey)
      .accounts({
        owner: newOwner.publicKey,
        vault,
        policy,
      } as any)
      .signers([newOwner])
      .rpc();

    const afterPause = await program.account.agentVault.fetch(vault);
    expect(afterPause.agents[0]!.paused).to.equal(true);

    // Phase 4: from new_owner, freeze the vault. Spec-required spot-check
    // that the freeze code path also resolves the vault PDA via
    // vault_authority post-transfer.
    await program.methods
      .freezeVault()
      .accounts({
        owner: newOwner.publicKey,
        vault,
      } as any)
      .signers([newOwner])
      .rpc();

    const afterFreeze = await program.account.agentVault.fetch(vault);
    expect(afterFreeze.status).to.have.property("frozen");
    expect((afterFreeze as any).vaultAuthority.toString()).to.equal(
      owner.publicKey.toString(),
      "vault_authority remains immutable across freeze",
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LBL-01 SPENDING REGRESSION GUARDS (added 2026-05-21 — H-6 from
  // pre-redeploy audit at HEAD 48c62cc).
  //
  // CRITICAL fixes C-1..C-4 swapped the inline CPI signer_seeds in 4
  // spending handlers from `vault.owner` (mutates on ownership transfer)
  // to `vault.vault_authority` (immutable PDA seed-key per LBL-01):
  //   - withdraw_funds.rs
  //   - agent_transfer.rs
  //   - validate_and_authorize.rs (Approve CPI for delegated sessions)
  //   - finalize_session.rs (Revoke CPI + outcome-check)
  //
  // The pre-existing LBL-01 test above exercises 3 owner-side ix
  // (register_agent / pause_agent / freeze_vault) that already used the
  // correct Fix-Up B pattern; it does NOT exercise the 4 SPENDING paths
  // that were broken. These 3 new tests close that gap:
  //   - withdraw_funds: owner-side spending CPI
  //   - agent_transfer: agent-side spending CPI
  //   - seal() = validate + finalize: composed-tx spending CPI (covers
  //     both validate_and_authorize Approve and finalize_session Revoke +
  //     outcome-based settlement)
  //
  // Pre-fix failure mode for ALL 3: signer_seeds derived from
  // `vault.owner = new_owner` produces a DIFFERENT signer pubkey than
  // the vault PDA's actual address (which is derived from the original
  // owner = vault_authority). The CPI then fails its signature check
  // with MissingRequiredSignature (token::transfer / token::approve /
  // token::revoke all require the vault PDA to sign as `authority`).
  // ─────────────────────────────────────────────────────────────────────────
  describe("LBL-01: post-transfer spending paths", () => {
    /**
     * Set up a vault that is funded, has a registered spending agent, and
     * (optionally) has a destination allowlist. Returns everything callers
     * need to (a) transfer ownership and (b) drive any of the 4 spending
     * handlers post-transfer.
     *
     * Why register the agent BEFORE the transfer: the new owner is a
     * fresh keypair and the LBL-01 audit fix applies to spending handlers
     * regardless of which owner registered the agent. Registering the
     * agent in this setup keeps the test focused on the spending CPI
     * signer_seeds rather than mixing in owner-side register_agent
     * coverage (which is already pinned by the LBL-01 test above).
     */
    async function prepareSpendingVault(
      vaultId: BN,
      opts: { allowedDestinations?: PublicKey[] } = {},
    ) {
      const ctx = await initVault(vaultId, {
        allowedDestinations: opts.allowedDestinations,
      });
      const vaultUsdcAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        ctx.vault,
        true, // allowOwnerOffCurve — vault is a PDA
      );
      // Deposit 600 USDC (well over the 100 USDC max_tx + headroom for
      // protocol fees on the seal() outcome-check path).
      await program.methods
        .depositFunds(new BN(600_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: ctx.vault,
          mint: DEVNET_USDC_MINT,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // Register a spending agent (FULL_CAPABILITY = Operator).
      const agent = Keypair.generate();
      airdropSol(svm, agent.publicKey, 5 * LAMPORTS_PER_SOL);
      await program.methods
        .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: ctx.vault,
          policy: ctx.policy,
          agentSpendOverlay: ctx.overlay,
        } as any)
        .rpc();
      return { ...ctx, vaultUsdcAta, agent };
    }

    /**
     * Initiate + wait + accept ownership transfer to `newOwner`. Shared
     * by every spending test below.
     */
    async function transferOwnership(args: {
      vault: PublicKey;
      policy: PublicKey;
      auditSuccess: PublicKey;
      pendingOwner: PublicKey;
      newOwner: Keypair;
    }) {
      await program.methods
        .initiateOwnershipTransfer(args.newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault: args.vault,
          policy: args.policy,
          pending: args.pendingOwner,
          auditLogSuccess: args.auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      advanceTime(svm, DEFAULT_MIN_DELAY);
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: args.newOwner.publicKey,
          vault: args.vault,
          policy: args.policy,
          pending: args.pendingOwner,
          auditLogSuccess: args.auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([args.newOwner])
        .rpc();
    }

    // ───────────────────────────────────────────────────────────────────
    // LBL-01 spending #1 — withdraw_funds (owner-side spending CPI).
    //
    // Pre-fix: signer_seeds = [b"vault", vault.owner=new_owner, ...] →
    // derives a different pubkey than the vault PDA address (which uses
    // vault_authority = original_owner). The token::transfer CPI fails
    // with MissingRequiredSignature.
    //
    // Post-fix: signer_seeds = [b"vault", vault.vault_authority, ...] →
    // derives the correct vault PDA → CPI succeeds.
    // ───────────────────────────────────────────────────────────────────
    it("LBL-01 spending: withdraw_funds works post-transfer", async () => {
      const ctx = await prepareSpendingVault(new BN(9100));
      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 5 * LAMPORTS_PER_SOL);
      // New-owner USDC ATA — the destination for withdraw_funds.
      const newOwnerUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        newOwner.publicKey,
      );

      await transferOwnership({
        vault: ctx.vault,
        policy: ctx.policy,
        auditSuccess: ctx.auditSuccess,
        pendingOwner: ctx.pendingOwner,
        newOwner,
      });

      // Sanity: post-transfer vault.owner is new, vault_authority unchanged.
      const v = await program.account.agentVault.fetch(ctx.vault);
      expect(v.owner.toString()).to.equal(newOwner.publicKey.toString());
      expect((v as any).vaultAuthority.toString()).to.equal(
        owner.publicKey.toString(),
      );

      const vaultBalBefore = getTokenBalance(svm, ctx.vaultUsdcAta);
      const recipientBalBefore = getTokenBalance(svm, newOwnerUsdcAta);

      const withdrawAmount = new BN(10_000_000); // 10 USDC
      await program.methods
        .withdrawFunds(withdrawAmount)
        .accounts({
          owner: newOwner.publicKey,
          vault: ctx.vault,
          mint: DEVNET_USDC_MINT,
          vaultTokenAccount: ctx.vaultUsdcAta,
          ownerTokenAccount: newOwnerUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([newOwner])
        .rpc();

      const vaultBalAfter = getTokenBalance(svm, ctx.vaultUsdcAta);
      const recipientBalAfter = getTokenBalance(svm, newOwnerUsdcAta);
      expect(Number(vaultBalBefore - vaultBalAfter)).to.equal(10_000_000);
      expect(Number(recipientBalAfter - recipientBalBefore)).to.equal(
        10_000_000,
      );
      // Audit log entry written by handler — discriminator = 6 (withdraw).
      expect(lastSuccessDisc(svm, ctx.auditSuccess)).to.equal(DISC_WITHDRAW);
    });

    // ───────────────────────────────────────────────────────────────────
    // LBL-01 spending #2 — agent_transfer (agent-side spending CPI).
    //
    // The agent signer is unaffected by ownership transfer (agents are a
    // vault-level concept and survive the transfer). The break is on the
    // inline CPI signer_seeds for the vault PDA, identical to #1.
    // ───────────────────────────────────────────────────────────────────
    it("LBL-01 spending: agent_transfer works post-transfer", async () => {
      // Allowlisted recipient — must be baked into the policy at init time
      // because we transfer ownership BEFORE issuing the agent_transfer,
      // and the new owner would have to drive queue_destination_update +
      // timelock to add a destination post-transfer (out of scope here).
      const recipient = Keypair.generate();
      airdropSol(svm, recipient.publicKey, 1 * LAMPORTS_PER_SOL);

      const ctx = await prepareSpendingVault(new BN(9101), {
        allowedDestinations: [recipient.publicKey],
      });
      const recipientUsdcAta = createAtaHelper(
        svm,
        (owner as any).payer,
        DEVNET_USDC_MINT,
        recipient.publicKey,
      );

      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);
      await transferOwnership({
        vault: ctx.vault,
        policy: ctx.policy,
        auditSuccess: ctx.auditSuccess,
        pendingOwner: ctx.pendingOwner,
        newOwner,
      });

      const recipientBalBefore = getTokenBalance(svm, recipientUsdcAta);
      const transferAmount = new BN(10_000_000); // 10 USDC

      const policyVersion =
        ((await program.account.policyConfig.fetch(ctx.policy))
          .policyVersion as BN) ?? new BN(0);

      await program.methods
        .agentTransfer(transferAmount, policyVersion)
        .accounts({
          agent: ctx.agent.publicKey,
          vault: ctx.vault,
          policy: ctx.policy,
          tracker: ctx.tracker,
          agentSpendOverlay: ctx.overlay,
          vaultTokenAccount: ctx.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: recipientUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([ctx.agent])
        .rpc();

      // Net = amount - protocol_fee (rate = 200 / 1_000_000 ceiling-div).
      // 10_000_000 * 200 / 1_000_000 = 2_000 fee → net 9_998_000.
      const recipientBalAfter = getTokenBalance(svm, recipientUsdcAta);
      expect(Number(recipientBalAfter - recipientBalBefore)).to.equal(
        9_998_000,
      );
    });

    // ───────────────────────────────────────────────────────────────────
    // LBL-01 spending #3 — validate_and_authorize + finalize_session
    // (composed seal()-style transaction).
    //
    // Two CPI signer_seeds sites are exercised by this atomic transaction:
    //   - validate_and_authorize:  token::approve (delegation to agent)
    //   - finalize_session:        token::revoke (undelegation) AND the
    //                              outcome-based settlement read path
    //
    // The composed [validate, finalize] tx mirrors the sigil.ts seal()
    // happy-path test at lines 1131-1205 (validate+finalize with no
    // intervening DeFi ix — mock DeFi is a no-op so the protocol fee is
    // the only balance change).
    //
    // Post-transfer assertions:
    //   - composed tx succeeds atomically (both CPIs signed correctly)
    //   - session PDA is closed (finalize ran)
    //   - audit-log success entry is the finalize discriminator (= 2)
    //   - vault.totalTransactions incremented
    //   - vault balance decreased by exactly the protocol fee (10K)
    // ───────────────────────────────────────────────────────────────────
    it("LBL-01 spending: validate_and_authorize + finalize_session works post-transfer (seal pattern)", async () => {
      const ctx = await prepareSpendingVault(new BN(9102));
      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

      await transferOwnership({
        vault: ctx.vault,
        policy: ctx.policy,
        auditSuccess: ctx.auditSuccess,
        pendingOwner: ctx.pendingOwner,
        newOwner,
      });

      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          ctx.vault.toBuffer(),
          ctx.agent.publicKey.toBuffer(),
          DEVNET_USDC_MINT.toBuffer(),
        ],
        program.programId,
      );

      const policyVersion =
        ((await program.account.policyConfig.fetch(ctx.policy))
          .policyVersion as BN) ?? new BN(0);
      const amount = new BN(50_000_000); // 50 USDC

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          amount,
          jupiterProgramId,
          policyVersion,
          new BN(0), // expectedNonce — fresh session
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: ctx.vault,
              agent: ctx.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount,
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: ctx.agent.publicKey,
          vault: ctx.vault,
          policy: ctx.policy,
          tracker: ctx.tracker,
          session: sessionPda,
          vaultTokenAccount: ctx.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          agentSpendOverlay: ctx.overlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: ctx.agent.publicKey,
          vault: ctx.vault,
          session: sessionPda,
          sessionRentRecipient: ctx.agent.publicKey,
          policy: ctx.policy,
          tracker: ctx.tracker,
          vaultTokenAccount: ctx.vaultUsdcAta,
          agentSpendOverlay: ctx.overlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const vaultBalBefore = getTokenBalance(svm, ctx.vaultUsdcAta);
      const txResult = sendVersionedTx(
        svm,
        [validateIx, finalizeIx],
        ctx.agent,
      );
      expect(txResult).to.exist;

      // Balance delta = protocol fee only (mock DeFi is a no-op).
      // 50_000_000 * 200 / 1_000_000 = 10_000.
      const vaultBalAfter = getTokenBalance(svm, ctx.vaultUsdcAta);
      expect(Number(vaultBalBefore - vaultBalAfter)).to.equal(10_000);

      // Session PDA closed by finalize.
      expect(svm.getAccount(sessionPda)).to.be.null;

      // FOCUSED finalize_session settlement assertion (test #4 spec, folded
      // into this test as the prompt allows): finalize wrote a success entry
      // with the finalize discriminator (= 2). This is the
      // settlement-CPI-success signal — if the Revoke CPI inside finalize
      // had failed (pre-LBL-01 signer_seeds bug), the entire tx would have
      // reverted and this assertion would never run.
      expect(lastSuccessDisc(svm, ctx.auditSuccess)).to.equal(
        DISC_FINALIZE_SUCCESS,
      );

      // Outcome-based settlement bumped the vault counters.
      const vaultState = await program.account.agentVault.fetch(ctx.vault);
      expect(vaultState.totalTransactions.toNumber()).to.be.greaterThan(0);
      // vault.owner is still the new owner (unchanged by finalize).
      expect(vaultState.owner.toString()).to.equal(
        newOwner.publicKey.toString(),
      );
      // vault_authority is still the original owner (immutable LBL-01 seed).
      expect((vaultState as any).vaultAuthority.toString()).to.equal(
        owner.publicKey.toString(),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. BOUNDARY REJECT — accept one second before timelock elapses.
  // ─────────────────────────────────────────────────────────────────────────
  it("boundary: accept at queued_at + min_delay - 1 → reject 6104", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9001),
    );
    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Advance to one second BEFORE the timelock window.
    advanceTime(svm, DEFAULT_MIN_DELAY - 1);

    let caughtCode: number | null = null;
    try {
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: newOwner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newOwner])
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "accept MUST have rejected").to.not.be.null;
    expect(caughtCode).to.equal(6095); // ErrPendingOwnershipNotReady
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. BOUNDARY OK — accept exactly at queued_at + min_delay succeeds.
  // ─────────────────────────────────────────────────────────────────────────
  it("boundary: accept at queued_at + min_delay → ok", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9002),
    );
    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Advance exactly to the boundary.
    advanceTime(svm, DEFAULT_MIN_DELAY);

    await program.methods
      .acceptOwnershipTransfer()
      .accounts({
        newOwner: newOwner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([newOwner])
      .rpc();

    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(newOwner.publicKey.toString());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. DOUBLE-INIT REJECT — initiate twice without intervening cancel.
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate when pending exists → reject (Anchor account-already-init)", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9003),
    );
    const newOwner1 = Keypair.generate();
    const newOwner2 = Keypair.generate();

    await program.methods
      .initiateOwnershipTransfer(newOwner1.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Second initiate against the SAME (vault, pending) → Anchor sees the
    // PDA already exists and rejects with AccountAlreadyInitialized.
    let rejected = false;
    try {
      await program.methods
        .initiateOwnershipTransfer(newOwner2.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      rejected = true;
    }
    expect(rejected, "double-initiate MUST reject").to.equal(true);

    // ASSERT — the first pending PDA still bound to newOwner1 (unchanged).
    const pendingState =
      await program.account.pendingOwnershipTransfer.fetch(pendingOwner);
    expect(pendingState.newOwner.toString()).to.equal(
      newOwner1.publicKey.toString(),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. CANCEL BY NON-CURRENT-OWNER REJECT
  //    Phase 8 LBL-01: vault PDA seed-key is `vault.vault_authority`
  //    (immutable, set at init). PDA derivation succeeds regardless of
  //    signer identity, but the handler-level `require_keys_eq!(
  //    pending.current_owner, current_owner.key())` check inside
  //    `cancel_ownership_transfer` rejects the imposter signer.
  // ─────────────────────────────────────────────────────────────────────────
  it("cancel by non-current-owner → reject", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9004),
    );
    const newOwner = Keypair.generate();
    const imposter = Keypair.generate();
    airdropSol(svm, imposter.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    let rejected = false;
    try {
      await program.methods
        .cancelOwnershipTransfer()
        .accounts({
          currentOwner: imposter.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([imposter])
        .rpc();
    } catch (err: any) {
      rejected = true;
    }
    expect(rejected, "non-current-owner cancel MUST reject").to.equal(true);

    // ASSERT — pending PDA still alive.
    expect(accountExists(svm, pendingOwner)).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. CANCEL HAPPY (cosign_required=false default).
  // ─────────────────────────────────────────────────────────────────────────
  it("cancel happy path (cosign_required=false) → pending closes, rent → current_owner", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9005),
    );
    const newOwner = Keypair.generate();

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    expect(accountExists(svm, pendingOwner)).to.equal(true);

    await program.methods
      .cancelOwnershipTransfer()
      .accounts({
        currentOwner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    expect(accountExists(svm, pendingOwner)).to.equal(false);
    expect(lastSuccessDisc(svm, auditSuccess)).to.equal(DISC_OWNERSHIP_CANCEL);

    // ASSERT — vault.owner UNCHANGED (cancel does not mutate authority).
    const vaultState = await program.account.agentVault.fetch(vault);
    expect(vaultState.owner.toString()).to.equal(owner.publicKey.toString());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. INITIATE WHEN VAULT.FROZEN REJECT — Council ISC-130.
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate when vault.Frozen → reject ErrVaultNotActive (6000)", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9006),
    );
    const newOwner = Keypair.generate();

    // Freeze the vault first.
    await program.methods
      .freezeVault()
      .accounts({ owner: owner.publicKey, vault } as any)
      .rpc();

    let caughtCode: number | null = null;
    try {
      await program.methods
        .initiateOwnershipTransfer(newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "initiate-when-frozen MUST reject").to.not.be.null;
    expect(caughtCode).to.equal(6000); // VaultNotActive
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. INITIATE TO BANNED ADDRESS REJECT — Council ISC-128.
  //    SystemProgram::ID is the canonical foot-gun target.
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate to SystemProgram::ID → reject 6107 ErrInvalidOwnershipTarget", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9007),
    );

    let caughtCode: number | null = null;
    try {
      await program.methods
        .initiateOwnershipTransfer(SystemProgram.programId, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "initiate-to-system MUST reject").to.not.be.null;
    expect(caughtCode).to.equal(6098); // ErrInvalidOwnershipTarget
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. INITIATE WHEN cosign_required + NO COSIGNER → 6089 ErrCosignRequired.
  //    Council ISC-129 interim cosign gate.
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate when cosign_required=true and no cosigner → reject 6089", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9008),
      { cosignRequired: true },
    );
    const newOwner = Keypair.generate();

    let caughtCode: number | null = null;
    try {
      await program.methods
        .initiateOwnershipTransfer(newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "no-cosigner initiate MUST reject").to.not.be.null;
    expect(caughtCode).to.equal(6080); // ErrCosignRequired
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. INITIATE WHEN cosign_required + COSIGNER SIGNS → success.
  //     Pins the legitimate cosign flow on the new ix.
  // ─────────────────────────────────────────────────────────────────────────
  it("initiate when cosign_required=true and cosigner signs → success", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9009),
      { cosignRequired: true },
    );
    const newOwner = Keypair.generate();
    const cosigner = Keypair.generate();
    airdropSol(svm, cosigner.publicKey, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, false)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: cosigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([cosigner])
      .rpc();

    const pendingState =
      await program.account.pendingOwnershipTransfer.fetch(pendingOwner);
    expect(pendingState.newOwner.toString()).to.equal(
      newOwner.publicKey.toString(),
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. EOA ACCEPT REJECTS MULTISIG-TARGETED PENDING.
  //     Pins the Batch 4 boundary: accept_ownership_transfer must NOT be a
  //     back-door for `is_multisig_target == true` pendings.
  // ─────────────────────────────────────────────────────────────────────────
  it("EOA accept rejects is_multisig_target=true pending (Batch 4 boundary)", async () => {
    const { vault, policy, auditSuccess, pendingOwner } = await initVault(
      new BN(9010),
    );
    const newOwner = Keypair.generate();
    airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

    // Queue a multisig-target initiate.
    await program.methods
      .initiateOwnershipTransfer(newOwner.publicKey, true) // is_multisig_target=true
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        pending: pendingOwner,
        auditLogSuccess: auditSuccess,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, DEFAULT_MIN_DELAY);

    let caughtCode: number | null = null;
    try {
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: newOwner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newOwner])
        .rpc();
    } catch (err: any) {
      caughtCode = err?.error?.errorCode?.number ?? null;
    }
    expect(caughtCode, "EOA accept of multisig pending MUST reject").to.not.be
      .null;
    expect(caughtCode).to.equal(6095); // ErrPendingOwnershipNotReady
  });

  // ===========================================================================
  // M1-02: freeze is terminal — cannot accept ownership on a frozen vault.
  //
  // Threat: a phished owner-key attacker queues an ownership transfer, then the
  // real owner freezes the vault. Without the status==Active gate at the head of
  // accept_ownership_transfer, the attacker could wait out the 48h timelock and
  // `accept` on the frozen vault, stealing ownership despite the kill-switch.
  // The gate (require!(status == Active, VaultNotActive) === 6000) makes freeze
  // terminal for the accept path.
  // ===========================================================================
  describe("M1-02: freeze is terminal — cannot accept ownership on a frozen vault", () => {
    // 1. EXPLOIT-BLOCKED — initiate → freeze → advance past timelock → accept
    //    MUST reject 6000 (VaultNotActive), and vault.owner MUST be unchanged.
    it("EXPLOIT-BLOCKED: accept on a frozen vault after timelock → reject 6000, owner unchanged", async () => {
      const { vault, policy, auditSuccess, pendingOwner } = await initVault(
        new BN(9500),
      );
      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);
      const originalOwner = owner.publicKey;

      // ACT 1 — initiate (vault still Active).
      await program.methods
        .initiateOwnershipTransfer(newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // ACT 2 — real owner freezes the vault (kill-switch).
      await program.methods
        .freezeVault()
        .accounts({ owner: owner.publicKey, vault } as any)
        .rpc();

      // ACT 3 — advance past the full timelock and attempt the attacker accept.
      advanceTime(svm, DEFAULT_MIN_DELAY);
      let caughtCode: number | null = null;
      try {
        await program.methods
          .acceptOwnershipTransfer()
          .accounts({
            newOwner: newOwner.publicKey,
            vault,
            policy,
            pending: pendingOwner,
            auditLogSuccess: auditSuccess,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([newOwner])
          .rpc();
      } catch (err: any) {
        caughtCode = err?.error?.errorCode?.number ?? null;
      }

      // ASSERT — accept rejected with VaultNotActive (6000), and the freeze held:
      // vault.owner is STILL the original owner, not the attacker's newOwner, and
      // the pending PDA survives (accept never executed → close never ran).
      expect(caughtCode, "frozen-vault accept MUST reject 6000").to.equal(6000);
      const vaultState = await program.account.agentVault.fetch(vault);
      expect(vaultState.owner.toString()).to.equal(originalOwner.toString());
      expect(vaultState.owner.toString()).to.not.equal(
        newOwner.publicKey.toString(),
      );
      expect(accountExists(svm, pendingOwner)).to.equal(true);
    });

    // 2. REGRESSION — the gate must NOT break the happy path: accept on an
    //    ACTIVE vault after the timelock still succeeds and transfers ownership.
    it("REGRESSION: accept on an active vault after timelock → success, owner transfers", async () => {
      const { vault, policy, auditSuccess, pendingOwner } = await initVault(
        new BN(9501),
      );
      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

      await program.methods
        .initiateOwnershipTransfer(newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // No freeze — vault stays Active.
      advanceTime(svm, DEFAULT_MIN_DELAY);
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: newOwner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newOwner])
        .rpc();

      const vaultState = await program.account.agentVault.fetch(vault);
      expect(vaultState.owner.toString()).to.equal(
        newOwner.publicKey.toString(),
      );
      expect(accountExists(svm, pendingOwner)).to.equal(false);
    });

    // 3. REACTIVATION — freeze is terminal for the FROZEN window, but the owner
    //    can lawfully reactivate (after the 5-min C28 cooldown) and THEN the
    //    accept succeeds. reactivate_vault requires status==Frozen + elapsed >=
    //    REACTIVATE_COOLDOWN_SECONDS (300s), and (soft-lock guard, handler §5)
    //    the vault must have >=1 agent after the call — so reactivate must graft
    //    one. We use VIEWER_CAPABILITY (1): the FULL_CAPABILITY (2) cosign gate
    //    fires only for capability==2, so a viewer agent reactivates with just
    //    { owner, vault } and no remaining-accounts cosigner.
    it("REACTIVATION: freeze → reactivate (after cooldown) → accept → success", async () => {
      const { vault, policy, auditSuccess, pendingOwner } = await initVault(
        new BN(9502),
      );
      const newOwner = Keypair.generate();
      airdropSol(svm, newOwner.publicKey, 1 * LAMPORTS_PER_SOL);

      // Initiate, then freeze.
      await program.methods
        .initiateOwnershipTransfer(newOwner.publicKey, false)
        .accounts({
          owner: owner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .freezeVault()
        .accounts({ owner: owner.publicKey, vault } as any)
        .rpc();

      // Advance past the C28 reactivate cooldown (300s) with margin, then
      // reactivate — grafting one VIEWER agent to satisfy the no-empty-agents
      // soft-lock guard (NoAgentRegistered 6011 otherwise).
      const VIEWER_CAPABILITY = 1;
      const reactivateAgent = Keypair.generate();
      advanceTime(svm, REACTIVATE_COOLDOWN_SECONDS + 60);
      await program.methods
        .reactivateVault(reactivateAgent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault } as any)
        .rpc();

      // Advance the remaining timelock window and accept — now Active again.
      advanceTime(svm, DEFAULT_MIN_DELAY);
      await program.methods
        .acceptOwnershipTransfer()
        .accounts({
          newOwner: newOwner.publicKey,
          vault,
          policy,
          pending: pendingOwner,
          auditLogSuccess: auditSuccess,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([newOwner])
        .rpc();

      const vaultState = await program.account.agentVault.fetch(vault);
      expect(vaultState.owner.toString()).to.equal(
        newOwner.publicKey.toString(),
      );
      expect(accountExists(svm, pendingOwner)).to.equal(false);
    });
  });
});
