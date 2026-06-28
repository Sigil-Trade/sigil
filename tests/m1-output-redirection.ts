import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
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
import { registerOperatorAgent } from "./helpers/register-operator-agent";
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
  getTokenBalance,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiDrainIx,
} from "./helpers/litesvm-setup";

/**
 * M1 — OUTPUT-OWNERSHIP / VALUE-REDIRECTION exploit (the Phase-2 RED test).
 *
 * THREAT (adversarial, non-SDK agent): on the stablecoin-input spending path,
 * `validate_and_authorize` grants the agent a same-tx SPL delegation over the
 * vault's USDC ATA, and `finalize_session` only checks that the vault's
 * stablecoin balance *decreased* by ≤ the authorized amount — it NEVER checks
 * WHERE the value went. So a compromised agent can spend its delegation to move
 * vault USDC straight into its OWN token account, up to the cap. The guard bounds
 * MAGNITUDE, not OWNERSHIP. (Confirmed open at main@7bfcc5e5; see
 * ROADMAP/MASTER_PLAN.md Phase 2.)
 *
 * This test encodes the SECURE expectation (the drain must revert / the agent
 * must gain nothing). It is therefore RED today and must stay red until Phase 2
 * lands the mandatory control-closure (measure the acquired mint + require the
 * output land in a vault-owned account). When the closure ships, the new
 * `OutputNotVaultOwned`-class revert flips this GREEN.
 *
 * VERIFICATION STATUS (2026-06-17): EXECUTED and confirmed RED. The exploit
 * lands — diagnostic prints `reverted=false agentGained=50000000
 * vaultDelta=-50020000`: 50 USDC of vault funds routed into the agent's OWN ATA,
 * no revert (vault also loses the 0.02 USDC upfront protocol fee on the 100
 * authorized). The F-Q1a completeness scan requires ALL THREE writable
 * compiled-message metas of the drain ix to be resolvable in
 * `remaining_accounts`: the vault USDC ATA (source), the agent's own ATA (sink),
 * AND the agent itself (it is the fee payer, which is writable in every ix's
 * COMPILED metas regardless of its declared read-only-signer flag).
 *
 * SKIP RATIONALE: this is the Phase-2 acceptance spec, asserting the SECURE
 * behavior that does NOT hold yet, so it is RED today. It is `it.skip`-ped ONLY
 * to keep the suite green while the Phase-2 output-ownership closure is blocked
 * on the `takeover/audit-fixes-finish-2026-06-16` merge (that branch edits
 * finalize_session.rs + intent_digest.rs, which the closure must also touch).
 * UN-SKIP this in the SAME PR that lands the closure — it must flip GREEN there.
 *
 * FOLLOW-UP (same M1 class, separate fixture): the wSOL → CloseAccount native-SOL
 * variant — fold in once Phase 0's `native-sol-residual` test confirms whether it
 * collapses into this M1 case or is a distinct lamport-plane drain.
 */
