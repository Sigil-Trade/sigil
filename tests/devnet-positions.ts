/**
 * Devnet Position Tests — 5 tests (V3)
 *
 * Position tracking: open/close, max concurrent limit,
 * vault close prevention, and failed-open non-increment.
 *
 * V3: Composed TX model (validate + finalize in same tx).
 *     closePosition is non-spending: amount=0, no fees.
 *     openPosition is spending: fees collected, cap checked.
 *     Stablecoin-only architecture (custom test mints).
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  deriveSessionPda,
  createFullVault,
  authorizeAndFinalize,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  expectError,
  FullVaultResult,
} from "./helpers/devnet-setup";

describe("devnet-positions", () => {
  const { provider, program, connection, owner } = getDevnetProvider();
  const payer = (owner as any).payer;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let mint: PublicKey;
  let agentMintAta: PublicKey; // agent ATA for mock DeFi spend destination

  before(async () => {
    await fundKeypair(provider, agent.publicKey);
    mint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
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
  });

  /** Create a position-enabled vault */
  async function createPositionVault(maxPositions: number = 3) {
    return createFullVault({
      program,
      connection,
      owner,
      agent,
      feeDestination: feeDestination.publicKey,
      mint,
      vaultId: nextVaultId(7),
      dailyCap: new BN(5_000_000_000), // 5000 USD — plenty of room
      maxTx: new BN(1_000_000_000),
      allowedProtocols: [jupiterProgramId],
      maxLevBps: 5000,
      maxPositions,
      canOpenPositions: true,
      depositAmount: new BN(5_000_000_000),
    });
  }

  /** Open a position (composed validate + finalize) */
  async function openPosition(
    vault: FullVaultResult,
    mockSpendDest?: PublicKey,
  ) {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
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
      mint,
      amount: new BN(10_000_000), // openPosition is spending
      protocol: jupiterProgramId,
      protocolTreasuryAta: vault.protocolTreasuryAta,
      feeDestinationAta: null,
      mockSpendDestination: mockSpendDest ?? null,
    });
  }

  /** Close a position (non-spending: amount=0, no fees) */
  async function closePosition(vault: FullVaultResult) {
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
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
      mint,
      amount: new BN(0), // closePosition is non-spending: amount must be 0
      protocol: jupiterProgramId,
      protocolTreasuryAta: null, // no fees for non-spending
      feeDestinationAta: null,
    });
  }

  it("1. openPosition increments counter", async () => {
    const vault = await createPositionVault();
    await openPosition(vault, agentMintAta);

    const v = await program.account.agentVault.fetch(vault.vaultPda);
    expect(v.openPositions).to.equal(1);
    console.log("    openPositions == 1 after opening 1 position");
  });

  it("2. closePosition decrements counter", async () => {
    const vault = await createPositionVault();
    await openPosition(vault, agentMintAta);

    const vBefore = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vBefore.openPositions).to.equal(1);

    await closePosition(vault);

    const vAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vAfter.openPositions).to.equal(0);
    console.log("    openPositions == 0 after open + close");
  });

  it("3. max_concurrent_positions enforced (TooManyPositions)", async () => {
    const vault = await createPositionVault(3);

    // Open 3 positions
    for (let i = 0; i < 3; i++) {
      await openPosition(vault, agentMintAta);
    }

    const v = await program.account.agentVault.fetch(vault.vaultPda);
    expect(v.openPositions).to.equal(3);

    // 4th should fail
    const sessionPda = deriveSessionPda(
      vault.vaultPda,
      agent.publicKey,
      mint,
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
        mint,
        amount: new BN(10_000_000),
        protocol: jupiterProgramId,
        protocolTreasuryAta: vault.protocolTreasuryAta,
        feeDestinationAta: null,
        mockSpendDestination: agentMintAta,
      });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "TooManyPositions", "positions");
    }
    console.log("    max_concurrent_positions=3 enforced on 4th open");
  });

  it("4. close_vault with open positions fails", async () => {
    const vault = await createPositionVault();
    await openPosition(vault, agentMintAta);

    // Try close — should fail due to open positions
    try {
      // First withdraw all tokens to prepare for close
      const { getAccount } = await import("@solana/spl-token");
      const vaultAccount = await getAccount(connection, vault.vaultTokenAta);
      if (Number(vaultAccount.amount) > 0) {
        await program.methods
          .withdrawFunds(new BN(Number(vaultAccount.amount)))
          .accounts({
            owner: owner.publicKey,
            vault: vault.vaultPda,
            mint,
            vaultTokenAccount: vault.vaultTokenAta,
            ownerTokenAccount: vault.ownerTokenAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc();
      }

      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: vault.vaultPda,
          policy: vault.policyPda,
          tracker: vault.trackerPda,
          agentSpendOverlay: vault.overlayPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectError(err, "OpenPositionsExist", "open positions");
    }
    console.log("    close_vault blocked with open positions");
  });

  it("5. openPosition with zero actual spend does not increment counter", async () => {
    const vault = await createPositionVault();

    const vBefore = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vBefore.openPositions).to.equal(0);

    // Open with mock DeFi (no actual token movement → actual_spend=0 → no position update)
    await openPosition(vault);

    const vAfter = await program.account.agentVault.fetch(vault.vaultPda);
    expect(vAfter.openPositions).to.equal(0);
    console.log("    Failed openPosition: counter stays at 0");
  });
});
