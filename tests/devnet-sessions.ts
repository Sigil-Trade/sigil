/**
 * Devnet Session Tests — 4 tests (V3)
 *
 * With the composed TX model (validate + finalize in same atomic transaction),
 * sessions are now transient — created and closed within a single TX.
 * Session expiry and permissionless cleanup are no longer testable because
 * the MissingFinalizeInstruction check (6028) prevents standalone validate.
 *
 * Tests cover composed TX success/failure paths, access control, and
 * sequential same-mint reuse.
 *
 *     Stablecoin-only architecture.
 *     finalizeSession includes policy and tracker accounts.
 */
// Strict error helpers assert the EXACT expected error code — see tests/helpers/strict-errors.ts
import { expectAnchorError } from "./helpers/strict-errors";
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  mintTo,
  getOrCreateAssociatedTokenAccount,
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
  buildAuthorizeIx,
  buildFinalizeIx,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  TEST_USDT_KEYPAIR,
  FullVaultResult,
  PROTOCOL_TREASURY,
  MOCK_DEFI_PROGRAM_ID,
} from "./helpers/devnet-setup";

describe("devnet-sessions", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const thirdParty = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let vault: FullVaultResult;
  let mintBVaultAta: PublicKey;
  let mintBTreasuryAta: PublicKey;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    await fundKeypair(provider, thirdParty.publicKey);

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

    vault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint: mintA,
      vaultId: nextVaultId(3),
      dailyCap: new BN(500_000_000),
      maxTx: new BN(100_000_000),
      allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
      depositAmount: new BN(500_000_000),
    });

    // F-Q6: the OPERATOR grant was QUEUED by createFullVault — wait out the
    // on-chain 600s single-key floor (real time; devnet has no clock
    // cheatcodes) and apply it. One batched wait for the whole file.
    await applyOperatorGrants(program, connection, owner, [
      vault.operatorGrant,
    ]);

    // Create vault ATA + deposit for mintB
    mintBVaultAta = anchor.utils.token.associatedAddress({
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
      500_000_000,
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
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const mintBTreasuryAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mintB,
      PROTOCOL_TREASURY,
      true,
    );
    mintBTreasuryAta = mintBTreasuryAccount.address;

    console.log("  Session tests vault:", vault.vaultPda.toString());
  });

  it("1. composed TX with success=true increments vault stats", async () => {
    const vaultBefore = await program.account.agentVault.fetch(vault.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    // Lifecycle/stats only (session closed + totalTransactions+1): NON-SPENDING
    // session (amount=0) — exempt from the require-measurable-outcome gate
    // (6115); totalTransactions still increments per finalize.
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
      amount: new BN(0),
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      feeDestinationAta: null,
    });

    // Session PDA closed atomically
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    // Stats incremented
    const vaultAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore + 1);
    console.log(
      "    Composed TX: session created + closed atomically, stats incremented",
    );
  });

  it("2. composed TX increments totalTransactions (success param removed)", async () => {
    const vaultBefore = await program.account.agentVault.fetch(vault.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    // Lifecycle/stats only (session closed + totalTransactions+1): NON-SPENDING
    // session (amount=0) — exempt from 6115; totalTransactions still increments.
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
      amount: new BN(0),
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      feeDestinationAta: null,
    });

    // Session PDA closed
    const sessionInfo = await connection.getAccountInfo(sessionPda);
    expect(sessionInfo).to.be.null;

    // Stats incremented (success param removed — every finalize counts)
    const vaultAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore + 1);
    console.log(
      "    composed TX: session closed, totalTransactions incremented",
    );
  });

  it("3. non-agent signer rejected in composed TX", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );

    // Build composed TX with thirdParty as signer (not the registered agent)
    const validateIx = await buildAuthorizeIx({
      program,
      connection,
      agent: thirdParty, // wrong signer
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(10_000_000),
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });
    const finalizeIx = await buildFinalizeIx({
      program,
      payer: thirdParty,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda,
      agentPubkey: thirdParty.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: thirdParty.publicKey,
      recentBlockhash: blockhash,
      instructions: [validateIx, finalizeIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([thirdParty]);

    try {
      await connection.sendTransaction(tx);
      expect.fail("Should have thrown");
    } catch (err: any) {
      // Session PDA seeds include agent key — wrong signer yields seed mismatch
      expectAnchorError(err, { name: "ConstraintSeeds", code: 2006 });
    }
    console.log("    Non-agent signer correctly rejected in composed TX");
  });

  it("4. sequential composed TXes with different mints succeed", async () => {
    const sessionPdaA = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintA,
      program.programId,
    );
    const sessionPdaB = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mintB,
      program.programId,
    );

    const vaultBefore = await program.account.agentVault.fetch(vault.vaultPda);
    const txCountBefore = vaultBefore.totalTransactions.toNumber();

    // Lifecycle/stats only (both sessions closed + totalTransactions+2):
    // NON-SPENDING sessions (amount=0) — exempt from 6115; the test exercises
    // per-mint concurrent session lifecycle, not spend magnitude.
    // Composed TX for mintA
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaA,
      vaultTokenAta: vault.vaultTokenAta,
      mint: mintA,
      amount: new BN(0),
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      feeDestinationAta: null,
    });

    // Composed TX for mintB
    await authorizeAndFinalize({
      connection,
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPdaB,
      vaultTokenAta: mintBVaultAta,
      mint: mintB,
      amount: new BN(0),
      protocol: MOCK_DEFI_PROGRAM_ID,
      protocolTreasuryAta: mintBTreasuryAta,
      feeDestinationAta: null,
    });

    // Both sessions closed
    expect(await connection.getAccountInfo(sessionPdaA)).to.be.null;
    expect(await connection.getAccountInfo(sessionPdaB)).to.be.null;

    // Stats incremented by 2
    const vaultAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore + 2);
    console.log(
      "    Sequential composed TXes with different mints: both succeeded",
    );
  });
});
