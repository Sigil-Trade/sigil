import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
// Strict error helpers — LOCAL SHIM (see tests/helpers/strict-errors.ts header
// for why LiteSVM tests can't import from @usesigil/kit/testing directly).
// Council decision: MEMORY/WORK/20260420-201121_test-assertion-precision-council/
import { expectAnchorError, expectSigilError } from "./helpers/strict-errors";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
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
import {
  initVaultPreviewDigest,
  fetchAndComputeQueueDigest,
} from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
// F-Q6 (2026-06-02): single-key vaults can no longer instant-register an OPERATOR
// agent — it must route through queue_agent_grant -> advance -> apply_agent_grant.
// This helper performs that sequence; see its header for the full rationale.
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import {
  createTestEnv,
  airdropSol,
  createMintHelper,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  getBalance,
  accountExists,
  advancePastSlot,
  advanceTime,
  sendVersionedTx,
  VersionedTxResult,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  MOCK_DEFI_2_PROGRAM_ID,
  buildMockDefiNoopIx,
  buildMockSwapToVaultIx,
} from "./helpers/litesvm-setup";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR
const VIEWER_CAPABILITY = 1;
const BAD_CAPABILITY = 255;

describe("sigil", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  // Test actors
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  // Token mints and accounts
  let usdcMint: PublicKey;
  let solMint: PublicKey; // a second SPL token for testing
  const vaultId = new BN(1);

  // PDAs
  let vaultPda: PublicKey;
  let vaultBump: number;
  let policyPda: PublicKey;
  let policyBump: number;
  let trackerPda: PublicKey;
  let trackerBump: number;
  let overlayPda: PublicKey;
  // Token accounts
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let feeDestUsdcAta: PublicKey;

  // Helper: read current policy version for TOCTOU check.
  // Defaults to main vault policyPda. Pass different address for other vaults.
  async function pv(addr?: PublicKey): Promise<BN> {
    const pol = await program.account.policyConfig.fetch(addr ?? policyPda);
    return (pol as any).policyVersion ?? new BN(0);
  }

  // F-Q2 drain sizing. validate_and_authorize arms the agent's SPL delegation
  // for only `amount - protocol_fee - developer_fee` (validate_and_authorize.rs
  // :995-1000) — the fees are CPI'd out of the vault ATA up front. A drain ix
  // can therefore move at most that delegated amount; draining the full
  // declared `amount` would exceed the delegation and the inner SPL Transfer
  // would fail with "insufficient funds". finalize then measures
  // actual_spend = total_decrease - fees = the DRAIN amount (finalize_session.rs
  // :328-350), so draining the full delegation makes actual_spend equal exactly
  // `amount - fees` and the per-protocol cap charges that. The per-protocol-cap
  // and TA-13 vaults are created with developer_fee_rate = 0, so the only fee is
  // the hardcoded protocol fee: ceil(amount * 200 / 1_000_000) (PROTOCOL_FEE_RATE
  // / FEE_RATE_DENOMINATOR, ceiling division — mirrors state/mod.rs::ceil_fee).
  const PROTOCOL_FEE_RATE_BN = new BN(200);
  const FEE_RATE_DENOMINATOR_BN = new BN(1_000_000);
  const netDrainAmount = (amount: BN): BN => {
    // ceil(amount * rate / denom) = (amount*rate + denom - 1) / denom
    const protocolFee = amount
      .mul(PROTOCOL_FEE_RATE_BN)
      .add(FEE_RATE_DENOMINATOR_BN.subn(1))
      .div(FEE_RATE_DENOMINATOR_BN);
    return amount.sub(protocolFee);
  };

  // Allowed protocol (fake Jupiter program ID for testing)
  // F-Q2: spending sandwiches need EXACTLY ONE counted DeFi instruction whose
  // program equals target_protocol. This outer "protocol" is used only as the
  // allowlist entry + authorized target by the simple validate/finalize tests
  // (the per-protocol-cap and TA-13 blocks declare their own scoped protocol
  // keypairs). It carries no identity assertion beyond "policy.protocols[0]
  // equals it", which still holds, so point it at the real, loaded, counted
  // mock-defi program; the sandwiches' middle ix is mock-defi's no-op
  // open_position (zero spend, outcome-based premises preserved).
  const jupiterProgramId = MOCK_DEFI_PROGRAM_ID;

  // Protocol treasury (must match hardcoded constant in program)
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  after(() => printCUSummary());

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Airdrop to test accounts
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, unauthorizedUser.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC mint at the hardcoded devnet address (required by is_stablecoin_mint())
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Create a second mint for testing disallowed tokens
    solMint = createMintHelper(svm, (owner as any).payer, owner.publicKey, 9);

    // Create owner's USDC ATA and mint tokens
    ownerUsdcAta = createAtaHelper(
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
      2_000_000_000n, // 2000 USDC
    );

    // Create protocol treasury ATA (needed for fee transfers)
    // Protocol treasury is an off-curve address, so we need allowOwnerOffCurve=true
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Derive PDAs
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    [policyPda, policyBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );

    [trackerPda, trackerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );

    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
  });

  // =========================================================================
  // initialize_vault
  // =========================================================================
  describe("initialize_vault", () => {
    it("creates vault, policy, and tracker PDAs with correct values", async () => {
      const dailyCap = new BN(500_000_000); // 500 USDC
      const maxTxSize = new BN(100_000_000); // 100 USDC

      await program.methods
        .initializeVault(
          vaultId,
          dailyCap,
          maxTxSize,
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: dailyCap,
            maxTransactionSizeUsd: maxTxSize,
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
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

      // Verify vault state
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
      expect(vault.agents.length).to.equal(0);
      expect(vault.feeDestination.toString()).to.equal(
        feeDestination.publicKey.toString(),
      );
      expect(vault.vaultId.toNumber()).to.equal(1);
      expect(vault.totalTransactions.toNumber()).to.equal(0);
      expect(vault.totalVolume.toNumber()).to.equal(0);
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);

      // Verify policy state
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.vault.toString()).to.equal(vaultPda.toString());
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);
      expect(policy.maxTransactionSizeUsd.toNumber()).to.equal(100_000_000);
      expect(policy.protocolMode).to.equal(1);
      expect(policy.protocols.length).to.equal(1);
      expect(policy.protocols[0].toString()).to.equal(
        jupiterProgramId.toString(),
      );
      expect(policy.developerFeeRate).to.equal(0);

      // Verify tracker state
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.vault.toString()).to.equal(vaultPda.toString());
    });

    it("rejects duplicate vault_id (PDA already exists)", async () => {
      try {
        await program.methods
          .initializeVault(
            vaultId,
            new BN(100),
            new BN(100),
            1,
            [jupiterProgramId],
            0,
            100,
            new BN(1800),
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
              dailySpendingCapUsd: new BN(100),
              maxTransactionSizeUsd: new BN(100),
              maxSlippageBps: 100,
              protocolMode: 1,
              protocols: [jupiterProgramId],
              allowedDestinations: [],
              timelockDuration: new BN(1800),
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor init constraint fails when account already exists
        expect(err.toString()).to.include("already in use");
      }
    });

    it("rejects invalid protocol mode", async () => {
      const vaultId2 = new BN(99);
      const [vault2] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vaultId2.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [policy2] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), vault2.toBuffer()],
        program.programId,
      );
      const [tracker2] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), vault2.toBuffer()],
        program.programId,
      );
      const [overlay2] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vault2.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // protocol_mode = 3 is invalid (valid values: 0=all, 1=allowlist, 2=denylist)
      try {
        await program.methods
          .initializeVault(
            vaultId2,
            new BN(100),
            new BN(100),
            3,
            [],
            0,
            100,
            new BN(1800),
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
              dailySpendingCapUsd: new BN(100),
              maxTransactionSizeUsd: new BN(100),
              maxSlippageBps: 100,
              protocolMode: 3,
              protocols: [],
              allowedDestinations: [],
              timelockDuration: new BN(1800),
              operatingHours: 0x00ffffff,
              autoPromoteGrays: false,
              autoRevokeThreshold: 5,
            }),
          )
          .accounts({
            owner: owner.publicKey,
            vault: vault2,
            policy: policy2,
            tracker: tracker2,
            agentSpendOverlay: overlay2,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidProtocolMode" });
      }
    });
  });

  // =========================================================================
  // deposit_funds
  // =========================================================================
  describe("deposit_funds", () => {
    it("transfers tokens from owner to vault", async () => {
      const depositAmount = new BN(100_000_000); // 100 USDC

      // vault ATA will be created by init_if_needed
      vaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: vaultPda,
      });

      await program.methods
        .depositFunds(depositAmount)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vaultBalance = getTokenBalance(svm, vaultUsdcAta);
      expect(Number(vaultBalance)).to.equal(100_000_000);
    });

    it("rejects non-owner signer", async () => {
      try {
        // Derive vault PDA for unauthorizedUser — won't match
        const [fakeVault] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("vault"),
            unauthorizedUser.publicKey.toBuffer(),
            vaultId.toArrayLike(Buffer, "le", 8),
          ],
          program.programId,
        );

        await program.methods
          .depositFunds(new BN(1_000_000))
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: vaultPda, // real vault owned by `owner`
            mint: usdcMint,
            ownerTokenAccount: ownerUsdcAta,
            vaultTokenAccount: vaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: vault PDA seed-key is now `vault.vault_authority`
        // (immutable, set at init). PDA derivation succeeds regardless of
        // signer identity, so the `has_one = owner` constraint fires
        // instead → UnauthorizedOwner (6002). Pre-LBL-01 this was
        // ConstraintSeeds (2006) because the seed-key was `signer.key()`.
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });
  });

  // =========================================================================
  // register_agent
  // =========================================================================
  describe("register_agent", () => {
    it("registers an agent pubkey", async () => {
      // F-Q6: an OPERATOR (FULL_CAPABILITY) grant on this single-key vault must
      // route through queue_agent_grant -> advance -> apply_agent_grant. The
      // helper performs that sequence and lands the agent as OPERATOR, so the
      // capability assertion below still holds.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: vaultPda,
        agent: agent.publicKey,
      });

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
      );
      // P1 #16: Verify capability actually stored (not just pubkey)
      expect(vault.agents[0].capability).to.equal(FULL_CAPABILITY);
    });

    it("rejects double registration", async () => {
      try {
        // Register the SAME agent pubkey that was already registered.
        // F-Q6: use VIEWER_CAPABILITY so the OPERATOR-grant timelock check
        // (ErrOperatorGrantRequiresTimelock, 6107) does not fire BEFORE the
        // AgentAlreadyRegistered check this test targets. The agent is already
        // registered (as OPERATOR via the helper in the prior test), so the
        // duplicate-pubkey check fires regardless of the capability arg.
        await program.methods
          .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            agentSpendOverlay: overlayPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentAlreadyRegistered" });
      }
    });

    it("rejects non-owner signer", async () => {
      // Create a new vault for this test
      const vid = new BN(200);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );
      const [vOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), v.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // First create the vault
      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          agentSpendOverlay: vOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Try to register agent as non-owner
      try {
        await program.methods
          .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: v,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), v.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: vOverlay,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });
  });

  // =========================================================================
  // queue/apply policy update (replaces deleted update_policy)
  // =========================================================================
  describe("queue/apply policy update", () => {
    let mainPendingPda: PublicKey;

    before(() => {
      [mainPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), vaultPda.toBuffer()],
        program.programId,
      );
    });

    it("updates individual policy fields via queue+apply", async () => {
      await program.methods
        .queuePolicyUpdate(
          new BN(200_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, policyPda, vaultPda, {
            dailySpendingCapUsd: new BN(200_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          pendingPolicy: mainPendingPda,
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
          tracker: trackerPda,
          pendingPolicy: mainPendingPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
      // Other fields unchanged
      expect(policy.maxTransactionSizeUsd.toNumber()).to.equal(100_000_000);
    });

    it("rejects non-owner signer", async () => {
      const [badPending] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), vaultPda.toBuffer()],
        program.programId,
      );
      try {
        await program.methods
          .queuePolicyUpdate(
            new BN(999),
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
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(program, policyPda, vaultPda, {
              dailySpendingCapUsd: new BN(999),
            }), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: vaultPda,
            policy: policyPda,
            pendingPolicy: badPending,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });

    it("rejects too many allowed protocols", async () => {
      const tooManyProtocols = Array.from(
        { length: 11 },
        () => Keypair.generate().publicKey,
      );
      try {
        await program.methods
          .queuePolicyUpdate(
            null,
            null,
            null,
            tooManyProtocols,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(program, policyPda, vaultPda, {
              protocols: tooManyProtocols,
            }), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            pendingPolicy: mainPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "TooManyAllowedProtocols" });
      }
    });
  });

  // =========================================================================
  // revoke_agent (kill switch)
  // =========================================================================
  describe("revoke_agent", () => {
    // We'll use a separate vault for revoke/reactivate tests to not affect other tests
    const revokeVaultId = new BN(10);
    let revokeVaultPda: PublicKey;
    let revokeOverlay: PublicKey;

    before(async () => {
      [revokeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          revokeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), revokeVaultPda.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), revokeVaultPda.toBuffer()],
        program.programId,
      );
      [revokeOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          revokeVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          revokeVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: revokeVaultPda,
          policy: rp,
          tracker: rt,
          agentSpendOverlay: revokeOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: this agent is only registered so it can be revoked (to drive the
      // vault to Frozen) — it never spends. Register as VIEWER to avoid the
      // OPERATOR-grant timelock requirement; revoke freezes on agent-count == 0
      // regardless of capability.
      await program.methods
        .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: revokeVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), revokeVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: revokeOverlay,
        } as any)
        .rpc();
    });

    it("freezes the vault", async () => {
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: revokeVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), revokeVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: revokeOverlay,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(revokeVaultPda);
      // VaultStatus::Frozen is represented as { frozen: {} }
      expect(vault.status).to.have.property("frozen");
    });

    it("revoking non-existent agent fails", async () => {
      // Agent was already removed by "freezes the vault" test
      try {
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault: revokeVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), revokeVaultPda.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: revokeOverlay,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "UnauthorizedAgent" });
      }
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: revokeVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), revokeVaultPda.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: revokeOverlay,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });
  });

  // =========================================================================
  // reactivate_vault
  // =========================================================================
  describe("reactivate_vault", () => {
    const reactVaultId = new BN(11);
    let reactVaultPda: PublicKey;
    let reactOverlay: PublicKey;

    before(async () => {
      [reactVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          reactVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), reactVaultPda.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), reactVaultPda.toBuffer()],
        program.programId,
      );
      [reactOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          reactVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          reactVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: rp,
          tracker: rt,
          agentSpendOverlay: reactOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent then freeze by revoking.
      // F-Q6: setup-only agent (never spends) — VIEWER avoids the OPERATOR-grant
      // timelock; the reactivate tests below seat their own OPERATOR via
      // reactivateVault (unchanged by F-Q6).
      await program.methods
        .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), reactVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: reactOverlay,
        } as any)
        .rpc();

      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), reactVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: reactOverlay,
        } as any)
        .rpc();
    });

    it("reactivates a frozen vault", async () => {
      // Phase 8 C28: advance past 5-min reactivate cooldown
      advanceTime(svm, 301);
      // F-Q6: a single-key vault cannot reactivate an OPERATOR agent instantly
      // (ErrOperatorGrantRequiresTimelock 6107). This test only needs the vault
      // Active with an agent present, so reactivate with VIEWER_CAPABILITY (1) —
      // which satisfies the >=1-agent requirement and skips the OPERATOR tier
      // gate (and therefore the NH-1 FULL-only cosigner requirement).
      await program.methods
        .reactivateVault(agent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(vault.status).to.have.property("active");
    });

    it("rejects reactivating an already-active vault", async () => {
      try {
        await program.methods
          .reactivateVault(null, null)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "VaultNotFrozen" });
      }
    });

    it("rejects reactivating without agent when agent is cleared", async () => {
      // Freeze first
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), reactVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: reactOverlay,
        } as any)
        .rpc();

      // Phase 8 C28: advance past 5-min reactivate cooldown
      advanceTime(svm, 301);

      try {
        await program.methods
          .reactivateVault(null, null)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "NoAgentRegistered" });
      }

      // Clean up: reactivate with new agent for subsequent tests.
      // F-Q6: VIEWER_CAPABILITY reactivate (single-key vault cannot grant
      // OPERATOR instantly); satisfies the >=1-agent requirement.
      await program.methods
        .reactivateVault(agent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();
    });

    it("optionally rotates agent key on reactivation", async () => {
      // Freeze again
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), reactVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: reactOverlay,
        } as any)
        .rpc();

      // Phase 8 C28: advance past 5-min reactivate cooldown
      advanceTime(svm, 301);

      const newAgent = Keypair.generate();
      // F-Q6: VIEWER_CAPABILITY reactivate — this test asserts the agent KEY
      // was rotated (not its capability), so VIEWER is the minimal correct fix
      // and skips the OPERATOR tier gate + NH-1 cosigner requirement.
      await program.methods
        .reactivateVault(newAgent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        newAgent.publicKey.toString(),
      );
      expect(vault.status).to.have.property("active");
    });

    it("F-Q6: rejects OPERATOR (FULL_CAPABILITY) reactivate on a single-key vault (timelock required)", async () => {
      // Read the current (rotated) agent from chain — prior test rotated
      // the agent to a fresh keypair whose handle is block-scoped, so we
      // re-derive from chain state.
      const activeVault = await program.account.agentVault.fetch(reactVaultPda);
      const currentAgentPk = new PublicKey(activeVault.agents[0].pubkey);
      // Freeze the vault first so the reactivate path is reachable.
      await program.methods
        .revokeAgent(currentAgentPk)
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), reactVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: reactOverlay,
        } as any)
        .rpc();
      // Advance past 5-min reactivate cooldown (Phase 8 C28).
      advanceTime(svm, 301);
      // F-Q6 (2026-06-02): on a SINGLE-KEY vault (cosign unbound), an instant
      // OPERATOR (FULL_CAPABILITY) grant via reactivate is rejected with
      // ErrOperatorGrantRequiresTimelock (6107) REGARDLESS of any signer — the
      // forced timelock (queue_agent_grant → apply_agent_grant) is the missing
      // 2nd authorization factor. The old NH-1 "bound-cosigner instant path"
      // only applies to cosign-BOUND vaults, so even adding a cosigner here
      // would still revert 6107. This supersedes the old NH-1 6104 assertion.
      const newAgentPk = Keypair.generate().publicKey;
      try {
        await program.methods
          .reactivateVault(newAgentPk, FULL_CAPABILITY)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown ErrOperatorGrantRequiresTimelock");
      } catch (err: any) {
        expectSigilError(err, {
          name: "ErrOperatorGrantRequiresTimelock",
        });
      }
      // Clean up: reactivate with VIEWER so subsequent tests have a viable
      // Active vault. F-Q6: a single-key vault cannot grant OPERATOR instantly,
      // so VIEWER (1) is the correct reactivation capability here.
      await program.methods
        .reactivateVault(newAgentPk, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();
    });
  });

  // =========================================================================
  // withdraw_funds
  // =========================================================================
  describe("withdraw_funds", () => {
    it("transfers tokens from vault to owner", async () => {
      const ownerBefore = Number(getTokenBalance(svm, ownerUsdcAta));
      const vaultBefore = Number(getTokenBalance(svm, vaultUsdcAta));

      const withdrawAmount = new BN(10_000_000); // 10 USDC
      await program.methods
        .withdrawFunds(withdrawAmount)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          mint: usdcMint,
          vaultTokenAccount: vaultUsdcAta,
          ownerTokenAccount: ownerUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      const ownerAfter = Number(getTokenBalance(svm, ownerUsdcAta));
      const vaultAfter = Number(getTokenBalance(svm, vaultUsdcAta));

      expect(vaultAfter).to.equal(vaultBefore - 10_000_000);
      expect(ownerAfter).to.equal(ownerBefore + 10_000_000);
    });

    it("rejects withdrawal exceeding balance", async () => {
      try {
        await program.methods
          .withdrawFunds(new BN(999_999_999_999))
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            mint: usdcMint,
            vaultTokenAccount: vaultUsdcAta,
            ownerTokenAccount: ownerUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "InsufficientBalance" });
      }
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .withdrawFunds(new BN(1))
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: vaultPda,
            mint: usdcMint,
            vaultTokenAccount: vaultUsdcAta,
            ownerTokenAccount: ownerUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });
  });

  // =========================================================================
  // validate_and_authorize + finalize_session (composed transaction)
  // =========================================================================
  describe("validate_and_authorize + finalize_session", () => {
    let sessionPda: PublicKey;

    before(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
    });

    it("authorizes a valid swap action and finalizes atomically", async () => {
      const amount = new BN(50_000_000); // 50 USDC

      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          amount,
          jupiterProgramId,
          await pv(), // expectedPolicyVersion
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount,
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: the mock-defi no-op ix lists the agent signer (the
        // writable fee-payer in the compiled v0 message). validate's
        // destination-completeness guard requires every writable DeFi meta
        // resolvable in remaining_accounts, so append the agent (mirrors seal()).
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: a spending sandwich needs EXACTLY ONE counted DeFi instruction
      // between validate and finalize. mock-defi's no-op open_position is that ix
      // (zero token movement → balance delta stays the protocol fee only).
      const defiIx = buildMockDefiNoopIx(agent.publicKey);

      // P0 Finding 1: Verify vault balance before/after composed TX
      const vaultBalBefore = getTokenBalance(svm, vaultUsdcAta);

      const txResult = sendVersionedTx(
        svm,
        [validateIx, defiIx, finalizeIx],
        agent,
      );
      recordCU("validate+finalize:stablecoin", txResult);

      // P0 Finding 1: Vault balance delta verification (outcome-based spending)
      // Mock DeFi is a no-op — vault balance decreases by protocol fee only.
      // Protocol fee = amount * PROTOCOL_FEE_RATE / FEE_RATE_DENOMINATOR
      // = 50_000_000 * 200 / 1_000_000 = 10_000
      const vaultBalAfter = getTokenBalance(svm, vaultUsdcAta);
      const balanceDelta = vaultBalBefore - vaultBalAfter;
      // With no-op DeFi, the ONLY balance change is the protocol fee (0.02% of declared amount)
      expect(balanceDelta).to.equal(10_000n); // 50M * 200 / 1M = 10K (protocol fee)

      // Session should be closed after atomic validate+finalize. Verify
      // by raw LiteSVM account lookup — bypasses Anchor's client which
      // throws "Could not find ..." through our LiteSVMConnectionProxy
      // instead of returning null.
      expect(svm.getAccount(sessionPda)).to.be.null;

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume uses actual_spend_tracked (outcome-based), not declared amount.
      // Mock DeFi is a no-op (0-lamport self-transfer), so actual spend = 0.
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // =========================================================================
  // Post-finalize instruction scan (Step 5.9 — defense-in-depth)
  // =========================================================================
  describe("post-finalize instruction scan", () => {
    async function buildValidateFinalizePair() {
      const [sessionPdaLocal] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      const amount = new BN(50_000_000);
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          amount,
          jupiterProgramId,
          await pv(), // restored pv() v2
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount,
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPdaLocal,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (writable in the
        // compiled message, referenced by the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      // F-Q2: the counted DeFi ix that sits between validate and finalize so the
      // spending sandwich satisfies defi_ix_count == 1. The post-finalize scan
      // tests append THEIR extra ix AFTER finalize, leaving this as the sole
      // mid-sandwich DeFi instruction.
      const defiIx = buildMockDefiNoopIx(agent.publicKey);

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPdaLocal,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          agentSpendOverlay: overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      return { validateIx, defiIx, finalizeIx };
    }

    it("succeeds with nothing after finalize", async () => {
      const { validateIx, defiIx, finalizeIx } =
        await buildValidateFinalizePair();
      const txResult = sendVersionedTx(
        svm,
        [validateIx, defiIx, finalizeIx],
        agent,
      );
      expect(txResult).to.exist;
    });

    it("allows ComputeBudget after finalize", async () => {
      const { validateIx, defiIx, finalizeIx } =
        await buildValidateFinalizePair();
      const cbIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      const txResult = sendVersionedTx(
        svm,
        [validateIx, defiIx, finalizeIx, cbIx],
        agent,
      );
      expect(txResult).to.exist;
    });

    it("allows SystemProgram after finalize", async () => {
      const { validateIx, defiIx, finalizeIx } =
        await buildValidateFinalizePair();
      const sysIx = SystemProgram.transfer({
        fromPubkey: agent.publicKey,
        toPubkey: agent.publicKey,
        lamports: 0,
      });
      const txResult = sendVersionedTx(
        svm,
        [validateIx, defiIx, finalizeIx, sysIx],
        agent,
      );
      expect(txResult).to.exist;
    });

    it("rejects SPL Transfer after finalize (rejected at validate or post-finalize scan)", async () => {
      const { validateIx, defiIx, finalizeIx } =
        await buildValidateFinalizePair();
      // Craft a top-level SPL Token transfer instruction (disc = 3)
      const splTransferIx = {
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: vaultUsdcAta, isSigner: false, isWritable: true },
          { pubkey: vaultUsdcAta, isSigner: false, isWritable: true },
          { pubkey: agent.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]), // Transfer disc + 0 amount
      };
      try {
        sendVersionedTx(
          svm,
          [validateIx, defiIx, finalizeIx, splTransferIx],
          agent,
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        // UnauthorizedPostFinalizeInstruction (code: 6049 post-M1-04 — shifted
        // from 6056 by the Phase 1 Option A demolition which deleted the two
        // Jupiter-specific variants at 6030/6031). Checked at finalize
        // instruction (index 1).
        expect(err.toString()).to.include("6049");
      }
    });
  });

  // =========================================================================
  // validate_and_authorize — error paths
  // =========================================================================
  describe("validate_and_authorize error paths", () => {
    let sessionPda: PublicKey;

    beforeEach(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
    });

    it("rejects non-stablecoin token without output stablecoin account", async () => {
      // Session PDA for solMint (non-stablecoin)
      const [solSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          solMint.toBuffer(),
        ],
        program.programId,
      );
      // Create vault ATA for solMint so Anchor account validation passes
      const vaultSolAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        solMint,
        vaultPda,
        true, // allowOwnerOffCurve — vault is a PDA
      );
      try {
        await program.methods
          .validateAndAuthorize(
            solMint, // non-stablecoin token mint
            new BN(1_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: vaultPda,
                agent: agent.publicKey,
                tokenMint: solMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: solSession,
            vaultTokenAccount: vaultSolAta,
            tokenMintAccount: solMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: overlayPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Non-stablecoin input requires output_stablecoin_account which is null
        expectSigilError(err, { name: "InvalidTokenAccount" });
      }
    });

    it("rejects disallowed protocol", async () => {
      const fakeProtocol = Keypair.generate().publicKey;
      try {
        await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000),
            fakeProtocol, // not in protocols
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: vaultPda,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: fakeProtocol,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: overlayPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "ProtocolNotAllowed" });
      }
    });

    it("standalone validate rejects without finalize (cap check moved to finalize)", async () => {
      // Outcome-based model: per-tx cap checks are in finalize_session, not validate.
      // A spending validate with its DeFi ix but NO finalize fails with
      // MissingFinalizeInstruction. F-Q2: the sandwich must carry EXACTLY ONE
      // counted DeFi ix, so the bundle is [validate, mock_defi] (no finalize) —
      // defi_ix_count == 1 passes, then the missing finalize is the sole defect.
      try {
        const validateIx = await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(200_000_000), // would exceed max_transaction_size — but checked in finalize now
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: vaultPda,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(200_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: overlayPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          // F-Q1a completeness: append the agent fee-payer (referenced writable
          // by the mock-defi no-op ix). Mirrors seal().
          .remainingAccounts([
            { pubkey: agent.publicKey, isSigner: false, isWritable: false },
          ])
          .instruction();
        const defiIx = buildMockDefiNoopIx(agent.publicKey);
        sendVersionedTx(svm, [validateIx, defiIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, {
          name: "MissingFinalizeInstruction",
        });
      }
    });

    it("standalone validate rejects without finalize (daily cap check moved to finalize)", async () => {
      // Outcome-based model: daily cap checks are in finalize_session, not validate.
      // Validate no longer records spend or checks caps — those use actual balance delta.
      // A spending validate with its DeFi ix but NO finalize fails with
      // MissingFinalizeInstruction. F-Q2: the bundle is [validate, mock_defi]
      // (no finalize) so defi_ix_count == 1 passes and the missing finalize is
      // the sole defect.
      try {
        const validateIx = await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(100_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: vaultPda,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(100_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: overlayPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          // F-Q1a completeness: append the agent fee-payer (referenced writable
          // by the mock-defi no-op ix). Mirrors seal().
          .remainingAccounts([
            { pubkey: agent.publicKey, isSigner: false, isWritable: false },
          ])
          .instruction();
        const defiIx = buildMockDefiNoopIx(agent.publicKey);
        sendVersionedTx(svm, [validateIx, defiIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, {
          name: "MissingFinalizeInstruction",
        });
      }
    });

    it("rejects unauthorized agent", async () => {
      const fakeAgent = Keypair.generate();
      airdropSol(svm, fakeAgent.publicKey, LAMPORTS_PER_SOL);

      const [fakeSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          fakeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      try {
        await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: vaultPda,
                agent: fakeAgent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: fakeAgent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: fakeSession,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: overlayPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([fakeAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "UnauthorizedAgent" });
      }
    });

    it("rejects action on frozen vault", async () => {
      // Create a fresh vault, register agent, then freeze it
      // Note: revoke_agent clears the agent key, so is_agent() fails before
      // the handler's VaultNotActive check. We verify the vault rejects
      // the action — either UnauthorizedAgent (agent cleared) or VaultNotActive.
      const frozenVaultId = new BN(10);
      const [frozenVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          frozenVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [frozenPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), frozenVault.toBuffer()],
        program.programId,
      );
      const [frozenTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), frozenVault.toBuffer()],
        program.programId,
      );
      const [frozenSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          frozenVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Create vault ATA so Anchor account validation passes,
      // allowing the agent/status checks to fire.
      const frozenVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        frozenVault,
        true, // allowOwnerOffCurve — vault is a PDA
      );

      const [frozenOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), frozenVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      try {
        await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: frozenVault,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: frozenVault,
            policy: frozenPolicy,
            tracker: frozenTracker,
            session: frozenSession,
            vaultTokenAccount: frozenVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: frozenOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // revoke_agent clears the agent key. The `#[account(constraint =
        // vault.is_agent(&agent.key()) @ SigilError::UnauthorizedAgent)]`
        // constraint on the agent field (validate_and_authorize.rs:22 /
        // agent_transfer.rs:18) fires before the handler body. Anchor
        // emits the custom-override error code (UnauthorizedAgent 6001),
        // NOT the default `ConstraintRaw 2003` tag — the `@ SigilError::X`
        // syntax replaces the default tag per Anchor codegen.
        expectSigilError(err, { name: "UnauthorizedAgent" });
      }
    });
  });

  // =========================================================================
  // close_vault
  // =========================================================================
  describe("close_vault", () => {
    const closeVaultId = new BN(20);
    let closeVaultPda: PublicKey;
    let closePolicyPda: PublicKey;
    let closeTrackerPda: PublicKey;
    let closeOverlayPda: PublicKey;

    before(async () => {
      [closeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [closePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), closeVaultPda.toBuffer()],
        program.programId,
      );
      [closeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), closeVaultPda.toBuffer()],
        program.programId,
      );
      [closeOverlayPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          closeVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closeVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: closeVaultPda,
          policy: closePolicyPda,
          tracker: closeTrackerPda,
          agentSpendOverlay: closeOverlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("closes vault and reclaims rent", async () => {
      const ownerBefore = getBalance(svm, owner.publicKey);

      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: closeVaultPda,
          policy: closePolicyPda,
          tracker: closeTrackerPda,
          agentSpendOverlay: closeOverlayPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Accounts should no longer exist
      expect(accountExists(svm, closeVaultPda)).to.be.false;
      expect(accountExists(svm, closePolicyPda)).to.be.false;
      expect(accountExists(svm, closeTrackerPda)).to.be.false;

      // Owner should have received rent back
      const ownerAfter = getBalance(svm, owner.publicKey);
      expect(ownerAfter).to.be.greaterThan(ownerBefore);
    });

    it("rejects non-owner signer", async () => {
      // Create another vault to test rejection
      const vid = new BN(21);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );
      const [vOverlay21] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), v.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          agentSpendOverlay: vOverlay21,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .closeVault()
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: v,
            policy: p,
            tracker: t,
            agentSpendOverlay: vOverlay21,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });
  });

  // =========================================================================
  // Dual Fee Model Tests
  // =========================================================================
  describe("dual fee model", () => {
    const feeVaultId = new BN(30);
    let feeVaultPda: PublicKey;
    let feePolicyPda: PublicKey;
    let feeTrackerPda: PublicKey;
    let feeVaultUsdcAta: PublicKey;
    let feeSessionPda: PublicKey;
    let feeOverlay: PublicKey;

    it("init vault with developer_fee_rate 30 → stored correctly", async () => {
      [feeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [feePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeVaultPda.toBuffer()],
        program.programId,
      );
      [feeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeVaultPda.toBuffer()],
        program.programId,
      );
      const [feeOverlayInit] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), feeVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          feeVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          30,
          100,
          new BN(1800),
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
            maxSlippageBps: 100,
            developerFeeRate: 30, // PEN-CROSS-6: must match the ix arg.
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          agentSpendOverlay: feeOverlayInit,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(30);
    });

    it("init vault with developer_fee_rate 501 → rejects DeveloperFeeTooHigh", async () => {
      const badVaultId = new BN(31);
      const [bv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId,
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId,
      );
      const [bOverlay31] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), bv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      try {
        await program.methods
          .initializeVault(
            badVaultId,
            new BN(1000),
            new BN(1000),
            1,
            [],
            501,
            100,
            new BN(1800),
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
              dailySpendingCapUsd: new BN(1000),
              maxTransactionSizeUsd: new BN(1000),
              maxSlippageBps: 100,
              protocolMode: 1,
              protocols: [jupiterProgramId],
              allowedDestinations: [],
              timelockDuration: new BN(1800),
              operatingHours: 0x00ffffff,
              autoPromoteGrays: false,
              autoRevokeThreshold: 5,
            }),
          )
          .accounts({
            owner: owner.publicKey,
            vault: bv,
            policy: bp,
            tracker: bt,
            agentSpendOverlay: bOverlay31,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "DeveloperFeeTooHigh" });
      }
    });

    it("queue/apply policy changes developer_fee_rate 0→30 → stored", async () => {
      const [feePendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), feeVaultPda.toBuffer()],
        program.programId,
      );

      // Use the fee vault created above, first set to 0
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, feePolicyPda, feeVaultPda, {
            developerFeeRate: 0,
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          pendingPolicy: feePendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          pendingPolicy: feePendingPda,
        } as any)
        .rpc();

      let policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(0);

      // Now update to 30
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          30,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, feePolicyPda, feeVaultPda, {
            developerFeeRate: 30,
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          pendingPolicy: feePendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          pendingPolicy: feePendingPda,
        } as any)
        .rpc();

      policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(30);
    });

    it("queue policy with developer_fee_rate 501 → rejects", async () => {
      const [feePendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), feeVaultPda.toBuffer()],
        program.programId,
      );
      try {
        await program.methods
          .queuePolicyUpdate(
            null,
            null,
            null,
            null,
            501,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(
              program,
              feePolicyPda,
              feeVaultPda,
              {},
            ), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: owner.publicKey,
            vault: feeVaultPda,
            policy: feePolicyPda,
            pendingPolicy: feePendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "DeveloperFeeTooHigh" });
      }
    });

    it("validate with developer_fee=0 → no developer fees collected", async () => {
      const [feePendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), feeVaultPda.toBuffer()],
        program.programId,
      );
      // Set developer fee to 0
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, feePolicyPda, feeVaultPda, {
            developerFeeRate: 0,
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          pendingPolicy: feePendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          pendingPolicy: feePendingPda,
        } as any)
        .rpc();

      // Register agent on fee vault.
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); the agent then spends below.
      [feeOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), feeVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: feeVaultPda,
        agent: agent.publicKey,
      });

      // Deposit to the fee vault
      feeVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: feeVaultPda,
      });

      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Derive session PDA
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Compose validate+finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          await pv(feePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeVaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(10_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx = buildMockDefiNoopIx(agent.publicKey);
      const feeResult = sendVersionedTx(
        svm,
        [validateIx, defiIx, finalizeIx],
        agent,
      );
      recordCU("validate+finalize:with_fees", feeResult);

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // developer fees should be 0 (only protocol fee collected, not tracked in totalFeesCollected)
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);
    });

    it("validate with developer_fee=500 → developer fees collected on vault", async () => {
      const [feePendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), feeVaultPda.toBuffer()],
        program.programId,
      );
      // Set developer fee to 500 (max, 5 BPS)
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          500,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, feePolicyPda, feeVaultPda, {
            developerFeeRate: 500,
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          pendingPolicy: feePendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          pendingPolicy: feePendingPda,
        } as any)
        .rpc();

      // Create fee destination ATA
      try {
        feeDestUsdcAta = createAtaHelper(
          svm,
          (owner as any).payer,
          usdcMint,
          feeDestination.publicKey,
        );
      } catch {
        // ATA may already exist
        feeDestUsdcAta = anchor.utils.token.associatedAddress({
          mint: usdcMint,
          owner: feeDestination.publicKey,
        });
      }

      // Derive session PDA
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Compose validate+finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          await pv(feePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeVaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(10_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx = buildMockDefiNoopIx(agent.publicKey);
      sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], agent);

      // developer fee = 10_000_000 * 500 / 1_000_000 = 5000
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalFeesCollected.toNumber()).to.equal(5000);
    });

    it("zero-spend finalize always tracks developer fees in total_fees_collected", async () => {
      // After removing the success param, fees are always tracked in accounting
      // even when the DeFi leg moved nothing (fee drain fix). F-Q2: a spending
      // sandwich must carry EXACTLY ONE counted DeFi ix, so the bundle is
      // [validate, mock_defi(noop), finalize]; the no-op moves zero tokens so
      // actual_spend = 0 and the fee-only accounting path is exercised — exactly
      // the case this test pins.
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const vaultBefore = await program.account.agentVault.fetch(feeVaultPda);
      const feesBefore = vaultBefore.totalFeesCollected.toNumber();

      // Compose validate + mock_defi(noop) + finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          await pv(feePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeVaultPda,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(10_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta,
          agentSpendOverlay: feeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx = buildMockDefiNoopIx(agent.publicKey);
      sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], agent);

      const vault = await program.account.agentVault.fetch(feeVaultPda);
      // Developer fees ALWAYS tracked now (fee drain fix — accounting matches reality)
      expect(vault.totalFeesCollected.toNumber()).to.be.greaterThan(feesBefore);
    });

    it("init vault with developer_fee_rate at max (500) succeeds", async () => {
      const maxFeeVaultId = new BN(32);
      const [mv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          maxFeeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [mp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), mv.toBuffer()],
        program.programId,
      );
      const [mt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), mv.toBuffer()],
        program.programId,
      );
      const [mOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), mv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          maxFeeVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          500,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            developerFeeRate: 500, // PEN-CROSS-6: must match the ix arg.
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: mv,
          policy: mp,
          tracker: mt,
          agentSpendOverlay: mOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(mp);
      expect(policy.developerFeeRate).to.equal(500);
    });
  });

  // =========================================================================
  // Composed validate+finalize — session lifecycle
  // =========================================================================
  describe("composed validate+finalize — session lifecycle", () => {
    const lifecycleVaultId = new BN(40);
    let lifecycleVaultPda: PublicKey;
    let lifecyclePolicyPda: PublicKey;
    let lifecycleTrackerPda: PublicKey;
    let lifecycleSessionPda: PublicKey;
    let lifecycleVaultUsdcAta: PublicKey;
    let lifecycleOverlay: PublicKey;
    const lifecycleAgent = Keypair.generate();

    before(async () => {
      // Airdrop to new agent
      airdropSol(svm, lifecycleAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [lifecycleVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          lifecycleVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [lifecyclePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), lifecycleVaultPda.toBuffer()],
        program.programId,
      );
      [lifecycleTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), lifecycleVaultPda.toBuffer()],
        program.programId,
      );
      [lifecycleSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          lifecycleVaultPda.toBuffer(),
          lifecycleAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      [lifecycleOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          lifecycleVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      // Create vault with USDC allowed
      await program.methods
        .initializeVault(
          lifecycleVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          agentSpendOverlay: lifecycleOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent.
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); lifecycleAgent spends below.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: lifecycleVaultPda,
        agent: lifecycleAgent.publicKey,
      });

      // Deposit USDC to vault
      lifecycleVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: lifecycleVaultPda,
      });

      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: lifecycleVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("composed validate+finalize succeeds and session is closed atomically", async () => {
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          await pv(lifecyclePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: lifecycleVaultPda,
              agent: lifecycleAgent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(10_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          session: lifecycleSessionPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: lifecycleOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          {
            pubkey: lifecycleAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          session: lifecycleSessionPda,
          sessionRentRecipient: lifecycleAgent.publicKey,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          agentSpendOverlay: lifecycleOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx = buildMockDefiNoopIx(lifecycleAgent.publicKey);
      sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], lifecycleAgent);

      // Session should be closed after atomic validate+finalize. Verify
      // by raw LiteSVM account lookup (see first site for context).
      expect(svm.getAccount(lifecycleSessionPda)).to.be.null;

      // Vault stats should be updated
      const vault = await program.account.agentVault.fetch(lifecycleVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
    });

    it("session rent recipient != agent in composed tx → rejects InvalidSession", async () => {
      // Compose validate+finalize but with wrong rent recipient
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(5_000_000),
          jupiterProgramId,
          await pv(lifecyclePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: lifecycleVaultPda,
              agent: lifecycleAgent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(5_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          session: lifecycleSessionPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: lifecycleOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          {
            pubkey: lifecycleAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          session: lifecycleSessionPda,
          sessionRentRecipient: unauthorizedUser.publicKey, // wrong recipient
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          vaultTokenAccount: null,
          agentSpendOverlay: lifecycleOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      try {
        // F-Q2: counted DeFi ix so validate passes and finalize reaches the
        // InvalidSession check (wrong rent recipient). Zero spend.
        const defiIx = buildMockDefiNoopIx(lifecycleAgent.publicKey);
        sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], lifecycleAgent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidSession" });
      }
    });

    it("multiple sequential composed transactions succeed", async () => {
      // Execute two more composed transactions to confirm sequential usage works
      for (let i = 0; i < 2; i++) {
        const validateIx = await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(5_000_000),
            jupiterProgramId,
            await pv(lifecyclePolicyPda),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: lifecycleVaultPda,
                agent: lifecycleAgent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(5_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accountsPartial({
            agent: lifecycleAgent.publicKey,
            vault: lifecycleVaultPda,
            policy: lifecyclePolicyPda,
            tracker: lifecycleTrackerPda,
            session: lifecycleSessionPda,
            vaultTokenAccount: lifecycleVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: lifecycleOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          // F-Q1a completeness: append the agent fee-payer (referenced writable
          // by the mock-defi no-op ix). Mirrors seal().
          .remainingAccounts([
            {
              pubkey: lifecycleAgent.publicKey,
              isSigner: false,
              isWritable: false,
            },
          ])
          .instruction();

        const finalizeIx = await program.methods
          .finalizeSession()
          .accountsPartial({
            payer: lifecycleAgent.publicKey,
            vault: lifecycleVaultPda,
            session: lifecycleSessionPda,
            sessionRentRecipient: lifecycleAgent.publicKey,
            policy: lifecyclePolicyPda,
            tracker: lifecycleTrackerPda,
            vaultTokenAccount: lifecycleVaultUsdcAta,
            agentSpendOverlay: lifecycleOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
          })
          .instruction();

        // F-Q2: counted DeFi ix between validate and finalize (zero spend).
        const defiIx = buildMockDefiNoopIx(lifecycleAgent.publicKey);
        sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], lifecycleAgent);
      }

      const vault = await program.account.agentVault.fetch(lifecycleVaultPda);
      // 1 from first test + 2 from this test = 3
      expect(vault.totalTransactions.toNumber()).to.equal(3);
    });
  });

  // =========================================================================
  // Agent registration security
  // =========================================================================
  describe("agent registration security", () => {
    it("rejects owner as agent → AgentIsOwner", async () => {
      const vid = new BN(50);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );
      const [vOverlay2] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), v.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          agentSpendOverlay: vOverlay2,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      try {
        // F-Q6: use VIEWER_CAPABILITY so the OPERATOR-grant timelock check
        // (6107) does not pre-empt the AgentIsOwner check this test targets.
        // owner == agent is rejected regardless of capability.
        await program.methods
          .registerAgent(owner.publicKey, VIEWER_CAPABILITY, new BN(0)) // owner = agent → reject
          .accounts({
            owner: owner.publicKey,
            vault: v,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), v.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: vOverlay2,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentIsOwner" });
      }
    });

    it("validate_and_authorize with agent after revocation → UnauthorizedAgent", async () => {
      // Use the revoke vault (ID=10) which has been frozen and agent cleared
      const revokeVaultId = new BN(10);
      const [rv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          revokeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), rv.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), rv.toBuffer()],
        program.programId,
      );
      const [rvOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), rv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Reactivate so status is Active but with a NEW agent, not our test agent
      const newAgent = Keypair.generate();
      airdropSol(svm, newAgent.publicKey, LAMPORTS_PER_SOL);

      // First reactivate with newAgent
      try {
        // May already be active from earlier test, so freeze first
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault: rv,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), rv.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: rvOverlay,
          } as any)
          .rpc();
      } catch {
        // ignore if already frozen
      }

      // Phase 8 Batch 5: advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      // F-Q6: reactivate with VIEWER (single-key vault cannot grant OPERATOR
      // instantly). This test asserts the OLD/revoked agent is rejected on
      // validate; the reactivation agent's capability is irrelevant, so VIEWER
      // is the minimal correct fix (skips the OPERATOR tier gate + cosigner).
      await program.methods
        .reactivateVault(newAgent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: rv } as any)
        .rpc();

      // Now try to use the ORIGINAL agent (who was revoked)
      const [oldSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          rv.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      try {
        await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: rv,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: rv,
            policy: rp,
            tracker: rt,
            session: oldSession,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: rvOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // `#[account(constraint = vault.is_agent(&agent.key()) @
        // SigilError::UnauthorizedAgent)]` on the agent field fires before
        // the handler body. Anchor emits the `@ X` custom-override code
        // (UnauthorizedAgent 6001), NOT the default `ConstraintRaw 2003`
        // tag — the override syntax replaces the default.
        expectSigilError(err, { name: "UnauthorizedAgent" });
      }
    });
  });

  // =========================================================================
  // Vault status transitions
  // =========================================================================
  describe("vault status transitions", () => {
    it("deposit to frozen vault → should succeed (only checks VaultAlreadyClosed)", async () => {
      const frozenVaultId = new BN(60);
      const [fv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          frozenVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [fp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), fv.toBuffer()],
        program.programId,
      );
      const [ft] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), fv.toBuffer()],
        program.programId,
      );
      const [fvOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), fv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          agentSpendOverlay: fvOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent then freeze by revoking.
      // F-Q6: setup-only agent (revoked immediately, never spends) — VIEWER
      // avoids the OPERATOR-grant timelock. The deposit-to-frozen-vault
      // assertion is independent of agent capability.
      await program.methods
        .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), fv.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: fvOverlay,
        } as any)
        .rpc();

      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), fv.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: fvOverlay,
        } as any)
        .rpc();

      const frozenVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: fv,
      });

      // Deposit should succeed even when frozen
      await program.methods
        .depositFunds(new BN(1_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: frozenVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vaultTokenBalance = getTokenBalance(svm, frozenVaultUsdcAta);
      expect(Number(vaultTokenBalance)).to.equal(1_000_000);
    });

    it("deposit to closed vault → rejects VaultAlreadyClosed", async () => {
      const closedVaultId = new BN(61);
      const [cv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closedVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId,
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId,
      );
      const [cvOverlay61] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), cv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closedVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          agentSpendOverlay: cvOverlay61,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Close vault
      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          agentSpendOverlay: cvOverlay61,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // The vault PDA no longer exists after closing, so any attempt to deposit
      // will fail at the account deserialization level
      const closedVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: cv,
      });

      try {
        await program.methods
          .depositFunds(new BN(1_000_000))
          .accounts({
            owner: owner.publicKey,
            vault: cv,
            mint: usdcMint,
            ownerTokenAccount: ownerUsdcAta,
            vaultTokenAccount: closedVaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Vault PDA was closed — Anchor can't deserialize a zeroed/missing account.
        // LiteSVM proxy returns "Account does not exist"; Anchor provider
        // returns "Could not find" or "AccountNotInitialized".
        expectAnchorError(err, { name: "AccountNotInitialized", code: 3012 });
      }
    });

    it("validate_and_authorize on closed vault → rejects", async () => {
      const closedVaultId = new BN(62);
      const [cv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closedVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId,
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId,
      );
      const [cs] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          cv.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      const [cvOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), cv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closedVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000),
            maxTransactionSizeUsd: new BN(1000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          agentSpendOverlay: cvOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent, then close.
      // F-Q6: setup-only agent — VIEWER avoids the OPERATOR-grant timelock.
      // The validate-on-closed-vault path fails at account resolution
      // (AccountNotInitialized) before any capability check, so the agent's
      // capability is irrelevant to the assertion.
      await program.methods
        .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), cv.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: cvOverlay,
        } as any)
        .rpc();

      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          agentSpendOverlay: cvOverlay,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            await pv(),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: cv,
                agent: agent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accounts({
            agent: agent.publicKey,
            vault: cv,
            policy: cp,
            tracker: ct,
            session: cs,
            vaultTokenAccount: anchor.utils.token.associatedAddress({
              mint: usdcMint,
              owner: cv,
            }),
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: cvOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Vault PDA was closed — Anchor can't deserialize it.
        // LiteSVM returns "does not exist"; Anchor returns "Could not find"
        // or "AccountNotInitialized".
        expectAnchorError(err, { name: "AccountNotInitialized", code: 3012 });
      }
    });
  });

  // =========================================================================
  // Audit log ring buffer (MAX_RECENT_TRANSACTIONS = 50)
  // =========================================================================
  describe("audit log ring buffer", () => {
    const ringVaultId = new BN(70);
    let ringVaultPda: PublicKey;
    let ringPolicyPda: PublicKey;
    let ringTrackerPda: PublicKey;
    let ringVaultUsdcAta: PublicKey;
    let ringOverlay: PublicKey;
    const ringAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, ringAgent.publicKey, 10 * LAMPORTS_PER_SOL);

      [ringVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          ringVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [ringPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), ringVaultPda.toBuffer()],
        program.programId,
      );
      [ringTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), ringVaultPda.toBuffer()],
        program.programId,
      );

      // Large daily cap to allow many transactions
      [ringOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), ringVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await program.methods
        .initializeVault(
          ringVaultId,
          new BN(999_000_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(999_000_000_000),
            maxTransactionSizeUsd: new BN(100_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: ringVaultPda,
          policy: ringPolicyPda,
          tracker: ringTrackerPda,
          agentSpendOverlay: ringOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); ringAgent runs 51 spend cycles below.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: ringVaultPda,
        agent: ringAgent.publicKey,
      });

      ringVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: ringVaultPda,
      });

      // Deposit enough for all transactions + fees
      await program.methods
        .depositFunds(new BN(500_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: ringVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: ringVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("51+ transactions → oldest evicted, newest preserved, count stays at 50", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          ringVaultPda.toBuffer(),
          ringAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Execute 51 composed validate+finalize cycles
      for (let i = 0; i < 51; i++) {
        const validateIx = await program.methods
          .validateAndAuthorize(
            usdcMint,
            new BN(1_000_000), // 1 USDC each
            jupiterProgramId,
            await pv(ringPolicyPda),
            new BN(0), // AC-10 expectedNonce
            digestAsArgs(
              buildExpectedIntentDigest({
                vault: ringVaultPda,
                agent: ringAgent.publicKey,
                tokenMint: usdcMint,
                amount: new BN(1_000_000),
                targetProtocol: jupiterProgramId,
              }),
            ),
          )
          .accountsPartial({
            agent: ringAgent.publicKey,
            vault: ringVaultPda,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            session: sessionPda,
            vaultTokenAccount: ringVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
            agentSpendOverlay: ringOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          // F-Q1a completeness: append the agent fee-payer (referenced writable
          // by the mock-defi no-op ix). Mirrors seal().
          .remainingAccounts([
            { pubkey: ringAgent.publicKey, isSigner: false, isWritable: false },
          ])
          .instruction();

        const finalizeIx = await program.methods
          .finalizeSession()
          .accountsPartial({
            payer: ringAgent.publicKey,
            vault: ringVaultPda,
            session: sessionPda,
            sessionRentRecipient: ringAgent.publicKey,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            vaultTokenAccount: ringVaultUsdcAta,
            agentSpendOverlay: ringOverlay,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            outputStablecoinAccount: null,
            outputSwapAccount: null,
          })
          .instruction();

        // F-Q2: counted DeFi ix between validate and finalize (zero spend).
        const defiIx = buildMockDefiNoopIx(ringAgent.publicKey);
        sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], ringAgent);
      }

      // Outcome-based model: the no-op DeFi ix moves nothing → actual_spend = 0
      // per TX. Tracker buckets remain empty (no recorded spend), but
      // total_transactions increments.
      const vault = await program.account.agentVault.fetch(ringVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(51);
    });
  });

  // =========================================================================
  // Fee precision edge cases
  // =========================================================================
  describe("fee precision edge cases", () => {
    const feeEdgeVaultId = new BN(80);
    let feeEdgeVaultPda: PublicKey;
    let feeEdgePolicyPda: PublicKey;
    let feeEdgeTrackerPda: PublicKey;
    let feeEdgeVaultUsdcAta: PublicKey;
    let feeEdgeOverlay: PublicKey;
    const feeEdgeAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, feeEdgeAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [feeEdgeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeEdgeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [feeEdgePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeEdgeVaultPda.toBuffer()],
        program.programId,
      );
      [feeEdgeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeEdgeVaultPda.toBuffer()],
        program.programId,
      );

      // developer_fee_rate = 0 to isolate protocol fee
      [feeEdgeOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          feeEdgeVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );
      await program.methods
        .initializeVault(
          feeEdgeVaultId,
          new BN(999_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(999_000_000),
            maxTransactionSizeUsd: new BN(100_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          agentSpendOverlay: feeEdgeOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); feeEdgeAgent spends below.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: feeEdgeVaultPda,
        agent: feeEdgeAgent.publicKey,
      });

      feeEdgeVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: feeEdgeVaultPda,
      });

      await program.methods
        .depositFunds(new BN(10_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: feeEdgeVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("amount = 1 lamport → protocol_fee = 1 (ceiling division)", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeEdgeVaultPda.toBuffer(),
          feeEdgeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      const treasuryBefore = getTokenBalance(svm, protocolTreasuryUsdcAta);

      // ceil(1 * 200 / 1_000_000) = 1 protocol fee (devFeeRate=0 → dev fee = 0)
      // net = 1 - 1 = 0 → delegation = 0, 1 unit goes to treasury
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(1), // 1 lamport
          jupiterProgramId,
          await pv(feeEdgePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeEdgeVaultPda,
              agent: feeEdgeAgent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(1),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          {
            pubkey: feeEdgeAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend; the
      // protocol fee is collected at validate, independent of the DeFi leg).
      const defiIx = buildMockDefiNoopIx(feeEdgeAgent.publicKey);
      sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], feeEdgeAgent);

      // Vault lost 1 unit (protocol fee), treasury gained 1 unit
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      const treasuryAfter = getTokenBalance(svm, protocolTreasuryUsdcAta);
      expect(Number(vaultBalBefore) - Number(vaultBalAfter)).to.equal(1);
      expect(Number(treasuryAfter) - Number(treasuryBefore)).to.equal(1);
    });

    it("amount = 4999 → fee = 1 (ceiling); amount = 5000 → fee = 1 (exact)", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeEdgeVaultPda.toBuffer(),
          feeEdgeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Test amount = 4999: ceil(4999 * 200 / 1_000_000) = 1 (ceiling division)
      // Compose validate+finalize atomically
      const validateIx1 = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(4_999),
          jupiterProgramId,
          await pv(feeEdgePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeEdgeVaultPda,
              agent: feeEdgeAgent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(4_999),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          {
            pubkey: feeEdgeAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx1 = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta, // H1: must provide for delegation revocation
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx1 = buildMockDefiNoopIx(feeEdgeAgent.publicKey);
      sendVersionedTx(svm, [validateIx1, defiIx1, finalizeIx1], feeEdgeAgent);

      // Test amount = 5000: ceil(5000 * 200 / 1_000_000) = 1 (exact division, same result)
      // Capture vault balance BEFORE validate (fee collected during validate)
      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);

      const validateIx2 = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(5_000),
          jupiterProgramId,
          await pv(feeEdgePolicyPda),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: feeEdgeVaultPda,
              agent: feeEdgeAgent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(5_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: append the agent fee-payer (referenced writable by
        // the mock-defi no-op ix). Mirrors seal().
        .remainingAccounts([
          {
            pubkey: feeEdgeAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx2 = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta, // H1: must provide for delegation revocation
          agentSpendOverlay: feeEdgeOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      // F-Q2: counted DeFi ix between validate and finalize (zero spend).
      const defiIx2 = buildMockDefiNoopIx(feeEdgeAgent.publicKey);
      sendVersionedTx(svm, [validateIx2, defiIx2, finalizeIx2], feeEdgeAgent);

      // Vault balance should decrease by exactly 1 (protocol fee deducted during validate)
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      expect(Number(vaultBalBefore) - Number(vaultBalAfter)).to.equal(1);
    });
  });

  // =========================================================================
  // Timelock policy changes
  // =========================================================================
  describe("timelock policy changes", () => {
    const tlVaultId = new BN(600);
    let tlVaultPda: PublicKey;
    let tlPolicyPda: PublicKey;
    let tlTrackerPda: PublicKey;
    let tlPendingPda: PublicKey;
    let tlOverlay: PublicKey;
    const tlAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, tlAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [tlVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          tlVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [tlPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), tlVaultPda.toBuffer()],
        program.programId,
      );
      [tlTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), tlVaultPda.toBuffer()],
        program.programId,
      );
      [tlPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), tlVaultPda.toBuffer()],
        program.programId,
      );

      // Create vault WITH timelock (1800 seconds = MIN_TIMELOCK_DURATION)
      [tlOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), tlVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await program.methods
        .initializeVault(
          tlVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          agentSpendOverlay: tlOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: tlAgent exists only to keep the vault non-Frozen during the
      // policy queue/apply tests below; it never spends and is revoked at the
      // end of the block. Register as VIEWER to avoid the OPERATOR-grant
      // timelock requirement.
      await program.methods
        .registerAgent(tlAgent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), tlVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: tlOverlay,
        } as any)
        .rpc();
    });

    it("queue policy update succeeds when timelock > 0", async () => {
      await program.methods
        .queuePolicyUpdate(
          new BN(200_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            dailySpendingCapUsd: new BN(200_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const pending =
        await program.account.pendingPolicyUpdate.fetch(tlPendingPda);
      expect(pending.vault.toString()).to.equal(tlVaultPda.toString());
      expect(pending.dailySpendingCapUsd!.toNumber()).to.equal(200_000_000);
      expect(pending.executesAt.toNumber()).to.be.greaterThan(
        pending.queuedAt.toNumber(),
      );
    });

    it("apply fails before timelock expires", async () => {
      try {
        await program.methods
          .applyPendingPolicy()
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            tracker: tlTrackerPda,
            pendingPolicy: tlPendingPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "TimelockNotExpired" });
      }
    });

    it("apply succeeds after timelock expires", async () => {
      // Advance time past timelock (1800 seconds + buffer)
      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      // Verify policy was updated
      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);

      // Pending PDA should be closed
      // Verify PendingPolicyUpdate was closed via raw LiteSVM account
      // lookup — the Anchor client's fetchNullable path throws on our
      // LiteSVMConnectionProxy instead of returning null.
      expect(svm.getAccount(tlPendingPda)).to.be.null;
    });

    it("cancel pending policy succeeds and returns rent", async () => {
      // Queue another update. Use a LOWER daily cap (100_000_000) so the
      // TA-09 (Phase 3) elevated-mutation guard does not fire — this test
      // exercises the cancel-rent-return path, not the cosign workflow.
      await program.methods
        .queuePolicyUpdate(
          new BN(100_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            dailySpendingCapUsd: new BN(100_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const ownerBalBefore = getBalance(svm, owner.publicKey);

      await program.methods
        .cancelPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      // Rent should be returned
      const ownerBalAfter = getBalance(svm, owner.publicKey);
      expect(ownerBalAfter).to.be.greaterThan(ownerBalBefore);

      // Policy unchanged
      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
    });

    it("only one pending update at a time (init fails if PDA exists)", async () => {
      // Queue an update. LOWER the daily cap so TA-09 (Phase 3) elevated-
      // mutation guard does not fire — this test exercises the
      // single-pending-PDA invariant, not the cosign workflow.
      await program.methods
        .queuePolicyUpdate(
          new BN(150_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            dailySpendingCapUsd: new BN(150_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Try to queue another (should fail — PDA already exists)
      try {
        await program.methods
          .queuePolicyUpdate(
            new BN(500_000_000),
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
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
              dailySpendingCapUsd: new BN(500_000_000),
            }), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            pendingPolicy: tlPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor init constraint fails when PDA already exists
        expect(err.toString()).to.not.include("Should have thrown");
      }

      // Clean up
      await program.methods
        .cancelPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();
    });

    it("initializeVault rejects timelock below MIN_TIMELOCK_DURATION", async () => {
      const noTlVaultId = new BN(601);
      const [noTlVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          noTlVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [noTlPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), noTlVault.toBuffer()],
        program.programId,
      );
      const [noTlTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), noTlVault.toBuffer()],
        program.programId,
      );
      const [noTlOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), noTlVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      try {
        await program.methods
          .initializeVault(
            noTlVaultId,
            new BN(1000),
            new BN(1000),
            1,
            [jupiterProgramId],
            0,
            100,
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
              dailySpendingCapUsd: new BN(1000),
              maxTransactionSizeUsd: new BN(1000),
              maxSlippageBps: 100,
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
            vault: noTlVault,
            policy: noTlPolicy,
            tracker: noTlTracker,
            agentSpendOverlay: noTlOverlay,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "TimelockTooShort" });
      }
    });

    it("changing timelock_duration itself goes through queue", async () => {
      // Queue a timelock change from 1800 to 3600
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          new BN(3600),
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            timelockDuration: new BN(3600),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.timelockDuration.toNumber()).to.equal(3600);
    });

    it("lowering timelock back to MIN via queue", async () => {
      // Queue timelock change from 3600 back to 1800 (MIN_TIMELOCK_DURATION)
      await program.methods
        .queuePolicyUpdate(
          null,
          null,
          null,
          null,
          null,
          null,
          new BN(1800),
          null,
          null,
          null,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            timelockDuration: new BN(1800),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 3601);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.timelockDuration.toNumber()).to.equal(1800);

      // Verify further updates still require queue/apply. Use a LOWER
      // cap (50_000_000) so TA-09 (Phase 3) elevated-mutation guard does
      // not fire — this assertion exercises queue/apply round-trip on
      // daily_spending_cap_usd, not the cosign workflow.
      await program.methods
        .queuePolicyUpdate(
          new BN(50_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, tlPolicyPda, tlVaultPda, {
            dailySpendingCapUsd: new BN(50_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      const updated = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(updated.dailySpendingCapUsd.toNumber()).to.equal(50_000_000);
    });

    it("revoke_agent bypasses timelock (emergency)", async () => {
      // Timelock is 1800 from previous test — revoke should still work immediately
      // Revoke agent should work immediately (no timelock needed for emergency ops)
      await program.methods
        .revokeAgent(tlAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), tlVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: tlOverlay,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(tlVaultPda);
      expect(JSON.stringify(vault.status)).to.include("frozen");
    });
  });

  // =========================================================================
  // Destination allowlist + agent_transfer
  // =========================================================================
  describe("destination allowlist & agent_transfer", () => {
    const destVaultId = new BN(510);
    let destVaultPda: PublicKey;
    let destOverlay: PublicKey;
    let destPolicyPda: PublicKey;
    let destTrackerPda: PublicKey;
    const destAgent = Keypair.generate();
    const allowedDest = Keypair.generate();
    const blockedDest = Keypair.generate();
    let destVaultUsdcAta: PublicKey;
    // Shared state between the F-4 default-deny test and the OpenWithCap
    // opt-in follow-up test (so we can flip mode on the same vault without
    // re-deploying the deposit + agent registration).
    const sharedAnyDest: {
      vault?: PublicKey;
      policy?: PublicKey;
      tracker?: PublicKey;
      overlay?: PublicKey;
      vaultAta?: PublicKey;
    } = {};
    let allowedDestAta: PublicKey;
    let blockedDestAta: PublicKey;

    before(async () => {
      airdropSol(svm, destAgent.publicKey, 5 * LAMPORTS_PER_SOL);
      airdropSol(svm, allowedDest.publicKey, 2 * LAMPORTS_PER_SOL);
      airdropSol(svm, blockedDest.publicKey, 2 * LAMPORTS_PER_SOL);

      [destVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          destVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [destPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), destVaultPda.toBuffer()],
        program.programId,
      );
      [destTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), destVaultPda.toBuffer()],
        program.programId,
      );

      // Create vault with destination allowlist
      [destOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), destVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await program.methods
        .initializeVault(
          destVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
          [allowedDest.publicKey],
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
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [allowedDest.publicKey],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: destVaultPda,
          policy: destPolicyPda,
          tracker: destTrackerPda,
          agentSpendOverlay: destOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); destAgent does agent_transfer below.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: destVaultPda,
        agent: destAgent.publicKey,
      });

      // Deposit USDC
      destVaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        destVaultPda,
        true,
      );
      await program.methods
        .depositFunds(new BN(600_000_000)) // 600 USDC
        .accounts({
          owner: owner.publicKey,
          vault: destVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: destVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create destination ATAs
      allowedDestAta = createAtaHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        allowedDest.publicKey,
      );
      blockedDestAta = createAtaHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        blockedDest.publicKey,
      );
    });

    it("agent_transfer to allowed destination succeeds", async () => {
      const balBefore = getTokenBalance(svm, allowedDestAta);

      await program.methods
        .agentTransfer(
          new BN(10_000_000),
          ((await program.account.policyConfig.fetch(destPolicyPda))
            .policyVersion as BN) ?? new BN(0),
        ) // 10 USDC
        .accounts({
          agent: destAgent.publicKey,
          vault: destVaultPda,
          policy: destPolicyPda,
          tracker: destTrackerPda,
          agentSpendOverlay: destOverlay,
          vaultTokenAccount: destVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: allowedDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();

      // Transfer is net of fees — protocol fee = 10_000_000 * 200 / 1_000_000 = 2_000
      // developer fee = 0 (rate is 0), so net = 10_000_000 - 2_000 = 9_998_000
      const balAfter = getTokenBalance(svm, allowedDestAta);
      expect(Number(balAfter) - Number(balBefore)).to.equal(9_998_000);
    });

    it("agent_transfer to non-allowed destination fails", async () => {
      try {
        await program.methods
          .agentTransfer(
            new BN(10_000_000),
            ((await program.account.policyConfig.fetch(destPolicyPda))
              .policyVersion as BN) ?? new BN(0),
          )
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            agentSpendOverlay: destOverlay,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: blockedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "DestinationNotAllowed" });
      }
    });

    // F-4 fix: empty allowlist now defaults to Restricted mode (default-deny).
    // Owners must explicitly opt into OpenWithCap via queue+apply to allow any
    // destination. This block exercises both branches.
    it("empty allowlist + default Restricted mode rejects any destination (F-4)", async () => {
      // Create vault with empty allowlist
      const anyDestVaultId = new BN(511);
      const [anyVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          anyDestVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [anyPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), anyVault.toBuffer()],
        program.programId,
      );
      const [anyTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), anyVault.toBuffer()],
        program.programId,
      );
      const [anyOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), anyVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          anyDestVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: anyVault,
          policy: anyPolicy,
          tracker: anyTracker,
          agentSpendOverlay: anyOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper). The agent must be OPERATOR so the
      // agent_transfer below reaches the destination check and fails with
      // DestinationNotAllowed (the F-4 default-deny this test verifies).
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: anyVault,
        agent: destAgent.publicKey,
      });

      const anyVaultAta = getAssociatedTokenAddressSync(
        usdcMint,
        anyVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: anyVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: anyVaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Sanity: default mode is Restricted (0).
      const policy = await program.account.policyConfig.fetch(anyPolicy);
      expect((policy as any).destinationMode).to.equal(0);

      // Under default Restricted mode + empty allowlist, every destination is
      // rejected. This is the F-4 fix: previously this transfer would have
      // succeeded and drained up to the daily cap.
      try {
        await program.methods
          .agentTransfer(
            new BN(5_000_000),
            ((await program.account.policyConfig.fetch(anyPolicy))
              .policyVersion as BN) ?? new BN(0),
          )
          .accounts({
            agent: destAgent.publicKey,
            vault: anyVault,
            policy: anyPolicy,
            tracker: anyTracker,
            agentSpendOverlay: anyOverlay,
            vaultTokenAccount: anyVaultAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: blockedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail(
          "Should have thrown DestinationNotAllowed (F-4 default-deny)",
        );
      } catch (err: any) {
        expectSigilError(err, { name: "DestinationNotAllowed" });
      }

      // Stash for the OpenWithCap follow-up test below.
      (sharedAnyDest as any).vault = anyVault;
      (sharedAnyDest as any).policy = anyPolicy;
      (sharedAnyDest as any).tracker = anyTracker;
      (sharedAnyDest as any).overlay = anyOverlay;
      (sharedAnyDest as any).vaultAta = anyVaultAta;
    });

    // Phase 2 Option A: OpenWithCap mode (destination_mode=1) was deleted.
    // The test now verifies that the queue rejects destination_mode=1 with
    // InvalidDestinationMode (6069), instead of the previous "opt-in to drain"
    // behavior. Companion test "queue with destination_mode=2" below covers
    // the >1 case.
    it("rejects destination_mode=1 (OpenWithCap deleted in Phase 2 Option A)", async () => {
      const anyVault = (sharedAnyDest as any).vault as PublicKey;
      const anyPolicy = (sharedAnyDest as any).policy as PublicKey;
      const [anyPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), anyVault.toBuffer()],
        program.programId,
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
            null,
            null,
            null,
            null,
            null,
            1,
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(program, anyPolicy, anyVault, {
              destinationMode: 1,
            }), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: owner.publicKey,
            vault: anyVault,
            policy: anyPolicy,
            pendingPolicy: anyPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("destination_mode=1 should reject under Phase 2");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidDestinationMode" });
      }
    });

    it("queue with destination_mode=2 (invalid) rejects with InvalidDestinationMode", async () => {
      const anyVault = (sharedAnyDest as any).vault as PublicKey;
      const anyPolicy = (sharedAnyDest as any).policy as PublicKey;
      const [anyPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), anyVault.toBuffer()],
        program.programId,
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
            null,
            null,
            null,
            null,
            null,
            2,
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
            await fetchAndComputeQueueDigest(program, anyPolicy, anyVault, {
              destinationMode: 2,
            }), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: owner.publicKey,
            vault: anyVault,
            policy: anyPolicy,
            pendingPolicy: anyPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown InvalidDestinationMode");
      } catch (err: any) {
        expectSigilError(err, { name: "InvalidDestinationMode" });
      }
    });

    it("too many destinations on init fails", async () => {
      const badVid = new BN(512);
      const [bv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badVid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId,
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId,
      );
      const [bOverlay512] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), bv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Generate 11 destinations (max is 10)
      const tooMany = Array.from(
        { length: 11 },
        () => Keypair.generate().publicKey,
      );

      try {
        await program.methods
          .initializeVault(
            badVid,
            new BN(1000),
            new BN(1000),
            1,
            [jupiterProgramId],
            0,
            100,
            new BN(1800),
            tooMany,
            [],
            false, // observeOnly (Phase 2 TA-19)
            0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
            false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
            5, // auto_revoke_threshold (TA-17 Phase 3 — default)
            new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
            new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
            false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
            initVaultPreviewDigest({
              dailySpendingCapUsd: new BN(1000),
              maxTransactionSizeUsd: new BN(1000),
              maxSlippageBps: 100,
              protocolMode: 1,
              protocols: [jupiterProgramId],
              allowedDestinations: tooMany,
              timelockDuration: new BN(1800),
              operatingHours: 0x00ffffff,
              autoPromoteGrays: false,
              autoRevokeThreshold: 5,
            }),
          )
          .accounts({
            owner: owner.publicKey,
            vault: bv,
            policy: bp,
            tracker: bt,
            agentSpendOverlay: bOverlay512,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "TooManyDestinations" });
      }
    });

    it("agent_transfer respects daily spending cap", async () => {
      // The destVault has 500 USDC daily cap and 100 USDC max-tx.
      // We already spent 10 USDC. Make 4 more transfers of 100 USDC
      // to bring total to 410 USDC, then try 100 USDC which would
      // push total to 510 USDC (exceeding 500 cap).
      for (let i = 0; i < 4; i++) {
        await program.methods
          .agentTransfer(
            new BN(100_000_000),
            ((await program.account.policyConfig.fetch(destPolicyPda))
              .policyVersion as BN) ?? new BN(0),
          ) // 100 USDC each
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            agentSpendOverlay: destOverlay,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
      }
      // Total spent: 10 + 4*100 = 410 USDC. Remaining: 90 USDC.
      // Try 100 USDC → total would be 510 > 500 cap
      try {
        await program.methods
          .agentTransfer(
            new BN(100_000_000),
            ((await program.account.policyConfig.fetch(destPolicyPda))
              .policyVersion as BN) ?? new BN(0),
          ) // 100 USDC (would push past cap)
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            agentSpendOverlay: destOverlay,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "SpendingCapExceeded" });
      }
    });

    it("agent_transfer respects per-tx limit", async () => {
      // Max tx size is 100 USDC
      try {
        await program.methods
          .agentTransfer(
            new BN(101_000_000),
            ((await program.account.policyConfig.fetch(destPolicyPda))
              .policyVersion as BN) ?? new BN(0),
          ) // 101 USDC (exceeds max tx)
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            agentSpendOverlay: destOverlay,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "TransactionTooLarge" });
      }
    });

    it("agent_transfer records in tracker", async () => {
      const tracker = await program.account.spendTracker.fetch(destTrackerPda);
      // V2: spending recorded in epoch buckets
      const nonZeroBuckets = tracker.buckets.filter(
        (b: any) => b.usdAmount.toNumber() > 0,
      );
      expect(nonZeroBuckets.length).to.be.greaterThan(0);
    });

    it("agent_transfer with fees (protocol + developer)", async () => {
      // Create a vault with developer fee
      const feeDestVaultId = new BN(513);
      const [fv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeDestVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [fp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), fv.toBuffer()],
        program.programId,
      );
      const [ft] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), fv.toBuffer()],
        program.programId,
      );
      const [fvOverlay2] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), fv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          feeDestVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          500,
          100,
          new BN(1800),
          [allowedDest.publicKey],
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
            maxSlippageBps: 100,
            developerFeeRate: 500, // PEN-CROSS-6: must match the ix arg.
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [allowedDest.publicKey],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          agentSpendOverlay: fvOverlay2,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper); destAgent does a fee-bearing
      // agent_transfer below.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: fv,
        agent: destAgent.publicKey,
      });

      const fvAta = getAssociatedTokenAddressSync(usdcMint, fv, true);
      await program.methods
        .depositFunds(new BN(100_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: fvAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create fee dest ATA if needed
      try {
        feeDestUsdcAta = createAtaHelper(
          svm,
          (owner as any).payer,
          usdcMint,
          feeDestination.publicKey,
        );
      } catch {
        feeDestUsdcAta = getAssociatedTokenAddressSync(
          usdcMint,
          feeDestination.publicKey,
        );
      }

      const destBalBefore = getTokenBalance(svm, allowedDestAta);
      const feeDestBalBefore = getTokenBalance(svm, feeDestUsdcAta);

      // Transfer 10 USDC with fees
      // protocol_fee = 10_000_000 * 200 / 1_000_000 = 2_000
      // developer_fee = 10_000_000 * 500 / 1_000_000 = 5_000
      // net = 10_000_000 - 2_000 - 5_000 = 9_993_000
      await program.methods
        .agentTransfer(
          new BN(10_000_000),
          ((await program.account.policyConfig.fetch(fp))
            .policyVersion as BN) ?? new BN(0),
        )
        .accounts({
          agent: destAgent.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          agentSpendOverlay: fvOverlay2,
          vaultTokenAccount: fvAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: allowedDestAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();

      const destBalAfter = getTokenBalance(svm, allowedDestAta);
      expect(Number(destBalAfter) - Number(destBalBefore)).to.equal(9_993_000);

      // Check vault fees (developer fee only)
      const vault = await program.account.agentVault.fetch(fv);
      expect(vault.totalFeesCollected.toNumber()).to.equal(5_000);

      // #26: Verify fee destination ATA actually received the developer fee (not just tracked in vault)
      const feeDestBalAfter = getTokenBalance(svm, feeDestUsdcAta);
      expect(feeDestBalAfter - feeDestBalBefore).to.equal(5_000n);
    });
  });

  // =========================================================================
  // Multi-agent vaults (Task A4.2)
  // =========================================================================
  describe("multi-agent vaults", () => {
    const maVaultId = new BN(700);
    let maVault: PublicKey;
    let maPolicy: PublicKey;
    let maTracker: PublicKey;
    let maOverlay: PublicKey;
    const agent2 = Keypair.generate();
    let maVaultUsdcAta: PublicKey;

    before(async () => {
      airdropSol(svm, agent2.publicKey, 10 * LAMPORTS_PER_SOL);

      [maVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          maVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [maPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), maVault.toBuffer()],
        program.programId,
      );
      [maTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), maVault.toBuffer()],
        program.programId,
      );
      [maOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), maVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          maVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1_000_000_000),
            maxTransactionSizeUsd: new BN(500_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          agentSpendOverlay: maOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      maVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        maVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(500_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: maVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("registers 2 agents with different capabilities", async () => {
      // Agent 1: viewer (capability = 1)
      await program.methods
        .registerAgent(agent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), maVault.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: maOverlay,
        } as any)
        .rpc();

      // Agent 2: full capability (operator).
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper). agent2 is registered second, so it lands
      // at agents[1] as OPERATOR — the capability assertion below still holds.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: maVault,
        agent: agent2.publicKey,
      });

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(2);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
      );
      expect(vault.agents[0].capability).to.equal(VIEWER_CAPABILITY);
      expect(vault.agents[1].pubkey.toString()).to.equal(
        agent2.publicKey.toString(),
      );
      expect(vault.agents[1].capability).to.equal(FULL_CAPABILITY);
    });

    it("agent with Observer capability succeeds with zero amount (non-spending)", async () => {
      const [session] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          maVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(0), // non-spending for Observer
          jupiterProgramId,
          await pv(maPolicy),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: maVault,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(0),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accounts({
          agent: agent.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          session,
          vaultTokenAccount: maVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: maOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .signers([agent])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accounts({
          payer: agent.publicKey,
          vault: maVault,
          session,
          sessionRentRecipient: agent.publicKey,
          policy: maPolicy,
          tracker: maTracker,
          vaultTokenAccount: maVaultUsdcAta,
          agentSpendOverlay: maOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        } as any)
        .signers([agent])
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("observer agent spending denied → InsufficientPermissions", async () => {
      // Agent 1 has Observer capability (1), spending requires Operator (2)
      const [session] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          maVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(1_000_000),
          jupiterProgramId,
          await pv(maPolicy),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: maVault,
              agent: agent.publicKey,
              tokenMint: usdcMint,
              amount: new BN(1_000_000),
              targetProtocol: jupiterProgramId,
            }),
          ),
        )
        .accounts({
          agent: agent.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          session,
          vaultTokenAccount: maVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          agentSpendOverlay: maOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .signers([agent])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accounts({
          payer: agent.publicKey,
          vault: maVault,
          session,
          sessionRentRecipient: agent.publicKey,
          policy: maPolicy,
          tracker: maTracker,
          vaultTokenAccount: maVaultUsdcAta,
          agentSpendOverlay: maOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        } as any)
        .signers([agent])
        .instruction();

      try {
        sendVersionedTx(svm, [validateIx, finalizeIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "InsufficientPermissions" });
      }
    });

    it("revoke 1 of 2 agents — vault stays Active", async () => {
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), maVault.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: maOverlay,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(1);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent2.publicKey.toString(),
      );
      expect(vault.status).to.have.property("active");
    });

    it("revoke last agent — vault Frozen", async () => {
      await program.methods
        .revokeAgent(agent2.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), maVault.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: maOverlay,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(0);
      expect(vault.status).to.have.property("frozen");
    });

    it("register up to 10 agents — succeeds", async () => {
      // Phase 8 Batch 5: prior it() froze vault via last-agent revoke;
      // advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      // Reactivate first.
      // F-Q6: reactivate with VIEWER (single-key vault cannot grant OPERATOR
      // instantly). This test asserts only the agent COUNT (10), not their
      // capabilities, so VIEWER is the minimal correct fix and skips the
      // OPERATOR tier gate + NH-1 cosigner requirement.
      await program.methods
        .reactivateVault(agent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      // Register 9 more (total 10 with the agent from reactivate).
      // F-Q6: these filler agents only exercise the MAX_AGENTS count path and
      // never spend — VIEWER avoids the OPERATOR-grant timelock. The test
      // asserts only the agent count (10), not their capabilities.
      for (let i = 0; i < 9; i++) {
        const a = Keypair.generate();
        airdropSol(svm, a.publicKey, LAMPORTS_PER_SOL);
        await program.methods
          .registerAgent(a.publicKey, VIEWER_CAPABILITY, new BN(0))
          .accounts({
            owner: owner.publicKey,
            vault: maVault,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), maVault.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: maOverlay,
          } as any)
          .rpc();
      }

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(10);
    });

    it("11th agent → MaxAgentsReached (6038)", async () => {
      const extra = Keypair.generate();
      try {
        // F-Q6: use VIEWER_CAPABILITY so the OPERATOR-grant timelock check
        // (6107) does not pre-empt the MaxAgentsReached check this test
        // targets. The vault is already at MAX_AGENTS, so registration is
        // rejected for being full regardless of the capability arg.
        await program.methods
          .registerAgent(extra.publicKey, VIEWER_CAPABILITY, new BN(0))
          .accounts({
            owner: owner.publicKey,
            vault: maVault,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), maVault.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: maOverlay,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "MaxAgentsReached" });
      }
    });

    it("reactivate with new agent + capability", async () => {
      // First freeze by revoking all 10 agents
      const vault10 = await program.account.agentVault.fetch(maVault);
      for (const a of vault10.agents) {
        await program.methods
          .revokeAgent(a.pubkey)
          .accounts({
            owner: owner.publicKey,
            vault: maVault,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), maVault.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: maOverlay,
          } as any)
          .rpc();
      }

      const newAgent = Keypair.generate();

      // Phase 8 Batch 5: advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      await program.methods
        .reactivateVault(newAgent.publicKey, VIEWER_CAPABILITY)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(1);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        newAgent.publicKey.toString(),
      );
      expect(vault.agents[0].capability).to.equal(VIEWER_CAPABILITY);
      expect(vault.status).to.have.property("active");
    });

    it("update agent capability via queue+apply (owner-only)", async () => {
      // Register a fresh agent for this test
      const updAgent = Keypair.generate();
      airdropSol(svm, updAgent.publicKey, LAMPORTS_PER_SOL);
      await program.methods
        .registerAgent(updAgent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), maVault.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: maOverlay,
        } as any)
        .rpc();

      // Derive pending agent perms PDA: seeds = ["pending_agent_perms", vault, agent]
      const [pendingAgentPermsPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("pending_agent_perms"),
          maVault.toBuffer(),
          updAgent.publicKey.toBuffer(),
        ],
        program.programId,
      );

      // Queue capability update
      await program.methods
        .queueAgentPermissionsUpdate(
          updAgent.publicKey,
          FULL_CAPABILITY,
          new BN(0),
          new BN(0), // cooldown_seconds (TA-06 Phase 3 — disabled)
          PublicKey.default, // cosign_session (F-RP3-2: default = no cosign)
        )
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: maPolicy,
          pendingAgentPerms: pendingAgentPermsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 1801);

      // Apply pending capability update
      await program.methods
        .applyAgentPermissionsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: maPolicy,
          pendingAgentPerms: pendingAgentPermsPda,
          agentSpendOverlay: maOverlay,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      const entry = vault.agents.find(
        (a: any) => a.pubkey.toString() === updAgent.publicKey.toString(),
      );
      expect(entry).to.not.be.undefined;
      expect(entry!.capability).to.equal(FULL_CAPABILITY);
    });

    it("invalid capability value → InvalidCapability (6070, Phase 2 TA-04)", async () => {
      const badAgent = Keypair.generate();
      try {
        await program.methods
          .registerAgent(badAgent.publicKey, BAD_CAPABILITY, new BN(0))
          .accounts({
            owner: owner.publicKey,
            vault: maVault,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), maVault.toBuffer()],
              program.programId,
            )[0],
            agentSpendOverlay: maOverlay,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 2 TA-04 replaced the generic `InvalidPermissions` with the
        // specific `InvalidCapability` so callers can distinguish "bad
        // capability value" from other permission errors.
        expectSigilError(err, { name: "InvalidCapability" });
      }
    });
  });

  // =========================================================================
  // Multi-epoch per-agent spend tracking
  // =========================================================================
  describe("multi-epoch per-agent spend tracking", () => {
    const epochVaultId = new BN(800);
    let epochVault: PublicKey;
    let epochPolicy: PublicKey;
    let epochTracker: PublicKey;
    let epochOverlay: PublicKey;
    const epochAgent = Keypair.generate();
    let epochVaultUsdcAta: PublicKey;
    let epochDestAta: PublicKey;
    const epochDest = Keypair.generate();

    before(async () => {
      airdropSol(svm, epochAgent.publicKey, 10 * LAMPORTS_PER_SOL);
      airdropSol(svm, epochDest.publicKey, 2 * LAMPORTS_PER_SOL);

      // Mint fresh USDC for this test suite (previous tests may have consumed the initial supply)
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        ownerUsdcAta,
        owner.publicKey,
        2_000_000_000n, // 2000 USDC
      );

      [epochVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          epochVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [epochPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), epochVault.toBuffer()],
        program.programId,
      );
      [epochTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), epochVault.toBuffer()],
        program.programId,
      );
      [epochOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), epochVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Create vault with $2000 daily cap, $1000 per-tx limit
      await program.methods
        .initializeVault(
          epochVaultId,
          new BN(2_000_000_000),
          new BN(1_000_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
          [epochDest.publicKey],
          [],
          false, // observeOnly (Phase 2 TA-19)
          0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
          false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
          5, // auto_revoke_threshold (TA-17 Phase 3 — default)
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
          false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
          initVaultPreviewDigest({
            dailySpendingCapUsd: new BN(2_000_000_000),
            maxTransactionSizeUsd: new BN(1_000_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [epochDest.publicKey],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent with $1000 per-agent spend limit.
      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper). The per-agent spend limit is carried
      // through queue_agent_grant via spendingLimitUsd so the multi-epoch
      // tracking assertions below remain valid.
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: epochVault,
        agent: epochAgent.publicKey,
        spendingLimitUsd: new BN(1_000_000_000),
      });

      // Deposit USDC
      epochVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        epochVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(1_500_000_000)) // 1500 USDC
        .accounts({
          owner: owner.publicKey,
          vault: epochVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create destination ATA
      epochDestAta = createAtaHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        epochDest.publicKey,
      );
    });

    it("accumulates spend across multiple epochs (catches old bug)", async () => {
      // Epoch 0: spend $500
      await program.methods
        .agentTransfer(
          new BN(500_000_000),
          ((await program.account.policyConfig.fetch(epochPolicy))
            .policyVersion as BN) ?? new BN(0),
        )
        .accounts({
          agent: epochAgent.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: epochDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([epochAgent])
        .rpc();

      // Advance clock by 1 hour (1 overlay epoch)
      advanceTime(svm, 3600);

      // Epoch 1: spend $300
      await program.methods
        .agentTransfer(
          new BN(300_000_000),
          ((await program.account.policyConfig.fetch(epochPolicy))
            .policyVersion as BN) ?? new BN(0),
        )
        .accounts({
          agent: epochAgent.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: epochDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([epochAgent])
        .rpc();

      // At this point, rolling 24h total should be $800 (500 + 300).
      // The OLD bug would show only $300 because sync_and_zero_if_stale
      // would zero the epoch-0 bucket when writing epoch-1.
      // We verify by trying to spend $250 more — total would be $1050 which
      // exceeds the $1000 per-agent limit.
      try {
        await program.methods
          .agentTransfer(
            new BN(250_000_000),
            ((await program.account.policyConfig.fetch(epochPolicy))
              .policyVersion as BN) ?? new BN(0),
          )
          .accounts({
            agent: epochAgent.publicKey,
            vault: epochVault,
            policy: epochPolicy,
            tracker: epochTracker,
            agentSpendOverlay: epochOverlay,
            vaultTokenAccount: epochVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: epochDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([epochAgent])
          .rpc();
        expect.fail("Should have exceeded per-agent spend limit");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentSpendLimitExceeded" });
      }

      // But spending $150 (total = $950 < $1000) should succeed
      await program.methods
        .agentTransfer(
          new BN(150_000_000),
          ((await program.account.policyConfig.fetch(epochPolicy))
            .policyVersion as BN) ?? new BN(0),
        )
        .accounts({
          agent: epochAgent.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: epochDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([epochAgent])
        .rpc();
    });

    it("expired epochs drop from rolling total after 24h", async () => {
      // Advance clock by 23 more hours (total ~24h from first spend).
      // The epoch-0 $500 should expire from the rolling window.
      advanceTime(svm, 23 * 3600);

      // After 24h, only epoch-1's $300 + epoch-1's $150 should remain.
      // The $500 from epoch-0 has expired.
      // Total rolling: $450 (300 + 150 from ~23h ago).
      // Spending $500 more (total ~$950) should succeed since $500 expired.
      await program.methods
        .agentTransfer(
          new BN(100_000_000),
          ((await program.account.policyConfig.fetch(epochPolicy))
            .policyVersion as BN) ?? new BN(0),
        ) // $100 — safe amount to verify window works
        .accounts({
          agent: epochAgent.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: epochDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([epochAgent])
        .rpc();

      // Advance 1 more hour — all previous spends are now >24h ago
      advanceTime(svm, 3600);

      // Now everything should be expired. Spending $999 (under $1000 limit) should succeed
      // even though we've spent $1050 total historically.
      await program.methods
        .agentTransfer(
          new BN(100_000_000),
          ((await program.account.policyConfig.fetch(epochPolicy))
            .policyVersion as BN) ?? new BN(0),
        ) // $100
        .accounts({
          agent: epochAgent.publicKey,
          vault: epochVault,
          policy: epochPolicy,
          tracker: epochTracker,
          agentSpendOverlay: epochOverlay,
          vaultTokenAccount: epochVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: epochDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([epochAgent])
        .rpc();
    });
  });

  // =========================================================================
  // per-protocol spend caps
  // =========================================================================
  describe("per-protocol spend caps", () => {
    const protoCapOwner = Keypair.generate();
    const protoCapAgent = Keypair.generate();
    const protoCapFee = Keypair.generate();
    // F-Q2 migration: per-protocol caps charge `actual_spend` (the measured
    // vault-ATA balance delta at finalize), so the sandwich's middle ix must
    // be a REAL fund-moving drain whose program == the authorized
    // target_protocol (the cap keys off `session.authorized_protocol`). The two
    // protocols must therefore be the two LOADED mock programs (MOCK_DEFI +
    // MOCK_DEFI_2), not arbitrary pubkeys — an arbitrary pubkey is not an
    // executable program, so a drain ix targeting it would fail to invoke.
    // protocolA = MOCK_DEFI (single-protocol tests), protocolB = MOCK_DEFI_2
    // (the "other protocol still has room" independence test).
    const protocolA = MOCK_DEFI_PROGRAM_ID;
    const protocolB = MOCK_DEFI_2_PROGRAM_ID;
    const protoCapVaultId = new BN(900);
    // Drain destination — a fresh-keypair USDC ATA. The destination need NOT be
    // allowlisted: validate's destination check (destination_check.rs) is
    // resolve-required, not allowlist-required — a resolved, non-allowlisted
    // token account is treated as a transient route hop and SKIPPED. It must,
    // however, be passed in validate's remaining_accounts (else
    // DestinationAccountUnresolvable).
    const protoCapDrainDest = Keypair.generate();
    let pcDrainDestUsdc: PublicKey;
    // G3a audit fix (§RP-2 2026-05-18 HIGH-1): protocol_caps weakening
    // (any cap → 0, or any cap raised, or has_protocol_caps → false) is
    // now classified as an elevated mutation by queue_policy_update. The
    // tests in this describe exercise documented "0 = unlimited" semantics
    // and master-switch disable — both weakenings that now require cosign.
    const protoCapCosigner = Keypair.generate();
    let pcVault: PublicKey;
    let pcPolicy: PublicKey;
    let pcTracker: PublicKey;
    let pcOverlay: PublicKey;
    let pcOwnerUsdc: PublicKey;
    let pcVaultUsdc: PublicKey;
    let pcFeeUsdc: PublicKey;
    // M1 output-ownership: a non-USDC mint a spend "acquires" into a
    // vault-owned ATA, so finalize's mandatory output gate (6112) is satisfied
    // while the per-protocol cap still charges the USDC outflow (actual_spend).
    let pcOutputMint: PublicKey;
    let pcVaultOutputAta: PublicKey;
    let pcAgentOutputReserve: PublicKey;

    before(async () => {
      airdropSol(svm, protoCapOwner.publicKey, 100 * LAMPORTS_PER_SOL);
      airdropSol(svm, protoCapAgent.publicKey, 10 * LAMPORTS_PER_SOL);
      airdropSol(svm, protoCapFee.publicKey, 2 * LAMPORTS_PER_SOL);

      pcOwnerUsdc = createAtaHelper(
        svm,
        protoCapOwner,
        usdcMint,
        protoCapOwner.publicKey,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        pcOwnerUsdc,
        owner.publicKey,
        10_000_000_000n,
      );
      pcFeeUsdc = createAtaHelper(
        svm,
        protoCapFee,
        usdcMint,
        protoCapFee.publicKey,
      );

      [pcVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          protoCapOwner.publicKey.toBuffer(),
          protoCapVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [pcPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), pcVault.toBuffer()],
        program.programId,
      );
      [pcTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), pcVault.toBuffer()],
        program.programId,
      );
      [pcOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), pcVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      pcVaultUsdc = createAtaHelper(
        svm,
        protoCapOwner,
        usdcMint,
        pcVault,
        true,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        pcVaultUsdc,
        owner.publicKey,
        5_000_000_000n,
      );

      // Drain destination ATA (receives the drained USDC each spend). Owner is
      // a throwaway keypair — intentionally NOT in allowed_destinations (the
      // sink-scoped check skips non-allowlisted route hops; see comment at the
      // protoCapDrainDest declaration).
      pcDrainDestUsdc = createAtaHelper(
        svm,
        protoCapOwner,
        usdcMint,
        protoCapDrainDest.publicKey,
      );

      // M1: a non-USDC output mint, a vault-owned ATA to receive it (the
      // acquisition the finalize gate verifies increased), and an agent-owned
      // reserve to fund the swap's output leg (test-only — a real swap sources
      // output from a pool).
      pcOutputMint = Keypair.generate().publicKey;
      createMintAtAddress(svm, pcOutputMint, owner.publicKey, 6);
      pcVaultOutputAta = createAtaHelper(
        svm,
        protoCapOwner,
        pcOutputMint,
        pcVault,
        true,
      );
      pcAgentOutputReserve = createAtaHelper(
        svm,
        protoCapOwner,
        pcOutputMint,
        protoCapAgent.publicKey,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        pcOutputMint,
        pcAgentOutputReserve,
        owner.publicKey,
        1_000_000_000n,
      );

      // Initialize vault with 2 protocols + per-protocol caps:
      // protocolA: 100 USDC cap, protocolB: 200 USDC cap
      // Global cap: 1000 USDC, Max tx: 500 USDC
      //
      // G6 §RP-2 P2 supplementary (2026-05-18): vault opted IN to cosign so
      // the `cap of 0 means unlimited` and `caps disabled` tests below
      // (which weaken protocol_caps) GENUINELY exercise the G6 elevation
      // gate. Previously those tests passed protoCapCosigner decoratively —
      // `policy.cosign_required = false` made the handler take the
      // non-elevated fallback. After the flip, removing protoCapCosigner
      // from those tests WOULD trip ErrCosignRequired.
      await program.methods
        .initializeVault(
          protoCapVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          1,
          [protocolA, protocolB],
          0,
          100,
          new BN(1800),
          [],
          [new BN(100_000_000), new BN(200_000_000)],
          false, // observeOnly (Phase 2 TA-19)
          0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
          false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
          5, // auto_revoke_threshold (TA-17 Phase 3 — default)
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
          false, // take-over 2026-06-16: init cosign-OFF; enabled+bound below via queue
          initVaultPreviewDigest({
            dailySpendingCapUsd: new BN(1_000_000_000),
            maxTransactionSizeUsd: new BN(500_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [protocolA, protocolB],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
            // take-over: cosign-OFF at init (enabled below via queue).
            cosignRequired: false,
            // M-1 (audit 2026-06-11): vault is initialized WITH per-protocol
            // caps [100, 200] USDC (see initializeVault arg above); bind the
            // SAME slice into the preview digest, else PolicyPreviewMismatch.
            protocolCaps: [new BN(100_000_000), new BN(200_000_000)],
          }),
        )
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          agentSpendOverlay: pcOverlay,
          feeDestination: protoCapFee.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([protoCapOwner])
        .rpc();

      // Take-over 2026-06-16: cosign can't be enabled at init; enable+bind
      // protoCapCosigner via queue->apply so the elevated FULL_CAPABILITY grant
      // and the weaken-protocol-caps queues below run on a cosign-BOUND vault.
      {
        const [pcPending] = PublicKey.findProgramAddressSync(
          [Buffer.from("pending_policy"), pcVault.toBuffer()],
          program.programId,
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
            protoCapCosigner.publicKey,
            null,
            PublicKey.default,
            await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {
              cosignRequired: true,
              cosignSessionPubkey: protoCapCosigner.publicKey,
            }),
          )
          .accounts({
            owner: protoCapOwner.publicKey,
            vault: pcVault,
            policy: pcPolicy,
            pendingPolicy: pcPending,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([protoCapOwner])
          .rpc();
        advanceTime(svm, 1801);
        await program.methods
          .applyPendingPolicy()
          .accounts({
            owner: protoCapOwner.publicKey,
            vault: pcVault,
            policy: pcPolicy,
            tracker: pcTracker,
            pendingPolicy: pcPending,
          } as any)
          .signers([protoCapOwner])
          .rpc();
      }

      // Phase 8 PEN-CROSS-1 migration: register_agent now rejects
      // CAPABILITY_OPERATOR direct grants on cosign-opted vaults. Migrate
      // the FULL_CAPABILITY grant through queue_agent_grant + advance
      // timelock + apply_agent_grant.
      const [pendingAgentGrantPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_agent_grant"), pcVault.toBuffer()],
        program.programId,
      );

      await program.methods
        .queueAgentGrant(protoCapAgent.publicKey, FULL_CAPABILITY, new BN(0))
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pending: pendingAgentGrantPda,
        } as any)
        .remainingAccounts([
          {
            pubkey: protoCapCosigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([protoCapOwner, protoCapCosigner])
        .rpc();

      // Phase 8 §RP Fix-Up B (PEN-02a CRITICAL): PendingAgentGrant default
      // timelock raised from MIN_TIMELOCK_DURATION (1800s) to
      // PendingAgentGrant::DEFAULT_MIN_DELAY (172_800s / 48h) to match
      // ownership transfer's observation window.
      advanceTime(svm, 172_801);

      await program.methods
        .applyAgentGrant()
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pending: pendingAgentGrantPda,
          agentSpendOverlay: pcOverlay,
        } as any)
        // H-1 close (audit 2026-05-25): policy.cosign_required=true + a
        // bound cosign_session_pubkey at queue time requires the apply
        // tx to include the same cosigner as a signer in
        // remainingAccounts. Defends against the joint-compromise +
        // cosign-rotation attack class — see apply_agent_grant.rs
        // docstring.
        .remainingAccounts([
          {
            pubkey: protoCapCosigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([protoCapOwner, protoCapCosigner])
        .rpc();
    });

    // Helper to build validate+finalize composed TX
    const composeSpend = async (protocol: PublicKey, amount: BN) => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          pcVault.toBuffer(),
          protoCapAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          amount,
          protocol,
          await pv(pcPolicy),
          new BN(0),
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: pcVault,
              agent: protoCapAgent.publicKey,
              tokenMint: usdcMint,
              amount,
              targetProtocol: protocol,
            }),
          ),
        )
        .accountsPartial({
          agent: protoCapAgent.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          session: sessionPda,
          vaultTokenAccount: pcVaultUsdc,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: pcVaultOutputAta,
          agentSpendOverlay: pcOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: the drain ix's writable metas (source vault ATA +
        // drain destination) plus the agent fee-payer (writable in the compiled
        // v0 message) must be resolvable in validate's remaining_accounts, or
        // validate rejects with DestinationAccountUnresolvable. Passed
        // read-only here — they are resolved/classified, not authorized.
        .remainingAccounts([
          { pubkey: pcVaultUsdc, isSigner: false, isWritable: false },
          { pubkey: pcDrainDestUsdc, isSigner: false, isWritable: false },
          { pubkey: pcAgentOutputReserve, isSigner: false, isWritable: false },
          { pubkey: pcVaultOutputAta, isSigner: false, isWritable: false },
          {
            pubkey: protoCapAgent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      // Real fund-moving DeFi ix: drain `amount` USDC out of the vault to the
      // throwaway destination, using the agent's validate-time SPL delegation.
      // The drain's program MUST equal the authorized target_protocol (the cap
      // keys off session.authorized_protocol), so route through MOCK_DEFI_2's
      // builder when targeting protocolB, else MOCK_DEFI's. This makes
      // `actual_spend == amount` at finalize so the per-protocol cap genuinely
      // charges (a no-op would move 0 and the cap would never fire).
      const drainAmount = netDrainAmount(amount);
      // M1: model a real ACQUIRING swap (not a bare drain) — pull `drainAmount`
      // USDC out of the vault AND deliver a tiny amount of a DIFFERENT mint into
      // the vault-owned output ATA, satisfying finalize's mandatory
      // output-ownership gate (6112). The per-protocol cap still charges
      // `actual_spend` (= the USDC outflow). `programId == protocol` so the cap
      // keys off the correct authorized_protocol.
      const drainIx = buildMockSwapToVaultIx(
        pcVaultUsdc,
        pcDrainDestUsdc,
        pcAgentOutputReserve,
        pcVaultOutputAta,
        protoCapAgent.publicKey,
        drainAmount,
        new BN(1_000),
        protocol,
      );

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: protoCapAgent.publicKey,
          vault: pcVault,
          session: sessionPda,
          sessionRentRecipient: protoCapAgent.publicKey,
          policy: pcPolicy,
          tracker: pcTracker,
          vaultTokenAccount: pcVaultUsdc,
          agentSpendOverlay: pcOverlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: pcVaultOutputAta,
        })
        .instruction();

      return sendVersionedTx(
        svm,
        [validateIx, drainIx, finalizeIx],
        protoCapAgent,
      );
    };

    it("happy path: spend under protocol cap succeeds", async () => {
      // Spend 50 USDC on protocolA (cap: 100) — should succeed.
      // composeSpend returns Promise<VersionedTxResult> (uses await on
      // .instruction() internally). Must await to surface tx rejection.
      await composeSpend(protocolA, new BN(50_000_000));
    });

    it("over-cap spend on a protocol reverts ErrDailyCapExceeded (F-Q2 review F1)", async () => {
      // Coverage gap closed: this describe otherwise only proves under-cap
      // success + bypass. protocolA cap = 100 USDC; a 150 USDC spend (net
      // ~149.97 after the 0.02% fee) exceeds it at finalize → a GENUINE
      // per-protocol revert (149.97 alone > 100, so it reverts regardless of
      // the ~50 already in the rolling counter from the happy path).
      try {
        await composeSpend(protocolA, new BN(150_000_000));
        expect.fail("over-cap spend must revert (per-protocol cap exceeded)");
      } catch (err: any) {
        if (err?.message?.startsWith("over-cap spend must revert")) throw err;
        expectSigilError(err, { name: "ErrDailyCapExceeded" });
      }
    });

    it("other protocol still has room", async () => {
      // ProtocolA is near cap, but protocolB has 200 USDC cap with 0 spent
      await composeSpend(protocolB, new BN(150_000_000));
    });

    it("cap of 0 means unlimited per-protocol", async () => {
      const [pcPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), pcVault.toBuffer()],
        program.programId,
      );

      // Update protocolA cap to 0 (unlimited).
      // G3a audit fix (§RP-2 2026-05-18 HIGH-1): live cap = 100_000_000;
      // proposing 0 disables enforcement for protocolA → ELEVATED weakening,
      // TA-09 cosign required.
      // G6 §RP-2 P2 supplementary (2026-05-18): pcVault was flipped to
      // `cosignRequired: true` at init — this `weakens_protocol_caps` queue
      // now GENUINELY exercises the G6 elevation gate.
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
          true,
          [new BN(0), new BN(200_000_000)],
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 — pass-through; live=true after §RP-2 P2 flip at vault init)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          protoCapCosigner.publicKey, // cosign_session (TA-09 — ELEVATED, weakens_protocol_caps on cosign-opted-in vault)
          await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {
            hasProtocolCaps: true,
            protocolCaps: [new BN(0), new BN(200_000_000)],
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          {
            pubkey: protoCapCosigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([protoCapOwner, protoCapCosigner])
        .rpc();

      advanceTime(svm, 1801);

      // ASYNC COSIGN (2026-06-17): bound cosigner approves the elevated
      // (weakens_protocol_caps) pending before apply (queue is now owner-only).
      await program.methods
        .approvePendingPolicy()
        .accounts({
          cosigner: protoCapCosigner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapCosigner])
        .rpc();

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapOwner])
        .rpc();

      // Now spend any amount on protocolA — should succeed (cap=0 means unlimited)
      await composeSpend(protocolA, new BN(200_000_000));

      // Restore caps.
      // G3a (§RP-2): protocolA cap moves from 0 (unlimited live) to 100_000_000
      // — that's a TIGHTENING (live=0 means already unlimited, no weakening
      // possible). Non-elevated, no cosign needed.
      // G6 §RP-2 P2 supplementary (2026-05-18): pcVault now has live=true
      // for cosign_required but the 7 elevation triggers all evaluate false
      // here (tightening only) and disables_cosign is false, so is_elevated
      // remains false. No cosign needed despite live=true.
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
          true,
          [new BN(100_000_000), new BN(200_000_000)],
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 — pass-through; live=true but no elevation trigger fires)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated, tightening)
          await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {
            hasProtocolCaps: true,
            protocolCaps: [new BN(100_000_000), new BN(200_000_000)],
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([protoCapOwner])
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapOwner])
        .rpc();
    });

    it("window expiry resets per-protocol spend", async () => {
      // Advance time by 24h+ (144 epochs x 600s = 86400s)
      advanceTime(svm, 87000);

      // After window expiry, protocolA spend resets to 0. Can spend up to cap again.
      await composeSpend(protocolA, new BN(90_000_000));
    });

    it("caps disabled means no per-protocol checks", async () => {
      const [pcPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), pcVault.toBuffer()],
        program.programId,
      );

      // Disable per-protocol caps.
      // G3a audit fix (§RP-2 2026-05-18 HIGH-1): has_protocol_caps: false
      // disables the master switch → ELEVATED weakening, TA-09 cosign required.
      // G6 §RP-2 P2 supplementary (2026-05-18): pcVault was flipped to
      // `cosignRequired: true` at init — this `weakens_protocol_caps`
      // (master-switch disable) now GENUINELY exercises the G6 elevation gate.
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
          false,
          null,
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 — pass-through; live=true after §RP-2 P2 flip at vault init)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          protoCapCosigner.publicKey, // cosign_session (TA-09 — ELEVATED, weakens_protocol_caps via has_protocol_caps=false on cosign-opted-in vault)
          await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {
            hasProtocolCaps: false,
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          {
            pubkey: protoCapCosigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([protoCapOwner, protoCapCosigner])
        .rpc();

      advanceTime(svm, 1801);

      // ASYNC COSIGN (2026-06-17): bound cosigner approves the elevated
      // (weakens_protocol_caps via has_protocol_caps=false) pending before apply.
      await program.methods
        .approvePendingPolicy()
        .accounts({
          cosigner: protoCapCosigner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapCosigner])
        .rpc();

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapOwner])
        .rpc();

      // Even though we spent near cap on protocolA, with caps disabled it should succeed
      await composeSpend(protocolA, new BN(200_000_000));

      // Re-enable caps for next test.
      // G3a (§RP-2): has_protocol_caps: true (live=false) is NOT a weakening
      // (the predicate triggers only on `has_protocol_caps: false`). The new
      // protocol_caps [100M, 200M] vs live [] (cleared) — live_cap=0 at every
      // index → unlimited → no weakening. Non-elevated, no cosign needed.
      // G6 §RP-2 P2 supplementary (2026-05-18): pcVault has live=true but no
      // elevation trigger fires here, so is_elevated remains false.
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
          true,
          [new BN(100_000_000), new BN(200_000_000)],
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 — pass-through; live=true but no elevation trigger fires)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated, tightening)
          await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {
            hasProtocolCaps: true,
            protocolCaps: [new BN(100_000_000), new BN(200_000_000)],
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
        )
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          pendingPolicy: pcPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([protoCapOwner])
        .rpc();

      advanceTime(svm, 1801);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: protoCapOwner.publicKey,
          vault: pcVault,
          policy: pcPolicy,
          tracker: pcTracker,
          pendingPolicy: pcPendingPda,
        } as any)
        .signers([protoCapOwner])
        .rpc();
    });

    it("protocol_caps length mismatch rejects (ProtocolCapsMismatch)", async () => {
      const [pcPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), pcVault.toBuffer()],
        program.programId,
      );
      // Try to set protocol_caps with wrong length (1 cap for 2 protocols).
      // G6 §RP-2 P2 supplementary (2026-05-18): pcVault has cosign_required=true
      // but ProtocolCapsMismatch fires BEFORE the elevation check (handler
      // queue_policy_update.rs:177-196 runs before line 245 elevation logic),
      // so cosign session is moot — the basic validation rejects first.
      try {
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
            true,
            [new BN(100_000_000)],
            null,
            null, // operating_hours (TA-05 Phase 3)
            null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
            null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
            null, // cosign_required (G6 — pass-through; mismatch fires before elevation check)
            null,
            null, // cosign_session_pubkey (D-5: pass-through)
            PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated; never reached)
            await fetchAndComputeQueueDigest(program, pcPolicy, pcVault, {}), // newPolicyPreviewDigest (Phase 2 TA-19)
          )
          .accounts({
            owner: protoCapOwner.publicKey,
            vault: pcVault,
            policy: pcPolicy,
            pendingPolicy: pcPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([protoCapOwner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "ProtocolCapsMismatch" });
      }
    });

    it("protocol_caps length mismatch rejects (ProtocolCapsMismatch)", async () => {
      // Phase 2 Option A deleted PROTOCOL_MODE_ALL (0). The remaining
      // ProtocolCapsMismatch failure mode is caps.len() != protocols.len() when
      // has_protocol_caps is implied. Test passes empty protocols + non-empty
      // caps; ProtocolCapsMismatch fires at line 113 of initialize_vault.rs,
      // BEFORE the F-11 ActiveVaultRequiresAllowlist check (line 119), so the
      // empty allowlist is intentional and load-bearing for the assertion.
      const badVaultId = new BN(901);
      const [bv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          protoCapOwner.publicKey.toBuffer(),
          badVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId,
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId,
      );
      const [bo] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), bv.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      try {
        await program.methods
          .initializeVault(
            badVaultId,
            new BN(1_000_000_000),
            new BN(500_000_000),
            1,
            [],
            0,
            100,
            new BN(1800),
            [],
            [new BN(100_000_000)],
            false, // observeOnly (Phase 2 TA-19)
            0x00ffffff, // operating_hours (TA-05 Phase 3 — all 24h)
            false, // auto_promote_grays (TA-07 Phase 3 — friction enabled)
            5, // auto_revoke_threshold (TA-17 Phase 3 — default)
            new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
            new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
            false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
            initVaultPreviewDigest({
              dailySpendingCapUsd: new BN(1_000_000_000),
              maxTransactionSizeUsd: new BN(500_000_000),
              maxSlippageBps: 100,
              protocolMode: 1,
              protocols: [],
              allowedDestinations: [],
              timelockDuration: new BN(1800),
              operatingHours: 0x00ffffff,
              autoPromoteGrays: false,
              autoRevokeThreshold: 5,
            }),
          )
          .accounts({
            owner: protoCapOwner.publicKey,
            vault: bv,
            policy: bp,
            tracker: bt,
            agentSpendOverlay: bo,
            feeDestination: protoCapFee.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([protoCapOwner])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "ProtocolCapsMismatch" });
      }
    });
  });

  // =========================================================================
  // TA-13 ratification: per-protocol daily cap enforcement (Phase 5, F-15)
  // =========================================================================
  //
  // Adds the 5 regression scenarios required by HARDENED §6 line 985-988.
  // Pre-Phase-5: the rolling 24h per-protocol cap was already wired in
  // `finalize_session.rs` (Phase 2), but no LiteSVM test scenario exercised
  // the actual "exceeds cap → reject" branch. The Phase 2 doc-comment on
  // `SpendTracker.protocol_counters` claimed "no enforcement yet" — stale.
  // Phase 5 deletes that comment, ratifies the live enforcement with a
  // dedicated error variant (`ErrDailyCapExceeded`, 6095), and adds these
  // 5 scenarios.
  describe("TA-13 ratification: per-protocol daily cap (F-15)", () => {
    const ta13Owner = Keypair.generate();
    const ta13Agent = Keypair.generate();
    const ta13Fee = Keypair.generate();
    // F-Q2 migration: the per-protocol cap charges `actual_spend` (measured
    // balance delta), so the sandwich middle ix must be a REAL drain whose
    // program == the authorized target_protocol. Both protocols must be LOADED
    // mock programs. jupiterProtocol = MOCK_DEFI (scenarios 1/3/4/5),
    // driftProtocol = MOCK_DEFI_2 (scenario 2 — per-protocol independence).
    const jupiterProtocol = MOCK_DEFI_PROGRAM_ID;
    const driftProtocol = MOCK_DEFI_2_PROGRAM_ID;
    const ta13VaultId = new BN(913);
    // G3a audit fix (§RP-2 2026-05-18 HIGH-1): see protoCapCosigner above.
    // S3 disables has_protocol_caps; S5 sets a per-protocol cap to 0 —
    // both weakenings that require cosign under TA-09.
    const ta13Cosigner = Keypair.generate();
    // F-Q2 drain destination (throwaway, intentionally NOT allowlisted — the
    // sink-scoped check skips non-allowlisted route hops; it only needs to be
    // resolvable in validate's remaining_accounts).
    const ta13DrainDest = Keypair.generate();
    let ta13Vault: PublicKey;
    let ta13Policy: PublicKey;
    let ta13Tracker: PublicKey;
    let ta13Overlay: PublicKey;
    let ta13OwnerUsdc: PublicKey;
    let ta13VaultUsdc: PublicKey;
    let ta13FeeUsdc: PublicKey;
    let ta13DrainDestUsdc: PublicKey;
    // M1 output-ownership: non-USDC mint acquired into a vault-owned ATA so the
    // mandatory finalize gate (6112) is satisfied while the cap charges USDC.
    let ta13OutputMint: PublicKey;
    let ta13VaultOutputAta: PublicKey;
    let ta13AgentOutputReserve: PublicKey;
    let ta13PendingPda: PublicKey;

    before(async () => {
      airdropSol(svm, ta13Owner.publicKey, 100 * LAMPORTS_PER_SOL);
      airdropSol(svm, ta13Agent.publicKey, 10 * LAMPORTS_PER_SOL);
      airdropSol(svm, ta13Fee.publicKey, 2 * LAMPORTS_PER_SOL);

      ta13OwnerUsdc = createAtaHelper(
        svm,
        ta13Owner,
        usdcMint,
        ta13Owner.publicKey,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        ta13OwnerUsdc,
        owner.publicKey,
        10_000_000_000n,
      );
      ta13FeeUsdc = createAtaHelper(svm, ta13Fee, usdcMint, ta13Fee.publicKey);

      [ta13Vault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          ta13Owner.publicKey.toBuffer(),
          ta13VaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [ta13Policy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), ta13Vault.toBuffer()],
        program.programId,
      );
      [ta13Tracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), ta13Vault.toBuffer()],
        program.programId,
      );
      [ta13Overlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), ta13Vault.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      [ta13PendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), ta13Vault.toBuffer()],
        program.programId,
      );

      ta13VaultUsdc = createAtaHelper(
        svm,
        ta13Owner,
        usdcMint,
        ta13Vault,
        true,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        ta13VaultUsdc,
        owner.publicKey,
        5_000_000_000n,
      );

      // F-Q2 drain destination ATA — receives the drained USDC each spend.
      ta13DrainDestUsdc = createAtaHelper(
        svm,
        ta13Owner,
        usdcMint,
        ta13DrainDest.publicKey,
      );

      // M1: output mint + vault-owned acquisition ATA + agent reserve (funds
      // the swap's output leg; test-only).
      ta13OutputMint = Keypair.generate().publicKey;
      createMintAtAddress(svm, ta13OutputMint, owner.publicKey, 6);
      ta13VaultOutputAta = createAtaHelper(
        svm,
        ta13Owner,
        ta13OutputMint,
        ta13Vault,
        true,
      );
      ta13AgentOutputReserve = createAtaHelper(
        svm,
        ta13Owner,
        ta13OutputMint,
        ta13Agent.publicKey,
      );
      mintToHelper(
        svm,
        (owner as any).payer,
        ta13OutputMint,
        ta13AgentOutputReserve,
        owner.publicKey,
        1_000_000_000n,
      );

      // F-15 fixture: daily_cap=$1000, max_tx=$501, protocols=[Jupiter, Drift],
      // protocol_caps=[$500, $500]. Bumped max_tx from $500 to $501 so a
      // single-tx spend of $500 hits the per-protocol cap exactly without
      // being capped earlier by max_transaction_size_usd. The TA-13
      // ratification scenarios then push spend AT the per-protocol limit.
      await program.methods
        .initializeVault(
          ta13VaultId,
          new BN(1_000_000_000), // daily_cap = $1000
          new BN(501_000_000), // max_tx = $501 (HEADROOM for $500 protocol cap)
          1,
          [jupiterProtocol, driftProtocol],
          0,
          100,
          new BN(1800),
          [],
          [new BN(500_000_000), new BN(500_000_000)], // Jupiter $500, Drift $500
          false,
          0x00ffffff,
          false,
          5,
          new BN(0), // stable_balance_floor (TA-12 Phase 5 — no reserve)
          new BN(0), // per_recipient_daily_cap_usd (TA-14 Phase 5 — no cap)
          false, // cosignRequired (G6 audit 2026-05-18 — opt-in, default off)
          initVaultPreviewDigest({
            dailySpendingCapUsd: new BN(1_000_000_000),
            maxTransactionSizeUsd: new BN(501_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProtocol, driftProtocol],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
            // M-1 (audit 2026-06-11): vault initialized WITH per-protocol caps
            // [$500, $500] (see initializeVault arg above); bind the SAME slice
            // into the preview digest, else PolicyPreviewMismatch (6071).
            protocolCaps: [new BN(500_000_000), new BN(500_000_000)],
          }),
        )
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          tracker: ta13Tracker,
          agentSpendOverlay: ta13Overlay,
          feeDestination: ta13Fee.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([ta13Owner])
        .rpc();

      // F-Q6: OPERATOR grant on this single-key vault routes through the
      // timelock queue path (helper). ta13Owner is a non-provider keypair, so
      // it is passed both as `owner` and in `signers` (queue + apply both
      // require the owner to sign). ta13Agent spends via ta13Spend below.
      await registerOperatorAgent({
        program,
        svm,
        owner: ta13Owner.publicKey,
        vault: ta13Vault,
        agent: ta13Agent.publicKey,
        signers: [ta13Owner],
      });
    });

    const ta13Spend = async (protocol: PublicKey, amount: BN) => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          ta13Vault.toBuffer(),
          ta13Agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          amount,
          protocol,
          await pv(ta13Policy),
          new BN(0),
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: ta13Vault,
              agent: ta13Agent.publicKey,
              tokenMint: usdcMint,
              amount,
              targetProtocol: protocol,
            }),
          ),
        )
        .accountsPartial({
          agent: ta13Agent.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          tracker: ta13Tracker,
          session: sessionPda,
          vaultTokenAccount: ta13VaultUsdc,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: ta13VaultOutputAta,
          agentSpendOverlay: ta13Overlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: the drain ix's writable metas (vault ATA + drain
        // dest) plus the agent fee-payer must be resolvable in validate's
        // remaining_accounts (else DestinationAccountUnresolvable). Read-only
        // here — resolved/classified, not authorized.
        .remainingAccounts([
          { pubkey: ta13VaultUsdc, isSigner: false, isWritable: false },
          { pubkey: ta13DrainDestUsdc, isSigner: false, isWritable: false },
          {
            pubkey: ta13AgentOutputReserve,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: ta13VaultOutputAta, isSigner: false, isWritable: false },
          { pubkey: ta13Agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();
      // Real fund-moving DeFi ix: drain `amount` USDC out of the vault. The
      // drain's program MUST equal the authorized target_protocol (the cap keys
      // off session.authorized_protocol), so route through MOCK_DEFI_2's builder
      // when targeting driftProtocol, else MOCK_DEFI's. actual_spend == amount,
      // so the per-protocol cap genuinely charges.
      const drainAmount = netDrainAmount(amount);
      // M1: acquiring swap (not a bare drain) — pull USDC out AND deliver a
      // different mint into the vault-owned output ATA (satisfies the 6112
      // gate); the per-protocol cap still charges the USDC outflow.
      const drainIx = buildMockSwapToVaultIx(
        ta13VaultUsdc,
        ta13DrainDestUsdc,
        ta13AgentOutputReserve,
        ta13VaultOutputAta,
        ta13Agent.publicKey,
        drainAmount,
        new BN(1_000),
        protocol,
      );
      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: ta13Agent.publicKey,
          vault: ta13Vault,
          session: sessionPda,
          sessionRentRecipient: ta13Agent.publicKey,
          policy: ta13Policy,
          tracker: ta13Tracker,
          vaultTokenAccount: ta13VaultUsdc,
          agentSpendOverlay: ta13Overlay,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: ta13VaultOutputAta,
        })
        .instruction();
      return sendVersionedTx(svm, [validateIx, drainIx, finalizeIx], ta13Agent);
    };

    // SCENARIO 1: spend $500 on Jupiter (at cap), then $1 more Jupiter
    // → ErrDailyCapExceeded (6095). Global daily_cap=$1000 not yet hit.
    it("scenario 1: spending exactly cap then $1 more on same protocol → ErrDailyCapExceeded", async () => {
      // First $500 on Jupiter — fills the per-protocol cap (net of the protocol
      // fee, actual_spend ≈ $499.90), succeeds.
      await ta13Spend(jupiterProtocol, new BN(500_000_000));
      // Next $1 — pushes the Jupiter rolling counter over the $500 cap.
      // Capture the thrown error OUTSIDE the assertion so a NON-revert is a
      // real failure: `expect.fail` must NOT live inside the catch (its own
      // AssertionError message contains "6095" and would vacuously satisfy the
      // include-check below — a false green). Instead, assert a throw occurred,
      // then assert it is the per-protocol cap error.
      // Strict typed assertion (F-Q2 review F2 fix): bind the exact
      // ErrDailyCapExceeded (6086) via the authoritative error map and reject
      // ANY other error. The prior loose `includes("6095")` accepted
      // ErrPendingOwnershipNotReady (6095, unrelated) — a latent false-green.
      try {
        await ta13Spend(jupiterProtocol, new BN(1_000_000));
        expect.fail("second spend must revert (per-protocol cap exceeded)");
      } catch (err: any) {
        if (err?.message?.startsWith("second spend must revert")) throw err;
        expectSigilError(err, { name: "ErrDailyCapExceeded" });
      }
    });

    // SCENARIO 2: same state after S1 — Jupiter $500 spent. Spend $499 on
    // Drift → SUCCEEDS (Drift cap=$500 untouched; global cap has $500
    // remaining = $1000 - $500).
    it("scenario 2: other protocol still has room when one is at cap", async () => {
      await ta13Spend(driftProtocol, new BN(499_000_000));
    });

    // SCENARIO 3: caps disabled (has_protocol_caps=false). Even after S1+S2,
    // a third spend on Jupiter would normally exceed the cap — but with
    // caps disabled, only the global daily_cap applies. Vault has $1 of
    // global headroom remaining ($1000 - $500 - $499 = $1).
    it("scenario 3: has_protocol_caps=false (legacy mode) — only global cap enforced", async () => {
      // Disable per-protocol caps via queue+apply.
      // G3a audit fix (§RP-2 2026-05-18 HIGH-1) NOTE: weakens_protocol_caps is
      // one of the 7 elevation triggers, BUT the gate only fires when
      // `live_cosign_required == true`. ta13Vault is initialized with
      // `cosignRequired: false` (the G6 default), so the 7-trigger gate
      // short-circuits and this mutation is NON-elevated. B4 F-3 (audit
      // 2026-05-19): non-elevated path requires `cosign_session = Pubkey::default`
      // — silent swallow of a caller-supplied pubkey is REJECTED with
      // InvalidPermissions. Pass `PublicKey.default` and drop the cosigner
      // wiring.
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
          false, // has_protocol_caps = false (master-switch disable)
          null,
          null,
          null,
          null, // stable_balance_floor (TA-12 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (B4 F-3: non-elevated → must be default)
          await fetchAndComputeQueueDigest(program, ta13Policy, ta13Vault, {
            hasProtocolCaps: false,
          }),
        )
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          pendingPolicy: ta13PendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([ta13Owner])
        .rpc();
      advanceTime(svm, 1801);
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          tracker: ta13Tracker,
          pendingPolicy: ta13PendingPda,
        } as any)
        .signers([ta13Owner])
        .rpc();

      // Now spend $1 on Jupiter (which would have exceeded the per-protocol
      // cap). With caps disabled, only global cap applies — and $1 fits
      // in the $1 of global headroom remaining.
      await ta13Spend(jupiterProtocol, new BN(1_000_000));
    });

    // SCENARIO 4: rolling window — after 24h, per-protocol counters expire
    // and another $500 Jupiter spend succeeds. NOTE: the global daily_cap
    // tracker uses proportional boundary correction (per
    // `get_rolling_24h_usd`), so 24h+ ensures BOTH per-protocol AND global
    // counters are reset. We advance enough to clear both.
    it("scenario 4: rolling window — 24h+ after first $500 Jupiter spend, another $500 succeeds", async () => {
      // First re-enable caps (S3 disabled them).
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
          true, // has_protocol_caps = true
          [new BN(500_000_000), new BN(500_000_000)],
          null,
          null,
          null,
          null,
          null, // cosign_required (G6 audit 2026-05-18 — pass-through)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default,
          await fetchAndComputeQueueDigest(program, ta13Policy, ta13Vault, {
            hasProtocolCaps: true,
            protocolCaps: [new BN(500_000_000), new BN(500_000_000)],
          }),
        )
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          pendingPolicy: ta13PendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([ta13Owner])
        .rpc();
      advanceTime(svm, 1801);
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          tracker: ta13Tracker,
          pendingPolicy: ta13PendingPda,
        } as any)
        .signers([ta13Owner])
        .rpc();

      // Advance past the 24h rolling window from S1's Jupiter spend.
      // 144 epochs * 600 = 86_400s. Add buffer.
      advanceTime(svm, 90_000);

      // Per-protocol Jupiter counter now expired (simple 24h window resets).
      // Global rolling counter mostly expired (proportional boundary
      // correction has rolled S1's spend out of the window).
      await ta13Spend(jupiterProtocol, new BN(500_000_000));
    });

    // SCENARIO 5: cap=$0 for a specific protocol → all spending on that
    // protocol blocked. The `get_protocol_cap` Option lookup returns
    // Some(0); the gate `if proto_cap > 0` SKIPS enforcement (treating
    // cap=0 as "unlimited"). This is documented behavior — the test
    // confirms it. To genuinely block, the owner must remove the protocol
    // from the allowlist (which `is_protocol_allowed` rejects at validate).
    it("scenario 5: cap=$0 for a specific protocol → unlimited (documented behavior)", async () => {
      // Update Jupiter cap to $0 (unlimited per documented semantics).
      // G3a audit fix (§RP-2 2026-05-18 HIGH-1) NOTE: weakens_protocol_caps is
      // one of the 7 elevation triggers, BUT the gate only fires when
      // `live_cosign_required == true`. ta13Vault has `cosignRequired: false`
      // (G6 default), so this mutation is NON-elevated. B4 F-3 (audit
      // 2026-05-19): non-elevated path requires `cosign_session = Pubkey::default`
      // — pass `PublicKey.default` and drop cosigner wiring.
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
          true,
          [new BN(0), new BN(500_000_000)], // Jupiter cap = $0 (unlimited)
          null,
          null,
          null,
          null,
          null, // cosign_required (G6 audit 2026-05-18 — pass-through)
          null,
          null, // cosign_session_pubkey (D-5: pass-through)
          PublicKey.default, // cosign_session (B4 F-3: non-elevated → must be default)
          await fetchAndComputeQueueDigest(program, ta13Policy, ta13Vault, {
            hasProtocolCaps: true,
            protocolCaps: [new BN(0), new BN(500_000_000)],
          }),
        )
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          pendingPolicy: ta13PendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([ta13Owner])
        .rpc();
      advanceTime(svm, 1801);
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: ta13Owner.publicKey,
          vault: ta13Vault,
          policy: ta13Policy,
          tracker: ta13Tracker,
          pendingPolicy: ta13PendingPda,
        } as any)
        .signers([ta13Owner])
        .rpc();

      // After S4 we spent $500 on Jupiter. Global cap is $1000, so we have
      // $500 of global headroom. With Jupiter cap=$0 (unlimited), the
      // $500 spend succeeds — bounded only by the global cap, not
      // per-protocol. Documents the cap=$0 = unlimited semantic.
      await ta13Spend(jupiterProtocol, new BN(500_000_000));
    });
  });

  // =========================================================================
  // freeze_vault
  // =========================================================================
  describe("freeze_vault", () => {
    const freezeVaultId = new BN(950);
    let freezeVaultPda: PublicKey;
    let freezeOverlay: PublicKey;
    let freezePolicyPda: PublicKey;
    let freezeTrackerPda: PublicKey;
    const freezeAgent = Keypair.generate();
    const freezeAgent2 = Keypair.generate();

    before(async () => {
      airdropSol(svm, freezeAgent.publicKey, 10 * LAMPORTS_PER_SOL);
      airdropSol(svm, freezeAgent2.publicKey, 10 * LAMPORTS_PER_SOL);

      [freezeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          freezeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [freezePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), freezeVaultPda.toBuffer()],
        program.programId,
      );
      [freezeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), freezeVaultPda.toBuffer()],
        program.programId,
      );
      [freezeOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          freezeVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          freezeVaultId,
          new BN(1000_000_000),
          new BN(1000_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000_000_000),
            maxTransactionSizeUsd: new BN(1000_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
          policy: freezePolicyPda,
          tracker: freezeTrackerPda,
          agentSpendOverlay: freezeOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // F-Q6: freezeAgent / freezeAgent2 only verify that freeze/unfreeze
      // preserves agent entries — neither spends and no capability is asserted.
      // Register both as VIEWER to avoid the OPERATOR-grant timelock.
      await program.methods
        .registerAgent(freezeAgent.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), freezeVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: freezeOverlay,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(freezeAgent2.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), freezeVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: freezeOverlay,
        } as any)
        .rpc();
    });

    it("owner can freeze an active vault", async () => {
      await program.methods
        .freezeVault()
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(freezeVaultPda);
      expect(vault.status).to.have.property("frozen");
    });

    it("freeze preserves all agent entries", async () => {
      const vault = await program.account.agentVault.fetch(freezeVaultPda);
      expect(vault.agents.length).to.equal(2);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        freezeAgent.publicKey.toString(),
      );
      expect(vault.agents[1].pubkey.toString()).to.equal(
        freezeAgent2.publicKey.toString(),
      );
    });

    it("cannot freeze an already-frozen vault", async () => {
      try {
        await program.methods
          .freezeVault()
          .accounts({
            owner: owner.publicKey,
            vault: freezeVaultPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "VaultNotActive" });
      }
    });

    it("non-owner cannot freeze", async () => {
      try {
        await program.methods
          .freezeVault()
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: freezeVaultPda,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });

    it("reactivate unfreezes without needing to add agent (agents preserved)", async () => {
      // Vault is currently frozen from the first test
      // Phase 8 Batch 5: advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      await program.methods
        .reactivateVault(null, null)
        .accounts({ owner: owner.publicKey, vault: freezeVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(freezeVaultPda);
      expect(vault.status).to.have.property("active");
      expect(vault.agents.length).to.equal(2);
    });

    it("owner can withdraw_funds from frozen vault (fund safety)", async () => {
      // Create USDC ATA for vault and deposit
      const vaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        freezeVaultPda,
        true,
      );
      const ownerAta = createAtaIdempotentHelper(
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
        1_000_000n,
      );

      await program.methods
        .depositFunds(new BN(500_000))
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerAta,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Freeze the vault
      await program.methods
        .freezeVault()
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
        } as any)
        .rpc();

      // Owner can still withdraw from frozen vault
      await program.methods
        .withdrawFunds(new BN(500_000))
        .accounts({
          owner: owner.publicKey,
          vault: freezeVaultPda,
          mint: usdcMint,
          vaultTokenAccount: vaultUsdcAta,
          ownerTokenAccount: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      const balance = getTokenBalance(svm, vaultUsdcAta);
      expect(balance.toString()).to.equal("0");

      // Phase 8 Batch 5: advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      // Clean up: reactivate
      await program.methods
        .reactivateVault(null, null)
        .accounts({ owner: owner.publicKey, vault: freezeVaultPda } as any)
        .rpc();
    });
  });

  // =========================================================================
  // pause_agent / unpause_agent
  // =========================================================================
  describe("pause_agent / unpause_agent", () => {
    const pauseVaultId = new BN(951);
    let pauseVaultPda: PublicKey;
    let pauseOverlay: PublicKey;
    let pausePolicyPda: PublicKey;
    let pauseTrackerPda: PublicKey;
    const pauseAgent = Keypair.generate();
    const pauseAgent2 = Keypair.generate();

    before(async () => {
      airdropSol(svm, pauseAgent.publicKey, 10 * LAMPORTS_PER_SOL);
      airdropSol(svm, pauseAgent2.publicKey, 10 * LAMPORTS_PER_SOL);

      [pauseVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          pauseVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [pausePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), pauseVaultPda.toBuffer()],
        program.programId,
      );
      [pauseTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), pauseVaultPda.toBuffer()],
        program.programId,
      );
      [pauseOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          pauseVaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          pauseVaultId,
          new BN(1000_000_000),
          new BN(1000_000_000),
          1,
          [jupiterProgramId],
          0,
          100,
          new BN(1800),
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
            dailySpendingCapUsd: new BN(1000_000_000),
            maxTransactionSizeUsd: new BN(1000_000_000),
            maxSlippageBps: 100,
            protocolMode: 1,
            protocols: [jupiterProgramId],
            allowedDestinations: [],
            timelockDuration: new BN(1800),
            operatingHours: 0x00ffffff,
            autoPromoteGrays: false,
            autoRevokeThreshold: 5,
          }),
        )
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: pausePolicyPda,
          tracker: pauseTrackerPda,
          agentSpendOverlay: pauseOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // F-Q6: pauseAgent must stay OPERATOR (a later test asserts its
      // capability == FULL_CAPABILITY and exercises a paused agent_transfer),
      // so its OPERATOR grant routes through the timelock queue path (helper).
      await registerOperatorAgent({
        program,
        svm,
        owner: owner.publicKey,
        vault: pauseVaultPda,
        agent: pauseAgent.publicKey,
      });

      // F-Q6: pauseAgent2 is only paused/unpaused (and never spends, no
      // capability assertion) — register as VIEWER to avoid the OPERATOR-grant
      // timelock. (pauseAgent above stays OPERATOR via the helper because a
      // later test asserts its capability == FULL_CAPABILITY and exercises a
      // paused agentTransfer.)
      await program.methods
        .registerAgent(pauseAgent2.publicKey, VIEWER_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
          agentSpendOverlay: pauseOverlay,
        } as any)
        .rpc();
    });

    it("owner can pause a specific agent", async () => {
      await program.methods
        .pauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(pauseVaultPda);
      const entry = vault.agents.find(
        (a: any) => a.pubkey.toString() === pauseAgent.publicKey.toString(),
      );
      expect(entry!.paused).to.equal(true);
    });

    it("cannot pause an already-paused agent", async () => {
      try {
        await program.methods
          .pauseAgent(pauseAgent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault: pauseVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), pauseVaultPda.toBuffer()],
              program.programId,
            )[0],
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentAlreadyPaused" });
      }
    });

    it("cannot pause an agent not in the vault", async () => {
      const fakeAgent = Keypair.generate();
      try {
        await program.methods
          .pauseAgent(fakeAgent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault: pauseVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), pauseVaultPda.toBuffer()],
              program.programId,
            )[0],
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "UnauthorizedAgent" });
      }
    });

    it("non-owner cannot pause", async () => {
      try {
        await program.methods
          .pauseAgent(pauseAgent2.publicKey)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: pauseVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), pauseVaultPda.toBuffer()],
              program.programId,
            )[0],
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }
    });

    it("other agent in same vault is NOT affected by one agent's pause", async () => {
      const vault = await program.account.agentVault.fetch(pauseVaultPda);
      const entry2 = vault.agents.find(
        (a: any) => a.pubkey.toString() === pauseAgent2.publicKey.toString(),
      );
      expect(entry2!.paused).to.equal(false);
    });

    it("paused agent is blocked by agent_transfer (AgentPaused)", async () => {
      // Create USDC ATAs and fund vault
      const vaultAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        pauseVaultPda,
        true,
      );
      const ownerAta = createAtaIdempotentHelper(
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
        1_000_000n,
      );
      await program.methods
        .depositFunds(new BN(1_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerAta,
          vaultTokenAccount: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Destination ATA
      const destAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        owner.publicKey,
      );

      try {
        await program.methods
          .agentTransfer(
            new BN(100_000),
            ((await program.account.policyConfig.fetch(pausePolicyPda))
              .policyVersion as BN) ?? new BN(0),
          )
          .accounts({
            agent: pauseAgent.publicKey,
            vault: pauseVaultPda,
            policy: pausePolicyPda,
            tracker: pauseTrackerPda,
            agentSpendOverlay: pauseOverlay,
            vaultTokenAccount: vaultAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: destAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([pauseAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentPaused" });
      }
    });

    it("pause works on frozen vault (pre-positioning for unfreeze)", async () => {
      // Freeze the vault
      await program.methods
        .freezeVault()
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
        } as any)
        .rpc();

      // Can pause agent2 while vault is frozen
      await program.methods
        .pauseAgent(pauseAgent2.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(pauseVaultPda);
      const entry2 = vault.agents.find(
        (a: any) => a.pubkey.toString() === pauseAgent2.publicKey.toString(),
      );
      expect(entry2!.paused).to.equal(true);

      // Phase 8 Batch 5: advance past 5-min reactivate cooldown (ErrReactivateCooldownActive 6097)
      advanceTime(svm, 301);

      // Clean up: unfreeze and unpause agent2
      await program.methods
        .reactivateVault(null, null)
        .accounts({ owner: owner.publicKey, vault: pauseVaultPda } as any)
        .rpc();
      await program.methods
        .unpauseAgent(pauseAgent2.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();
    });

    it("owner can unpause a paused agent", async () => {
      await program.methods
        .unpauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(pauseVaultPda);
      const entry = vault.agents.find(
        (a: any) => a.pubkey.toString() === pauseAgent.publicKey.toString(),
      );
      expect(entry!.paused).to.equal(false);
    });

    it("cannot unpause an agent that isn't paused", async () => {
      try {
        await program.methods
          .unpauseAgent(pauseAgent.publicKey)
          .accounts({
            owner: owner.publicKey,
            vault: pauseVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), pauseVaultPda.toBuffer()],
              program.programId,
            )[0],
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err, { name: "AgentNotPaused" });
      }
    });

    it("non-owner cannot unpause", async () => {
      // Pause first
      await program.methods
        .pauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      try {
        await program.methods
          .unpauseAgent(pauseAgent.publicKey)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: pauseVaultPda,
            policy: PublicKey.findProgramAddressSync(
              [Buffer.from("policy"), pauseVaultPda.toBuffer()],
              program.programId,
            )[0],
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Phase 8 LBL-01: seed-key is `vault.vault_authority` (immutable),
        // not `signer.key()`. PDA derivation passes regardless of signer
        // identity → `has_one = owner` fires → UnauthorizedOwner (6002).
        expectSigilError(err, { name: "UnauthorizedOwner", code: 6002 });
      }

      // Clean up: unpause
      await program.methods
        .unpauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();
    });

    it("paused agent's capability preserved after unpause", async () => {
      // Pause and unpause
      await program.methods
        .pauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      await program.methods
        .unpauseAgent(pauseAgent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: pauseVaultPda,
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("policy"), pauseVaultPda.toBuffer()],
            program.programId,
          )[0],
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(pauseVaultPda);
      const entry = vault.agents.find(
        (a: any) => a.pubkey.toString() === pauseAgent.publicKey.toString(),
      );
      expect(entry!.paused).to.equal(false);
      expect(entry!.capability).to.equal(FULL_CAPABILITY);
    });
  });
});
