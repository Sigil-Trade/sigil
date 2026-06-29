/**
 * M2 — explicit session<->finalize binding (LiteSVM coverage).
 *
 * validate_and_authorize's forward instruction-sysvar scan locates the finalize
 * ix by DISCRIMINATOR ONLY (scan_instruction_shared). Before this fix it never
 * asserted the finalize ix's session-account meta == ctx.accounts.session.key();
 * a cross-session [validate(X), DeFi, finalize(Y)] bundle was blocked only
 * EMERGENTLY (one-validate-per-tx 6082 + Anchor `init` + same-tx close). The fix
 * pins the finalize ix's session meta (FinalizeSession Accounts index 2) to THIS
 * validate's session with require_keys_eq!(..., MissingFinalizeInstruction).
 *
 * Proves:
 *   - honest same-session [validate, defi-noop, finalize] passes
 *   - a bundle whose finalize ix references a DIFFERENT session pubkey reverts
 *     (MissingFinalizeInstruction)
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
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import { initVaultPreviewDigest } from "./helpers/policy-digest";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "./helpers/intent-digest-fixture";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  mintToHelper,
  sendVersionedTx,
  TestEnv,
  LiteSVM,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "./helpers/litesvm-setup";
import { registerOperatorAgent } from "./helpers/register-operator-agent";
import { expectSigilError } from "./helpers/strict-errors";

// FinalizeSession Accounts ordering: payer(0), vault(1), session(2), ...
const FINALIZE_SESSION_META_INDEX = 2;

describe("M2 session<->finalize binding", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(31);
  const targetProtocol = MOCK_DEFI_PROGRAM_ID;
  const protocolTreasury = new PublicKey(
    "6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp",
  );

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let protocolTreasuryUsdcAta: PublicKey;

  const TIMELOCK = new BN(1800);

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );

    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });
    createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      feeDestination.publicKey,
    );
    protocolTreasuryUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      10_000_000_000n,
    );

    await program.methods
      .initializeVault(
        vaultId,
        new BN(1_000_000_000),
        new BN(500_000_000),
        1,
        [targetProtocol],
        0,
        5000,
        TIMELOCK,
        [],
        [],
        false,
        0x00ffffff,
        false,
        5,
        new BN(0),
        new BN(0),
        false,
        initVaultPreviewDigest({
          dailySpendingCapUsd: new BN(1_000_000_000),
          maxTransactionSizeUsd: new BN(500_000_000),
          maxSlippageBps: 5000,
          protocolMode: 1,
          protocols: [targetProtocol],
          allowedDestinations: [],
          timelockDuration: TIMELOCK,
          operatingHours: 0x00ffffff,
          autoPromoteGrays: false,
          autoRevokeThreshold: 5,
        }),
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await registerOperatorAgent({
      program,
      svm,
      owner: owner.publicKey,
      vault: vaultPda,
      agent: agent.publicKey,
    });

    await program.methods
      .depositFunds(new BN(5_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });

  function getSessionPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    )[0];
  }

  async function buildValidateIx(amount: BN) {
    const livePolicy = await program.account.policyConfig.fetch(policyPda);
    return program.methods
      .validateAndAuthorize(
        usdcMint,
        amount,
        targetProtocol,
        livePolicy.policyVersion,
        new BN(0),
        digestAsArgs(
          buildExpectedIntentDigest({
            vault: vaultPda,
            agent: agent.publicKey,
            tokenMint: usdcMint,
            amount,
            targetProtocol,
          }),
        ),
      )
      .accountsPartial({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: getSessionPda(),
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: agent.publicKey, isSigner: false, isWritable: false },
      ])
      .instruction();
  }

  async function buildFinalizeIx() {
    return program.methods
      .finalizeSession()
      .accountsPartial({
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        payer: agent.publicKey,
        vault: vaultPda,
        session: getSessionPda(),
        sessionRentRecipient: agent.publicKey,
        policy: policyPda,
        tracker: trackerPda,
        vaultTokenAccount: vaultUsdcAta,
        agentSpendOverlay: overlayPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        outputStablecoinAccount: null,
        outputSwapAccount: null,
      })
      .instruction();
  }

  it("honest same-session [validate, defi-noop, finalize] passes", async () => {
    const validateIx = await buildValidateIx(new BN(0));
    const defiIx = buildMockDefiNoopIx(agent.publicKey);
    const finalizeIx = await buildFinalizeIx();
    // Sanity: the finalize ix's session meta is at the assumed index.
    expect(
      finalizeIx.keys[FINALIZE_SESSION_META_INDEX].pubkey.equals(
        getSessionPda(),
      ),
      "finalize meta[2] is the session account",
    ).to.equal(true);
    sendVersionedTx(svm, [validateIx, defiIx, finalizeIx], agent);
  });

  it("finalize ix referencing a DIFFERENT session pubkey reverts (MissingFinalizeInstruction)", async () => {
    const validateIx = await buildValidateIx(new BN(0));
    const defiIx = buildMockDefiNoopIx(agent.publicKey);
    const finalizeIx = await buildFinalizeIx();

    // Tamper: swap the finalize ix's session meta (index 2) to a foreign pubkey,
    // simulating a cross-session [validate(X), DeFi, finalize(Y)] bundle. validate
    // reads the finalize meta from the instructions sysvar and must reject BEFORE
    // finalize executes.
    const foreignSession = Keypair.generate().publicKey;
    const tamperedFinalize = {
      ...finalizeIx,
      keys: finalizeIx.keys.map((k, i) =>
        i === FINALIZE_SESSION_META_INDEX
          ? { ...k, pubkey: foreignSession }
          : k,
      ),
    };

    try {
      sendVersionedTx(svm, [validateIx, defiIx, tamperedFinalize], agent);
      expect.fail("expected MissingFinalizeInstruction (session mismatch)");
    } catch (err) {
      expectSigilError(err, { name: "MissingFinalizeInstruction" });
    }
  });
});
