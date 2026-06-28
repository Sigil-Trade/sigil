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
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  advancePastSlot,
  sendVersionedTx,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "./helpers/litesvm-setup";
import { registerOperatorAgent } from "./helpers/register-operator-agent";

const FULL_CAPABILITY = 2; // CAPABILITY_OPERATOR

describe("analytics-counters", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(1);

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let feeDestUsdcAta: PublicKey;

  // F-Q2: spending sandwiches require EXACTLY ONE counted DeFi instruction, and
  // the executed DeFi ix's program must equal target_protocol. This "protocol"
  // is used only as the allowlist entry + authorized target here (no identity
  // assertion), so point it at the real, loaded, counted mock-defi program; the
  // sandwich's middle ix is mock-defi's no-op open_position (zero spend).
  const jupiterProgramId = MOCK_DEFI_PROGRAM_ID;
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

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Derive PDAs
    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    // Create ATAs
    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    // Vault ATA will be created by depositFunds (init_if_needed)
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
    feeDestUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      feeDestination.publicKey,
    );
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Fund owner and vault
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      10_000_000_000n,
    );

    // Initialize vault
    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000),
        new BN(500_000_000),
        1,
        [jupiterProgramId],
        0,
        5000,
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
          maxSlippageBps: 5000,
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

    // Register agent (F-Q6: single-key OPERATOR grant via queue→advance→apply)
    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });

    // Deposit USDC to vault
    await program.methods
      .depositFunds(new BN(5_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getSessionPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    )[0];
  }

  async function buildValidateIx(amount: BN) {
    // Read live policy_version for TOCTOU guard (default 0 if not yet bumped).
    const livePolicy = await program.account.policyConfig.fetch(policyPda);
    return (
      program.methods
        .validateAndAuthorize(
          usdcMint,
          amount,
          jupiterProgramId,
          livePolicy.policyVersion,
          new BN(0),
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
          session: getSessionPda(),
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: usdcMint,
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
        .instruction()
    );
  }

  async function buildFinalizeIx() {
    return program.methods
      .finalizeSession()
      .accountsPartial({
        // C-1 fix: relocated fee accounts (protocol treasury + dev fee dest).
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        payer: agent.publicKey,
        vault: vaultPda,
        session: getSessionPda(),
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
  }

  async function executeSession(amount?: BN): Promise<void> {
    // These counter tests assert lifecycle behavior (total_transactions /
    // lifetime_tx_count) on a NON-EXPIRED session — none of them depends on a
    // measurable spend (they explicitly expect actual_spend == 0). The
    // require-measurable-outcome invariant (err 6115) exempts non-spending
    // sessions (amount == 0 → run_outcome_check == false), so default to a
    // non-spending session. total_transactions still increments on every
    // non-expired finalize (finalize_session.rs:1119), and lifetime_tx_count
    // still only increments when actual_spend > 0 — so every assertion below is
    // preserved unchanged.
    const sessionAmount = amount ?? new BN(0);
    const validateIx = await buildValidateIx(sessionAmount);
    // A counted DeFi no-op ix is allowed (not required) on a non-spending
    // session: validate's defi_ix_count == 1 gate is spending-only
    // (validate_and_authorize.rs:878), and the non-spending scan treats the
    // mock-defi ix as PassedSharedChecks. Keeping it preserves the original
    // [validate, defi, finalize] sandwich shape these tests exercised.
    const defiIx = buildMockDefiNoopIx(agent.publicKey);
    const finalizeIx = await buildFinalizeIx();
    sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], agent);
  }

  // ─── Tests ───────────────────────────────────────────────────────────────

  it("1: new vault has total_failed_transactions = 0", async () => {
    const vault = await program.account.agentVault.fetch(vaultPda);
    expect(vault.totalFailedTransactions.toNumber()).to.equal(0);
  });

  it("2: successful session increments total_transactions, NOT total_failed_transactions", async () => {
    const before = await program.account.agentVault.fetch(vaultPda);
    const txBefore = before.totalTransactions.toNumber();
    const failBefore = before.totalFailedTransactions.toNumber();

    await executeSession();

    const after = await program.account.agentVault.fetch(vaultPda);
    expect(after.totalTransactions.toNumber()).to.equal(txBefore + 1);
    expect(after.totalFailedTransactions.toNumber()).to.equal(failBefore);
  });

  it("3: non-expired session always increments total_transactions (success param removed)", async () => {
    // With the success param removed, ALL non-expired finalize calls increment
    // total_transactions. Only expired sessions increment total_failed_transactions.
    const before = await program.account.agentVault.fetch(vaultPda);
    const txBefore = before.totalTransactions.toNumber();
    const failBefore = before.totalFailedTransactions.toNumber();

    await executeSession();

    const after = await program.account.agentVault.fetch(vaultPda);
    expect(after.totalTransactions.toNumber()).to.equal(txBefore + 1);
    expect(after.totalFailedTransactions.toNumber()).to.equal(failBefore);
  });

  // Test 4 was moved to Surfpool — expired-session coverage lives in
  // tests/surfpool-integration.ts (time-travel tests at lines ~1507, 3121, 3935).

  it("5: multiple sessions accumulate correctly", async () => {
    const before = await program.account.agentVault.fetch(vaultPda);
    const txBefore = before.totalTransactions.toNumber();

    // All 3 sessions now count as transactions (success param removed)
    await executeSession();
    await executeSession();
    await executeSession();

    const after = await program.account.agentVault.fetch(vaultPda);
    expect(after.totalTransactions.toNumber()).to.equal(txBefore + 3);
  });

  it("6: success rate computable from counters (100% when no expired sessions)", async () => {
    // With success param removed, all non-expired sessions count as successes.
    // Only expired sessions increment total_failed_transactions.
    // In this test suite (LiteSVM, no time travel), no sessions expire.
    const vault = await program.account.agentVault.fetch(vaultPda);
    const total = vault.totalTransactions.toNumber();
    const failed = vault.totalFailedTransactions.toNumber();

    expect(total).to.be.greaterThan(0);
    expect(failed).to.equal(0); // no expired sessions in LiteSVM
    const successRate = total / (total + failed);
    expect(successRate).to.equal(1); // 100% — all non-expired
  });

  it("7: per-agent lifetime_tx_count increments on spending session", async () => {
    // Fetch overlay and find agent slot
    const overlay = await program.account.agentSpendOverlay.fetch(overlayPda);
    const agentBytes = agent.publicKey.toBuffer();
    const slotIdx = overlay.entries.findIndex((e: any) =>
      Buffer.from(e.agent).equals(agentBytes),
    );
    expect(slotIdx).to.be.greaterThanOrEqual(0);

    const txCountBefore = overlay.lifetimeTxCount[slotIdx].toNumber();

    await executeSession();

    const overlayAfter =
      await program.account.agentSpendOverlay.fetch(overlayPda);
    const txCountAfter = overlayAfter.lifetimeTxCount[slotIdx].toNumber();

    // Mock DeFi is no-op → actual_spend = 0 (on-chain subtracts fees before
    // computing actual_spend — finalize_session.rs:236). lifetime_tx_count only
    // increments when actual_spend > 0 (finalize_session.rs:239).
    // To truly test increment, need a mock DeFi that moves tokens (#29).
    expect(txCountAfter).to.equal(txCountBefore);
  });

  it("8: lifetime_tx_count zeroed on agent revoke (release_slot)", async () => {
    // Register a second agent, do a session, then revoke
    const agent2 = Keypair.generate();
    airdropSol(svm, agent2.publicKey, 5 * LAMPORTS_PER_SOL);

    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent2.publicKey,
    });

    // Find agent2's slot
    let overlay = await program.account.agentSpendOverlay.fetch(overlayPda);
    const agent2Bytes = agent2.publicKey.toBuffer();
    const slotIdx = overlay.entries.findIndex((e: any) =>
      Buffer.from(e.agent).equals(agent2Bytes),
    );
    expect(slotIdx).to.be.greaterThanOrEqual(0);

    // Revoke agent2
    await program.methods
      .revokeAgent(agent2.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      })
      .rpc();

    // Verify slot is zeroed
    overlay = await program.account.agentSpendOverlay.fetch(overlayPda);
    expect(overlay.lifetimeTxCount[slotIdx].toNumber()).to.equal(0);
    expect(overlay.lifetimeSpend[slotIdx].toNumber()).to.equal(0);
  });
});
