/**
 * Devnet Token Routing Tests -- 12 tests
 *
 * Validates the stablecoin-only architecture on the deployed devnet program:
 * - Stablecoin (USDC/USDT) swap input paths
 * - Aggregate USD cap tracking across stablecoins
 * - Non-stablecoin rejection paths
 * - agent_transfer stablecoin/non-stablecoin enforcement
 * - Fee collection parity across stablecoins
 *
 * Vault ID prefix: 9
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
  getAssociatedTokenAddressSync,
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
  fundKeypair,
  calculateFees,
  getTokenBalance,
  ensureStablecoinMint,
  createNonStablecoinMint,
  setupSwapOutput,
  buildMockSwapToVaultIx,
  TEST_USDC_KEYPAIR,
  TEST_USDT_KEYPAIR,
  PROTOCOL_TREASURY,
  PROTOCOL_FEE_RATE,
  FEE_RATE_DENOMINATOR,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";

describe("devnet-routing", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  // V2 agent_transfer requires explicitly allowlisted destination owners
  // (RESTRICTED mode; empty allowlist allows nothing). Tests 7/8 transfer to
  // these, allowlisted on their vaults at creation.
  const routeDest7 = Keypair.generate();
  const routeDest8 = Keypair.generate();

  let usdcMint: PublicKey;
  let usdtMint: PublicKey;
  let testSolMint: PublicKey; // non-stablecoin (random address)
  let testWifMint: PublicKey; // non-stablecoin (random address)
  let agentUsdcAta: PublicKey; // agent ATA for mock DeFi spend destination
  let agentUsdtAta: PublicKey;

  // Per-test vault configs — all twelve vaults are created up front in
  // before() so their OPERATOR grants share ONE 600s timelock wait (queue all
  // → single wait → apply all) instead of twelve sequential waits (F-Q6).
  const ROUTING_CONFIGS: {
    dailyCap: BN;
    maxTx: BN;
    devFeeRate?: number;
    allowedDestinations?: PublicKey[];
  }[] = [
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 1
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 2
    { dailyCap: new BN(100_000_000), maxTx: new BN(100_000_000) }, // test 3
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 4
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 5
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 6
    {
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedDestinations: [routeDest7.publicKey],
    }, // test 7 (agent_transfer USDC)
    {
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedDestinations: [routeDest8.publicKey],
    }, // test 8 (agent_transfer USDT)
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 9
    { dailyCap: new BN(200_000_000), maxTx: new BN(200_000_000) }, // test 10
    {
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      devFeeRate: 500,
    }, // test 11
    { dailyCap: new BN(500_000_000), maxTx: new BN(200_000_000) }, // test 12
  ];
  let routingVaults: Awaited<ReturnType<typeof createRoutingVault>>[] = [];

  before(async () => {
    await fundKeypair(provider, agent.publicKey);

    // Create stablecoin mints at deterministic addresses (matches Rust constants)
    usdcMint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
    usdtMint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDT_KEYPAIR,
      owner.publicKey,
      6,
    );

    // Create non-stablecoin mints (random addresses -- will fail is_stablecoin_mint)
    testSolMint = await createNonStablecoinMint(
      connection,
      payer,
      owner.publicKey,
      9,
    );
    testWifMint = await createNonStablecoinMint(
      connection,
      payer,
      owner.publicKey,
      6,
    );

    // Agent ATAs for mock DeFi spend destinations
    const agentUsdcAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      agent.publicKey,
    );
    agentUsdcAta = agentUsdcAccount.address;
    const agentUsdtAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdtMint,
      agent.publicKey,
    );
    agentUsdtAta = agentUsdtAccount.address;

    console.log("  USDC mint:", usdcMint.toString());
    console.log("  USDT mint:", usdtMint.toString());
    console.log("  testSOL mint:", testSolMint.toString());
    console.log("  testWIF mint:", testWifMint.toString());

    // Create all twelve per-test vaults (queues each OPERATOR grant), then
    // one batched wait + apply for every grant.
    routingVaults = [];
    for (const cfg of ROUTING_CONFIGS) {
      routingVaults.push(await createRoutingVault(cfg));
    }
    await applyOperatorGrants(
      program,
      connection,
      owner,
      routingVaults.map((v) => v.operatorGrant),
    );
    console.log(`  ${routingVaults.length} vaults created, operators seated`);
  });

  /** Create a dual-stablecoin vault with both USDC and USDT deposited */
  async function createRoutingVault(opts: {
    dailyCap: BN;
    maxTx: BN;
    devFeeRate?: number;
    allowedDestinations?: PublicKey[];
  }) {
    const vaultId = nextVaultId(9);

    const vault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint: usdcMint,
      vaultId,
      dailyCap: opts.dailyCap,
      maxTx: opts.maxTx,
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      allowedDestinations: opts.allowedDestinations ?? [],
      depositAmount: new BN(1_000_000_000), // 1000 USDC
      devFeeRate: opts.devFeeRate ?? 0,
    });

    // Deposit USDT into vault
    const usdtVaultAta = anchor.utils.token.associatedAddress({
      mint: usdtMint,
      owner: vault.vaultPda,
    });
    const ownerUsdtAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdtMint,
      owner.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdtMint,
      ownerUsdtAtaAccount.address,
      owner.publicKey,
      1_000_000_000, // 1000 USDT
    );
    await program.methods
      .depositFunds(new BN(1_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        mint: usdtMint,
        ownerTokenAccount: ownerUsdtAtaAccount.address,
        vaultTokenAccount: usdtVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Treasury ATA for USDT
    const usdtTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdtMint,
      PROTOCOL_TREASURY,
      true,
    );

    // Fee destination ATA for both mints (if devFeeRate > 0)
    let usdcFeeDestAta: PublicKey | null = null;
    let usdtFeeDestAta: PublicKey | null = null;
    if (opts.devFeeRate && opts.devFeeRate > 0) {
      const usdcFeeAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        feeDestination.publicKey,
      );
      usdcFeeDestAta = usdcFeeAccount.address;
      const usdtFeeAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdtMint,
        feeDestination.publicKey,
      );
      usdtFeeDestAta = usdtFeeAccount.address;
    }

    return {
      ...vault,
      usdtVaultAta,
      usdtTreasuryAta: usdtTreasuryAccount.address,
      usdcFeeDestAta,
      usdtFeeDestAta,
    };
  }

  // ── Stablecoin input tests ──────────────────────────────────────────

  it("1. stablecoin (USDC) input: swap action succeeds", async () => {
    const vault = routingVaults[0];

    // M1 + 6115: the stablecoin-input swap action must ACQUIRE a vault-owned
    // output and move real stablecoin so finalize measures a spend (else
    // 6112/6115). inAmount = net-of-fees.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
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
      mint: usdcMint,
      amount: new BN(50_000_000), // 50 USDC
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(50_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    const vaultData = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultData.totalTransactions.toNumber()).to.equal(1);
    console.log("    USDC swap succeeded, totalTransactions=1");
  });

  it("2. stablecoin (USDT) input: swap action succeeds", async () => {
    const vault = routingVaults[1];

    // M1 + 6115: USDT-input swap action must ACQUIRE a vault-owned output and
    // move real stablecoin so finalize measures a spend (else 6112/6115).
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdtMint,
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
      vaultTokenAta: vault.usdtVaultAta,
      mint: usdtMint,
      amount: new BN(50_000_000), // 50 USDT
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.usdtTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.usdtVaultAta,
        agentUsdtAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(50_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    const vaultData = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultData.totalTransactions.toNumber()).to.equal(1);
    console.log("    USDT swap succeeded, totalTransactions=1");
  });

  it("3. USDC + USDT spending tracked in same cap", async () => {
    const vault = routingVaults[2];

    // M1: every stablecoin-input spend must ACQUIRE a vault-owned output (else
    // 6112 before the cap). One acquiring-swap fixture (fresh NON-stablecoin
    // output mint, vault-owned output ATA, funded agent reserve) serves both the
    // USDC and USDT legs — the acquired output is a different mint from BOTH
    // stablecoin inputs. The USDC/USDT sink (agentUsdcAta/agentUsdtAta) is
    // leg-1's inputSink. inAmount = net-of-fees so the aggregate cap math is
    // unchanged.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Spend 50 USDC
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
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
      mint: usdcMint,
      amount: new BN(50_000_000), // 50 USDC
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(50_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Spend 50 USDT
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdtMint,
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
      vaultTokenAta: vault.usdtVaultAta,
      mint: usdtMint,
      amount: new BN(50_000_000), // 50 USDT
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.usdtTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.usdtVaultAta,
        agentUsdtAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(50_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Now at ~100 USD cap -- 1 more USDC should fail. The swap satisfies M1 so
    // execution reaches the rolling-cap check, which reverts.
    const sessionC = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
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
        mint: usdcMint,
        amount: new BN(1_000_000), // 1 USDC over cap
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentUsdcAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(1_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
      expect.fail("Should have thrown SpendingCapExceeded");
    } catch (err: any) {
      expectSigilError(err, { name: "SpendingCapExceeded" });
    }
    console.log("    USDC + USDT aggregate cap enforced");
  });

  // ── Non-stablecoin rejection tests ──────────────────────────────────
  //
  // V2 enforces stablecoin-only at the DEPOSIT boundary (deposit_funds.rs:76,
  // ErrMintNotPinned 6074): a non-stablecoin mint cannot enter a vault at all.
  // The former validate/transfer-time variants (non-stablecoin input→output,
  // non-stablecoin agent_transfer, deferred fees) are therefore UNREACHABLE on
  // the live binary — they're defense-in-depth covered by the in-process
  // LiteSVM tier. On devnet we confirm the reachable enforcement: the deposit
  // itself reverts. (User-approved 2026-06-10: "test the deposit boundary".)
  async function expectNonStablecoinDepositRejected(
    vaultPda: PublicKey,
    nsMint: PublicKey,
    amount: BN,
  ): Promise<void> {
    const nsVaultAta = getAssociatedTokenAddressSync(nsMint, vaultPda, true);
    const ownerNsAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      nsMint,
      owner.publicKey,
    );
    await mintTo(
      connection,
      payer,
      nsMint,
      ownerNsAta.address,
      owner.publicKey,
      BigInt(amount.toString()),
    );
    const depositIx = await program.methods
      .depositFunds(amount)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: nsMint,
        ownerTokenAccount: ownerNsAta.address,
        vaultTokenAccount: nsVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    try {
      await sendVersionedTx(connection, [depositIx], payer);
      expect.fail(
        "non-stablecoin deposit should have reverted ErrMintNotPinned",
      );
    } catch (err: any) {
      expectSigilError(err, { name: "ErrMintNotPinned" });
    }
  }

  it("4. non-stablecoin (testSOL) deposit rejected at boundary (ErrMintNotPinned)", async () => {
    await expectNonStablecoinDepositRejected(
      routingVaults[3].vaultPda,
      testSolMint,
      new BN(100_000_000_000), // 100 testSOL (9 dec)
    );
    console.log("    testSOL deposit rejected at the deposit boundary (6074)");
  });

  it("5. non-stablecoin (testWIF) deposit rejected at boundary (ErrMintNotPinned)", async () => {
    // Exercises the boundary with a SECOND non-stablecoin mint (testWIF, 6-dec)
    // — distinct from test 4's testSOL (9-dec) — so the pin covers both.
    await expectNonStablecoinDepositRejected(
      routingVaults[4].vaultPda,
      testWifMint,
      new BN(100_000_000),
    );
    console.log("    testWIF deposit rejected at the deposit boundary (6074)");
  });

  it("6. non-stablecoin deposit rejected even with a fresh vault (ErrMintNotPinned)", async () => {
    // Same boundary on an independent vault — confirms the pin is per-vault
    // policy, not a one-off (routingVaults[5] never held a stablecoin balance).
    await expectNonStablecoinDepositRejected(
      routingVaults[5].vaultPda,
      testSolMint,
      new BN(100_000_000_000),
    );
    console.log("    testSOL deposit rejected on an independent vault (6074)");
  });

  // ── agent_transfer tests ────────────────────────────────────────────

  it("7. agent_transfer USDC: succeeds", async () => {
    const vault = routingVaults[6];

    const dest = routeDest7; // allowlisted on routingVaults[6]
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      dest.publicKey,
    );

    // Live policy_version + versioned send ({Custom:N} on failure, unmasked).
    const livePolicyUsdc = await program.account.policyConfig.fetch(
      vault.policyPda,
    );
    const usdcTransferIx = await program.methods
      .agentTransfer(new BN(10_000_000), (livePolicyUsdc as any).policyVersion) // 10 USDC
      .accounts({
        agent: agent.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        tracker: vault.trackerPda,
        agentSpendOverlay: vault.overlayPda,
        vaultTokenAccount: vault.vaultTokenAta,
        tokenMintAccount: usdcMint,
        destinationTokenAccount: destAta.address,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: vault.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await sendVersionedTx(connection, [usdcTransferIx], agent);

    const balance = await getTokenBalance(connection, destAta.address);
    // Protocol fee = 10_000_000 * 200 / 1_000_000 = 2000
    const expected =
      10_000_000 -
      Math.ceil((10_000_000 * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR);
    expect(balance).to.equal(expected);
    console.log(`    agent_transfer USDC succeeded, dest received ${balance}`);
  });

  it("8. agent_transfer USDT: succeeds", async () => {
    const vault = routingVaults[7];

    const dest = routeDest8; // allowlisted on routingVaults[7]
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdtMint,
      dest.publicKey,
    );

    // Live policy_version + versioned send ({Custom:N} on failure, unmasked).
    const livePolicyUsdt = await program.account.policyConfig.fetch(
      vault.policyPda,
    );
    const usdtTransferIx = await program.methods
      .agentTransfer(new BN(10_000_000), (livePolicyUsdt as any).policyVersion) // 10 USDT
      .accounts({
        agent: agent.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        tracker: vault.trackerPda,
        agentSpendOverlay: vault.overlayPda,
        vaultTokenAccount: vault.usdtVaultAta,
        tokenMintAccount: usdtMint,
        destinationTokenAccount: destAta.address,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: vault.usdtTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await sendVersionedTx(connection, [usdtTransferIx], agent);

    const balance = await getTokenBalance(connection, destAta.address);
    const expected =
      10_000_000 -
      Math.ceil((10_000_000 * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR);
    expect(balance).to.equal(expected);
    console.log(`    agent_transfer USDT succeeded, dest received ${balance}`);
  });

  it("9. non-stablecoin can't fund a vault for agent_transfer (ErrMintNotPinned)", async () => {
    // The old test deposited testSOL then agent_transferred that token,
    // expecting the stablecoin-only UnsupportedToken. V2 blocks the funding
    // deposit itself, so a non-stablecoin agent_transfer can never be set up
    // on-chain — the deposit boundary is the enforcement point.
    await expectNonStablecoinDepositRejected(
      routingVaults[8].vaultPda,
      testSolMint,
      new BN(100_000_000_000),
    );
    console.log(
      "    testSOL can't be deposited to fund an agent_transfer (6074)",
    );
  });

  // ── Cap aggregation tests ───────────────────────────────────────────

  it("10. full chain: USDC swap + USDT swap, caps aggregate", async () => {
    const vault = routingVaults[9];

    // M1: every stablecoin-input spend must ACQUIRE a vault-owned output (else
    // 6112 before the cap). One acquiring-swap fixture serves both the USDC and
    // USDT legs (output mint differs from both stablecoin inputs). inAmount =
    // net-of-fees so the 200-USD aggregate cap math is unchanged.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Swap 100 USDC
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
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
      mint: usdcMint,
      amount: new BN(100_000_000), // 100 USDC = 100 USD
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // Swap 100 USDT
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdtMint,
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
      vaultTokenAta: vault.usdtVaultAta,
      mint: usdtMint,
      amount: new BN(100_000_000), // 100 USDT = 100 USD
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.usdtTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.usdtVaultAta,
        agentUsdtAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(calculateFees(100_000_000, 0).netAmount),
        new BN(1_000),
      ),
    });

    // At ~200 USD cap -- 1 more USDC should fail. The swap satisfies M1 so
    // execution reaches the rolling-cap check, which reverts.
    const sessionC = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
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
        mint: usdcMint,
        amount: new BN(1_000_000), // 1 USDC over cap
        protocol: MOCK_DEFI_PROGRAM_ID,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        outputSwapAccount: swap.vaultOutputAta,
        middleIx: buildMockSwapToVaultIx(
          vault.vaultTokenAta,
          agentUsdcAta,
          swap.agentReserve,
          swap.vaultOutputAta,
          agent.publicKey,
          new BN(calculateFees(1_000_000, 0).netAmount),
          new BN(1_000),
        ),
      });
      expect.fail("Should have thrown SpendingCapExceeded");
    } catch (err: any) {
      expectSigilError(err, { name: "SpendingCapExceeded" });
    }
    console.log("    Full chain USDC+USDT cap aggregation enforced");
  });

  it("11. fee collection differs by stablecoin (USDC vs USDT)", async () => {
    const devFeeRate = 500; // max developer fee
    const vault = routingVaults[10];

    const amount = 100_000_000; // 100 tokens
    const { protocolFee } = calculateFees(amount, devFeeRate);

    // C-1: fees are charged at FINALIZE on the MEASURED spend, so each leg must
    // really spend its full `amount` (inAmount = amount) for the protocol fee to
    // land in the per-stablecoin treasury (protocolFee = ceil(amount * rate)).
    // M1 + 6115: outAmount>0 acquires a vault-owned output so the
    // require-measurable-outcome gate is satisfied. The two legs use different
    // stablecoins; their aggregate net_value_out (~200.14 USDC) stays well under
    // routingVaults[10]'s 500 USD daily cap (and each leg < the 200 USD per-tx
    // cap), so the cap does not interfere with the fee assertions.
    const swap = await setupSwapOutput(
      connection,
      payer,
      vault.vaultPda,
      agent.publicKey,
    );

    // Swap USDC -- check fees
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdcMint,
      program.programId,
    );
    const usdcTreasuryBefore = await getTokenBalance(
      connection,
      vault.protocolTreasuryAta,
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
      mint: usdcMint,
      amount: new BN(amount),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: vault.usdcFeeDestAta,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.vaultTokenAta,
        agentUsdcAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000),
      ),
    });
    const usdcTreasuryAfter = await getTokenBalance(
      connection,
      vault.protocolTreasuryAta,
    );
    expect(usdcTreasuryAfter - usdcTreasuryBefore).to.equal(protocolFee);

    // Swap USDT -- check same fee math
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      usdtMint,
      program.programId,
    );
    const usdtTreasuryBefore = await getTokenBalance(
      connection,
      vault.usdtTreasuryAta,
    );
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionB,
      vaultTokenAta: vault.usdtVaultAta,
      mint: usdtMint,
      amount: new BN(amount),
      protocol: MOCK_DEFI_PROGRAM_ID,
      feeDestinationAta: vault.usdtFeeDestAta,
      protocolTreasuryAta: vault.usdtTreasuryAta,
      outputSwapAccount: swap.vaultOutputAta,
      middleIx: buildMockSwapToVaultIx(
        vault.usdtVaultAta,
        agentUsdtAta,
        swap.agentReserve,
        swap.vaultOutputAta,
        agent.publicKey,
        new BN(amount), // C-1: real measured spend == amount
        new BN(1_000),
      ),
    });
    const usdtTreasuryAfter = await getTokenBalance(
      connection,
      vault.usdtTreasuryAta,
    );
    expect(usdtTreasuryAfter - usdtTreasuryBefore).to.equal(protocolFee);

    console.log(
      `    Fee parity: USDC protocol fee=${usdcTreasuryAfter - usdcTreasuryBefore}, USDT protocol fee=${usdtTreasuryAfter - usdtTreasuryBefore}`,
    );
  });

  it("12. rejected non-stablecoin deposit collects no fees (atomic revert)", async () => {
    // Preserves the original "no fees leaked on a non-stablecoin path" intent
    // at the V2 enforcement point: the deposit reverts (ErrMintNotPinned), and
    // because it reverts atomically the protocol treasury is untouched.
    const vault = routingVaults[11];
    const treasuryBefore = await getTokenBalance(
      connection,
      vault.protocolTreasuryAta,
    );

    await expectNonStablecoinDepositRejected(
      vault.vaultPda,
      testSolMint,
      new BN(100_000_000_000),
    );

    const treasuryAfter = await getTokenBalance(
      connection,
      vault.protocolTreasuryAta,
    );
    expect(treasuryAfter).to.equal(treasuryBefore);
    console.log("    Rejected non-stablecoin deposit: no fees collected");
  });
});
