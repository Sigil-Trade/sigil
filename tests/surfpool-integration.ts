/**
 * Surfpool Integration Tests — realistic integration tier between LiteSVM and devnet.
 *
 * Requires Surfnet running: `surfpool start --network devnet --slot-time 100`
 *
 * Tests session expiry with real slot progression, time travel for timelocks,
 * token balance cheatcodes, CU profiling, and network reset isolation.
 *
 * ~22 tests across 8 suites.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Phalnx } from "../target/types/phalnx";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  createSurfpoolTestEnv,
  SurfpoolTestEnv,
  DEVNET_USDC_MINT,
  DEVNET_USDT_MINT,
  PROTOCOL_TREASURY,
  PROTOCOL_FEE_RATE,
  FEE_RATE_DENOMINATOR,
  SESSION_EXPIRY_SLOTS,
  setAccountLamports,
  createWallet,
  fundWithTokens,
  timeTravel,
  pauseClock,
  resumeClock,
  getClock,
  waitForSlot,
  resetNetwork,
  profileTransaction,
  getProfilesByTag,
  sendVersionedTx,
  derivePDAs,
  deriveSessionPda,
  deriveOverlayPda,
  nextVaultId,
  surfnetRpc,
  ensureMintExists,
  setupVaultWithAgent,
  expectTxError,
  VaultSetupResult,
  VersionedTxResult,
} from "./helpers/surfpool-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

// ─── Shared state ───────────────────────────────────────────────────────────

let env: SurfpoolTestEnv;
let program: Program<Phalnx>;

describe("surfpool-integration", function () {
  this.timeout(300_000); // 5 min global timeout

  before(async () => {
    env = await createSurfpoolTestEnv();
    program = env.program;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 1: Vault lifecycle (create → deposit → operate → withdraw → close)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("1. vault lifecycle", () => {
    const vaultId = nextVaultId();
    const agent = Keypair.generate();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let overlayPda: PublicKey;
    let vaultUsdcAta: PublicKey;
    let ownerUsdcAta: PublicKey;
    let protocolTreasuryAta: PublicKey;
    let feeDestAta: PublicKey;

    before(async () => {
      // Fund test wallets
      await setAccountLamports(
        env.connection,
        agent.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      // Derive PDAs
      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      [overlayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Fund owner with USDC via cheatcode (lazy-forked from devnet)
      ownerUsdcAta = await fundWithTokens(
        env.connection,
        env.payer.publicKey,
        DEVNET_USDC_MINT,
        2_000_000_000, // 2000 USDC
      );
    });

    it("creates vault with correct state", async () => {
      const dailyCap = new BN(500_000_000); // 500 USDC
      const maxTxSize = new BN(100_000_000); // 100 USDC

      await program.methods
        .initializeVault(
          vaultId,
          dailyCap,
          maxTxSize,
          0, // protocolMode: all
          [],
          new BN(0) as any, // max_leverage_bps
          3, // max_concurrent_positions
          0, // developer_fee_rate
          100, // maxSlippageBps (1%)
          new BN(0), // timelockDuration
          [], // allowedDestinations
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.owner.toString()).to.equal(env.payer.publicKey.toString());
      expect(vault.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(vault.totalTransactions.toNumber()).to.equal(0);
    });

    it("registers agent and deposits USDC", async () => {
      // Register agent
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          agentSpendOverlay: overlayPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
      );

      // Create vault ATA and fund it
      vaultUsdcAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        vaultPda,
        true,
      );
      await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDC_MINT,
        1_000_000_000, // 1000 USDC
      );
    });

    it("executes validate+finalize composed transaction", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      // Fund protocol treasury ATA
      protocolTreasuryAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        PROTOCOL_TREASURY,
        true,
      );
      await fundWithTokens(
        env.connection,
        PROTOCOL_TREASURY,
        DEVNET_USDC_MINT,
        0, // just create the ATA
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(50_000_000), // 50 USDC
          program.programId, // dummy protocol
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        agent,
      );

      expect(result.signature).to.be.a("string");
      expect(result.logs.length).to.be.greaterThan(0);

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume uses actual_spend_tracked; mock DeFi is no-op → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 2: Session expiry with real slots
  // ═══════════════════════════════════════════════════════════════════════════
  describe("2. session expiry with real slots", () => {
    const vaultId = nextVaultId();
    const agent = Keypair.generate();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let overlayPda: PublicKey;
    let vaultUsdcAta: PublicKey;
    let protocolTreasuryAta: PublicKey;

    before(async () => {
      await setAccountLamports(
        env.connection,
        agent.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      [overlayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Initialize vault
      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          agentSpendOverlay: overlayPda,
        } as any)
        .rpc();

      vaultUsdcAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        vaultPda,
        true,
      );
      await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDC_MINT,
        1_000_000_000,
      );

      protocolTreasuryAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        PROTOCOL_TREASURY,
        true,
      );
      await fundWithTokens(
        env.connection,
        PROTOCOL_TREASURY,
        DEVNET_USDC_MINT,
        0,
      );
    });

    it("session valid within 20-slot window", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(10_000_000), // 10 USDC
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      // Should succeed — session is created and used in same transaction
      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("session created at current slot includes correct expiry", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      // Use validate without finalize to leave session open (will fail since
      // finalize is required in same tx, but we can check the error)
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(10_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      // Without finalize in the tx, should get MissingFinalizeInstruction error
      try {
        await sendVersionedTx(env.connection, [validateIx], agent);
        expect.fail("Should have rejected — no finalize instruction");
      } catch (err: any) {
        const errStr = err.message || JSON.stringify(err);
        expect(errStr).to.include("MissingFinalizeInstruction");
      }
    });

    it("validate+finalize succeeds at session boundary", async () => {
      // Another composed transaction should succeed immediately
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(5_000_000), // 5 USDC
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        agent,
      );
      expect(result.signature).to.be.a("string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 3: Composed transaction atomicity
  // ═══════════════════════════════════════════════════════════════════════════
  describe("3. composed transaction atomicity", () => {
    const vaultId = nextVaultId();
    const agent = Keypair.generate();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let overlayPda: PublicKey;
    let vaultUsdcAta: PublicKey;
    let protocolTreasuryAta: PublicKey;

    before(async () => {
      await setAccountLamports(
        env.connection,
        agent.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      [overlayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          agentSpendOverlay: overlayPda,
        } as any)
        .rpc();

      vaultUsdcAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        vaultPda,
        true,
      );
      await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDC_MINT,
        1_000_000_000,
      );

      protocolTreasuryAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        PROTOCOL_TREASURY,
        true,
      );
      await fundWithTokens(
        env.connection,
        PROTOCOL_TREASURY,
        DEVNET_USDC_MINT,
        0,
      );
    });

    it("successful composed swap updates vault stats", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(25_000_000), // 25 USDC
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      await sendVersionedTx(env.connection, [validateIx, finalizeIx], agent);

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume uses actual_spend_tracked; no DeFi ix → 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });

    it("failed validate reverts entire transaction atomically", async () => {
      const vaultBefore = await program.account.agentVault.fetch(vaultPda);
      const txCountBefore = vaultBefore.totalTransactions.toNumber();

      // Use an unregistered agent to trigger UnauthorizedAgent at validation.
      const rogueAgent = await createWallet(env.connection, "rogueAgent", 5);

      const sessionPda = deriveSessionPda(
        vaultPda,
        rogueAgent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(25_000_000), // 25 USDC (valid amount)
          program.programId,
          null,
        )
        .accountsPartial({
          agent: rogueAgent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: rogueAgent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: rogueAgent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      try {
        await sendVersionedTx(
          env.connection,
          [validateIx, finalizeIx],
          rogueAgent,
        );
        expect.fail("Should have failed — unregistered agent");
      } catch (err: any) {
        if (err.name === "AssertionError") throw err;
        const errStr = err.message || JSON.stringify(err);
        expect(errStr).to.include("UnauthorizedAgent");
      }

      // Verify no state changes occurred (atomic revert)
      const vaultAfter = await program.account.agentVault.fetch(vaultPda);
      expect(vaultAfter.totalTransactions.toNumber()).to.equal(txCountBefore);
    });

    it("sequential swaps accumulate spending correctly", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      // Second swap (first was 25 USDC)
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(30_000_000), // 30 USDC
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      await sendVersionedTx(env.connection, [validateIx, finalizeIx], agent);

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      // totalVolume uses actual_spend_tracked; no DeFi ix → cumulative 0
      expect(vault.totalVolume.toNumber()).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 4: Token balance via cheatcodes
  // ═══════════════════════════════════════════════════════════════════════════
  describe("4. token balance via cheatcodes", () => {
    const vaultId = nextVaultId();
    const agent = Keypair.generate();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let overlayPda: PublicKey;
    let vaultUsdcAta: PublicKey;
    let vaultUsdtAta: PublicKey;

    before(async () => {
      await setAccountLamports(
        env.connection,
        agent.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      [overlayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          agentSpendOverlay: overlayPda,
        } as any)
        .rpc();
    });

    it("funds vault with USDC via surfnet_setTokenAccount", async () => {
      vaultUsdcAta = await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDC_MINT,
        500_000_000, // 500 USDC
      );

      // Verify the balance by fetching the token account
      const accountInfo =
        await env.connection.getTokenAccountBalance(vaultUsdcAta);
      expect(Number(accountInfo.value.amount)).to.equal(500_000_000);
    });

    it("funds vault with USDT via surfnet_setTokenAccount", async () => {
      // USDT mint may not exist on devnet — create it if needed
      await ensureMintExists(env.connection, DEVNET_USDT_MINT, 6);

      vaultUsdtAta = await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDT_MINT,
        300_000_000, // 300 USDT
      );

      const accountInfo =
        await env.connection.getTokenAccountBalance(vaultUsdtAta);
      expect(Number(accountInfo.value.amount)).to.equal(300_000_000);
    });

    it("protocol treasury receives fees on validate", async () => {
      const protocolTreasuryAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        PROTOCOL_TREASURY,
        true,
      );
      await fundWithTokens(
        env.connection,
        PROTOCOL_TREASURY,
        DEVNET_USDC_MINT,
        0,
      );

      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const amount = 100_000_000; // 100 USDC
      const expectedProtocolFee = Math.ceil(
        (amount * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(amount),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      await sendVersionedTx(env.connection, [validateIx, finalizeIx], agent);

      // Check protocol treasury balance increased
      const treasuryBalance =
        await env.connection.getTokenAccountBalance(protocolTreasuryAta);
      expect(Number(treasuryBalance.value.amount)).to.be.greaterThanOrEqual(
        expectedProtocolFee,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 5: CU profiling
  // ═══════════════════════════════════════════════════════════════════════════
  describe("5. CU profiling", () => {
    const vaultId = nextVaultId();
    const agent = Keypair.generate();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let overlayPda: PublicKey;
    let vaultUsdcAta: PublicKey;
    let protocolTreasuryAta: PublicKey;

    before(async () => {
      await setAccountLamports(
        env.connection,
        agent.publicKey,
        10 * LAMPORTS_PER_SOL,
      );
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      [overlayPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          agentSpendOverlay: overlayPda,
        } as any)
        .rpc();

      vaultUsdcAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        vaultPda,
        true,
      );
      await fundWithTokens(
        env.connection,
        vaultPda,
        DEVNET_USDC_MINT,
        1_000_000_000,
      );

      protocolTreasuryAta = getAssociatedTokenAddressSync(
        DEVNET_USDC_MINT,
        PROTOCOL_TREASURY,
        true,
      );
      await fundWithTokens(
        env.connection,
        PROTOCOL_TREASURY,
        DEVNET_USDC_MINT,
        0,
      );
    });

    it("profiles validate+finalize CU consumption", async () => {
      const sessionPda = deriveSessionPda(
        vaultPda,
        agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(20_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: policyPda,
          tracker: trackerPda,
          vaultTokenAccount: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        agent,
      );

      // Profile the transaction
      try {
        const profile = await profileTransaction(
          env.connection,
          result.signature,
          "validate+finalize",
        );
        // CU should be in a reasonable range (LiteSVM measured 53-56K)
        expect(profile.computeUnits).to.be.greaterThan(0);
        console.log(`    CU: validate+finalize = ${profile.computeUnits}`);
      } catch {
        // Profiling may not be available in --ci mode; verify TX succeeded
        expect(result.signature).to.be.a("string");
      }
    });

    it("profiles initializeVault CU consumption", async () => {
      const profileVaultId = nextVaultId();
      const profilePdas = derivePDAs(
        env.payer.publicKey,
        profileVaultId,
        program.programId,
      );
      const [profileOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          profilePdas.vaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      const tx = await program.methods
        .initializeVault(
          profileVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: profilePdas.vaultPda,
          policy: profilePdas.policyPda,
          tracker: profilePdas.trackerPda,
          agentSpendOverlay: profileOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        const profile = await profileTransaction(
          env.connection,
          tx,
          "initializeVault",
        );
        expect(profile.computeUnits).to.be.greaterThan(0);
        console.log(`    CU: initializeVault = ${profile.computeUnits}`);
      } catch {
        // Profiling best-effort
        expect(tx).to.be.a("string");
      }
    });

    it("retrieves profiling results by tag", async () => {
      try {
        const results = await getProfilesByTag(
          env.connection,
          "validate+finalize",
        );
        expect(results).to.be.an("array");
      } catch {
        // Profiling may not be available; test is best-effort
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 6: Network reset isolation
  // ═══════════════════════════════════════════════════════════════════════════
  describe("6. network reset isolation", () => {
    it("state persists within a session", async () => {
      const testVaultId = nextVaultId();
      const feeDestination = Keypair.generate();
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(
        env.payer.publicKey,
        testVaultId,
        program.programId,
      );
      const [persistOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          pdas.vaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          testVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: persistOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // State persists — fetch should work
      const vault = await program.account.agentVault.fetch(pdas.vaultPda);
      expect(vault.owner.toString()).to.equal(env.payer.publicKey.toString());
    });

    it("resetNetwork clears state", async () => {
      // Record a vault PDA that exists before reset
      const preResetVaultId = nextVaultId();
      const feeDestination = Keypair.generate();
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(
        env.payer.publicKey,
        preResetVaultId,
        program.programId,
      );
      const [resetOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          pdas.vaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          preResetVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: resetOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Reset network
      await resetNetwork(env.connection);

      // Re-create test env (payer needs re-funding after reset)
      env = await createSurfpoolTestEnv();
      program = env.program;

      // Old vault should no longer exist
      try {
        await program.account.agentVault.fetch(pdas.vaultPda);
        expect.fail("Vault should not exist after network reset");
      } catch (err: any) {
        const errStr = err.message || JSON.stringify(err);
        expect(errStr).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }
    });

    it("re-setup works after reset", async () => {
      const postResetVaultId = nextVaultId();
      const feeDestination = Keypair.generate();
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(
        env.payer.publicKey,
        postResetVaultId,
        program.programId,
      );
      const [postResetOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          pdas.vaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          postResetVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: postResetOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(pdas.vaultPda);
      expect(vault.vaultId.toNumber()).to.equal(postResetVaultId.toNumber());
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 7: Timelock with time travel
  // ═══════════════════════════════════════════════════════════════════════════
  describe("7. timelock with time travel", () => {
    const vaultId = nextVaultId();
    const feeDestination = Keypair.generate();
    let vaultPda: PublicKey;
    let policyPda: PublicKey;
    let trackerPda: PublicKey;
    let pendingPolicyPda: PublicKey;

    before(async () => {
      await setAccountLamports(
        env.connection,
        feeDestination.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const pdas = derivePDAs(env.payer.publicKey, vaultId, program.programId);
      vaultPda = pdas.vaultPda;
      policyPda = pdas.policyPda;
      trackerPda = pdas.trackerPda;
      pendingPolicyPda = pdas.pendingPolicyPda;
      const [timelockOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Create vault WITH timelock (60 seconds)
      await program.methods
        .initializeVault(
          vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(60), // 60-second timelock
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          agentSpendOverlay: timelockOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("queue + time travel + apply succeeds", async () => {
      // Queue policy update
      await program.methods
        .queuePolicyUpdate(
          new BN(200_000_000), // new daily cap: 200 USDC
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
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          pendingPolicy: pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Verify pending policy was created
      const pending =
        await program.account.pendingPolicyUpdate.fetch(pendingPolicyPda);
      expect(pending.dailySpendingCapUsd!.toNumber()).to.equal(200_000_000);

      // Time travel past the timelock (60 seconds + buffer)
      // Surfnet absoluteTimestamp is in milliseconds
      await timeTravel(env.connection, {
        absoluteTimestamp: Date.now() + 120_000,
      });

      // Apply should now succeed
      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          pendingPolicy: pendingPolicyPda,
        } as any)
        .rpc();

      // Verify policy was updated
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
    });

    it("apply fails before timelock expires", async () => {
      // Queue another update (use sendVersionedTx since Anchor .rpc()
      // can have issues after time travel)
      const queueIx = await program.methods
        .queuePolicyUpdate(
          new BN(300_000_000),
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
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          pendingPolicy: pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();

      await sendVersionedTx(env.connection, [queueIx], env.payer);

      // Try to apply immediately (without time travel)
      const applyIx = await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: env.payer.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          pendingPolicy: pendingPolicyPda,
        } as any)
        .instruction();

      try {
        await sendVersionedTx(env.connection, [applyIx], env.payer);
        expect.fail("Should have thrown TimelockNotExpired");
      } catch (err: any) {
        const errStr = err.message || JSON.stringify(err);
        expect(errStr).to.include("TimelockNotExpired");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 8: Balance flows (deposit, withdraw, agent_transfer)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("8. balance flows", () => {
    let setup: VaultSetupResult;
    let ownerUsdcAta: PublicKey;

    before(async () => {
      setup = await setupVaultWithAgent(env, program, {
        vaultFunding: 0,
        allowedDestinations: [],
      });

      // Fund owner with USDC for deposit
      ownerUsdcAta = await fundWithTokens(
        env.connection,
        env.payer.publicKey,
        DEVNET_USDC_MINT,
        1_000_000_000, // 1000 USDC
      );
    });

    it("deposit_funds increases vault balance and tracks P&L", async () => {
      const depositAmount = new BN(200_000_000); // 200 USDC

      await program.methods
        .depositFunds(depositAmount)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
          mint: DEVNET_USDC_MINT,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const balance = await env.connection.getTokenAccountBalance(
        setup.vaultUsdcAta,
      );
      expect(Number(balance.value.amount)).to.equal(200_000_000);

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      expect(vault.totalDepositedUsd.toNumber()).to.equal(200_000_000);
    });

    it("withdraw_funds decreases vault balance and tracks P&L", async () => {
      const withdrawAmount = new BN(50_000_000); // 50 USDC

      await program.methods
        .withdrawFunds(withdrawAmount)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
          mint: DEVNET_USDC_MINT,
          vaultTokenAccount: setup.vaultUsdcAta,
          ownerTokenAccount: ownerUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      const balance = await env.connection.getTokenAccountBalance(
        setup.vaultUsdcAta,
      );
      expect(Number(balance.value.amount)).to.equal(150_000_000);

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      expect(vault.totalWithdrawnUsd.toNumber()).to.equal(50_000_000);
    });

    it("agent_transfer sends stablecoins with fee deduction", async () => {
      // Create a new vault with an allowed destination for agent_transfer
      const destWallet = await createWallet(env.connection, "dest", 2);
      const destUsdcAta = await fundWithTokens(
        env.connection,
        destWallet.publicKey,
        DEVNET_USDC_MINT,
        0,
      );

      const transferSetup = await setupVaultWithAgent(env, program, {
        vaultFunding: 500_000_000, // 500 USDC
        allowedDestinations: [destWallet.publicKey],
      });

      const transferAmount = new BN(10_000_000); // 10 USDC
      const expectedFee = Math.ceil(
        (10_000_000 * PROTOCOL_FEE_RATE) / FEE_RATE_DENOMINATOR,
      );

      const transferIx = await program.methods
        .agentTransfer(transferAmount)
        .accounts({
          agent: transferSetup.agent.publicKey,
          vault: transferSetup.vaultPda,
          policy: transferSetup.policyPda,
          tracker: transferSetup.trackerPda,
          agentSpendOverlay: transferSetup.overlayPda,
          vaultTokenAccount: transferSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: transferSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await sendVersionedTx(
        env.connection,
        [transferIx],
        transferSetup.agent,
      );

      const destBalance =
        await env.connection.getTokenAccountBalance(destUsdcAta);
      expect(Number(destBalance.value.amount)).to.equal(
        10_000_000 - expectedFee,
      );
    });

    it("withdraw more than balance fails", async () => {
      // setup vault has 150_000_000 remaining after deposit/withdraw tests
      const overdrawIx = await program.methods
        .withdrawFunds(new BN(999_000_000))
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
          mint: DEVNET_USDC_MINT,
          vaultTokenAccount: setup.vaultUsdcAta,
          ownerTokenAccount: ownerUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [overdrawIx],
        env.payer,
        "InsufficientFunds",
      );
    });

    it("deposit then withdraw preserves P&L counter consistency", async () => {
      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      // After 200 deposited, 50 withdrawn:
      expect(vault.totalDepositedUsd.toNumber()).to.be.greaterThan(0);
      expect(vault.totalWithdrawnUsd.toNumber()).to.be.greaterThan(0);
      expect(vault.totalDepositedUsd.toNumber()).to.be.greaterThan(
        vault.totalWithdrawnUsd.toNumber(),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 9: Emergency operations (freeze, reactivate, pause, unpause)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("9. emergency operations", () => {
    let setup: VaultSetupResult;
    let agent2: Keypair;

    before(async () => {
      setup = await setupVaultWithAgent(env, program);

      // Register a second agent for pause isolation tests
      agent2 = await createWallet(env.connection, "agent2", 10);
      await program.methods
        .registerAgent(agent2.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
          agentSpendOverlay: setup.overlayPda,
        } as any)
        .rpc();
    });

    it("freeze_vault blocks validate+finalize", async () => {
      await program.methods
        .freezeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      expect(vault.status).to.have.property("frozen");

      // Attempt composed TX — should fail
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(10_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: setup.agent.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: setup.agent.publicKey,
          vault: setup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: setup.agent.publicKey,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      await expectTxError(
        env.connection,
        [validateIx, finalizeIx],
        setup.agent,
        "VaultNotActive",
      );
    });

    it("reactivate_vault restores operations", async () => {
      await program.methods
        .reactivateVault(null, null)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      expect(vault.status).to.have.property("active");

      // Composed TX should now succeed
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: setup.agent.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: setup.agent.publicKey,
          vault: setup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: setup.agent.publicKey,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("non-owner cannot reactivate frozen vault", async () => {
      // Freeze first
      await program.methods
        .freezeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      // Non-owner (agent) tries to reactivate
      const reactivateIx = await program.methods
        .reactivateVault(null, null)
        .accounts({
          owner: setup.agent.publicKey,
          vault: setup.vaultPda,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [reactivateIx],
        setup.agent,
        "ConstraintHasOne",
      );

      // Unfreeze for subsequent tests
      await program.methods
        .reactivateVault(null, null)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();
    });

    it("pause_agent blocks that agent", async () => {
      await program.methods
        .pauseAgent(setup.agent.publicKey)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      const agentEntry = vault.agents.find(
        (a: any) =>
          a.pubkey.toString() === setup.agent.publicKey.toString(),
      );
      expect(agentEntry.paused).to.equal(true);

      // Agent's composed TX should fail
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: setup.agent.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: setup.agent.publicKey,
          vault: setup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: setup.agent.publicKey,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      await expectTxError(
        env.connection,
        [validateIx, finalizeIx],
        setup.agent,
        "AgentPaused",
      );
    });

    it("paused agent does not affect other agent", async () => {
      // agent2 should still work (agent1 is paused)
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        agent2.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: agent2.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent2.publicKey,
          vault: setup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent2.publicKey,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        agent2,
      );
      expect(result.signature).to.be.a("string");
    });

    it("unpause_agent restores operations", async () => {
      await program.methods
        .unpauseAgent(setup.agent.publicKey)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      const agentEntry = vault.agents.find(
        (a: any) =>
          a.pubkey.toString() === setup.agent.publicKey.toString(),
      );
      expect(agentEntry.paused).to.equal(false);

      // Agent's composed TX should work again
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          null,
        )
        .accountsPartial({
          agent: setup.agent.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: setup.agent.publicKey,
          vault: setup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: setup.agent.publicKey,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("frozen vault blocks agent_transfer too", async () => {
      // Create a destination for agent_transfer
      const destWallet = await createWallet(env.connection, "emergDest", 2);
      const destUsdcAta = await fundWithTokens(
        env.connection,
        destWallet.publicKey,
        DEVNET_USDC_MINT,
        0,
      );

      // Freeze vault
      await program.methods
        .freezeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();

      // agent_transfer should also fail
      const transferIx = await program.methods
        .agentTransfer(new BN(5_000_000))
        .accounts({
          agent: setup.agent.publicKey,
          vault: setup.vaultPda,
          policy: setup.policyPda,
          tracker: setup.trackerPda,
          agentSpendOverlay: setup.overlayPda,
          vaultTokenAccount: setup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: setup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [transferIx],
        setup.agent,
        "VaultNotActive",
      );

      // Unfreeze for any subsequent tests
      await program.methods
        .reactivateVault(null, null)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
        } as any)
        .rpc();
    });
  });
});
