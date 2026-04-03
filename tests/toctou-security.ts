/**
 * TOCTOU Security Fix Tests
 *
 * Validates the Time-of-Check to Time-of-Use security hardening:
 * - Mandatory minimum timelockDuration (1800s / 30 min)
 * - Policy version counter (OCC) to prevent stale-policy agent TXes
 * - Deletion of direct-mutation instructions (updatePolicy, etc.)
 * - Version bump on apply_pending_policy and apply_constraints_update
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
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaIdempotentHelper,
  mintToHelper,
  advanceTime,
  sendVersionedTx,
  expectSigilError,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

describe("TOCTOU Security Fix", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;
  let owner: anchor.Wallet;

  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const jupiterProgramId = Keypair.generate().publicKey;

  let usdcMint: PublicKey;

  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );
  let protocolTreasuryUsdcAta: PublicKey;

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

    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  let vaultCounter = 0;

  /** Create a fresh vault with the given timelockDuration and return all PDAs. */
  function createVault(timelockDuration: number) {
    vaultCounter++;
    const vaultId = new BN(9000 + vaultCounter);

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
    const [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );
    const [trackerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
    const [overlayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
      program.programId,
    );
    const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_policy"), vaultPda.toBuffer()],
      program.programId,
    );

    return { vaultId, vaultPda, policyPda, trackerPda, overlayPda, pendingPolicyPda };
  }

  /** Initialize a vault, register agent, deposit funds. Returns PDAs. */
  async function setupFullVault(timelockDuration: number) {
    const pdas = createVault(timelockDuration);

    const ownerUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey,
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      1_000_000_000n,
    );

    const vaultUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      pdas.vaultPda,
      true,
    );

    await program.methods
      .initializeVault(
        pdas.vaultId,
        new BN(500_000_000), // daily cap: 500 USDC
        new BN(100_000_000), // max tx: 100 USDC
        0, // protocol mode: all
        [jupiterProgramId],
        new BN(0) as any, // max_leverage_bps
        3, // max_concurrent_positions
        0, // developer_fee_rate
        500, // maxSlippageBps
        new BN(timelockDuration),
        [], // allowedDestinations
        [], // protocolCaps
      )
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        policy: pdas.policyPda,
        tracker: pdas.trackerPda,
        agentSpendOverlay: pdas.overlayPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
      .accountsPartial({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        agentSpendOverlay: pdas.overlayPda,
      })
      .rpc();

    await program.methods
      .depositFunds(new BN(500_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { ...pdas, ownerUsdcAta, vaultUsdcAta };
  }

  /** Queue a policy update, advance time, and apply it. Returns the new policy version. */
  async function queueAndApplyPolicy(
    v: { vaultPda: PublicKey; policyPda: PublicKey; pendingPolicyPda: PublicKey },
    timelockSeconds: number,
    dailyCap?: BN,
  ) {
    await program.methods
      .queuePolicyUpdate(
        dailyCap ?? null,
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
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        pendingPolicy: v.pendingPolicyPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    advanceTime(svm, timelockSeconds + 1);

    await program.methods
      .applyPendingPolicy()
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        pendingPolicy: v.pendingPolicyPda,
      } as any)
      .rpc();

    const policy = await program.account.policyConfig.fetch(v.policyPda);
    return (policy as any).policyVersion.toNumber();
  }

  // ─── Test 1: PolicyVersionMismatch ───────────────────────────────────────

  it("rejects validate_and_authorize with stale policy version", async () => {
    const v = await setupFullVault(1800);

    // Queue a policy change, advance time, apply it → version becomes 1
    const newVersion = await queueAndApplyPolicy(v, 1800, new BN(400_000_000));
    expect(newVersion).to.equal(1);

    // Build validate_and_authorize with stale expectedPolicyVersion: 0
    const sessionPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        v.vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    )[0];

    try {
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
          new BN(0), // STALE: policy is now at version 1
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          tracker: v.trackerPda,
          session: sessionPda,
          vaultTokenAccount: v.vaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          agentSpendOverlay: v.overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession()
        .accountsPartial({
          payer: agent.publicKey,
          vault: v.vaultPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: v.policyPda,
          tracker: v.trackerPda,
          vaultTokenAccount: v.vaultUsdcAta,
          agentSpendOverlay: v.overlayPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err.toString(), "PolicyVersionMismatch");
    }
  });

  // ─── Test 2: TimelockTooShort on vault creation ──────────────────────────

  it("rejects initialize_vault with timelockDuration below minimum", async () => {
    const pdas = createVault(0); // will attempt timelockDuration: 0

    // No need for ATA — initializeVault should fail before touching tokens

    try {
      await program.methods
        .initializeVault(
          pdas.vaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          500,
          new BN(0), // timelockDuration: 0 — below minimum (NEGATIVE TEST)
          [],
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: pdas.vaultPda,
          policy: pdas.policyPda,
          tracker: pdas.trackerPda,
          agentSpendOverlay: pdas.overlayPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err.toString(), "TimelockTooShort");
    }
  });

  // ─── Test 3: TimelockTooShort on queue with reduction below floor ────────

  it("rejects queuePolicyUpdate with timelockDuration below minimum", async () => {
    const v = await setupFullVault(1800);

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
          new BN(900), // timelockDuration: 900 — below 1800 minimum
          null,
          null, // sessionExpirySlots
          null, // hasProtocolCaps
          null, // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          pendingPolicy: v.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err.toString(), "TimelockTooShort");
    }
  });

  // ─── Test 4: Timelock self-removal blocked ───────────────────────────────

  it("rejects queuePolicyUpdate with timelockDuration: 0", async () => {
    const v = await setupFullVault(1800);

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
          new BN(0), // timelockDuration: 0 — removal blocked (NEGATIVE TEST)
          null,
          null, // sessionExpirySlots
          null, // hasProtocolCaps
          null, // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: v.vaultPda,
          policy: v.policyPda,
          pendingPolicy: v.pendingPolicyPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expectSigilError(err.toString(), "TimelockTooShort");
    }
  });

  // ─── Test 5: Version bump on apply_pending_policy ────────────────────────

  it("bumps policy_version when applying pending policy", async () => {
    const v = await setupFullVault(1800);

    // Initial version should be 0
    const policy0 = await program.account.policyConfig.fetch(v.policyPda);
    expect((policy0 as any).policyVersion.toNumber()).to.equal(0);

    // Queue + apply → version 1
    const v1 = await queueAndApplyPolicy(v, 1800, new BN(400_000_000));
    expect(v1).to.equal(1);

    // Queue + apply again → version 2
    const v2 = await queueAndApplyPolicy(v, 1800, new BN(300_000_000));
    expect(v2).to.equal(2);
  });

  // ─── Test 6: Version bump on apply_constraints_update ────────────────────

  it("bumps policy_version when applying constraints update", async () => {
    const v = await setupFullVault(1800);

    // Initial version
    const policy0 = await program.account.policyConfig.fetch(v.policyPda);
    expect((policy0 as any).policyVersion.toNumber()).to.equal(0);

    // Create instruction constraints PDA
    const [constraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("constraints"), v.vaultPda.toBuffer()],
      program.programId,
    );

    const entries = [
      {
        programId: jupiterProgramId,
        dataConstraints: [
          {
            offset: 0,
            operator: { eq: {} },
            value: Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]),
          },
        ],
        accountConstraints: [],
      },
    ];

    await program.methods
      .createInstructionConstraints(entries, false)
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        constraints: constraintsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Queue constraints update
    const [pendingConstraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_constraints"), v.vaultPda.toBuffer()],
      program.programId,
    );

    const newEntries = [
      {
        programId: jupiterProgramId,
        dataConstraints: [
          {
            offset: 0,
            operator: { ne: {} },
            value: Buffer.from([0x00]),
          },
        ],
        accountConstraints: [],
      },
    ];

    await program.methods
      .queueConstraintsUpdate(newEntries, false)
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        constraints: constraintsPda,
        pendingConstraints: pendingConstraintsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Advance time past the 1800s timelock
    advanceTime(svm, 1801);

    // Apply constraints update — now requires policy account for version bump
    await program.methods
      .applyConstraintsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        constraints: constraintsPda,
        pendingConstraints: pendingConstraintsPda,
      } as any)
      .rpc();

    // Verify policy version bumped to 1
    const policy1 = await program.account.policyConfig.fetch(v.policyPda);
    expect((policy1 as any).policyVersion.toNumber()).to.equal(1);
  });

  // ─── Test 7: Deleted instructions not callable ───────────────────────────

  it("updatePolicy instruction does not exist", async () => {
    // TypeScript-level check: the deleted instruction should not appear
    // in the generated program methods.
    expect((program.methods as any).updatePolicy).to.be.undefined;
  });
});