describe("m1-output-redirection", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const mockDefiProtocol = MOCK_DEFI_PROGRAM_ID;

  const vaultId = new BN(901);
  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;

  // Protocol treasury (must match the hardcoded constant in the program).
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let agentUsdcAta: PublicKey; // the ADVERSARY's own token account — the sink

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

    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // daily_spending_cap_usd = 500 USDC
        new BN(200_000_000), // max_transaction_size_usd = 200 USDC
        1, // protocol_mode = ALLOWLIST
        [mockDefiProtocol],
        0, // destination_mode
        100, // max_slippage_bps
        new BN(1800), // timelock_duration
        [],
        [],
        false, // observeOnly
        0x00ffffff, // operating_hours (all 24h)
        false, // auto_promote_grays
        5, // auto_revoke_threshold
        new BN(0), // stable_balance_floor
        new BN(0), // per_recipient_daily_cap_usd
        false, // cosignRequired
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(500_000_000),
          maxTransactionSizeUsd: new BN(200_000_000),
          maxSlippageBps: 100,
          protocolMode: 1,
          protocols: [mockDefiProtocol],
          allowedDestinations: [],
          timelockDuration: new BN(1800),
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });

    // Fund the vault with USDC.
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
      1_000_000_000n, // 1000 USDC
    );
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
    await program.methods
      .depositFunds(new BN(500_000_000)) // 500 USDC into the vault
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // The adversary's OWN USDC account — the sink the drain redirects to.
    agentUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      agent.publicKey,
    );
  });

  /**
   * Build + send the malicious sandwich:
   *   [ComputeBudget, validate_and_authorize, drain→AGENT-OWN-ATA, finalize]
   * The drain spends the agent's validate-granted SPL delegation to move
   * `drainAmount` from the vault USDC ATA into the agent's OWN USDC ATA.
   */
  async function sendM1Drain(amount: BN, drainAmount: BN): Promise<void> {
    const [session] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 600_000,
    });

    const livePolicy = await program.account.policyConfig.fetch(policyPda);
    const validateIx = await program.methods
      .validateAndAuthorize(
        usdcMint,
        amount,
        mockDefiProtocol,
        livePolicy.policyVersion,
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount,
            targetProtocol: mockDefiProtocol,
          }),
        ),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        outputStablecoinAccount: program.programId,
        // M1: the agent declares NO acquired-output account (program.programId =
        // the None sentinel). On a stablecoin-input spend with actual_spend > 0,
        // finalize's output-ownership gate then reverts (6112) — the drain brings
        // no vault-owned acquisition back.
        outputSwapAccount: program.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      // F-Q1a COMPLETENESS: validate_and_authorize walks the drain ix's account
      // metas (read via load_instruction_at_checked, i.e. COMPILED-message
      // writability) and fails closed (DestinationAccountUnresolvable, 6105) on
      // ANY writable, non-vault-PDA meta it cannot resolve here. Three metas of
      // the drain ix are writable in the compiled message:
      //   1. source = the vault's USDC *ATA* (NOT the vault PDA → not auto-skipped)
      //   2. destination = the agent's own ATA (the M1 sink)
      //   3. the agent itself — declared read-only-signer, but it is the tx FEE
      //      PAYER, and the fee payer is writable in EVERY instruction's compiled
      //      metas (learning: onchain-ix-introspection-compiled-writability).
      // All three must be resolvable. Once resolved: the vault ATA → vault-owned
      // → skipped; the agent ATA → non-allowlisted token account → skipped as a
      // "transient route hop" (swap-path enforces WHERE only via the allowlist,
      // which a self-owned sink is not on); the agent → System-owned non-token →
      // skipped by the owner pre-filter. So the drain is ALLOWED to proceed — the
      // M1 hole.
      .remainingAccounts([
        { pubkey: vaultUsdcAta, isSigner: false, isWritable: true },
        { pubkey: agentUsdcAta, isSigner: false, isWritable: true },
        { pubkey: agent.publicKey, isSigner: false, isWritable: false },
      ])
      .instruction();

    // The malicious middle ix: redirect vault USDC to the agent's OWN ATA.
    const drainIx = buildMockDefiDrainIx(
      vaultUsdcAta, // source: vault's USDC ATA
      agentUsdcAta, // destination: the AGENT's own ATA  ← the M1 redirect
      agent.publicKey, // authority: the validate-granted delegate
      drainAmount,
      mockDefiProtocol,
    );

    const finalizeIx = await program.methods
      .finalizeSession()
      .accountsPartial({
        // C-1 fix: relocated fee accounts (protocol treasury + dev fee dest).
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        payer: agent.publicKey,
        vault: vaultPda,
        session,
        sessionRentRecipient: agent.publicKey,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        outputStablecoinAccount: program.programId,
        // M1: the agent declares NO acquired-output account (program.programId =
        // the None sentinel). On a stablecoin-input spend with actual_spend > 0,
        // finalize's output-ownership gate then reverts (6112) — the drain brings
        // no vault-owned acquisition back.
        outputSwapAccount: program.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // Throws (FailedTransactionMetadata) if the bundle reverts.
    sendVersionedTx(svm, [computeIx, validateIx, drainIx, finalizeIx], agent);
  }

  it("M1: the agent must NOT be able to route vault funds into its own ATA", async () => {
    const amount = new BN(100_000_000); // authorize 100 USDC of spend
    const drainAmount = new BN(50_000_000); // redirect 50 USDC to the agent

    const agentBefore = getTokenBalance(svm, agentUsdcAta);
    const vaultBefore = getTokenBalance(svm, vaultUsdcAta);

    let reverted = false;
    let revertMsg = "";
    try {
      await sendM1Drain(amount, drainAmount);
    } catch (e: any) {
      reverted = true;
      revertMsg = String(e?.message ?? e);
    }

    const agentAfter = getTokenBalance(svm, agentUsdcAta);
    const vaultAfter = getTokenBalance(svm, vaultUsdcAta);
    const agentGained = agentAfter - agentBefore;

    // Diagnostic — visible in test output so the M1 state is unambiguous.
    // eslint-disable-next-line no-console
    console.log(
      `[M1] reverted=${reverted} agentGained=${agentGained} ` +
        `vaultDelta=${vaultAfter - vaultBefore}` +
        (reverted ? ` revert="${revertMsg.slice(0, 120)}"` : ""),
    );

    // SECURE expectation — GREEN now that the M1 output-ownership closure landed.
    // The drain MUST revert specifically at 6112 (ErrOutputNotVaultOwned): the
    // ON-CHAIN finalize gate fired, NOT a client-side build error or a different
    // revert (which would be a false green — pre-closure this false-greened at
    // 6105). The agent must gain nothing.
    expect(
      reverted,
      "M1 OPEN: the drain redirecting vault USDC to the agent's own ATA did NOT revert",
    ).to.equal(true);
    expect(
      revertMsg,
      `M1: expected the on-chain output-ownership gate (6112) to fire, got: ${revertMsg}`,
    ).to.match(/6112|ErrOutputNotVaultOwned/);
    expect(
      agentGained,
      "M1 OPEN: vault USDC landed in the agent's own ATA (value left the vault to the agent)",
    ).to.equal(0n);
  });
});
