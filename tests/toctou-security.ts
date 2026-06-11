/**
 * TOCTOU Security Fix Tests
 *
 * Validates the Time-of-Check to Time-of-Use security hardening:
 * - Mandatory minimum timelockDuration (1800s / 30 min)
 * - Policy version counter (OCC) to prevent stale-policy agent TXes
 * - Deletion of direct-mutation instructions (updatePolicy, etc.)
 * - Version bump on apply_pending_policy and apply_constraints_update
 */
// Strict error helpers — LOCAL SHIM (see tests/helpers/strict-errors.ts header
// for why LiteSVM tests can't import from @usesigil/kit/testing directly).
// Council decision: MEMORY/WORK/20260420-201121_test-assertion-precision-council/
import { expectSigilError } from "./helpers/strict-errors";
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
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
} from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaIdempotentHelper,
  mintToHelper,
  advanceTime,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

describe("TOCTOU Security Fix", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let usdcMint: PublicKey;

  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  let vaultCounter = 0;

  /** Create a fresh vault with the given timelockDuration and return all PDAs. */
  function createVault(timelockDuration: number) {
    vaultCounter++;
    const vaultId = new BN(9000 + vaultCounter);

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

  /** Initialize a vault, register agent, deposit funds. Returns PDAs. */
  async function setupFullVault(timelockDuration: number) {
    const pdas = createVault(timelockDuration);

    const ownerUsdcAta = createAtaIdempotentHelper(
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
      1_000_000_000n,
    );

    const vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      pdas.vaultPda,
      true,
    );

    await program.methods
      .initializeVault(
        pdas.vaultId,
        new BN(500_000_000),
        new BN(100_000_000),
        1,
        [jupiterProgramId],
        0,
        500,
        new BN(timelockDuration),
        [],
        [],
        false, // observeOnly (Phase 2 TA-19)
        0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
        false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
        5, // auto_revoke_threshold (TA-17 Phase 3 — default)
        new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
        new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
        false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(100_000_000),
          maxSlippageBps: 500,
          protocolMode: 1,
          protocols: [jupiterProgramId],
          allowedDestinations: [],
          timelockDuration: new BN(timelockDuration),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        policy: pdas.policyPda,
        tracker: pdas.trackerPda,
        agentSpendOverlay: pdas.overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // F-Q6: instant OPERATOR grant on a single-key vault is rejected
    // (ErrOperatorGrantRequiresTimelock 6107). Seat the agent via the
    // timelocked queue→advance→apply path. Net policy_version effect is one
    // bump (apply_agent_grant), identical to the prior inline registerAgent.
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      agent: agent.publicKey,
    });

    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { ...pdas, ownerUsdcAta, vaultUsdcAta };
  }

  /** Queue a policy update, advance time, and apply it. Returns the new policy version. */
  async function queueAndApplyPolicy(
    v: {
      vaultPda: PublicKey;
      policyPda: PublicKey;
      pendingPolicyPda: PublicKey;
    },
    timelockSeconds: number,
    dailyCap?: BN,
  ) {
    // Phase 2 TA-19: compute the digest of the merged-effective policy.
    const newDigest = await fetchAndComputeQueueDigest(
      program,
      v.policyPda,
      v.vaultPda,
      { dailySpendingCapUsd: dailyCap ?? null },
    );
    await program.methods
      .queuePolicyUpdate(
        dailyCap ?? null,
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
        null, // destinationMode,
        null, // operating_hours (TA-05 Phase 3 — null pass-through)
        null, // stable_balance_floor (TA-12 Phase 5 — null pass-through)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — null pass-through)
        null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
        null,
        null, // cosign_session_pubkey (D-5: pass-through)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        newDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        pendingPolicy: v.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, timelockSeconds + 1);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        pendingPolicy: v.pendingPolicyPda,
      } as any)
      .rpc();

    const policy = await program.account.policyConfig.fetch(v.policyPda);
    return (policy as any).policyVersion.toNumber();
  }

  // ─── Test 1: PolicyVersionMismatch ───────────────────────────────────────

  it("rejects validate_and_authorize with stale policy version", async () => {
    const v = await setupFullVault(1800);

    // PEN-CROSS-5: register_agent in setupFullVault bumped version to 1.
    // Queue + apply policy change → version becomes 2.
    const newVersion = await queueAndApplyPolicy(v, 1800, new BN(400_000_000));
    expect(newVersion).to.equal(2);

    // Build validate_and_authorize with stale expectedPolicyVersion: 0
    const sessionPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        v.vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    )[0];

    try {
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          new BN(0), // STALE: policy is now at version 1
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: v.vaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(10_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          tracker: v.trackerPda,
          session: sessionPda,
          vaultTokenAccount: v.vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          agentSpendOverlay: v.overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: v.vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: v.policyPda,
          tracker: v.trackerPda,
          vaultTokenAccount: v.vaultUsdcAta,
          agentSpendOverlay: v.overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "PolicyVersionMismatch" });
    }
  });

  // ─── Test 2: TimelockTooShort on vault creation ──────────────────────────

  it("rejects initialize_vault with timelockDuration below minimum", async () => {
    const pdas = createVault(0); // will attempt timelockDuration: 0

    // No need for ATA — initializeVault should fail before touching tokens

    try {
      await program.methods
        .initializeVault(
          pdas.vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          500,
          new BN(0),
          [],
          [],
          false, // observeOnly (Phase 2 TA-19)
          0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
          false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
          5, // auto_revoke_threshold (TA-17 Phase 3 — default)
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
          false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
          initVaultPreviewDigest({
            dailySpendingCapUsd: new BN(500_000_000),
            maxTransactionSizeUsd: new BN(100_000_000),
            maxSlippageBps: 500,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(0),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: pdas.overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooShort" });
    }
  });

  // ─── Test 3: TimelockTooShort on queue with reduction below floor ────────

  it("rejects queuePolicyUpdate with timelockDuration below minimum", async () => {
    const v = await setupFullVault(1800);

    try {
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          new BN(900),
          null,
          null,
          null,
          null,
          null, // destinationMode,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          new Array(32).fill(0), // newPolicyPreviewDigest (Phase 2 TA-19 placeholder)
        )
        .accounts({
          owner: owner.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          pendingPolicy: v.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooShort" });
    }
  });

  // ─── Test 4: Timelock self-removal blocked ───────────────────────────────

  it("rejects queuePolicyUpdate with timelockDuration: 0", async () => {
    const v = await setupFullVault(1800);

    try {
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          new BN(0),
          null,
          null,
          null,
          null,
          null, // destinationMode,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          new Array(32).fill(0), // newPolicyPreviewDigest (Phase 2 TA-19 placeholder)
        )
        .accounts({
          owner: owner.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          pendingPolicy: v.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "TimelockTooShort" });
    }
  });

  // ─── Test 5: Version bump on apply_pending_policy ────────────────────────

  it("bumps policy_version when applying pending policy", async () => {
    const v = await setupFullVault(1800);

    // PEN-CROSS-5 (Phase 4 absorption): register_agent now bumps
    // policy_version (defense-in-depth OCC). setupFullVault calls
    // register_agent once → baseline is 1, not 0.
    const policy0 = await program.account.policyConfig.fetch(v.policyPda);
    const baseline = (policy0 as any).policyVersion.toNumber();
    expect(baseline).to.equal(1);

    // Queue + apply → bumps by 1
    const v1 = await queueAndApplyPolicy(v, 1800, new BN(400_000_000));
    expect(v1).to.equal(baseline + 1);

    // Queue + apply again → bumps by 1
    const v2 = await queueAndApplyPolicy(v, 1800, new BN(300_000_000));
    expect(v2).to.equal(baseline + 2);
  });

  // ─── Test 6: Version bump on apply_constraints_update ────────────────────

  // ─── Test 7: Deleted instructions not callable ───────────────────────────

  it("updatePolicy instruction does not exist", async () => {
    // TypeScript-level check: the deleted instruction should not appear
    // in the generated program methods.
    expect((program.methods as any).updatePolicy).to.be.undefined;
  });
});
