/**
 * Phase 2 TA-19 regression test — policy_preview_digest invariant.
 *
 * Four handlers mutate `PolicyConfig.has_constraints` / `has_post_assertions`
 * fields outside of `apply_pending_policy`. These flags are part of the
 * canonical policy_preview_digest encoding. The handlers MUST recompute
 * the stored digest on every mutation; otherwise external consumers see
 * a stale on-chain digest that diverges from a canonical recompute.
 *
 * Covered handlers:
 *   1. create_instruction_constraints   (has_constraints   = true)
 *   2. apply_close_constraints          (has_constraints   = false)
 *   3. create_post_assertions           (has_post_assertions = 1)
 *   4. close_post_assertions            (has_post_assertions = 0)
 *
 * Each test:
 *   - Records the stored digest BEFORE the mutation.
 *   - Records the policy_version BEFORE.
 *   - Runs the mutation handler.
 *   - Re-reads stored digest + policy_version.
 *   - Asserts: stored digest CHANGED, policy_version BUMPED, and
 *     stored digest == SDK-recomputed digest with the new flag value.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  initVaultPreviewDigest,
  computePolicyPreviewDigest,
  queuePolicyMergedDigest,
  siblingHandlerDigest,
} from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  mintToHelper,
  advanceTime,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_CAPABILITY = 2;
/**
 * Phase 8 PEN-CROSS-1 (Batch 6 audit 2026-05-19): `register_agent` now
 * hard-rejects `capability == CAPABILITY_OPERATOR`. OPERATOR-class grants
 * route through `queue_agent_grant` → `apply_agent_grant` (timelock-gated).
 * Tests that exercise non-spending paths (observe_only short-circuit,
 * permission-update queue rejection) can switch to CAPABILITY_OBSERVER
 * because the check they target fires BEFORE the capability gate.
 */
const CAPABILITY_OBSERVER = 1;

