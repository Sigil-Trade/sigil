/**
 * Devnet Security Tests — 11 tests (V2)
 *
 * Adversarial access control tests against the live deployed program.
 * Confirms the same constraints that LiteSVM tests verify actually hold
 * on the deployed devnet binary.
 *
 *     Stablecoin-only architecture. Non-stablecoin tokens -> TokenNotRegistered.
 *     updatePolicy: no tracker in accounts.
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
  createFullVault,
  authorize,
  finalize,
  fundKeypair,
  expectError,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-security", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const attacker = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mint: PublicKey;
  let unregisteredMint: PublicKey; // non-stablecoin mint
  let vault: FullVaultResult;
  let vaultId: BN;

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    await fundKeypair(provider, attacker.publicKey);

    mint = await createMint(connection, payer, owner.publicKey, null, 6);
    unregisteredMint = await createMint(
      connection,
      payer,
      owner.publicKey,
      null,
      6,
    );

    vaultId = nextVaultId(4);

    vault = await createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId,
      dailyCap: new BN(100_000_000), // 100 USDC
      maxTx: new BN(50_000_000), // 50 USDC max per tx
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(1_000_000_000),
    });

    console.log("  Security test vault:", vault.vaultPda.toString());
    console.log("  Attacker:", attacker.publicKey.toString());
  });

  it("1. non-owner cannot update_policy", async () => {
    try {
      await program.methods
        .updatePolicy(
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
        )
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Non-owner update_policy rejected");
  });

  it("2. non-owner cannot revoke_agent", async () => {
    try {
      await program.methods
        .revokeAgent()
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Non-owner revoke_agent rejected");
  });

  it("3. non-owner cannot withdraw_funds", async () => {
    try {
      const attackerAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        attacker.publicKey,
      );
      const attackerAta = attackerAtaAccount.address;
      await program.methods
        .withdrawFunds(new BN(1_000_000))
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
          mint,
          vaultTokenAccount: vault.vaultTokenAta,
          ownerTokenAccount: attackerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Non-owner withdraw_funds rejected");
  });

  it("4. non-owner cannot close_vault", async () => {
    try {
      await program.methods
        .closeVault()
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          tracker: vault.trackerPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Non-owner close_vault rejected");
  });

  it("5. non-agent cannot validate_and_authorize", async () => {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      attacker.publicKey,
      mint,
      program.programId,
    );
    try {
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          mint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
        )
        .accounts({
          agent: attacker.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          tracker: vault.trackerPda,
          session: sessionPda,
          vaultTokenAccount: vault.vaultTokenAta,
          tokenMintAccount: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "UnauthorizedAgent", "unauthorized", "constraint");
    }
    console.log("    Non-agent validate_and_authorize rejected");
  });

  it("6. agent cannot call update_policy (owner-only)", async () => {
    try {
      await program.methods
        .updatePolicy(
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
        )
        .accounts({
          owner: agent.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
        } as any)
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Agent update_policy rejected (owner-only)");
  });

  it("7. over-cap spending blocked with DailyCapExceeded", async () => {
    // Spend 40 USDC (within maxTx=50)
    const sessionPda1 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPda1,
      vaultTokenAta: vault.vaultTokenAta,
      mint,
      amount: new BN(40_000_000), // 40 USDC
      protocol: jupiterProgramId,
    });
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPda1,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: true,
    });

    const sessionPda2 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
      program.programId,
    );
    await authorize({
      program,
      agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPda2,
      vaultTokenAta: vault.vaultTokenAta,
      mint,
      amount: new BN(40_000_000),
      protocol: jupiterProgramId,
    });
    await finalize({
      program,
      payer: agent,
      vaultPda: vault.vaultPda,
      policyPda: vault.policyPda,
      trackerPda: vault.trackerPda,
      sessionPda: sessionPda2,
      agentPubkey: agent.publicKey,
      vaultTokenAta: vault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      success: true,
    });

    // Now at 80 USDC of 100 cap — try 21 more to exceed
    const sessionPda3 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
      program.programId,
    );
    try {
      await authorize({
        program,
        agent,
        vaultPda: vault.vaultPda,
        policyPda: vault.policyPda,
        trackerPda: vault.trackerPda,
        sessionPda: sessionPda3,
        vaultTokenAta: vault.vaultTokenAta,
        mint,
        amount: new BN(21_000_000), // 21 USDC — exceeds remaining 20
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "DailyCapExceeded", "cap");
    }
    console.log("    Over-cap spending correctly blocked");
  });

  it("8. aggregate TransactionTooLarge enforced (maxTx=50)", async () => {
    // maxTx=50 USDC for the vault — try 51
    // Need a fresh vault since the cap on the main vault is spent
    const freshVaultId = nextVaultId(4);
    const freshAgent = Keypair.generate();
    await fundKeypair(provider, freshAgent.publicKey);

    const freshVault = await createFullVault({
      program,
      connection,
      owner,
      agent: freshAgent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: freshVaultId,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(50_000_000), // 50 USDC max per tx
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(500_000_000),
    });

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );

    try {
      await authorize({
        program,
        agent: freshAgent,
        vaultPda: freshVault.vaultPda,
        policyPda: freshVault.policyPda,
        trackerPda: freshVault.trackerPda,
        sessionPda,
        vaultTokenAta: freshVault.vaultTokenAta,
        mint,
        amount: new BN(51_000_000), // 51 > maxTx=50
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TransactionTooLarge", "maximum");
    }
    console.log("    Aggregate TransactionTooLarge enforced");
  });

  it("9. double-finalize same session fails", async () => {
    const freshVaultId = nextVaultId(4);
    const freshAgent = Keypair.generate();
    await fundKeypair(provider, freshAgent.publicKey);

    const freshVault = await createFullVault({
      program,
      connection,
      owner,
      agent: freshAgent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: freshVaultId,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(500_000_000),
    });

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      program,
      agent: freshAgent,
      vaultPda: freshVault.vaultPda,
      policyPda: freshVault.policyPda,
      trackerPda: freshVault.trackerPda,
      sessionPda,
      vaultTokenAta: freshVault.vaultTokenAta,
      mint,
      amount: new BN(10_000_000),
      protocol: jupiterProgramId,
    });

    // First finalize succeeds
    await finalize({
      program,
      payer: freshAgent,
      vaultPda: freshVault.vaultPda,
      policyPda: freshVault.policyPda,
      trackerPda: freshVault.trackerPda,
      sessionPda,
      agentPubkey: freshAgent.publicKey,
      vaultTokenAta: freshVault.vaultTokenAta,
      feeDestinationAta: null,
      protocolTreasuryAta: freshVault.protocolTreasuryAta,
      success: true,
    });

    // Second finalize fails (session PDA closed)
    try {
      await finalize({
        program,
        payer: freshAgent,
        vaultPda: freshVault.vaultPda,
        policyPda: freshVault.policyPda,
        trackerPda: freshVault.trackerPda,
        sessionPda,
        agentPubkey: freshAgent.publicKey,
        vaultTokenAta: freshVault.vaultTokenAta,
        feeDestinationAta: null,
        protocolTreasuryAta: freshVault.protocolTreasuryAta,
        success: true,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(
        err,
        "AccountNotInitialized",
        "not found",
        "not exist",
        "3012",
      );
    }
    console.log("    Double-finalize correctly rejected");
  });

  it("10. frozen vault blocks validate_and_authorize", async () => {
    const freshVaultId = nextVaultId(4);
    const freshAgent = Keypair.generate();
    await fundKeypair(provider, freshAgent.publicKey);

    const freshVault = await createFullVault({
      program,
      connection,
      owner,
      agent: freshAgent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: freshVaultId,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(500_000_000),
    });

    // Freeze vault — revokeAgent sets status=Frozen AND clears the agent field.
    // The on-chain constraint checks agent identity before vault status, so
    // the error will be UnauthorizedAgent (agent cleared) rather than VaultNotActive.
    await program.methods
      .revokeAgent()
      .accounts({ owner: owner.publicKey, vault: freshVault.vaultPda } as any)
      .rpc();

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );

    try {
      await authorize({
        program,
        agent: freshAgent,
        vaultPda: freshVault.vaultPda,
        policyPda: freshVault.policyPda,
        trackerPda: freshVault.trackerPda,
        sessionPda,
        vaultTokenAta: freshVault.vaultTokenAta,
        mint,
        amount: new BN(10_000_000),
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      // revokeAgent clears the agent, so the first constraint hit is UnauthorizedAgent
      expectError(
        err,
        "UnauthorizedAgent",
        "VaultNotActive",
        "not active",
        "unauthorized",
      );
    }
    console.log("    Frozen vault blocks authorize");
  });

  it("11. frozen vault still allows deposit and withdraw", async () => {
    const freshVaultId = nextVaultId(4);
    const freshAgent = Keypair.generate();
    await fundKeypair(provider, freshAgent.publicKey);

    const freshVault = await createFullVault({
      program,
      connection,
      owner,
      agent: freshAgent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: freshVaultId,
      dailyCap: new BN(500_000_000),
      maxTx: new BN(200_000_000),
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(500_000_000),
    });

    // Freeze
    await program.methods
      .revokeAgent()
      .accounts({ owner: owner.publicKey, vault: freshVault.vaultPda } as any)
      .rpc();

    // Deposit should succeed even when frozen
    // Mint more to owner's ATA
    await mintTo(
      connection,
      payer,
      mint,
      freshVault.ownerTokenAta,
      owner.publicKey,
      100_000_000,
    );

    await program.methods
      .depositFunds(new BN(100_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        mint,
        ownerTokenAccount: freshVault.ownerTokenAta,
        vaultTokenAccount: freshVault.vaultTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Withdraw should also succeed
    await program.methods
      .withdrawFunds(new BN(50_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        mint,
        vaultTokenAccount: freshVault.vaultTokenAta,
        ownerTokenAccount: freshVault.ownerTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    console.log("    Frozen vault: deposit + withdraw succeeded");
  });
});
