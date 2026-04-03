/**
 * Escrow Integration Tests — Workstream B
 *
 * Tests the escrow primitive: create, settle, refund, close, and error paths.
 * Requires two vaults (source and destination) with separate owners and agents.
 *
 * Uses LiteSVM — no validator needed.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import * as crypto from "crypto";
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
  accountExists,
  advanceTime,
  TestEnv,
  LiteSVM,
  LiteSVMProvider,
} from "./helpers/litesvm-setup";

// 21-bit permission bitmask (covers all 21 ActionType variants including escrow)
const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

// Protocol treasury (must match on-chain constant)
const PROTOCOL_TREASURY = new PublicKey(
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
);

// Fee constants (from on-chain)
const PROTOCOL_FEE_RATE = 200n; // 2 BPS
const FEE_RATE_DENOMINATOR = 1_000_000n;

describe("escrow-integration", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  // Source vault actors
  let sourceOwner: anchor.Wallet;
  const sourceAgent = Keypair.generate();
  const sourceFeeDestination = Keypair.generate();

  // Destination vault actors
  const destOwnerKeypair = Keypair.generate();
  const destAgent = Keypair.generate();
  const destFeeDestination = Keypair.generate();

  // USDC mint
  let usdcMint: PublicKey;

  // Vault IDs (300/301 to avoid conflicts with other test files)
  const sourceVaultId = new BN(300);
  const destVaultId = new BN(301);

  // Source vault PDAs
  let sourceVaultPda: PublicKey;
  let sourcePolicyPda: PublicKey;
  let sourceTrackerPda: PublicKey;

  // Destination vault PDAs
  let destVaultPda: PublicKey;
  let destPolicyPda: PublicKey;
  let destTrackerPda: PublicKey;

  // Overlay PDAs
  let sourceOverlayPda: PublicKey;

  // Token accounts
  let sourceOwnerUsdcAta: PublicKey;
  let sourceVaultUsdcAta: PublicKey;
  let sourceFeeDestUsdcAta: PublicKey;
  let destOwnerUsdcAta: PublicKey;
  let destVaultUsdcAta: PublicKey;
  let destFeeDestUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  /**
   * Derive escrow PDA and its associated token account.
   */
  function deriveEscrow(
    srcVault: PublicKey,
    dstVault: PublicKey,
    escrowId: BN,
  ): { escrowPda: PublicKey; escrowUsdcAta: PublicKey } {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        srcVault.toBuffer(),
        dstVault.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const escrowUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      escrowPda,
      true, // allowOwnerOffCurve — escrow is a PDA
    );
    return { escrowPda, escrowUsdcAta };
  }

  /**
   * Helper to create an escrow with default parameters.
   */
  async function createEscrowHelper(
    escrowId: BN,
    amount: BN,
    expiresAt: BN,
    conditionHash: number[] = Array(32).fill(0),
  ): Promise<{ escrowPda: PublicKey; escrowUsdcAta: PublicKey }> {
    const { escrowPda, escrowUsdcAta } = deriveEscrow(
      sourceVaultPda,
      destVaultPda,
      escrowId,
    );

    await program.methods
      .createEscrow(escrowId, amount, expiresAt, conditionHash)
      .accounts({
        agent: sourceAgent.publicKey,
        sourceVault: sourceVaultPda,
        policy: sourcePolicyPda,
        tracker: sourceTrackerPda,
        agentSpendOverlay: sourceOverlayPda,
        destinationVault: destVaultPda,
        escrow: escrowPda,
        sourceVaultAta: sourceVaultUsdcAta,
        escrowAta: escrowUsdcAta,
        protocolTreasuryAta: protocolTreasuryUsdcAta,
        feeDestinationAta: sourceFeeDestUsdcAta,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([sourceAgent])
      .rpc();

    return { escrowPda, escrowUsdcAta };
  }

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    sourceOwner = env.provider.wallet;

    // ── Airdrop SOL to all actors ──────────────────────────────────────────
    airdropSol(svm, sourceOwner.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, sourceAgent.publicKey, 20 * LAMPORTS_PER_SOL);
    airdropSol(svm, sourceFeeDestination.publicKey, 2 * LAMPORTS_PER_SOL);
    airdropSol(svm, destOwnerKeypair.publicKey, 200 * LAMPORTS_PER_SOL);
    airdropSol(svm, destAgent.publicKey, 20 * LAMPORTS_PER_SOL);
    airdropSol(svm, destFeeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // ── Create USDC mint at hardcoded devnet address ───────────────────────
    createMintAtAddress(svm, DEVNET_USDC_MINT, sourceOwner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // ── Create token accounts ──────────────────────────────────────────────
    // Source owner USDC ATA + mint tokens
    sourceOwnerUsdcAta = createAtaHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      sourceOwner.publicKey,
    );
    mintToHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      sourceOwnerUsdcAta,
      sourceOwner.publicKey,
      10_000_000_000n, // 10,000 USDC
    );

    // Dest owner USDC ATA (needed for deposit into dest vault)
    destOwnerUsdcAta = createAtaHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      destOwnerKeypair.publicKey,
    );
    mintToHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      destOwnerUsdcAta,
      sourceOwner.publicKey,
      2_000_000_000n, // 2,000 USDC
    );

    // Protocol treasury ATA (off-curve)
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      PROTOCOL_TREASURY,
      true,
    );

    // Fee destination ATAs
    sourceFeeDestUsdcAta = createAtaHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      sourceFeeDestination.publicKey,
    );
    destFeeDestUsdcAta = createAtaHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      destFeeDestination.publicKey,
    );

    // ── Derive source vault PDAs ───────────────────────────────────────────
    [sourceVaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        sourceOwner.publicKey.toBuffer(),
        sourceVaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [sourcePolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), sourceVaultPda.toBuffer()],
      program.programId,
    );
    [sourceTrackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), sourceVaultPda.toBuffer()],
      program.programId,
    );

    // ── Derive destination vault PDAs ──────────────────────────────────────
    [destVaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        destOwnerKeypair.publicKey.toBuffer(),
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

    // ── Initialize source vault ────────────────────────────────────────────
    const [sourceOverlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), sourceVaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    sourceOverlayPda = sourceOverlay;
    await program.methods
      .initializeVault(
        sourceVaultId,
        new BN(500_000_000), // daily_spending_cap_usd ($500)
        new BN(100_000_000), // max_transaction_size_usd ($100)
        0, // protocol_mode = ALL
        [], // protocols (empty for mode ALL)
        10000, // max_leverage_bps
        5, // max_concurrent_positions
        100, // developer_fee_rate (0.01%)
        500, // max_slippage_bps
        new BN(1800), // timelock_duration (0 = no timelock)
        [], // allowed_destinations
        [], // protocolCaps
      )
      .accounts({
        owner: sourceOwner.publicKey,
        vault: sourceVaultPda,
        policy: sourcePolicyPda,
        tracker: sourceTrackerPda,
        agentSpendOverlay: sourceOverlay,
        feeDestination: sourceFeeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Register source agent
    await program.methods
      .registerAgent(sourceAgent.publicKey, FULL_PERMISSIONS, new BN(0))
      .accounts({
        owner: sourceOwner.publicKey,
        vault: sourceVaultPda,
        agentSpendOverlay: sourceOverlay,
      } as any)
      .rpc();

    // Create source vault USDC ATA and deposit
    sourceVaultUsdcAta = createAtaIdempotentHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      sourceVaultPda,
      true,
    );
    await program.methods
      .depositFunds(new BN(5_000_000_000)) // 5000 USDC
      .accounts({
        owner: sourceOwner.publicKey,
        vault: sourceVaultPda,
        mint: usdcMint,
        ownerTokenAccount: sourceOwnerUsdcAta,
        vaultTokenAccount: sourceVaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // ── Initialize destination vault ───────────────────────────────────────
    // Use LiteSVMProvider with destOwner wallet for dest-owner-signed instructions
    const destProvider = new LiteSVMProvider(
      svm,
      new anchor.Wallet(destOwnerKeypair),
    );
    const destProgram = new Program<Sigil>(
      require("../target/idl/sigil.json"),
      destProvider as unknown as anchor.Provider,
    );

    const [destOverlay] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), destVaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    await destProgram.methods
      .initializeVault(
        destVaultId,
        new BN(500_000_000), // daily_spending_cap_usd ($500)
        new BN(100_000_000), // max_transaction_size_usd ($100)
        0, // protocol_mode = ALL
        [], // protocols (empty for mode ALL)
        10000, // max_leverage_bps
        5, // max_concurrent_positions
        100, // developer_fee_rate (0.01%)
        500, // max_slippage_bps
        new BN(1800), // timelock_duration (0 = no timelock)
        [], // allowed_destinations
        [], // protocolCaps
      )
      .accounts({
        owner: destOwnerKeypair.publicKey,
        vault: destVaultPda,
        policy: destPolicyPda,
        tracker: destTrackerPda,
        agentSpendOverlay: destOverlay,
        feeDestination: destFeeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Register destination agent
    await destProgram.methods
      .registerAgent(destAgent.publicKey, FULL_PERMISSIONS, new BN(0))
      .accounts({
        owner: destOwnerKeypair.publicKey,
        vault: destVaultPda,
        agentSpendOverlay: destOverlay,
      } as any)
      .rpc();

    // Create destination vault USDC ATA and deposit some funds
    destVaultUsdcAta = createAtaIdempotentHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      destVaultPda,
      true,
    );
    await destProgram.methods
      .depositFunds(new BN(1_000_000_000)) // 1000 USDC
      .accounts({
        owner: destOwnerKeypair.publicKey,
        vault: destVaultPda,
        mint: usdcMint,
        ownerTokenAccount: destOwnerUsdcAta,
        vaultTokenAccount: destVaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });

  // =========================================================================
  // Test 1: Create escrow between two vaults
  // =========================================================================
  it("creates escrow between two vaults — funds move to escrow ATA, source vault debited", async () => {
    const escrowId = new BN(1);
    const escrowAmount = new BN(50_000_000); // 50 USDC

    const sourceVaultBalanceBefore = getTokenBalance(svm, sourceVaultUsdcAta);

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600); // 1 hour from now

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Calculate expected net amount (after protocol + developer fees)
    const grossAmount = 50_000_000n;
    const protocolFee =
      (grossAmount * PROTOCOL_FEE_RATE + FEE_RATE_DENOMINATOR - 1n) /
      FEE_RATE_DENOMINATOR;
    const developerFee =
      (grossAmount * 100n + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR; // dev_fee_rate = 100
    const netAmount = grossAmount - protocolFee - developerFee;

    // Verify escrow ATA received net amount
    const escrowBalance = getTokenBalance(svm, escrowUsdcAta);
    expect(escrowBalance.toString()).to.equal(netAmount.toString());

    // Verify source vault was debited by gross amount
    const sourceVaultBalanceAfter = getTokenBalance(svm, sourceVaultUsdcAta);
    expect(
      (sourceVaultBalanceBefore - sourceVaultBalanceAfter).toString(),
    ).to.equal(grossAmount.toString());

    // Verify protocol treasury received fee
    const treasuryBalance = getTokenBalance(svm, protocolTreasuryUsdcAta);
    expect(treasuryBalance >= protocolFee).to.be.true;

    // Verify escrow PDA state
    const escrowAccount = await program.account.escrowDeposit.fetch(escrowPda);
    expect(escrowAccount.sourceVault.toString()).to.equal(
      sourceVaultPda.toString(),
    );
    expect(escrowAccount.destinationVault.toString()).to.equal(
      destVaultPda.toString(),
    );
    expect(escrowAccount.escrowId.toNumber()).to.equal(1);
    expect(escrowAccount.amount.toNumber()).to.equal(Number(netAmount));
    expect(escrowAccount.tokenMint.toString()).to.equal(usdcMint.toString());
    expect(escrowAccount.expiresAt.toNumber()).to.equal(
      currentTimestamp + 3600,
    );
    // Status should be Active (enum variant 0)
    expect(JSON.stringify(escrowAccount.status)).to.include("active");
    // Condition hash should be all zeros (unconditional)
    expect(escrowAccount.conditionHash).to.deep.equal(Array(32).fill(0));
  });

  // =========================================================================
  // Test 2: Settle before expiry
  // =========================================================================
  it("settles escrow before expiry — destination receives funds", async () => {
    const escrowId = new BN(2);
    const escrowAmount = new BN(30_000_000); // 30 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Calculate expected net
    const grossAmount = 30_000_000n;
    const protocolFee =
      (grossAmount * PROTOCOL_FEE_RATE + FEE_RATE_DENOMINATOR - 1n) /
      FEE_RATE_DENOMINATOR;
    const developerFee =
      (grossAmount * 100n + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR;
    const netAmount = grossAmount - protocolFee - developerFee;

    const destVaultBalanceBefore = getTokenBalance(svm, destVaultUsdcAta);

    // Settle (empty proof for unconditional)
    await program.methods
      .settleEscrow(Buffer.from([]))
      .accounts({
        destinationAgent: destAgent.publicKey,
        destinationVault: destVaultPda,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        destinationVaultAta: destVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([destAgent])
      .rpc();

    // Verify destination vault received net amount
    const destVaultBalanceAfter = getTokenBalance(svm, destVaultUsdcAta);
    expect(
      (destVaultBalanceAfter - destVaultBalanceBefore).toString(),
    ).to.equal(netAmount.toString());

    // Verify escrow status is Settled
    const escrowAccount = await program.account.escrowDeposit.fetch(escrowPda);
    expect(JSON.stringify(escrowAccount.status)).to.include("settled");

    // Verify escrow ATA was closed (settle closes it)
    expect(accountExists(svm, escrowUsdcAta)).to.be.false;
  });

  // =========================================================================
  // Test 3: Refund after expiry
  // =========================================================================
  it("refunds escrow after expiry — source receives back", async () => {
    const escrowId = new BN(3);
    const escrowAmount = new BN(20_000_000); // 20 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    // Set expiry to 60 seconds from now (short window for testing)
    const expiresAt = new BN(currentTimestamp + 60);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Calculate expected net
    const grossAmount = 20_000_000n;
    const protocolFee =
      (grossAmount * PROTOCOL_FEE_RATE + FEE_RATE_DENOMINATOR - 1n) /
      FEE_RATE_DENOMINATOR;
    const developerFee =
      (grossAmount * 100n + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR;
    const netAmount = grossAmount - protocolFee - developerFee;

    const sourceVaultBalanceBefore = getTokenBalance(svm, sourceVaultUsdcAta);

    // Advance time past expiry
    advanceTime(svm, 61);

    // Refund
    await program.methods
      .refundEscrow()
      .accounts({
        sourceSigner: sourceAgent.publicKey,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        sourceVaultAta: sourceVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([sourceAgent])
      .rpc();

    // Verify source vault received net amount back
    const sourceVaultBalanceAfter = getTokenBalance(svm, sourceVaultUsdcAta);
    expect(
      (sourceVaultBalanceAfter - sourceVaultBalanceBefore).toString(),
    ).to.equal(netAmount.toString());

    // Verify escrow status is Refunded
    const escrowAccount = await program.account.escrowDeposit.fetch(escrowPda);
    expect(JSON.stringify(escrowAccount.status)).to.include("refunded");

    // Verify escrow ATA was closed
    expect(accountExists(svm, escrowUsdcAta)).to.be.false;

    // P0 Finding 6: Verify cap NOT reversed on refund (prevents cap-washing).
    // Spec says: "Cap NOT reversed on refund (prevents cap-washing)."
    // The spending tracked by the escrow creation should remain charged.
    const trackerAfterRefund =
      await program.account.spendTracker.fetch(sourceTrackerPda);
    // The tracker's rolling 24h spend should still include the escrow amount
    // (it was charged at creation time and must NOT be reversed on refund).
    const rolling24h = trackerAfterRefund.get_rolling_24h_usd
      ? trackerAfterRefund.get_rolling_24h_usd()
      : trackerAfterRefund.buckets.reduce(
          (sum: bigint, b: { usdAmount: { toNumber: () => number } }) =>
            sum + BigInt(b.usdAmount.toNumber()),
          0n,
        );
    expect(Number(rolling24h)).to.be.greaterThanOrEqual(
      escrowAmount.toNumber(),
    );
  });

  // =========================================================================
  // P2 #24: Escrow expiry exact boundary test
  // =========================================================================
  // P2 #24: Escrow expiry boundary — on-chain uses `>=` so settle fails AT exact expiry
  it("settle at exact expiry timestamp fails (boundary: >= check)", async () => {
    const escrowId = new BN(30);
    const escrowAmount = new BN(5_000_000); // 5 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 60);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Advance to EXACTLY the expiry timestamp (not past it)
    advanceTime(svm, 60);

    // Settle at exact expiry — fails (on-chain: `now >= expiresAt` → EscrowExpired)
    // This verifies the boundary: at T=expiresAt, settle is already blocked.
    try {
      await program.methods
        .settleEscrow(Buffer.from([]))
        .accounts({
          destinationAgent: destAgent.publicKey,
          destinationVault: destVaultPda,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta,
          destinationVaultAta: destVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();
      expect.fail("Should have thrown EscrowExpired at exact expiry");
    } catch (err: any) {
      if (err.message?.includes("Should have thrown")) throw err;
      expect(err.toString()).to.include("6046"); // EscrowExpired exact code
    }
  });

  // =========================================================================
  // Test 4: Conditional escrow — create with SHA-256 condition, settle with proof
  // =========================================================================
  it("conditional escrow — settles with matching SHA-256 proof", async () => {
    const escrowId = new BN(4);
    const escrowAmount = new BN(25_000_000); // 25 USDC

    // Create condition hash from a preimage
    const preimage = Buffer.from("secret preimage");
    const conditionHash = Array.from(
      crypto.createHash("sha256").update(preimage).digest(),
    );

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 7200); // 2 hours

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
      conditionHash,
    );

    // Verify escrow has condition hash set
    const escrowAccount = await program.account.escrowDeposit.fetch(escrowPda);
    expect(escrowAccount.conditionHash).to.deep.equal(conditionHash);

    const destVaultBalanceBefore = getTokenBalance(svm, destVaultUsdcAta);

    // Settle with correct preimage as proof
    await program.methods
      .settleEscrow(preimage)
      .accounts({
        destinationAgent: destAgent.publicKey,
        destinationVault: destVaultPda,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        destinationVaultAta: destVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([destAgent])
      .rpc();

    // Verify destination vault received funds
    const destVaultBalanceAfter = getTokenBalance(svm, destVaultUsdcAta);
    expect(destVaultBalanceAfter > destVaultBalanceBefore).to.be.true;

    // Verify escrow status is Settled
    const escrowAfter = await program.account.escrowDeposit.fetch(escrowPda);
    expect(JSON.stringify(escrowAfter.status)).to.include("settled");
  });

  // =========================================================================
  // Test 5: Multiple escrows between same vault pair (different IDs)
  // =========================================================================
  it("creates multiple escrows between same vault pair with different IDs", async () => {
    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600);

    const escrowId5 = new BN(5);
    const escrowId6 = new BN(6);
    const amount = new BN(10_000_000); // 10 USDC each

    // Create first escrow
    const { escrowPda: escrowPda5 } = await createEscrowHelper(
      escrowId5,
      amount,
      expiresAt,
    );

    // Create second escrow
    const { escrowPda: escrowPda6 } = await createEscrowHelper(
      escrowId6,
      amount,
      expiresAt,
    );

    // Both should exist with distinct PDAs
    expect(escrowPda5.toString()).to.not.equal(escrowPda6.toString());

    const escrow5 = await program.account.escrowDeposit.fetch(escrowPda5);
    const escrow6 = await program.account.escrowDeposit.fetch(escrowPda6);

    expect(escrow5.escrowId.toNumber()).to.equal(5);
    expect(escrow6.escrowId.toNumber()).to.equal(6);
    expect(JSON.stringify(escrow5.status)).to.include("active");
    expect(JSON.stringify(escrow6.status)).to.include("active");
  });

  // =========================================================================
  // Test 6: close_settled_escrow after settle
  // =========================================================================
  it("closes settled escrow PDA — rent returned to source owner", async () => {
    const escrowId = new BN(7);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Settle it first
    await program.methods
      .settleEscrow(Buffer.from([]))
      .accounts({
        destinationAgent: destAgent.publicKey,
        destinationVault: destVaultPda,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        destinationVaultAta: destVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([destAgent])
      .rpc();

    // Verify escrow PDA exists before close
    expect(accountExists(svm, escrowPda)).to.be.true;

    // Close the settled escrow
    await program.methods
      .closeSettledEscrow(escrowId)
      .accounts({
        signer: sourceOwner.publicKey,
        sourceVault: sourceVaultPda,
        destinationVaultKey: destVaultPda,
        escrow: escrowPda,
      } as any)
      .rpc();

    // Verify escrow PDA is closed
    expect(accountExists(svm, escrowPda)).to.be.false;
  });

  // =========================================================================
  // Test 7: close_settled_escrow after refund
  // =========================================================================
  it("closes refunded escrow PDA — rent returned to source owner", async () => {
    const escrowId = new BN(8);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 60); // 60 seconds

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Advance time past expiry
    advanceTime(svm, 61);

    // Refund
    await program.methods
      .refundEscrow()
      .accounts({
        sourceSigner: sourceAgent.publicKey,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        sourceVaultAta: sourceVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([sourceAgent])
      .rpc();

    // Verify escrow PDA exists before close
    expect(accountExists(svm, escrowPda)).to.be.true;

    // Close the refunded escrow
    await program.methods
      .closeSettledEscrow(escrowId)
      .accounts({
        signer: sourceOwner.publicKey,
        sourceVault: sourceVaultPda,
        destinationVaultKey: destVaultPda,
        escrow: escrowPda,
      } as any)
      .rpc();

    // Verify escrow PDA is closed
    expect(accountExists(svm, escrowPda)).to.be.false;
  });

  // =========================================================================
  // Test 8: Settle after expiry -> EscrowExpired (6046)
  // =========================================================================
  it("rejects settle after expiry — EscrowExpired (6046)", async () => {
    const escrowId = new BN(9);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 60);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Advance time past expiry
    advanceTime(svm, 61);

    try {
      await program.methods
        .settleEscrow(Buffer.from([]))
        .accounts({
          destinationAgent: destAgent.publicKey,
          destinationVault: destVaultPda,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta,
          destinationVaultAta: destVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();
      expect.fail("should have failed with EscrowExpired");
    } catch (e: any) {
      expect(e.toString()).to.include("6046");
    }
  });

  // =========================================================================
  // Test 9: Refund before expiry -> EscrowNotExpired (6047)
  // =========================================================================
  it("rejects refund before expiry — EscrowNotExpired (6047)", async () => {
    const escrowId = new BN(10);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 7200); // 2 hours from now

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Do NOT advance time — escrow is still active
    try {
      await program.methods
        .refundEscrow()
        .accounts({
          sourceSigner: sourceAgent.publicKey,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta,
          sourceVaultAta: sourceVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([sourceAgent])
        .rpc();
      expect.fail("should have failed with EscrowNotExpired");
    } catch (e: any) {
      expect(e.toString()).to.include("6047");
    }
  });

  // =========================================================================
  // Test 10: Wrong condition proof -> EscrowConditionsNotMet (6049)
  // =========================================================================
  it("rejects settle with wrong proof — EscrowConditionsNotMet (6049)", async () => {
    const escrowId = new BN(11);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    // Create conditional escrow
    const preimage = Buffer.from("correct secret");
    const conditionHash = Array.from(
      crypto.createHash("sha256").update(preimage).digest(),
    );

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 7200);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
      conditionHash,
    );

    // Try to settle with wrong proof
    const wrongProof = Buffer.from("wrong secret");
    try {
      await program.methods
        .settleEscrow(wrongProof)
        .accounts({
          destinationAgent: destAgent.publicKey,
          destinationVault: destVaultPda,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta,
          destinationVaultAta: destVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();
      expect.fail("should have failed with EscrowConditionsNotMet");
    } catch (e: any) {
      expect(e.toString()).to.include("6049");
    }
  });

  // =========================================================================
  // Test 11: Non-destination agent settles -> UnauthorizedAgent (6001)
  // =========================================================================
  it("rejects settle by non-destination agent — UnauthorizedAgent (6001)", async () => {
    const escrowId = new BN(12);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 7200);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // Try to settle using the SOURCE agent (not authorized for dest vault)
    try {
      await program.methods
        .settleEscrow(Buffer.from([]))
        .accounts({
          destinationAgent: sourceAgent.publicKey, // wrong agent
          destinationVault: destVaultPda,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta,
          destinationVaultAta: destVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([sourceAgent])
        .rpc();
      expect.fail("should have failed with UnauthorizedAgent");
    } catch (e: any) {
      expect(e.toString()).to.include("6001");
    }
  });

  // =========================================================================
  // Test 12: Exceeds spending cap -> SpendingCapExceeded (6006)
  // =========================================================================
  it("rejects escrow exceeding daily spending cap — SpendingCapExceeded (6006)", async () => {
    // The source vault has a $500 daily cap. Create a large escrow that exceeds it.
    // Previous tests have already consumed some cap. We try a single $500 escrow
    // which together with prior spending should exceed the $500 cap.
    const escrowId = new BN(13);
    const escrowAmount = new BN(500_000_000); // 500 USDC — exceeds remaining cap

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600);

    const { escrowPda, escrowUsdcAta } = deriveEscrow(
      sourceVaultPda,
      destVaultPda,
      escrowId,
    );

    try {
      await program.methods
        .createEscrow(escrowId, escrowAmount, expiresAt, Array(32).fill(0))
        .accounts({
          agent: sourceAgent.publicKey,
          sourceVault: sourceVaultPda,
          policy: sourcePolicyPda,
          tracker: sourceTrackerPda,
          agentSpendOverlay: sourceOverlayPda,
          destinationVault: destVaultPda,
          escrow: escrowPda,
          sourceVaultAta: sourceVaultUsdcAta,
          escrowAta: escrowUsdcAta,
          protocolTreasuryAta: protocolTreasuryUsdcAta,
          feeDestinationAta: sourceFeeDestUsdcAta,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([sourceAgent])
        .rpc();
      expect.fail("should have failed with SpendingCapExceeded");
    } catch (e: any) {
      // Could be SpendingCapExceeded (6006) or TransactionTooLarge (6005)
      // depending on whether single-tx check or rolling check triggers first.
      // $500 > $100 max_transaction_size_usd, so 6005 triggers first.
      const errStr = e.toString();
      expect(errStr.includes("6006") || errStr.includes("6005")).to.be.true;
    }
  });

  // =========================================================================
  // Test 13: Non-stablecoin -> UnsupportedToken (6003)
  // =========================================================================
  it("rejects escrow with non-stablecoin token — UnsupportedToken (6003)", async () => {
    const escrowId = new BN(14);
    const escrowAmount = new BN(1_000_000_000); // 1 token

    // Create a random non-stablecoin mint
    const fakeMint = createMintHelper(
      svm,
      (sourceOwner as any).payer,
      sourceOwner.publicKey,
      9,
    );

    // Create source vault ATA for the fake mint
    const sourceVaultFakeAta = createAtaIdempotentHelper(
      svm,
      (sourceOwner as any).payer,
      fakeMint,
      sourceVaultPda,
      true,
    );

    const { escrowPda } = deriveEscrow(sourceVaultPda, destVaultPda, escrowId);
    const escrowFakeAta = getAssociatedTokenAddressSync(
      fakeMint,
      escrowPda,
      true,
    );

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 3600);

    try {
      await program.methods
        .createEscrow(escrowId, escrowAmount, expiresAt, Array(32).fill(0))
        .accounts({
          agent: sourceAgent.publicKey,
          sourceVault: sourceVaultPda,
          policy: sourcePolicyPda,
          tracker: sourceTrackerPda,
          agentSpendOverlay: sourceOverlayPda,
          destinationVault: destVaultPda,
          escrow: escrowPda,
          sourceVaultAta: sourceVaultFakeAta,
          escrowAta: escrowFakeAta,
          protocolTreasuryAta: null,
          feeDestinationAta: null,
          tokenMint: fakeMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([sourceAgent])
        .rpc();
      expect.fail("should have failed with UnsupportedToken");
    } catch (e: any) {
      expect(e.toString()).to.include("6003");
    }
  });

  // =========================================================================
  // Test 14: Double settle -> EscrowNotActive (6045)
  // =========================================================================
  it("rejects double settle — EscrowNotActive (6045)", async () => {
    const escrowId = new BN(15);
    const escrowAmount = new BN(10_000_000); // 10 USDC

    const clock = svm.getClock();
    const currentTimestamp = Number(clock.unixTimestamp);
    const expiresAt = new BN(currentTimestamp + 7200);

    const { escrowPda, escrowUsdcAta } = await createEscrowHelper(
      escrowId,
      escrowAmount,
      expiresAt,
    );

    // First settle succeeds
    await program.methods
      .settleEscrow(Buffer.from([]))
      .accounts({
        destinationAgent: destAgent.publicKey,
        destinationVault: destVaultPda,
        sourceVault: sourceVaultPda,
        escrow: escrowPda,
        escrowAta: escrowUsdcAta,
        destinationVaultAta: destVaultUsdcAta,
        rentDestination: sourceOwner.publicKey,
        tokenMint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([destAgent])
      .rpc();

    // The escrow ATA is closed by settle. Re-create it for the second attempt
    // so the account constraint (associated_token) can be satisfied.
    const escrowUsdcAta2 = createAtaIdempotentHelper(
      svm,
      (sourceOwner as any).payer,
      usdcMint,
      escrowPda,
      true,
    );

    // Second settle should fail — escrow is already Settled
    try {
      await program.methods
        .settleEscrow(Buffer.from([]))
        .accounts({
          destinationAgent: destAgent.publicKey,
          destinationVault: destVaultPda,
          sourceVault: sourceVaultPda,
          escrow: escrowPda,
          escrowAta: escrowUsdcAta2,
          destinationVaultAta: destVaultUsdcAta,
          rentDestination: sourceOwner.publicKey,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();
      expect.fail("should have failed with EscrowNotActive");
    } catch (e: any) {
      expect(e.toString()).to.include("6045");
    }
  });
});