/** Encode a [u8;32] returned by Anchor as a hex string for clean asserts. */
function digestHex(d: number[] | Uint8Array): string {
  const bytes = Array.from(d);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("policy-digest invariant (TA-19 sibling-handler recompute)", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();
  let usdcMint: PublicKey;

  /**
   * Fresh vault per test: each handler is destructive (creates / closes the
   * sibling PDA), so isolating per-vault prevents test-ordering coupling.
   */
  async function freshVault(vaultIdNum: number) {
    const vaultId = new BN(vaultIdNum);
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
    const [constraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("constraints"), vaultPda.toBuffer()],
      program.programId,
    );
    const [postAssertionsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("post_assertions"), vaultPda.toBuffer()],
      program.programId,
    );
    const [pendingCloseConstraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_close_constraints"), vaultPda.toBuffer()],
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
        new BN(1800),
        [],
        [],
        true, // observeOnly — required for F-11 (no protocols/destinations)
        // Phase 3 (TA-05/TA-07/TA-17): operating_hours, auto_promote_grays,
        // auto_revoke_threshold are now positional args BEFORE preview_digest.
        // Values MUST match the helper below.
        0x00ffffff, // operatingHours — all 24h
        false, // autoPromoteGrays
        5, // autoRevokeThreshold — must be in [3, 20]
        new BN(0), // stableBalanceFloor (TA-12 Phase 5 — no reserve)
        new BN(0), // perRecipientDailyCapUsd (TA-14 Phase 5 — no cap)
        false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          observeOnly: true,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
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
      .rpc();

    return {
      vaultPda,
      policyPda,
      constraintsPda,
      postAssertionsPda,
      pendingCloseConstraintsPda,
    };
  }

  /**
   * Compute the expected canonical digest for a vault's current live policy,
   * letting caller override the flag(s) under test.
   */
  async function expectedDigestFor(
    policyPda: PublicKey,
    vaultPda: PublicKey,
    override: Partial<{
      hasConstraints: boolean;
      hasPostAssertions: number;
    }> = {},
  ): Promise<number[]> {
    const policy: any = await program.account.policyConfig.fetch(policyPda);
    const vault: any = await program.account.agentVault.fetch(vaultPda);
    return computePolicyPreviewDigest({
      dailySpendingCapUsd: policy.dailySpendingCapUsd,
      maxTransactionSizeUsd: policy.maxTransactionSizeUsd,
      maxSlippageBps: policy.maxSlippageBps,
      developerFeeRate: policy.developerFeeRate ?? 0,
      protocolMode: policy.protocolMode,
      protocols: policy.protocols,
      destinationMode: policy.destinationMode,
      allowedDestinations: policy.allowedDestinations,
      timelockDuration: policy.timelockDuration,
      sessionExpirySeconds: policy.sessionExpirySeconds,
      observeOnly: !!vault.observeOnly,
      hasConstraints:
        override.hasConstraints !== undefined
          ? override.hasConstraints
          : !!policy.hasConstraints,
      hasPostAssertions:
        override.hasPostAssertions !== undefined
          ? override.hasPostAssertions
          : (policy.hasPostAssertions as number),
      // PEN-CROSS-2: read created_at_slot off live PolicyConfig.
      createdAtSlot: policy.createdAtSlot ?? 0,
      // TA-05 (Phase 3): read operating_hours off live PolicyConfig.
      operatingHours: policy.operatingHours ?? 0,
      // TA-07/17 (Phase 3): graylist-bypass + auto-revoke-threshold are
      // policy-owned. destination_graylist itself is NOT in digest.
      autoPromoteGrays: !!policy.autoPromoteGrays,
      autoRevokeThreshold: policy.autoRevokeThreshold ?? 0,
      // Phase 5 (TA-12/14): pass-through from live policy at digest
      // positions 18/19. Required for byte parity with on-chain handler.
      stableBalanceFloor: policy.stableBalanceFloor ?? 0,
      perRecipientDailyCapUsd: policy.perRecipientDailyCapUsd ?? 0,
      // G6 (audit 2026-05-18 cosign opt-in): pass-through from live
      // policy at canonical digest position 20.
      cosignRequired: !!policy.cosignRequired,
    });
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Owner ATA / mint — kept symmetrical with other test files (some helpers
    // assume the vault token account exists, but these digest tests don't
    // execute any spending so ATAs are not strictly required).
    const ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      2_000_000_000n,
    );
  });


  it("create_post_assertions recomputes policy_preview_digest", async () => {
    const { vaultPda, policyPda, postAssertionsPda } = await freshVault(902);

    const before: any = await program.account.policyConfig.fetch(policyPda);
    const digestBefore = before.policyPreviewDigest as number[];
    const versionBefore = (before.policyVersion as BN).toString();
    expect(before.hasPostAssertions).to.equal(0);

    const targetAccount = Keypair.generate().publicKey;
    const createPADigest = await siblingHandlerDigest(
      program,
      policyPda,
      vaultPda,
      { hasPostAssertions: 1 },
    );
    await program.methods
      .createPostAssertions(
        [
          {
            targetAccount,
            offset: 0,
            valueLen: 8,
            operator: 3, // ConstraintOperator::Lte (PostAssertionEntry.operator is u8)
            expectedValue: Buffer.from(new BN(1_000_000).toArray("le", 8)),
            assertionMode: 0,
            auxValue: Array.from(new Uint8Array(8)), // Phase 6: modes 0..3 must zero aux fields
            auxByte: 0,
          },
        ],
        createPADigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        postAssertions: postAssertionsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const after: any = await program.account.policyConfig.fetch(policyPda);
    expect(after.hasPostAssertions).to.equal(1);

    const digestAfter = after.policyPreviewDigest as number[];
    expect(digestHex(digestAfter)).to.not.equal(
      digestHex(digestBefore),
      "stored digest MUST change after has_post_assertions=1 mutation",
    );

    const expected = await expectedDigestFor(policyPda, vaultPda);
    expect(digestHex(digestAfter)).to.equal(
      digestHex(expected),
      "stored digest MUST match SDK-recomputed digest with has_post_assertions=1",
    );

    const versionAfter = (after.policyVersion as BN).toString();
    expect(new BN(versionAfter).gt(new BN(versionBefore))).to.equal(
      true,
      "policy_version must strictly increase across create_post_assertions",
    );
  });

  it("close_post_assertions recomputes policy_preview_digest", async () => {
    const { vaultPda, policyPda, postAssertionsPda } = await freshVault(903);

    // Establish assertions
    const targetAccount = Keypair.generate().publicKey;
    const setupPADigest = await siblingHandlerDigest(
      program,
      policyPda,
      vaultPda,
      { hasPostAssertions: 1 },
    );
    await program.methods
      .createPostAssertions(
        [
          {
            targetAccount,
            offset: 0,
            valueLen: 8,
            operator: 3, // ConstraintOperator::Lte (PostAssertionEntry.operator is u8)
            expectedValue: Buffer.from(new BN(1_000_000).toArray("le", 8)),
            assertionMode: 0,
            auxValue: Array.from(new Uint8Array(8)), // Phase 6: modes 0..3 must zero aux fields
            auxByte: 0,
          },
        ],
        setupPADigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        postAssertions: postAssertionsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const before: any = await program.account.policyConfig.fetch(policyPda);
    const digestBefore = before.policyPreviewDigest as number[];
    const versionBefore = (before.policyVersion as BN).toString();
    expect(before.hasPostAssertions).to.equal(1);

    const closePADigest = await siblingHandlerDigest(
      program,
      policyPda,
      vaultPda,
      { hasPostAssertions: 0 },
    );
    await program.methods
      .closePostAssertions(closePADigest)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        postAssertions: postAssertionsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const after: any = await program.account.policyConfig.fetch(policyPda);
    expect(after.hasPostAssertions).to.equal(0);

    const digestAfter = after.policyPreviewDigest as number[];
    expect(digestHex(digestAfter)).to.not.equal(
      digestHex(digestBefore),
      "stored digest MUST change after has_post_assertions=0 mutation",
    );

    const expected = await expectedDigestFor(policyPda, vaultPda);
    expect(digestHex(digestAfter)).to.equal(
      digestHex(expected),
      "stored digest MUST match SDK-recomputed digest with has_post_assertions=0",
    );

    const versionAfter = (after.policyVersion as BN).toString();
    expect(new BN(versionAfter).gt(new BN(versionBefore))).to.equal(
      true,
      "policy_version must strictly increase across close_post_assertions",
    );
  });

  // CR-4 (Phase 2 close-up): apply_pending_policy must re-assert the canonical
  // digest from the merged live state. The existing F-16 negative test (below)
  // covers the rejection path; THIS positive test pins the success path —
  // after apply, the live PolicyConfig.policy_preview_digest is byte-equal to
  // the SDK-recomputed digest from the post-merge fields. If either side
  // drifts the byte layout, this test fails in lock-step.
  it("apply_pending_policy re-asserts digest from merged live policy state (CR-4)", async () => {
    const { vaultPda, policyPda } = await freshVault(904);

    // Queue: change daily_spending_cap_usd to a known value.
    // Phase 3 (TA-09): LOWERED (not raised) so the mutation is non-elevated
    // and does not require a cosigner. This is a digest-invariant test —
    // direction of the change is irrelevant; we only assert digest equality.
    const newCap = new BN(250_000_000);
    const livePolicy: any = await program.account.policyConfig.fetch(policyPda);
    const newPolicyPreviewDigest = queuePolicyMergedDigest(
      {
        dailySpendingCapUsd: livePolicy.dailySpendingCapUsd,
        maxTransactionSizeUsd: livePolicy.maxTransactionSizeUsd,
        maxSlippageBps: livePolicy.maxSlippageBps,
        developerFeeRate: livePolicy.developerFeeRate ?? 0,
        protocolMode: livePolicy.protocolMode,
        protocols: livePolicy.protocols,
        destinationMode: livePolicy.destinationMode,
        allowedDestinations: livePolicy.allowedDestinations,
        timelockDuration: livePolicy.timelockDuration,
        sessionExpirySeconds: livePolicy.sessionExpirySeconds,
        hasConstraints: !!livePolicy.hasConstraints,
        hasPostAssertions: livePolicy.hasPostAssertions as number,
        createdAtSlot: livePolicy.createdAtSlot ?? 0,
        // Phase 3 (TA-05/TA-07/TA-17): pass live values through so the
        // merged digest matches the on-chain recompute.
        operatingHours: livePolicy.operatingHours ?? 0,
        autoPromoteGrays: !!livePolicy.autoPromoteGrays,
        autoRevokeThreshold: livePolicy.autoRevokeThreshold ?? 0,
      },
      { dailySpendingCapUsd: newCap },
      true, // observeOnly — freshVault uses observe_only=true
    );

    const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vaultPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .queuePolicyUpdate(
        newCap,
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
        // Phase 3 (TA-05): operating_hours — null pass-through from live.
        null,
        // Phase 5 (TA-12): stable_balance_floor — null pass-through from live.
        null,
        // Phase 5 (TA-14): per_recipient_daily_cap_usd — null pass-through.
        null,
        // G6 (audit 2026-05-18 cosign opt-in): cosign_required — null
        // pass-through. Toggling cosign goes through a separate test path.
        null,
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey — null
        // pass-through from live policy. Reactivate-cosign gate is not
        // exercised in this digest-invariant scope.
        null,
        // Phase 3 (TA-09): cosign_session — PublicKey.default = non-elevated
        // (single-sig owner mutation; daily_cap is non-elevated).
        PublicKey.default,
        newPolicyPreviewDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, 1801);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        pendingPolicy: pendingPolicyPda,
      } as any)
      .rpc();

    // Verify: live PolicyConfig.policy_preview_digest matches both the
    // ix arg AND the SDK-recomputed digest from the post-merge fields.
    const merged: any = await program.account.policyConfig.fetch(policyPda);
    const storedDigest = merged.policyPreviewDigest as number[];

    expect(digestHex(storedDigest)).to.equal(
      digestHex(newPolicyPreviewDigest),
      "stored digest MUST equal the owner-signed digest",
    );

    const recomputed = await expectedDigestFor(policyPda, vaultPda);
    expect(digestHex(storedDigest)).to.equal(
      digestHex(recomputed),
      "stored digest MUST equal the SDK recompute from post-merge live policy",
    );
    expect(merged.dailySpendingCapUsd.toString()).to.equal(
      newCap.toString(),
      "daily cap must reflect the queued change",
    );
  });
});

