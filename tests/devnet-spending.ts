/**
 * Devnet Spending Tests — 6 tests (V2)
 *
 * Aggregate USD caps, max_transaction_size_usd enforcement, and
 * agent_transfer spending tracked alongside session spends.
 *
 * V2: No per-token caps or rolling_spends. Tracker uses zero-copy epoch buckets.
 *     No recentTransactions. Stablecoin-only architecture.
 */
// Strict error helpers — see MEMORY/WORK/20260420-201121_test-assertion-precision-council/
import { expectSigilError } from "./helpers/strict-errors";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  deriveSessionPda,
  createFullVault,
  applyOperatorGrants,
  authorizeAndFinalize,
  sendVersionedTx,
  buildQueueDigest,
  fundKeypair,
  ensureStablecoinMint,
  setupSwapOutput,
  buildMockSwapToVaultIx,
  calculateFees,
  TEST_USDC_KEYPAIR,
  TEST_USDT_KEYPAIR,
  FullVaultResult,
  PROTOCOL_TREASURY,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";

describe("devnet-spending", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  // V2 agent_transfer requires an explicitly allowlisted destination owner
  // (RESTRICTED mode; empty allowlist allows nothing). Test 5's transfer
  // target is allowlisted on its vault at creation.
  const spendDest = Keypair.generate();

  let mintA: PublicKey; // 6 decimals (test USDC)
  let mintB: PublicKey; // 6 decimals (test USDT)
  let agentMintAAta: PublicKey; // agent ATA for mock DeFi spend destination
  let agentMintBAta: PublicKey;

  // Per-test vault configs — all six vaults are created up front in before()
  // so their OPERATOR grants share ONE 600s timelock wait (queue all → single
  // wait → apply all) instead of six sequential waits (F-Q6).
  const VAULT_CONFIGS: {
    dailyCap: BN;
    maxTx: BN;
    allowedDestinations?: PublicKey[];
  }[] = [
    { dailyCap: new BN(200_000_000), maxTx: new BN(200_000_000) }, // test 1
    { dailyCap: new BN(100_000_000), maxTx: new BN(100_000_000) }, // test 2
    { dailyCap: new BN(500_000_000), maxTx: new BN(50_000_000) }, // test 3
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 4
    {
      dailyCap: new BN(100_000_000),
      maxTx: new BN(100_000_000),
      allowedDestinations: [spendDest.publicKey],
    }, // test 5 (agent_transfer)
    { dailyCap: new BN(500_000_000), maxTx: new BN(300_000_000) }, // test 6
  ];
  let vaults: (FullVaultResult & {
    mintBVaultAta: PublicKey;
    mintBTreasuryAta: PublicKey;
  })[] = [];

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    mintA = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
    mintB = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDT_KEYPAIR,
      owner.publicKey,
      6,
    );

    // Create agent ATAs as mock DeFi spend destinations
    const agentMintAAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintA,
      agent.publicKey,
    );
    agentMintAAta = agentMintAAccount.address;
    const agentMintBAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      agent.publicKey,
    );
    agentMintBAta = agentMintBAccount.address;

    console.log("  MintA (USDC):", mintA.toString());
    console.log("  MintB (USDT):", mintB.toString());

    // Create all six per-test vaults (queues each OPERATOR grant), then one
    // batched wait + apply for every grant.
    vaults = [];
    for (const cfg of VAULT_CONFIGS) {
      vaults.push(await createDualTokenVault(cfg));
    }
    await applyOperatorGrants(
      program,
      connection,
      owner,
      vaults.map((v) => v.operatorGrant),
    );
    console.log(`  ${vaults.length} vaults created, operators seated`);
  });

  /** Helper to create a two-token vault and deposit both mints */
  async function createDualTokenVault(opts: {
    dailyCap: BN;
    maxTx: BN;
    allowedDestinations?: PublicKey[];
  }) {
    const vaultId = nextVaultId(5);

    const vault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint: mintA,
      vaultId,
      dailyCap: opts.dailyCap,
      maxTx: opts.maxTx,
      allowedDestinations: opts.allowedDestinations ?? [],
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      depositAmount: new BN(500_000_000),
    });

    // Deposit mintB
    const mintBVaultAta = anchor.utils.token.associatedAddress({
      mint: mintB,
      owner: vault.vaultPda,
    });
    const ownerMintBAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      owner.publicKey,
    );
    const ownerMintBAta = ownerMintBAtaAccount.address;
    await mintTo(
      connection,
      payer,
      mintB,
      ownerMintBAta,
      owner.publicKey,
      500_000_000, // 500 tokens (6 dec USDT)
    );
    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        mint: mintB,
        ownerTokenAccount: ownerMintBAta,
        vaultTokenAccount: mintBVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Create protocol treasury ATA for mintB (needed for mintB finalize)
    const mintBTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      PROTOCOL_TREASURY,
      true,
    );

    return {
      ...vault,
      mintBVaultAta,
      mintBTreasuryAta: mintBTreasuryAccount.address,
    };
  }

  it("1. aggregate USD cap tracks across both tokens", async () => {
    const vault = vaults[0]; // dailyCap 200 USD, maxTx 200 USD

    // M1: every stablecoin-input spend must ACQUIRE a vault-owned output (else
    // 6112 before the cap). One acquiring-swap fixture (fresh NON-stablecoin
    // output mint, vault-owned output ATA, funded agent reserve) is reused for
    // every leg — the acquired output is a different mint from BOTH USDC and
    // USDT inputs, so it works for the mintA and mintB legs alike. The USDC/USDT
    // sink (agentMint*Ata) is leg-1's inputSink.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Spend 100 USDC via mintA (6 dec, stablecoin -> 1:1 USD)
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000), // 100 USDC
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentMintAAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Spend 100 USDT (6 dec stablecoin -> 1:1 USD)
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintB,
      program.programId,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionB,
      vaultTokenAta: vault.mintBVaultAta,
      mint: mintB,
      amount: new BN(100_000_000), // 100 USDT (6 dec) = 100 USD
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.mintBTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.mintBVaultAta,
        agentMintBAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Now at ~200 USD cap — 1 more of either should fail. The swap satisfies M1
    // so execution reaches the rolling-cap check, which reverts.
    const sessionC = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorizeAndFinalize({
        connection,
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda: sessionC,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(1_000_000), // 1 USDC more
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentMintAAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(1_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "SpendingCapExceeded" });
    }
    console.log("    Aggregate USD cap enforced across two tokens");
  });

  it("2. spending exactly at cap boundary succeeds", async () => {
    const vault = vaults[1]; // dailyCap 100 USD, maxTx 100 USD

    // M1 + 6115: the cap-boundary spend must ACQUIRE a vault-owned output and
    // move real stablecoin so finalize measures actual_spend == 100 USD (else
    // ErrUnmeasurableSpend 6115 / ErrOutputNotVaultOwned 6112 before the cap).
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    // Spend exactly 100 USDC = cap
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentMintAAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });
    console.log("    Spend exactly at cap boundary succeeded (<=)");
  });

  it("3. max_transaction_size_usd enforced", async () => {
    const vault = vaults[2]; // dailyCap 500 USD, maxTx 50 USD

    // M1: TransactionTooLarge sits AFTER enforce_output_ownership inside
    // finalize's `actual_spend > 0` branch, so the spend must acquire a
    // vault-owned output for the size check to run. inAmount = net(51) ≈ 50.99
    // USDC still exceeds maxTx=50.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorizeAndFinalize({
        connection,
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(51_000_000), // 51 > maxTx=50
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentMintAAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(51_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "TransactionTooLarge" });
    }
    console.log("    max_transaction_size_usd enforced");
  });

  it("4. multiple spend cycles tracked in epoch buckets", async () => {
    const vault = vaults[3]; // dailyCap 500 USD, maxTx 200 USD

    // M1 + 6115: each cycle must ACQUIRE a vault-owned output and move real
    // stablecoin so finalize measures actual_spend > 0 (else 6112/6115 before
    // the bucket is recorded). One acquiring-swap fixture reused across all
    // three cycles — the acquired output mint differs from the USDC input, so
    // every leg satisfies the gate and records its 10 USD into the epoch bucket.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Execute 3 authorize+finalize cycles
    for (let i = 0; i < 3; i++) {
      const sessionPda = deriveSessionPda(
        vault.vaultPda,
        agent.publicKey,
        mintA,
        program.programId,
      );
      await authorizeAndFinalize({
        connection,
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(10_000_000),
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentMintAAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(10_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
    }

    // Verify vault stats reflect the 3 transactions
    const vaultData = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultData.totalTransactions.toNumber()).to.equal(3);
    console.log(
      `    Vault has ${vaultData.totalTransactions.toNumber()} transactions`,
    );
  });

  it("5. agent_transfer spends tracked alongside session spends", async () => {
    const vault = vaults[4]; // dailyCap 100 USD, maxTx 100 USD

    // M1: the session-spend legs must ACQUIRE a vault-owned output (else 6112).
    // One acquiring-swap fixture reused by both session legs; agentMintAAta is
    // the USDC inputSink. (The agent_transfer leg below is a SEPARATE instruction
    // — not a finalize sandwich — so the M1 gate does not apply to it.)
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Session spend 50
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(50_000_000),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentMintAAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(50_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // agent_transfer 50 — spendDest is allowlisted on this vault (V2 requires
    // an explicitly allowlisted destination owner).
    const { getOrCreateAssociatedTokenAccount } =
      await import("@solana/spl-token");
    const dest = spendDest;
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintA,
      dest.publicKey,
    );
    // Live policy_version (apply_agent_grant seating bumped it past 0) +
    // versioned send (a failure surfaces as {Custom:N}, not the .rpc() mask).
    const livePolicy = await program.account.policyConfig.fetch(
      vault.policyPda,
    );
    const transferIx = await program.methods
      .agentTransfer(new BN(50_000_000), (livePolicy as any).policyVersion)
      .accounts({
        agent: agent.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        tracker: vault.trackerPda,
        agentSpendOverlay: vault.overlayPda,
        vaultTokenAccount: vault.vaultTokenAta,
        tokenMintAccount: mintA,
        destinationTokenAccount: destAta.address,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: vault.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await sendVersionedTx(connection, [transferIx], agent);

    // Now at 100 USD (50 session + 50 agent_transfer) — 1 more should fail. The
    // swap satisfies M1 so execution reaches the rolling-cap check, which reverts.
    const sessionPda2 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorizeAndFinalize({
        connection,
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda: sessionPda2,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(1_000_000),
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentMintAAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(1_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err, { name: "SpendingCapExceeded" });
    }
    console.log("    Session + agent_transfer spends tracked together at cap");
  });

  it("6. queue/cancel policy update + spend within original cap", async () => {
    // Vault with 500M cap — high enough for two spends without needing a mid-test change.
    // With mandatory 30-min timelock, we can't apply policy changes on devnet in a test.
    // Instead we verify: (a) queue works, (b) pending values correct, (c) cancel works,
    // (d) spending under the original cap succeeds.
    const vault = vaults[5]; // dailyCap 500 USD, maxTx 300 USD

    // M1 + 6115: both spends must ACQUIRE a vault-owned output and move real
    // stablecoin so finalize measures actual_spend > 0 and the 300M total
    // accumulates under the original 500M cap (else 6112/6115 before tracking).
    // One acquiring-swap fixture reused by both legs.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Spend 100M (first spend)
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentMintAAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Queue a policy cap change (verify queue mechanism works on devnet).
    // queue_policy_update requires the correctly-merged post-change digest.
    const queueDigest = await buildQueueDigest(
      program,
      vault.policyPda,
      vault.vaultPda,
      { dailySpendingCapUsd: new BN(1_000_000_000) },
    );
    await program.methods
      .queuePolicyUpdate(
        new BN(1_000_000_000),
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
        null, // operating_hours (TA-05 Phase 3)
        null, // stable_balance_floor (TA-12 Phase 5)
        null, // per_recipient_daily_cap_usd (TA-14 Phase 5)
        null, // cosign_required (G6 audit 2026-05-18)
        null,
        null, // cosign_session_pubkey (D-5 Phase 10a-B7)
        PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
        queueDigest,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Verify the pending update was created with correct values
    const pendingAccount = await program.account.pendingPolicyUpdate.fetch(
      vault.pendingPolicyPda,
    );
    expect(pendingAccount.dailySpendingCapUsd!.toNumber()).to.equal(
      1_000_000_000,
    );
    console.log("    Queue policy update succeeded, pending cap = 1B");

    // Cancel the pending update (can't wait 30min on devnet)
    await program.methods
      .cancelPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        pendingPolicy: vault.pendingPolicyPda,
      } as any)
      .rpc();

    // Verify policy unchanged after cancel
    const policy = await program.account.policyConfig.fetch(vault.policyPda);
    expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);
    console.log("    Cancel succeeded, cap still 500M");

    // Spend 200M more (within original 500M cap — total now 300M < 500M)
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionB,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(200_000_000),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentMintAAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(200_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });
    console.log(
      "    Second spend succeeded under original 500M cap (300M total)",
    );
  });
});
