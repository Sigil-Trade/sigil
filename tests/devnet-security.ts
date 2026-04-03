/**
 * Devnet Security Tests — 14 tests (V4)
 *
 * Adversarial access control tests against the live deployed program.
 * Confirms the same constraints that LiteSVM tests verify actually hold
 * on the deployed devnet binary.
 *
 *     Stablecoin-only architecture. Non-stablecoin tokens -> UnsupportedToken.
 *     V4: updatePolicy deleted; security tests use queuePolicyUpdate instead.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
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
  authorize,
  fundKeypair,
  expectError,
  ensureStablecoinMint,
  createNonStablecoinMint,
  TEST_USDC_KEYPAIR,
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
  let agentMintAta: PublicKey; // agent ATA for mock DeFi spend destination

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    await fundKeypair(provider, attacker.publicKey);

    mint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
    unregisteredMint = await createNonStablecoinMint(
      connection,
      payer,
      owner.publicKey,
      6,
    );

    // Agent ATA for mock DeFi spend destination
    const agentMintAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      agent.publicKey,
    );
    agentMintAta = agentMintAccount.address;

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

  it("1. non-owner cannot queue_policy_update", async () => {
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
          null, // sessionExpirySlots
          null, // hasProtocolCaps
          null, // protocolCaps
        )
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          pendingPolicy: vault.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Non-owner queue_policy_update rejected");
  });

  it("2. non-owner cannot revoke_agent", async () => {
    try {
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({
          owner: attacker.publicKey,
          vault: vault.vaultPda,
          agentSpendOverlay: vault.overlayPda,
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
          agentSpendOverlay: vault.overlayPda,
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
          new BN(0),
        )
        .accounts({
          agent: attacker.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          tracker: vault.trackerPda,
          session: sessionPda,
          agentSpendOverlay: vault.overlayPda,
          vaultTokenAccount: vault.vaultTokenAta,
          tokenMintAccount: mint,
          protocolTreasuryTokenAccount: null,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "UnauthorizedAgent", "unauthorized", "constraint");
    }
    console.log("    Non-agent validate_and_authorize rejected");
  });

  it("6. agent cannot call queue_policy_update (owner-only)", async () => {
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
          null, // sessionExpirySlots
          null, // hasProtocolCaps
          null, // protocolCaps
        )
        .accounts({
          owner: agent.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          pendingPolicy: vault.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "ConstraintSeeds", "Unauthorized", "2006", "constraint");
    }
    console.log("    Agent queue_policy_update rejected (owner-only)");
  });

  it("7. over-cap spending blocked with SpendingCapExceeded", async () => {
    // Spend 40 USDC twice (within maxTx=50 each, composed validate+finalize)
    const sessionPda1 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
      program.programId,
    );

    await authorize({
      connection,
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
      protocolTreasuryAta: vault.protocolTreasuryAta,
      mockSpendDestination: agentMintAta,
    });

    const sessionPda2 = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
      program.programId,
    );
    await authorize({
      connection,
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
      protocolTreasuryAta: vault.protocolTreasuryAta,
      mockSpendDestination: agentMintAta,
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
        connection,
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
        protocolTreasuryAta: vault.protocolTreasuryAta,
        mockSpendDestination: agentMintAta,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "SpendingCapExceeded", "cap");
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

    // Mock spend destination for freshAgent
    const freshAgentAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      freshAgent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );

    try {
      await authorize({
        connection,
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
        protocolTreasuryAta: freshVault.protocolTreasuryAta,
        mockSpendDestination: freshAgentAta.address,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TransactionTooLarge", "maximum");
    }
    console.log("    Aggregate TransactionTooLarge enforced");
  });

  it("9. back-to-back composed TXes reuse same session PDA", async () => {
    // With composed TX model, each authorize() does validate+finalize atomically.
    // The session PDA is created and closed within a single TX, so the same
    // session PDA (same vault+agent+mint) can be reused for subsequent TXes.
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

    // First composed TX
    await authorize({
      connection,
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
      protocolTreasuryAta: freshVault.protocolTreasuryAta,
    });

    // Session PDA closed after first TX
    const session1 = await connection.getAccountInfo(sessionPda);
    expect(session1).to.be.null;

    // Second composed TX — same session PDA works
    await authorize({
      connection,
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
      protocolTreasuryAta: freshVault.protocolTreasuryAta,
    });

    // Session PDA closed after second TX too
    const session2 = await connection.getAccountInfo(sessionPda);
    expect(session2).to.be.null;

    // Vault stats incremented by 2
    const v = await program.account.agentVault.fetch(freshVault.vaultPda);
    expect(v.totalTransactions.toNumber()).to.equal(2);
    console.log(
      "    Back-to-back composed TXes: session PDA reused successfully",
    );
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

    // Freeze vault — revokeAgent removes the agent and freezes if no agents remain.
    // The on-chain constraint checks agent identity before vault status, so
    // the error will be UnauthorizedAgent (agent removed) rather than VaultNotActive.
    await program.methods
      .revokeAgent(freshAgent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        agentSpendOverlay: freshVault.overlayPda,
      } as any)
      .rpc();

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );

    try {
      await authorize({
        connection,
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
      // revokeAgent removed the agent, so the first constraint hit is UnauthorizedAgent
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

    // Freeze — revoking the only agent freezes the vault
    await program.methods
      .revokeAgent(freshAgent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        agentSpendOverlay: freshVault.overlayPda,
      } as any)
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

  // ── Routing-aware security tests ──────────────────────────────────────

  it("12. non-stablecoin mint rejected in validate_and_authorize", async () => {
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

    // Deposit unregistered (non-stablecoin) mint into vault
    const unregVaultAta = anchor.utils.token.associatedAddress({
      mint: unregisteredMint,
      owner: freshVault.vaultPda,
    });
    const ownerUnregAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      unregisteredMint,
      owner.publicKey,
    );
    await mintTo(
      connection,
      payer,
      unregisteredMint,
      ownerUnregAta.address,
      owner.publicKey,
      500_000_000,
    );
    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        mint: unregisteredMint,
        ownerTokenAccount: ownerUnregAta.address,
        vaultTokenAccount: unregVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Try authorize with unregistered mint and no stablecoin output
    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      unregisteredMint,
      program.programId,
    );
    try {
      await authorize({
        connection,
        program,
        agent: freshAgent,
        vaultPda: freshVault.vaultPda,
        policyPda: freshVault.policyPda,
        trackerPda: freshVault.trackerPda,
        sessionPda,
        vaultTokenAta: unregVaultAta,
        mint: unregisteredMint,
        amount: new BN(10_000_000),
        protocol: jupiterProgramId,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "UnsupportedToken", "InvalidTokenAccount", "6014");
    }
    console.log("    Non-stablecoin mint rejected in validate_and_authorize");
  });

  it("13. frozen vault rejects agent_transfer with stablecoin", async () => {
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

    // Freeze vault by revoking the only agent
    await program.methods
      .revokeAgent(freshAgent.publicKey)
      .accounts({
        owner: owner.publicKey,
        vault: freshVault.vaultPda,
        agentSpendOverlay: freshVault.overlayPda,
      } as any)
      .rpc();

    // Try agent_transfer with stablecoin on frozen vault
    const dest = Keypair.generate();
    const destAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      dest.publicKey,
    );

    try {
      await program.methods
        .agentTransfer(new BN(10_000_000))
        .accounts({
          agent: freshAgent.publicKey,
          vault: freshVault.vaultPda,
          policy: freshVault.policyPda,
          tracker: freshVault.trackerPda,
          agentSpendOverlay: freshVault.overlayPda,
          vaultTokenAccount: freshVault.vaultTokenAta,
          tokenMintAccount: mint,
          destinationTokenAccount: destAta.address,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: freshVault.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([freshAgent])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "VaultNotActive", "UnauthorizedAgent", "not active");
    }
    console.log("    Frozen vault rejects agent_transfer with stablecoin");
  });

  it("14. max_transaction_size_usd enforced on stablecoin", async () => {
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
      maxTx: new BN(50_000_000), // 50 USD max per tx
      allowedProtocols: [jupiterProgramId],
      depositAmount: new BN(1_000_000_000),
    });

    // Mock spend destination for freshAgent
    const freshAgentAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      freshAgent.publicKey,
    );

    const sessionPda = deriveSessionPda(
      freshVault.vaultPda,
      freshAgent.publicKey,
      mint,
      program.programId,
    );
    try {
      await authorize({
        connection,
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
        protocolTreasuryAta: freshVault.protocolTreasuryAta,
        mockSpendDestination: freshAgentAta.address,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TransactionTooLarge", "maximum");
    }
    console.log("    max_transaction_size_usd enforced on stablecoin");
  });
});