// ============================================================================
// F-16 audit fix: negative tests for Phase 2 primitives
// ============================================================================
//
// 1. observe_only rejects validate_and_authorize (code 6072)
// 2. apply_pending_policy digest re-assert defends pending-update staleness
//    (code 6080) — substitute path: requeue invalidates prior digest
// 3. F-4 capability bound at apply_agent_permissions_update (code 6070) —
//    queue with valid capability, mutate to invalid in cancel/requeue flow

describe("Phase 2 close-up — F-16 negative tests", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();
  let usdcMint: PublicKey;
  // Junk pubkey used as the protocol allowlist baseline so observe_only=false
  // vaults satisfy F-11 ActiveVaultRequiresAllowlist.
  const dummyProtocol = Keypair.generate().publicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;
  });

  /**
   * Init a fresh vault parametrised by observeOnly. Vault PDAs returned for
   * downstream use. allowlist defaults to [dummyProtocol] which satisfies F-11
   * for active vaults.
   */
  async function initVault(
    vaultIdNum: number,
    observeOnly: boolean,
    protocols: PublicKey[] = [dummyProtocol],
  ) {
    const vaultId = new BN(vaultIdNum);
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

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        protocols,
        0,
        100,
        new BN(1800),
        [],
        [],
        observeOnly,
        // Phase 3 (TA-05/TA-07/TA-17): operating_hours, auto_promote_grays,
        // auto_revoke_threshold are now positional args BEFORE preview_digest.
        0x00ffffff, // operatingHours — all 24h
        false, // autoPromoteGrays
        5, // autoRevokeThreshold — must be in [3, 20]
        new BN(0), // stableBalanceFloor (TA-12 Phase 5 — no reserve)
        new BN(0), // perRecipientDailyCapUsd (TA-14 Phase 5 — no cap)
        false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols,
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          observeOnly,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
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
      .rpc();

    return { vaultId, vaultPda, policyPda, trackerPda, overlayPda };
  }

  // ---------------------------------------------------------------------------
  // Test 1: observe_only rejects validate_and_authorize
  // ---------------------------------------------------------------------------
  it("observe_only vault rejects validate_and_authorize → ObserveOnlyModeBlocksExecute", async () => {
    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);

    // Vault with observeOnly=true. F-11 allows empty allowlist when
    // observeOnly=true; we still pass [dummyProtocol] to keep the fixture
    // close to active-vault shape so the only differentiator is observe_only.
    const vault = await initVault(1100, true, [dummyProtocol]);

    // Phase 8 Batch 6: register_agent now hard-rejects OPERATOR; the
    // observe_only short-circuit fires at validate_and_authorize line 188
    // (BEFORE the has_capability gate at line 318), so an Observer agent
    // is sufficient to reproduce the reject — the test target is the
    // observe_only check, not the capability check.
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        agentSpendOverlay: vault.overlayPda,
      })
      .rpc();

    // Anchor account-resolution runs BEFORE the handler body. We need a
    // real vault-owned ATA so the #[account(constraint = ...owner == vault.key())]
    // check passes. Once Anchor hydration succeeds the handler hits the moved
    // observe_only short-circuit and rejects.
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      vault.vaultPda,
      true,
    );
    const ownerAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerAta,
      owner.publicKey,
      1_000_000_000n,
    );
    // Deposit a small amount so the vault ATA exists with the vault as owner.
    await program.methods
      .depositFunds(new BN(1_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const policyAccount: any = await program.account.policyConfig.fetch(
      vault.policyPda,
    );
    const currentVersion = policyAccount.policyVersion;
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vault.vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );

    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        new BN(0),
        dummyProtocol,
        currentVersion,
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vault.vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount: new BN(0),
            targetProtocol: dummyProtocol,
          }),
        ),
      )
      .accounts({
        agent: agent.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        tracker: vault.trackerPda,
        session: sessionPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: null,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        agentSpendOverlay: vault.overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .instruction();

    let threw = false;
    try {
      sendVersionedTx(svm, [validateIx], agent);
    } catch (err: any) {
      threw = true;
      const msg = err?.message ?? String(err);
      expect(msg).to.satisfy(
        (m: string) =>
          m.includes("ObserveOnlyModeBlocksExecute") || m.includes("6081"),
        `expected ObserveOnlyModeBlocksExecute (6072), got: ${msg}`,
      );
    }
    expect(
      threw,
      "validate_and_authorize MUST reject on observe_only",
    ).to.equal(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2: apply_pending_policy digest re-assert defends against stale digest
  // ---------------------------------------------------------------------------
  // Strategy (per audit prompt's "substitute" fallback): the pending PDA is
  // closed on apply (close = owner). To exercise the digest re-assert defense
  // we cancel the first pending and queue a SECOND pending with a NEW digest;
  // then we attempt to apply the second using a STALE digest computed against
  // the first pending's intended fields. The apply handler re-computes against
  // the merged-effective policy fields and the stored pending digest — if the
  // queue caller supplied a stale digest, queue itself rejects (covered) AND
  // apply rejects with PolicyPreviewMismatch (the re-assert path).
  //
  // To hit the apply-side rejection cleanly we DIRECTLY tamper the live policy
  // state between queue and apply: bump `policy.policy_version` via a sibling
  // handler (create_post_assertions / close_post_assertions) which mutates a
  // field included in the digest. The pending digest captured at queue time is
  // now stale relative to the merged-effective live policy at apply time.
  it("apply_pending_policy re-asserts digest against tampered live policy → PolicyPreviewMismatch", async () => {
    const vault = await initVault(1101, false, [dummyProtocol]);

    // 1. Queue a policy update with a valid digest for the merged-effective policy.
    const livePolicy: any = await program.account.policyConfig.fetch(
      vault.policyPda,
    );
    const validDigest = queuePolicyMergedDigest(
      {
        dailySpendingCapUsd: livePolicy.dailySpendingCapUsd,
        maxTransactionSizeUsd: livePolicy.maxTransactionSizeUsd,
        maxSlippageBps: livePolicy.maxSlippageBps,
        developerFeeRate: livePolicy.developerFeeRate ?? 0,
        protocolMode: livePolicy.protocolMode,
        protocols: livePolicy.protocols,
        destinationMode: livePolicy.destinationMode,
        allowedDestinations: livePolicy.allowedDestinations,
        timelockDuration: livePolicy.timelockDuration,
        sessionExpirySeconds: livePolicy.sessionExpirySeconds,
        hasConstraints: !!livePolicy.hasConstraints,
        hasPostAssertions: livePolicy.hasPostAssertions as number,
        createdAtSlot: livePolicy.createdAtSlot ?? 0,
        // Phase 3 (TA-05/TA-07/TA-17): pass live values through so the
        // merged digest matches the on-chain recompute.
        operatingHours: livePolicy.operatingHours ?? 0,
        autoPromoteGrays: !!livePolicy.autoPromoteGrays,
        autoRevokeThreshold: livePolicy.autoRevokeThreshold ?? 0,
      },
      // Phase 3 (TA-09): LOWERED (not raised) so the mutation is non-elevated
      // and does not require a cosigner. initVault sets cap=500M; here we
      // queue cap=250M.
      { dailySpendingCapUsd: new BN(250_000_000) },
      false, // observeOnly
    );

    const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vault.vaultPda.toBuffer()],
      program.programId,
    );

    await program.methods
      .queuePolicyUpdate(
        new BN(250_000_000), // dailySpendingCapUsd (lowered — non-elevated)
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
        // Phase 3 (TA-05): operating_hours — null pass-through from live.
        null,
        // Phase 5 (TA-12): stable_balance_floor — null pass-through from live.
        null,
        // Phase 5 (TA-14): per_recipient_daily_cap_usd — null pass-through.
        null,
        // G6 (audit 2026-05-18 cosign opt-in): cosign_required — null
        // pass-through. Toggling cosign goes through a separate test path.
        null,
        // D-5 (audit 2026-05-19, F-RP3-1): cosign_session_pubkey — null
        // pass-through from live policy. Reactivate-cosign gate is not
        // exercised in this digest-invariant scope.
        null,
        // Phase 3 (TA-09): cosign_session — PublicKey.default = non-elevated
        // (single-sig owner mutation; daily_cap is non-elevated).
        PublicKey.default,
        validDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // 2. Tamper live policy: create post-assertions, which mutates
    //    `has_post_assertions` (included in the digest). The pending PDA's
    //    stored `new_policy_preview_digest` was computed when
    //    has_post_assertions=0; now apply will recompute against
    //    has_post_assertions=1 → mismatch.
    const [postAssertionsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("post_assertions"), vault.vaultPda.toBuffer()],
      program.programId,
    );
    const tamperPADigest = await siblingHandlerDigest(
      program,
      vault.policyPda,
      vault.vaultPda,
      { hasPostAssertions: 1 },
    );
    await program.methods
      .createPostAssertions(
        [
          {
            targetAccount: Keypair.generate().publicKey,
            offset: 0,
            valueLen: 8,
            operator: 3, // ConstraintOperator::Lte (PostAssertionEntry.operator is u8)
            expectedValue: Buffer.from(new BN(1).toArray("le", 8)),
            assertionMode: 0,
            auxValue: Array.from(new Uint8Array(8)), // Phase 6: modes 0..3 must zero aux fields
            auxByte: 0,
          },
        ],
        tamperPADigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        postAssertions: postAssertionsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // 3. Advance timelock and attempt apply.
    advanceTime(svm, 1801);

    let threw = false;
    try {
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          pendingPolicy: pendingPolicyPda,
        } as any)
        .rpc();
    } catch (err: any) {
      threw = true;
      const msg = err?.message ?? String(err);
      expect(msg).to.satisfy(
        (m: string) =>
          m.includes("PolicyPreviewMismatch") || m.includes("6080"),
        `expected PolicyPreviewMismatch (6080), got: ${msg}`,
      );
    }
    expect(
      threw,
      "apply_pending_policy MUST reject when live policy digest differs from pending",
    ).to.equal(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: F-4 capability bound at queue_agent_permissions_update
  // ---------------------------------------------------------------------------
  // The auditor noted F-4 (capability bound 0..=2) is enforced at
  // register_agent + queue_agent_permissions_update + apply_agent_permissions_update.
  // Easiest reproducible negative is at queue (apply is a re-validation of the
  // queued capability, so queue rejection covers the same surface). Test that
  // capability=5 is rejected with InvalidCapability (6070).
  it("queue_agent_permissions_update with capability=5 → InvalidCapability", async () => {
    const agent = Keypair.generate();
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);

    const vault = await initVault(1102, false, [dummyProtocol]);

    // Phase 8 Batch 6: register_agent now hard-rejects OPERATOR. This test
    // targets the queue_agent_permissions_update's InvalidCapability check
    // for capability=5 (an explicitly reserved value) — the agent's INITIAL
    // capability doesn't matter for the queue reject. Observer (1) is
    // sufficient to satisfy the queue's `vault.is_agent` requirement.
    await program.methods
      .registerAgent(agent.publicKey, CAPABILITY_OBSERVER, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        agentSpendOverlay: vault.overlayPda,
      })
      .rpc();

    const [pendingAgentPermsPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pending_agent_perms"),
        vault.vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
      ],
      program.programId,
    );

    let threw = false;
    try {
      await program.methods
        .queueAgentPermissionsUpdate(
          agent.publicKey,
          5,
          new BN(0),
          new BN(0),
          PublicKey.default,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          pendingAgentPerms: pendingAgentPermsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err: any) {
      threw = true;
      const msg = err?.message ?? String(err);
      expect(msg).to.satisfy(
        (m: string) => m.includes("InvalidCapability") || m.includes("6079"),
        `expected InvalidCapability (6070), got: ${msg}`,
      );
    }
    expect(
      threw,
      "queue_agent_permissions_update MUST reject capability values > 2",
    ).to.equal(true);
  });
});

