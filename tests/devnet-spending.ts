/**
 * Devnet Spending Tests — 6 tests (V2)
 *
 * Aggregate USD caps, max_transaction_size_usd enforcement, and
 * agent_transfer spending tracked alongside session spends.
 *
 * V2: No per-token caps or rolling_spends. Tracker uses zero-copy epoch buckets.
 *     No recentTransactions. Tokens managed via OracleRegistry.
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  derivePDAs,
  deriveSessionPda,
  deriveOracleRegistryPda,
  initializeOracleRegistry,
  updateOracleRegistry,
  makeOracleEntry,
  createFullVault,
  authorize,
  finalize,
  authorizeAndFinalize,
  fundKeypair,
  expectError,
  FullVaultResult,
  PROTOCOL_TREASURY,
} from "./helpers/devnet-setup";

describe("devnet-spending", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mintA: PublicKey; // 6 decimals (USDC-like stablecoin)
  let mintB: PublicKey; // 9 decimals (SOL-like stablecoin, oracleFeed=default)
  let oracleRegistryPda: PublicKey;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    mintA = await createMint(connection, payer, owner.publicKey, null, 6);
    mintB = await createMint(connection, payer, owner.publicKey, null, 9);
    console.log("  MintA (6 dec):", mintA.toString());
    console.log("  MintB (9 dec):", mintB.toString());

    // Initialize oracle registry with both mints as stablecoins
    oracleRegistryPda = await initializeOracleRegistry(program, owner, [
      makeOracleEntry(mintA),
      makeOracleEntry(mintB),
    ]);
  });

  /** Helper to create a two-token vault and deposit both mints */
  async function createDualTokenVault(opts: { dailyCap: BN; maxTx: BN }) {
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
      allowedProtocols: [jupiterProgramId],
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
      500_000_000_000, // 500 tokens (9 dec)
    );
    await program.methods
      .depositFunds(new BN(500_000_000_000))
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
    const vault = await createDualTokenVault({
      dailyCap: new BN(200_000_000), // 200 USD
      maxTx: new BN(200_000_000),
    });

    // Spend 100 USDC via mintA (6 dec, stablecoin -> 1:1 USD)
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda: sessionA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000), // 100 USDC
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });

    // Spend 100 mintB (9 dec stablecoin -> USD conversion)
    // For 9-decimal stablecoin: amount / 10^(9-6) = USD
    // 100 tokens = 100_000_000_000 (9 dec), USD = 100_000_000_000 / 1000 = 100_000_000
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintB,
      program.programId,
    );
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda: sessionB,
      vaultTokenAta: vault.mintBVaultAta,
      mint: mintB,
      amount: new BN(100_000_000_000), // 100 tokens (9 dec) = 100 USD
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.mintBTreasuryAta,
    });

    // Now at 200 USD cap — 1 more of either should fail
    const sessionC = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        oracleRegistryPda: vault.oracleRegistryPda,
        sessionPda: sessionC,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(1_000_000), // 1 USDC more
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "DailyCapExceeded", "cap");
    }
    console.log("    Aggregate USD cap enforced across two tokens");
  });

  it("2. spending exactly at cap boundary succeeds", async () => {
    const vault = await createDualTokenVault({
      dailyCap: new BN(100_000_000), // 100 USD
      maxTx: new BN(100_000_000),
    });

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    // Spend exactly 100 USDC = cap
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000),
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });
    console.log("    Spend exactly at cap boundary succeeded (<=)");
  });

  it("3. max_transaction_size_usd enforced", async () => {
    const vault = await createDualTokenVault({
      dailyCap: new BN(500_000_000),
      maxTx: new BN(50_000_000), // 50 USD max per tx
    });

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        oracleRegistryPda: vault.oracleRegistryPda,
        sessionPda,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(51_000_000), // 51 > maxTx=50
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TransactionTooLarge", "maximum");
    }
    console.log("    max_transaction_size_usd enforced");
  });

  it("4. multiple spend cycles tracked in epoch buckets", async () => {
    const vault = await createDualTokenVault({
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
    });

    // Execute 3 authorize+finalize cycles
    for (let i = 0; i < 3; i++) {
      const sessionPda = deriveSessionPda(
        vault.vaultPda,
        agent.publicKey,
        mintA,
        program.programId,
      );
      await authorizeAndFinalize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        oracleRegistryPda: vault.oracleRegistryPda,
        sessionPda,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(10_000_000),
        protocol: jupiterProgramId,
        feeDestinationAta: null,
        protocolTreasuryAta: vault.protocolTreasuryAta,
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
    const vault = await createDualTokenVault({
      dailyCap: new BN(100_000_000), // 100 USD total
      maxTx: new BN(100_000_000),
    });

    // Session spend 50
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(50_000_000),
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });

    // agent_transfer 50
    const { getOrCreateAssociatedTokenAccount } =
      await import("@solana/spl-token");
    const dest = Keypair.generate();
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintA,
      dest.publicKey,
    );
    await program.methods
      .agentTransfer(new BN(50_000_000))
      .accounts({
        agent: agent.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
        tracker: vault.trackerPda,
        oracleRegistry: vault.oracleRegistryPda,
        vaultTokenAccount: vault.vaultTokenAta,
        tokenMintAccount: mintA,
        destinationTokenAccount: destAta.address,
        feeDestinationTokenAccount: null,
        protocolTreasuryTokenAccount: vault.protocolTreasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([agent])
      .rpc();

    // Now at 100 USD — 1 more should fail
    const sessionPda2 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    try {
      await authorize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        oracleRegistryPda: vault.oracleRegistryPda,
        sessionPda: sessionPda2,
        vaultTokenAta: vault.vaultTokenAta,
        mint: mintA,
        amount: new BN(1_000_000),
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "DailyCapExceeded", "cap");
    }
    console.log("    Session + agent_transfer spends tracked together at cap");
  });

  it("6. update_policy changes daily cap (V2: no tracker in updatePolicy)", async () => {
    const vault = await createDualTokenVault({
      dailyCap: new BN(200_000_000),
      maxTx: new BN(200_000_000),
    });

    // Spend some
    const sessionA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda: sessionA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(100_000_000),
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });

    // Update daily cap higher (V2: no tracker account, no allowedTokens param)
    await program.methods
      .updatePolicy(
        new BN(500_000_000), // new daily cap
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      )
      .accounts({
        owner: owner.publicKey,
        vault: vault.vaultPda,
        policy: vault.policyPda,
      } as any)
      .rpc();

    // Verify policy changed
    const policy = await program.account.policyConfig.fetch(vault.policyPda);
    expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);

    // Can spend more with increased cap
    const sessionB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    await authorizeAndFinalize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      oracleRegistryPda: vault.oracleRegistryPda,
      sessionPda: sessionB,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(200_000_000),
      protocol: jupiterProgramId,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });
    console.log("    Daily cap updated and additional spend succeeded");
  });
});
