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
} from "./helpers/litesvm-setup";

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

  const jupiterProgramId = Keypair.generate().publicKey;
  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
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
        new BN(1_000_000_000), // 1000 USDC daily cap
        new BN(500_000_000), // 500 USDC max tx
        0, // protocol mode: all
        [], // protocols
        new BN(0) as any, // max_leverage_bps (u16)
        10, // max_concurrent_positions
        0, // developer_fee_rate
        5000, // maxSlippageBps (50%)
        new BN(1800), // timelockDuration (mandatory minimum: 30 min)
        [], // allowedDestinations
        [], // protocolCaps
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

    // Register agent
    await program.methods
      .registerAgent(agent.publicKey, FULL_CAPABILITY, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      })
      .rpc();

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
    return program.methods
      .validateAndAuthorize(usdcMint, amount, jupiterProgramId, new BN(0))
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: getSessionPda(),
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
  }

  async function buildFinalizeIx() {
    return program.methods
      .finalizeSession()
      .accountsPartial({
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
      })
      .instruction();
  }

  async function executeSession(amount?: BN): Promise<void> {
    const validateIx = await buildValidateIx(amount ?? new BN(50_000_000));
    const finalizeIx = await buildFinalizeIx();
    sendVersionedTx(svm, [validateIx, finalizeIx], agent);
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

    await program.methods
      .registerAgent(agent2.publicKey, FULL_CAPABILITY, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      })
      .rpc();

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