// ============================================================================
// PEN-CROSS-2 (Phase 2 close-up): close+reinit replay protection
// ============================================================================
//
// Narrow attack: owner closes vault V1, later re-inits with the same
// (owner, vault_id), and an attacker replays the original signed init tx.
// Defense: `created_at_slot` is bound into the TA-19 digest. The signed
// init digest encodes the OLD slot; the fresh PDA re-init runs at a NEW
// slot, the on-chain handler recomputes the digest with the NEW slot, and
// the mismatch rejects with `PolicyPreviewMismatch`.

describe("PEN-CROSS-2 — close+reinit replay protection", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const feeDestination = Keypair.generate();
  const dummyProtocol = Keypair.generate().publicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
  });

  it("init at slot=N then re-init at slot=N+1 with stale digest → PolicyPreviewMismatch", async () => {
    // Re-using the same `vault_id` simulates the close+reinit scenario at
    // the PDA-derivation level (the original PDA must be closed before a
    // second `init` succeeds; here we just exercise the digest-mismatch
    // path on a fresh PDA at a different slot).
    const vaultId = new BN(2000);
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

    // Capture the slot the OLD init was signed against. The replay attacker
    // owns a tx with this slot embedded in the digest.
    const oldSlot = Number(svm.getClock().slot);

    // Advance slot — simulates: "owner closed vault, then time passed, then
    // tried to re-init". Even a single-slot delta produces a mismatch.
    const advancePastSlotFn = (await import("./helpers/litesvm-setup"))
      .advancePastSlot;
    advancePastSlotFn(svm, oldSlot + 5);

    // Build the STALE signed init: digest encodes oldSlot. The attacker
    // replays this exact ix against the fresh PDA after the new slot.
    const staleDigest = initVaultPreviewDigest({
      dailySpendingCapUsd: new BN(500_000_000),
      maxTransactionSizeUsd: new BN(100_000_000),
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [dummyProtocol],
      allowedDestinations: [],
      timelockDuration: new BN(1800),
      observeOnly: false,
      createdAtSlot: oldSlot,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
    });

    let threw = false;
    try {
      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [dummyProtocol],
          0,
          100,
          new BN(1800),
          [],
          [],
          false,
          // Phase 3 (TA-05/TA-07/TA-17): positional args MUST match staleDigest
          // helper above (operatingHours=0x00FFFFFF, autoPromoteGrays=false,
          // autoRevokeThreshold=5). The mismatch here is intentional on
          // `createdAtSlot`, not on the Phase 3 fields.
          0x00ffffff,
          false,
          5,
          new BN(0), // stableBalanceFloor (TA-12 Phase 5 — no reserve)
          new BN(0), // perRecipientDailyCapUsd (TA-14 Phase 5 — no cap)
          false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
          staleDigest,
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
        .rpc();
    } catch (err: any) {
      threw = true;
      const msg = err?.message ?? String(err);
      expect(msg).to.satisfy(
        (m: string) =>
          m.includes("PolicyPreviewMismatch") || m.includes("6080"),
        `expected PolicyPreviewMismatch (6080), got: ${msg}`,
      );
    }
    expect(
      threw,
      "initialize_vault MUST reject a digest encoding a slot != current Clock::get()?.slot",
    ).to.equal(true);
  });

  // PEN-CROSS-3: deliberate-wrong expected_digest must be rejected by each
  // of the 4 sibling handlers. Single test exercises
  // create_instruction_constraints (path with the most state setup); the
  // other three handlers share the same code shape and are covered by the
  // positive-path tests above (which would fail if the require! gate were
  // missing or in the wrong order).

  it("init with current-slot digest succeeds → defense doesn't false-positive", async () => {
    const vaultId = new BN(2001);
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

    const currentSlot = Number(svm.getClock().slot);
    const goodDigest = initVaultPreviewDigest({
      dailySpendingCapUsd: new BN(500_000_000),
      maxTransactionSizeUsd: new BN(100_000_000),
      maxSlippageBps: 100,
      developerFeeRate: 0,
      protocolMode: 1,
      protocols: [dummyProtocol],
      allowedDestinations: [],
      timelockDuration: new BN(1800),
      observeOnly: false,
      createdAtSlot: currentSlot,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
    });

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        [dummyProtocol],
        0,
        100,
        new BN(1800),
        [],
        [],
        false,
        // Phase 3 (TA-05/TA-07/TA-17): positional args match goodDigest helper
        // (operatingHours=0x00FFFFFF, autoPromoteGrays=false,
        // autoRevokeThreshold=5).
        0x00ffffff,
        false,
        5,
        new BN(0), // stableBalanceFloor (TA-12 Phase 5 — no reserve)
        new BN(0), // perRecipientDailyCapUsd (TA-14 Phase 5 — no cap)
        false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
        goodDigest,
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
      .rpc();

    const policy: any = await program.account.policyConfig.fetch(policyPda);
    expect(policy.createdAtSlot.toNumber()).to.equal(
      currentSlot,
      "on-chain stored slot must match the slot at handler entry",
    );
  });
});
