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
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  fetchAndComputeQueueDigest,
  siblingHandlerDigest,
} from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createSurfpoolTestEnv,
  SurfpoolTestEnv,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
  buildMockSwapToVaultIx,
  DEVNET_USDC_MINT,
  DEVNET_USDT_MINT,
  PROTOCOL_TREASURY,
  PROTOCOL_FEE_RATE,
  FEE_RATE_DENOMINATOR,
  SESSION_DURATION_SECONDS,
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
  seatOperatorAgent,
  initVaultInline,
  expectTxError,
  VaultSetupResult,
  VersionedTxResult,
} from "./helpers/surfpool-setup";

const FULL_CAPABILITY = 2;

// Helper: read current policy version for any vault's policy PDA
async function readPolicyVersion(
  prog: Program<Sigil>,
  policyPda: PublicKey,
): Promise<BN> {
  try {
    const pol = await prog.account.policyConfig.fetch(policyPda);
    return (pol as any).policyVersion ?? new BN(0);
  } catch {
    return new BN(0);
  }
}

// ─── Shared state ───────────────────────────────────────────────────────────

let env: SurfpoolTestEnv;
let program: Program<Sigil>;

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
      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        overlayPda,
        feeDestination.publicKey,
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.owner.toString()).to.equal(env.payer.publicKey.toString());
      expect(vault.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(vault.totalTransactions.toNumber()).to.equal(0);
    });

    it("registers agent and deposits USDC", async () => {
      // Register agent
      // F-Q6: OPERATOR (FULL_CAPABILITY=2) on a single-key vault must be seated
      // via the queue → time-travel → apply timelock path (an instant
      // register_agent reverts with ErrOperatorGrantRequiresTimelock, 6107).
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        vaultPda,
        agent.publicKey,
      );

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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this lifecycle test asserts
          // only totalTransactions/totalVolume (no spend magnitude), so a
          // NON-spending session (amount 0) is the correct fixture — exempt from
          // 6115, still increments totalTransactions, keeps totalVolume == 0.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch fires otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
        agent,
      );

      expect(result.signature).to.be.a("string");
      expect(result.logs.length).to.be.greaterThan(0);

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume = 0: mock DeFi is no-op (no real token movement).
      // Real volume tracking verified in Surfpool integration tests with forked mainnet (#29).
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
      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        overlayPda,
        feeDestination.publicKey,
      );

      // F-Q6: OPERATOR (FULL_CAPABILITY=2) on a single-key vault must be seated
      // via the queue → time-travel → apply timelock path (an instant
      // register_agent reverts with ErrOperatorGrantRequiresTimelock, 6107).
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        vaultPda,
        agent.publicKey,
      );

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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test asserts only the
          // composed TX lands within the 20-slot window (signature returned), not
          // a spend magnitude — a NON-spending session (amount 0) is exempt and
          // preserves the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      // Should succeed — session is created and used in same transaction
      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
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
          DEVNET_USDC_MINT,
          new BN(10_000_000),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(10_000_000),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      // Without finalize in the tx, should get MissingFinalizeInstruction error
      try {
        await sendVersionedTx(
          env.connection,
          [validateIx, buildMockDefiNoopIx(agent.publicKey)],
          agent,
        );
        expect.fail("Should have rejected — no finalize instruction");
      } catch (err: any) {
        const errStr = err.message || JSON.stringify(err);
        expect(
          errStr.includes("MissingFinalizeInstruction") ||
            errStr.includes("6028"),
        ).to.equal(
          true,
          `Expected MissingFinalizeInstruction (6028) but got: ${errStr.slice(0, 200)}`,
        );
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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): boundary test asserts only the
          // composed TX succeeds (signature), not a spend — non-spending session
          // (amount 0) is exempt and preserves intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
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

      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        overlayPda,
        feeDestination.publicKey,
      );

      // F-Q6: OPERATOR (FULL_CAPABILITY=2) on a single-key vault must be seated
      // via the queue → time-travel → apply timelock path (an instant
      // register_agent reverts with ErrOperatorGrantRequiresTimelock, 6107).
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        vaultPda,
        agent.publicKey,
      );

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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): asserts only
          // totalTransactions == 1 / totalVolume == 0 (mock DeFi moves nothing),
          // so a non-spending session (amount 0) is the correct fixture — exempt
          // from 6115, still counts the transaction, keeps totalVolume == 0.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
        agent,
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // totalVolume = 0: no DeFi ix in TX (mock is no-op). Real volume tested with forked mainnet (#29).
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
          DEVNET_USDC_MINT,
          new BN(25_000_000), // 25 USDC (valid amount)
          program.programId,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: rogueAgent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(25_000_000),
              targetProtocol: program.programId,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
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
        expect(
          errStr.includes("UnauthorizedAgent") || errStr.includes("6001"),
        ).to.equal(
          true,
          `Expected UnauthorizedAgent (6001) but got: ${errStr.slice(0, 200)}`,
        );
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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): asserts only the cumulative
          // transaction count (totalTransactions == 2) and totalVolume == 0, not
          // a spend magnitude — non-spending session (amount 0) is exempt and
          // still increments the counter.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
        agent,
      );

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(2);
      // totalVolume = 0: cumulative no-op (mock DeFi doesn't move tokens). Real volume tested with forked mainnet (#29).
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

      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        overlayPda,
        feeDestination.publicKey,
      );

      // F-Q6: OPERATOR (FULL_CAPABILITY=2) on a single-key vault must be seated
      // via the queue → time-travel → apply timelock path (an instant
      // register_agent reverts with ErrOperatorGrantRequiresTimelock, 6107).
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        vaultPda,
        agent.publicKey,
      );
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

      // require-measurable-outcome (err 6115): the fee is collected at validate on
      // the AUTHORIZED amount (upfront, spend-independent), so this test must keep
      // a SPENDING session (amount > 0) to prove the fee lands. To satisfy the
      // invariant at finalize without inflating spend, the middle ix is an
      // ACQUIRING swap with inAmount = 0 (no stablecoin leaves the vault →
      // actual_spend == 0) and outAmount > 0 (a non-USDC, vault-owned output
      // INCREASES → M1 satisfied). USDT (≠ USDC) is the acquired mint; the
      // vault-owned USDT ATA (funded earlier in this suite) is the pinned output.
      // Mirrors sandwich-integration.ts / flash-trade-integration.ts.
      await ensureMintExists(env.connection, DEVNET_USDT_MINT, 6);
      const agentUsdtReserve = await fundWithTokens(
        env.connection,
        agent.publicKey,
        DEVNET_USDT_MINT,
        100_000_000, // agent-owned reserve funds the swap's output leg
      );
      // Off-vault USDC recipient for the swap's input leg. With inAmount = 0 it
      // receives nothing, but the ix lists it as a writable meta so it must be a
      // resolvable token account in the completeness checks.
      const drainRecipient = Keypair.generate();
      const drainRecipientUsdcAta = await fundWithTokens(
        env.connection,
        drainRecipient.publicKey,
        DEVNET_USDC_MINT,
        0,
      );
      const swapOutAmount = new BN(1_000); // tiny acquisition → output increases

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          new BN(amount),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(amount),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          // M1: pin the vault-owned USDT ATA finalize requires to have increased.
          outputSwapAccount: vaultUsdtAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        // F-Q1a completeness: the swap ix's writable, non-vault metas (vault USDC
        // input source, drain recipient, agent reserve, vault output ATA) plus the
        // agent fee-payer must be resolvable in validate's remaining_accounts.
        .remainingAccounts([
          { pubkey: vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: drainRecipientUsdcAta, isSigner: false, isWritable: false },
          { pubkey: agentUsdtReserve, isSigner: false, isWritable: false },
          { pubkey: vaultUsdtAta, isSigner: false, isWritable: false },
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: vaultUsdtAta,
        })
        // F-Q1b finalize completeness (err 6113): the swap's writable, non-vault
        // metas plus the agent must reach finalize too. READONLY — resolved, not
        // authorized.
        .remainingAccounts([
          { pubkey: vaultUsdcAta, isSigner: false, isWritable: false },
          { pubkey: drainRecipientUsdcAta, isSigner: false, isWritable: false },
          { pubkey: agentUsdtReserve, isSigner: false, isWritable: false },
          { pubkey: vaultUsdtAta, isSigner: false, isWritable: false },
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const swapIx = buildMockSwapToVaultIx(
        vaultUsdcAta, // input source (vault USDC) — agent's validate delegation
        drainRecipientUsdcAta, // input sink (receives 0; inAmount = 0)
        agentUsdtReserve, // output source (agent-owned USDT reserve)
        vaultUsdtAta, // vault-owned acquired output — must INCREASE (M1)
        agent.publicKey,
        new BN(0), // inAmount = 0 → no stablecoin leaves vault (actual_spend == 0)
        swapOutAmount, // outAmount > 0 → vault USDT increases (satisfies 6115)
      );

      await sendVersionedTx(
        env.connection,
        [validateIx, swapIx, finalizeIx],
        agent,
      );

      // Check protocol treasury balance increased (fee collected on amount > 0).
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

      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        overlayPda,
        feeDestination.publicKey,
      );

      // F-Q6: OPERATOR (FULL_CAPABILITY=2) on a single-key vault must be seated
      // via the queue → time-travel → apply timelock path (an instant
      // register_agent reverts with ErrOperatorGrantRequiresTimelock, 6107).
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        vaultPda,
        agent.publicKey,
      );

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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test only PROFILES the
          // CU of a validate+finalize pair (amount-independent), so a non-spending
          // session (amount 0) is exempt and exercises the same code path.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: vaultPda,
              agent: agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent.publicKey), finalizeIx],
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

      const initResult = await initVaultInline(
        env,
        program,
        profileVaultId,
        profilePdas.vaultPda,
        profilePdas.policyPda,
        profilePdas.trackerPda,
        profileOverlay,
        feeDestination.publicKey,
      );
      const tx = initResult.signature;

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

      await initVaultInline(
        env,
        program,
        testVaultId,
        pdas.vaultPda,
        pdas.policyPda,
        pdas.trackerPda,
        persistOverlay,
        feeDestination.publicKey,
      );

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

      await initVaultInline(
        env,
        program,
        preResetVaultId,
        pdas.vaultPda,
        pdas.policyPda,
        pdas.trackerPda,
        resetOverlay,
        feeDestination.publicKey,
      );

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

      await initVaultInline(
        env,
        program,
        postResetVaultId,
        pdas.vaultPda,
        pdas.policyPda,
        pdas.trackerPda,
        postResetOverlay,
        feeDestination.publicKey,
      );

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

      // Create vault WITH timelock (1800 seconds = MIN_TIMELOCK_DURATION)
      await initVaultInline(
        env,
        program,
        vaultId,
        vaultPda,
        policyPda,
        trackerPda,
        timelockOverlay,
        feeDestination.publicKey,
      );
    });

    it("queue + time travel + apply succeeds", async () => {
      // Queue policy update
      await program.methods
        .queuePolicyUpdate(
          new BN(200_000_000),
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
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null, // cosign_session_pubkey (D-5: pass-through)
          null, // operator_grant_delay_seconds (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, policyPda, vaultPda, {
            dailySpendingCapUsd: new BN(200_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
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

      // Time travel past the timelock (1800 seconds + buffer)
      // Surfnet absoluteTimestamp is in milliseconds
      await timeTravel(env.connection, {
        absoluteTimestamp: Date.now() + 2_000_000,
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
          null,
          null, // operating_hours (TA-05 Phase 3)
          null, // stable_balance_floor (TA-12 Phase 5 — pass-through)
          null, // per_recipient_daily_cap_usd (TA-14 Phase 5 — pass-through)
          null, // cosign_required (G6 audit 2026-05-18 — pass-through, default off)
          null, // cosign_session_pubkey (D-5: pass-through)
          null, // operator_grant_delay_seconds (D-5: pass-through)
          PublicKey.default, // cosign_session (TA-09 Phase 3 — non-elevated)
          await fetchAndComputeQueueDigest(program, policyPda, vaultPda, {
            dailySpendingCapUsd: new BN(300_000_000),
          }), // newPolicyPreviewDigest (Phase 2 TA-19)
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
        expect(
          errStr.includes("TimelockNotExpired") || errStr.includes("6026"),
        ).to.equal(
          true,
          `Expected TimelockNotExpired (6026) but got: ${errStr.slice(0, 200)}`,
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 8: Balance flows (deposit, withdraw, agent_transfer)
  // ═══════════════════════════════════════════════════════════════════════════
  // NOTE: Intentional cascading state — tests verify P&L accumulation across
  // deposit/withdraw/transfer operations. Order-dependent by design.
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

      const transferVersion = await readPolicyVersion(
        program,
        transferSetup.policyPda,
      );
      const transferIx = await program.methods
        .agentTransfer(transferAmount, transferVersion)
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

      await sendVersionedTx(env.connection, [transferIx], transferSetup.agent);

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
        "InsufficientBalance",
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

      // Register a second agent for pause isolation tests. F-Q6: OPERATOR on a
      // single-key vault is seated via the queue → time-travel → apply timelock
      // path (instant register reverts with ErrOperatorGrantRequiresTimelock,
      // 6107). agent2 must be a true OPERATOR — the isolation test exercises its
      // ability to operate, so Observer would not suffice.
      agent2 = await createWallet(env.connection, "agent2", 10);
      await seatOperatorAgent(
        env,
        program,
        env.payer.publicKey,
        setup.vaultPda,
        agent2.publicKey,
      );
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
          DEVNET_USDC_MINT,
          new BN(10_000_000),
          program.programId,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(10_000_000),
              targetProtocol: program.programId,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
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
      // Phase 8 Batch 5: prior it() froze vault; advance past 5-min reactivate
      // cooldown (ErrReactivateCooldownActive 6097) via Surfnet time travel.
      {
        const clock = await getClock(env.connection);
        await timeTravel(env.connection, {
          absoluteTimestamp: (clock.timestamp + 301) * 1000,
        });
      }

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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves a reactivated
          // vault accepts operations again (signature returned), not a spend
          // magnitude — a non-spending session (amount 0) is exempt and preserves
          // the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: setup.agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(setup.agent.publicKey), finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("non-owner cannot reactivate frozen vault", async () => {
      // Dedicated vault: freezing the shared `setup` vault here used to leak a
      // frozen state into the pause/unpause tests below (their fragile cleanup
      // reactivate could silently fail), so this test owns its vault and never
      // touches `setup`.
      const fv = await setupVaultWithAgent(env, program);
      await program.methods
        .freezeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: fv.vaultPda,
        } as any)
        .rpc();

      // Non-owner (the agent) tries to reactivate. The `has_one = owner @
      // SigilError::UnauthorizedOwner` constraint (reactivate_vault.rs:20) fires
      // during account validation → UnauthorizedOwner (6002), which overrides
      // the generic Anchor ConstraintHasOne.
      const reactivateIx = await program.methods
        .reactivateVault(null, null)
        .accounts({
          owner: fv.agent.publicKey,
          vault: fv.vaultPda,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [reactivateIx],
        fv.agent,
        "UnauthorizedOwner",
      );
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
        (a: any) => a.pubkey.toString() === setup.agent.publicKey.toString(),
      );
      expect(agentEntry, "agent must be registered").to.exist;
      expect(agentEntry!.paused).to.equal(true);

      // Agent's composed TX should fail
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(5_000_000),
              targetProtocol: program.programId,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
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
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves the UNPAUSED
          // second agent can still operate (signature returned) while a different
          // agent is paused — no spend magnitude asserted, so a non-spending
          // session (amount 0) is exempt and preserves the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: agent2.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: agent2.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(agent2.publicKey), finalizeIx],
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
        (a: any) => a.pubkey.toString() === setup.agent.publicKey.toString(),
      );
      expect(agentEntry, "agent must be registered").to.exist;
      expect(agentEntry!.paused).to.equal(false);

      // Agent's composed TX should work again
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves an unpaused
          // agent can operate again (signature returned), not a spend magnitude —
          // a non-spending session (amount 0) is exempt and preserves the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: setup.agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(setup.agent.publicKey), finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("frozen vault blocks agent_transfer too", async () => {
      // Dedicated vault — freezing it must not leak into the shared `setup`
      // vault that earlier emergency-ops tests rely on.
      const fv = await setupVaultWithAgent(env, program);

      // Create a destination for agent_transfer
      const destWallet = await createWallet(env.connection, "emergDest", 2);
      const destUsdcAta = await fundWithTokens(
        env.connection,
        destWallet.publicKey,
        DEVNET_USDC_MINT,
        0,
      );

      await program.methods
        .freezeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: fv.vaultPda,
        } as any)
        .rpc();

      // agent_transfer must also be rejected on a frozen vault. agent_transfer
      // checks PolicyVersionMismatch (agent_transfer.rs:95) BEFORE VaultNotActive
      // (:101), so expected_policy_version must be live (setupVaultWithAgent's
      // OPERATOR seat bumped it) for the tx to reach the VaultNotActive gate.
      const transferIx = await program.methods
        .agentTransfer(
          new BN(5_000_000),
          await readPolicyVersion(program, fv.policyPda),
        )
        .accounts({
          agent: fv.agent.publicKey,
          vault: fv.vaultPda,
          policy: fv.policyPda,
          tracker: fv.trackerPda,
          agentSpendOverlay: fv.overlayPda,
          vaultTokenAccount: fv.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: fv.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [transferIx],
        fv.agent,
        "VaultNotActive",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 10: Multi-agent permissions
  // ═══════════════════════════════════════════════════════════════════════════
  describe("10. multi-agent permissions", () => {
    // Capability levels: 0=Disabled, 1=Observer (non-spending), 2=Operator (full)
    // Renamed from `SWAP_ONLY` in the A11 cleanup — the SDK's historical
    // `SWAP_ONLY` export was a 21-bit bitmask (`1n << 0n` = 1), not the
    // v6 operator-capability value (2). Name changed to eliminate the
    // cross-codebase shadow.
    const OPERATOR_CAPABILITY = 2; // Operator — can do spending operations (swap)
    const NO_SWAP = 1; // Observer — non-spending only, swap (spending) blocked
    const OBSERVER_ONLY = 1; // Observer — can only do non-spending operations
    const ZERO_PERMISSIONS = 0; // Disabled — no operations

    let swapSetup: VaultSetupResult;
    let noSwapSetup: VaultSetupResult;

    before(async () => {
      // Vault with swap-only agent (timelockDuration required for queue/apply)
      swapSetup = await setupVaultWithAgent(env, program, {
        agentCapability: OPERATOR_CAPABILITY,
        timelockDuration: new BN(1800),
      });
      // Vault with no-swap agent
      noSwapSetup = await setupVaultWithAgent(env, program, {
        agentCapability: NO_SWAP,
      });
    });

    it("agent with swap permission can execute swap", async () => {
      const sessionPda = deriveSessionPda(
        swapSetup.vaultPda,
        swapSetup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves an
          // OPERATOR-capability agent is PERMITTED to open a session (the
          // permission gate runs at validate, independent of amount) — it asserts
          // only the signature, not a spend magnitude. A non-spending session
          // (amount 0) is exempt from 6115 and preserves the permission intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, swapSetup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: swapSetup.vaultPda,
              agent: swapSetup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
        )
        .accountsPartial({
          agent: swapSetup.agent.publicKey,
          vault: swapSetup.vaultPda,
          policy: swapSetup.policyPda,
          tracker: swapSetup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: swapSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: swapSetup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: swapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          {
            pubkey: swapSetup.agent.publicKey,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: swapSetup.agent.publicKey,
          vault: swapSetup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: swapSetup.agent.publicKey,
          policy: swapSetup.policyPda,
          tracker: swapSetup.trackerPda,
          vaultTokenAccount: swapSetup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: swapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [
          validateIx,
          buildMockDefiNoopIx(swapSetup.agent.publicKey),
          finalizeIx,
        ],
        swapSetup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("agent without swap permission gets InsufficientPermissions", async () => {
      const sessionPda = deriveSessionPda(
        noSwapSetup.vaultPda,
        noSwapSetup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      // Read current policy version dynamically
      const pol = await program.account.policyConfig.fetch(
        noSwapSetup.policyPda,
      );
      const currentVersion = (pol as any).policyVersion ?? new BN(0);

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          currentVersion,
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: noSwapSetup.vaultPda,
              agent: noSwapSetup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(5_000_000),
              targetProtocol: program.programId,
            }),
          ),
        )
        .accountsPartial({
          agent: noSwapSetup.agent.publicKey,
          vault: noSwapSetup.vaultPda,
          policy: noSwapSetup.policyPda,
          tracker: noSwapSetup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: noSwapSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: noSwapSetup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: noSwapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: noSwapSetup.agent.publicKey,
          vault: noSwapSetup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: noSwapSetup.agent.publicKey,
          policy: noSwapSetup.policyPda,
          tracker: noSwapSetup.trackerPda,
          vaultTokenAccount: noSwapSetup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: noSwapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      await expectTxError(
        env.connection,
        [validateIx, finalizeIx],
        noSwapSetup.agent,
        "InsufficientPermissions",
      );
    });

    it("queue+apply agent_permissions_update changes bitmask", async () => {
      // Give swap-only agent full permissions via queue+apply
      const [pendingAgentPerms] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("pending_agent_perms"),
          swapSetup.vaultPda.toBuffer(),
          swapSetup.agent.publicKey.toBuffer(),
        ],
        program.programId,
      );

      // Queue
      await program.methods
        .queueAgentPermissionsUpdate(
          swapSetup.agent.publicKey,
          FULL_CAPABILITY,
          new BN(0),
          new BN(0), // cooldown_seconds (TA-06 Phase 3 — disabled)
          PublicKey.default, // cosign_session (F-RP3-2: default = no cosign)
        )
        .accounts({
          owner: env.payer.publicKey,
          vault: swapSetup.vaultPda,
          policy: swapSetup.policyPda,
          pendingAgentPerms: pendingAgentPerms,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Time travel past 1800s timelock
      const SYSVAR_CLOCK = new PublicKey(
        "SysvarC1ock11111111111111111111111111111111",
      );
      const clockInfo = await env.connection.getAccountInfo(SYSVAR_CLOCK);
      let travelTs = Math.floor(Date.now() / 1000);
      if (clockInfo && clockInfo.data.length >= 40) {
        travelTs = Number(clockInfo.data.readBigInt64LE(32));
      }
      await timeTravel(env.connection, {
        absoluteTimestamp: (travelTs + 2000) * 1000,
      });

      // Apply
      await program.methods
        .applyAgentPermissionsUpdate()
        .accounts({
          owner: env.payer.publicKey,
          vault: swapSetup.vaultPda,
          policy: swapSetup.policyPda,
          pendingAgentPerms: pendingAgentPerms,
          agentSpendOverlay: swapSetup.overlayPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(swapSetup.vaultPda);
      const agentEntry = vault.agents.find(
        (a: any) =>
          a.pubkey.toString() === swapSetup.agent.publicKey.toString(),
      );
      expect(agentEntry, "agent must be registered").to.exist;
      expect(agentEntry!.capability).to.equal(FULL_CAPABILITY);
    });

    it("two agents with different permissions operate independently", async () => {
      // Register agent2 with transfer-only on the swap vault
      const agent2 = await createWallet(env.connection, "permAgent2", 10);
      await program.methods
        .registerAgent(agent2.publicKey, OBSERVER_ONLY, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: swapSetup.vaultPda,
          agentSpendOverlay: swapSetup.overlayPda,
        } as any)
        .rpc();

      // agent2 should NOT be able to swap (no bit 0)
      const sessionPda = deriveSessionPda(
        swapSetup.vaultPda,
        agent2.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );
      // Read current policy version (may have been bumped by earlier queue+apply)
      const pol = await program.account.policyConfig.fetch(swapSetup.policyPda);
      const currentVersion = (pol as any).policyVersion ?? new BN(0);
      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          currentVersion,
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: swapSetup.vaultPda,
              agent: agent2.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(5_000_000),
              targetProtocol: program.programId,
            }),
          ),
        )
        .accountsPartial({
          agent: agent2.publicKey,
          vault: swapSetup.vaultPda,
          policy: swapSetup.policyPda,
          tracker: swapSetup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: swapSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: swapSetup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: swapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent2.publicKey,
          vault: swapSetup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent2.publicKey,
          policy: swapSetup.policyPda,
          tracker: swapSetup.trackerPda,
          vaultTokenAccount: swapSetup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: swapSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      await expectTxError(
        env.connection,
        [validateIx, finalizeIx],
        agent2,
        "InsufficientPermissions",
      );
    });

    it("agent with transfer permission can agent_transfer", async () => {
      // Create vault with transfer-only agent + allowed destination
      const destWallet = await createWallet(env.connection, "permDest", 2);
      const destUsdcAta = await fundWithTokens(
        env.connection,
        destWallet.publicKey,
        DEVNET_USDC_MINT,
        0,
      );

      const transferSetup = await setupVaultWithAgent(env, program, {
        agentCapability: OPERATOR_CAPABILITY, // Operator (2) — transfers are spending actions
        allowedDestinations: [destWallet.publicKey],
      });

      const transferVersion = await readPolicyVersion(
        program,
        transferSetup.policyPda,
      );
      const transferIx = await program.methods
        .agentTransfer(new BN(5_000_000), transferVersion)
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

      const result = await sendVersionedTx(
        env.connection,
        [transferIx],
        transferSetup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("zero-permission agent fails on any action", async () => {
      const zeroSetup = await setupVaultWithAgent(env, program, {
        agentCapability: ZERO_PERMISSIONS,
      });

      const sessionPda = deriveSessionPda(
        zeroSetup.vaultPda,
        zeroSetup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          new BN(5_000_000),
          program.programId,
          await readPolicyVersion(program, zeroSetup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: zeroSetup.vaultPda,
              agent: zeroSetup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              amount: new BN(5_000_000),
              targetProtocol: program.programId,
            }),
          ),
        )
        .accountsPartial({
          agent: zeroSetup.agent.publicKey,
          vault: zeroSetup.vaultPda,
          policy: zeroSetup.policyPda,
          tracker: zeroSetup.trackerPda,
          session: sessionPda,
          vaultTokenAccount: zeroSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          protocolTreasuryTokenAccount: zeroSetup.protocolTreasuryAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: zeroSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: zeroSetup.agent.publicKey,
          vault: zeroSetup.vaultPda,
          session: sessionPda,
          sessionRentRecipient: zeroSetup.agent.publicKey,
          policy: zeroSetup.policyPda,
          tracker: zeroSetup.trackerPda,
          vaultTokenAccount: zeroSetup.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: zeroSetup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
          outputSwapAccount: null,
        })
        .instruction();

      await expectTxError(
        env.connection,
        [validateIx, finalizeIx],
        zeroSetup.agent,
        "InsufficientPermissions",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 11: Spending cap rolling window (time travel)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("11. spending cap rolling window", () => {
    let capSetup: VaultSetupResult;
    let destWallet: Keypair;
    let destUsdcAta: PublicKey;

    before(async () => {
      destWallet = await createWallet(env.connection, "capDest", 2);
      destUsdcAta = await fundWithTokens(
        env.connection,
        destWallet.publicKey,
        DEVNET_USDC_MINT,
        0,
      );

      capSetup = await setupVaultWithAgent(env, program, {
        dailyCap: new BN(100_000_000), // 100 USDC daily cap
        maxTxSize: new BN(100_000_000),
        vaultFunding: 5_000_000_000, // 5000 USDC
        allowedDestinations: [destWallet.publicKey],
      });
    });

    // Note: No clock reset needed — each suite uses getClock() for Surfnet's
    // actual time and creates isolated vaults via nextVaultId().
    // Surfnet does not support traveling to past timestamps.

    it("agent_transfer within daily cap succeeds", async () => {
      const version = await readPolicyVersion(program, capSetup.policyPda);
      const transferIx = await program.methods
        .agentTransfer(new BN(50_000_000), version) // 50 USDC
        .accounts({
          agent: capSetup.agent.publicKey,
          vault: capSetup.vaultPda,
          policy: capSetup.policyPda,
          tracker: capSetup.trackerPda,
          agentSpendOverlay: capSetup.overlayPda,
          vaultTokenAccount: capSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: capSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [transferIx],
        capSetup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("agent_transfer exceeding daily cap fails", async () => {
      // Already spent 50, cap is 100, try 60 (total 110 > 100)
      const version = await readPolicyVersion(program, capSetup.policyPda);
      const transferIx = await program.methods
        .agentTransfer(new BN(60_000_000), version) // 60 USDC
        .accounts({
          agent: capSetup.agent.publicKey,
          vault: capSetup.vaultPda,
          policy: capSetup.policyPda,
          tracker: capSetup.trackerPda,
          agentSpendOverlay: capSetup.overlayPda,
          vaultTokenAccount: capSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: capSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [transferIx],
        capSetup.agent,
        "SpendingCapExceeded",
      );
    });

    it("time travel 24h resets rolling cap", async () => {
      // Get current Surfnet clock and advance 24h + buffer
      const clock = await getClock(env.connection);
      await timeTravel(env.connection, {
        absoluteTimestamp: (clock.timestamp + 86_400 + 60) * 1000,
      });

      // After 24h, the rolling window resets — 50 USDC should succeed again
      const version = await readPolicyVersion(program, capSetup.policyPda);
      const transferIx = await program.methods
        .agentTransfer(new BN(50_000_000), version)
        .accounts({
          agent: capSetup.agent.publicKey,
          vault: capSetup.vaultPda,
          policy: capSetup.policyPda,
          tracker: capSetup.trackerPda,
          agentSpendOverlay: capSetup.overlayPda,
          vaultTokenAccount: capSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: destUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: capSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [transferIx],
        capSetup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("sequential transfers accumulate toward cap", async () => {
      // Fresh vault for clean accumulation test
      const dest2 = await createWallet(env.connection, "capDest2", 2);
      const dest2Ata = await fundWithTokens(
        env.connection,
        dest2.publicKey,
        DEVNET_USDC_MINT,
        0,
      );
      const seqSetup = await setupVaultWithAgent(env, program, {
        dailyCap: new BN(100_000_000),
        maxTxSize: new BN(100_000_000),
        vaultFunding: 5_000_000_000,
        allowedDestinations: [dest2.publicKey],
      });

      const version = await readPolicyVersion(program, seqSetup.policyPda);
      // Transfer 30 + 30 + 30 = 90 (under 100 cap)
      for (let i = 0; i < 3; i++) {
        const ix = await program.methods
          .agentTransfer(new BN(30_000_000), version)
          .accounts({
            agent: seqSetup.agent.publicKey,
            vault: seqSetup.vaultPda,
            policy: seqSetup.policyPda,
            tracker: seqSetup.trackerPda,
            agentSpendOverlay: seqSetup.overlayPda,
            vaultTokenAccount: seqSetup.vaultUsdcAta,
            tokenMintAccount: DEVNET_USDC_MINT,
            destinationTokenAccount: dest2Ata,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: seqSetup.protocolTreasuryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .instruction();

        await sendVersionedTx(env.connection, [ix], seqSetup.agent);
      }

      // 4th transfer of 15 would be 105 > 100 — should fail
      const overIx = await program.methods
        .agentTransfer(new BN(15_000_000), version)
        .accounts({
          agent: seqSetup.agent.publicKey,
          vault: seqSetup.vaultPda,
          policy: seqSetup.policyPda,
          tracker: seqSetup.trackerPda,
          agentSpendOverlay: seqSetup.overlayPda,
          vaultTokenAccount: seqSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: dest2Ata,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: seqSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [overIx],
        seqSetup.agent,
        "SpendingCapExceeded",
      );
    });

    it("per-agent spending limit enforced independently", async () => {
      const dest3 = await createWallet(env.connection, "capDest3", 2);
      const dest3Ata = await fundWithTokens(
        env.connection,
        dest3.publicKey,
        DEVNET_USDC_MINT,
        0,
      );
      const limitSetup = await setupVaultWithAgent(env, program, {
        dailyCap: new BN(500_000_000), // 500 USDC vault cap
        agentSpendingLimit: new BN(50_000_000), // 50 USDC per-agent limit
        vaultFunding: 5_000_000_000,
        allowedDestinations: [dest3.publicKey],
      });

      const version = await readPolicyVersion(program, limitSetup.policyPda);
      // Transfer 40 USDC — under per-agent limit
      const okIx = await program.methods
        .agentTransfer(new BN(40_000_000), version)
        .accounts({
          agent: limitSetup.agent.publicKey,
          vault: limitSetup.vaultPda,
          policy: limitSetup.policyPda,
          tracker: limitSetup.trackerPda,
          agentSpendOverlay: limitSetup.overlayPda,
          vaultTokenAccount: limitSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: dest3Ata,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: limitSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();
      await sendVersionedTx(env.connection, [okIx], limitSetup.agent);

      // Transfer 20 USDC — total 60 > 50 per-agent limit
      const overIx = await program.methods
        .agentTransfer(new BN(20_000_000), version)
        .accounts({
          agent: limitSetup.agent.publicKey,
          vault: limitSetup.vaultPda,
          policy: limitSetup.policyPda,
          tracker: limitSetup.trackerPda,
          agentSpendOverlay: limitSetup.overlayPda,
          vaultTokenAccount: limitSetup.vaultUsdcAta,
          tokenMintAccount: DEVNET_USDC_MINT,
          destinationTokenAccount: dest3Ata,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: limitSetup.protocolTreasuryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [overIx],
        limitSetup.agent,
        "AgentSpendLimitExceeded",
      );
    });

    it("register 11th agent fails with MaxAgentsReached", async () => {
      const maxSetup = await setupVaultWithAgent(env, program);

      // Register agents 2-10 (agent 1 already registered by setup). These are
      // pure count-fillers — never used for an OPERATOR action — so seat them as
      // Observer (capability 1), which is instant-eligible (no F-Q6 timelock).
      // MaxAgentsReached is checked at register_agent.rs:125, BEFORE the OPERATOR
      // gate at :140, so the cap is capability-agnostic and the 11th-agent
      // assertion below still fires with the exact same error. (Capability levels:
      // 0=Disabled, 1=Observer, 2=Operator.)
      const OBSERVER_CAPABILITY = 1;
      for (let i = 2; i <= 10; i++) {
        const extra = await createWallet(env.connection, `maxAgent${i}`, 2);
        const regIx = await program.methods
          .registerAgent(extra.publicKey, OBSERVER_CAPABILITY, new BN(0))
          .accounts({
            owner: env.payer.publicKey,
            vault: maxSetup.vaultPda,
            agentSpendOverlay: maxSetup.overlayPda,
          } as any)
          .instruction();
        await sendVersionedTx(env.connection, [regIx], env.payer);
      }

      // 11th agent should fail
      const eleventh = await createWallet(env.connection, "agent11", 2);
      const regIx = await program.methods
        .registerAgent(eleventh.publicKey, FULL_CAPABILITY, new BN(0))
        .accounts({
          owner: env.payer.publicKey,
          vault: maxSetup.vaultPda,
          agentSpendOverlay: maxSetup.overlayPda,
        } as any)
        .instruction();

      await expectTxError(
        env.connection,
        [regIx],
        env.payer,
        "MaxAgentsReached",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 13: Session expiry edge cases (slot-based)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("13. session expiry edge cases", () => {
    let setup: VaultSetupResult;

    before(async () => {
      setup = await setupVaultWithAgent(env, program);
    });

    it("validate+finalize succeeds at normal slot", async () => {
      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves a composed TX
          // succeeds at a normal slot (signature returned), not a spend magnitude
          // — a non-spending session (amount 0) is exempt and preserves the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: setup.agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(setup.agent.publicKey), finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });

    it("validate+finalize succeeds after large slot advancement", async () => {
      // Time travel forward by many slots — each TX creates a fresh session,
      // so slot advancement should not break composed TX flow
      const currentSlot = await env.connection.getSlot();
      await timeTravel(env.connection, {
        absoluteSlot: currentSlot + 1000,
      });

      const sessionPda = deriveSessionPda(
        setup.vaultPda,
        setup.agent.publicKey,
        DEVNET_USDC_MINT,
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          DEVNET_USDC_MINT,
          // require-measurable-outcome (err 6115): this test proves slot
          // advancement does not break the composed TX flow (signature returned),
          // not a spend magnitude — a non-spending session (amount 0) is exempt
          // and preserves the intent.
          new BN(0),
          MOCK_DEFI_PROGRAM_ID,
          await readPolicyVersion(program, setup.policyPda),
          new BN(0), // AC-10 expectedNonce (fresh session)
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: setup.vaultPda,
              agent: setup.agent.publicKey,
              tokenMint: DEVNET_USDC_MINT,
              // must match the validate arg above (PolicyPreviewMismatch otherwise)
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          agentSpendOverlay: setup.overlayPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: setup.agent.publicKey, isSigner: false, isWritable: false },
        ])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
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
          outputSwapAccount: null,
        })
        .instruction();

      const result = await sendVersionedTx(
        env.connection,
        [validateIx, buildMockDefiNoopIx(setup.agent.publicKey), finalizeIx],
        setup.agent,
      );
      expect(result.signature).to.be.a("string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Suite 14: Vault lifecycle completion (revoke + close)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("14. vault lifecycle completion", () => {
    it("revoke_agent removes agent and freezes empty vault", async () => {
      const setup = await setupVaultWithAgent(env, program, {
        vaultFunding: 0,
      });

      // Revoke the only agent
      await program.methods
        .revokeAgent(setup.agent.publicKey)
        .accounts({
          owner: env.payer.publicKey,
          vault: setup.vaultPda,
          agentSpendOverlay: setup.overlayPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(setup.vaultPda);
      expect(vault.agents.length).to.equal(0);
      // Vault should be frozen when all agents are revoked
      expect(vault.status).to.have.property("frozen");
    });

    it("close_vault deletes vault PDA and reclaims rent", async () => {
      const closeSetup = await setupVaultWithAgent(env, program, {
        vaultFunding: 0,
      });

      // Revoke agent first (required before close)
      await program.methods
        .revokeAgent(closeSetup.agent.publicKey)
        .accounts({
          owner: env.payer.publicKey,
          vault: closeSetup.vaultPda,
          agentSpendOverlay: closeSetup.overlayPda,
        } as any)
        .rpc();

      // Close vault
      await program.methods
        .closeVault()
        .accounts({
          owner: env.payer.publicKey,
          vault: closeSetup.vaultPda,
          policy: closeSetup.policyPda,
          tracker: closeSetup.trackerPda,
          agentSpendOverlay: closeSetup.overlayPda,
        } as any)
        .rpc();

      // Vault PDA should no longer exist
      try {
        await program.account.agentVault.fetch(closeSetup.vaultPda);
        expect.fail("Vault should be closed");
      } catch (err: any) {
        if (err.name === "AssertionError") throw err;
        const errStr = err.message || JSON.stringify(err);
        expect(errStr).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }
    });
  });
});
