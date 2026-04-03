import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  createTestEnv,
  airdropSol,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  accountExists,
  advanceTime,
  sendVersionedTx,
  expectSigilError,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

describe("instruction-constraints", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Sigil>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(400);

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let overlayPda: PublicKey;
  let constraintsPda: PublicKey;
  let pendingConstraintsPda: PublicKey;
  let pendingCloseConstraintsPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

  // Read current policy version for TOCTOU check
  async function pv(addr?: PublicKey): Promise<BN> {
    try {
      const pol = await program.account.policyConfig.fetch(addr ?? policyPda);
      return (pol as any).policyVersion ?? new BN(0);
    } catch { return new BN(0); }
  }

  const jupiterProgramId = Keypair.generate().publicKey;
  const protocolTreasury = new PublicKey(
    "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
  );
  let protocolTreasuryUsdcAta: PublicKey;

  after(() => printCUSummary());

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

    ownerUsdcAta = createAtaHelper(
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
      2_000_000_000n,
    );

    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

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
    [constraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("constraints"), vaultPda.toBuffer()],
      program.programId,
    );
    [pendingConstraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_constraints"), vaultPda.toBuffer()],
      program.programId,
    );
    [pendingCloseConstraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_close_constraints"), vaultPda.toBuffer()],
      program.programId,
    );

    // Initialize vault (protocolMode=0 = all allowed, timelock=1800)
    await program.methods
      .initializeVault(
        vaultId,
        new BN(500_000_000), // 500 USDC daily cap
        new BN(100_000_000), // 100 USDC max tx
        0, // protocolMode: all
        [],
        new BN(0) as any,
        3,
        0, // no developer fee
        100, // maxSlippageBps
        new BN(1800), // 1800s timelock (MIN_TIMELOCK_DURATION)
        [],
        [], // protocolCaps
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

    // Register agent
    await program.methods
      .registerAgent(agent.publicKey, FULL_PERMISSIONS, new BN(0))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        agentSpendOverlay: overlayPda,
      } as any)
      .rpc();

    // Create vault ATA and deposit
    vaultUsdcAta = anchor.utils.token.associatedAddress({
      mint: usdcMint,
      owner: vaultPda,
    });

    await program.methods
      .depositFunds(new BN(1_000_000_000))
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });

  // Helper: build finalize instruction
  function buildFinalizeIx(agentKey: PublicKey, mint: PublicKey) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agentKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId,
    );
    return program.methods
      .finalizeSession()
      .accountsPartial({
        payer: agentKey,
        vault: vaultPda,
        session: sessionPda,
        sessionRentRecipient: agentKey,
        policy: policyPda,
        tracker: trackerPda,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // Helper: build validate instruction with optional remaining accounts
  async function buildValidateIx(
    amount: BN,
    actionType: any,
    targetProtocol: PublicKey,
    remainingAccounts?: {
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }[],
  ) {
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("session"),
        vaultPda.toBuffer(),
        agent.publicKey.toBuffer(),
        usdcMint.toBuffer(),
      ],
      program.programId,
    );
    let builder = program.methods
      .validateAndAuthorize(actionType, usdcMint, amount, targetProtocol, null, await pv())
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
        agentSpendOverlay: overlayPda,
        vaultTokenAccount: vaultUsdcAta,
        tokenMintAccount: usdcMint,
        protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
        feeDestinationTokenAccount: null,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any);
    if (remainingAccounts) {
      builder = builder.remainingAccounts(remainingAccounts);
    }
    return builder.instruction();
  }

  // Helper: queue constraints update + advance time + apply (replaces updateInstructionConstraints)
  async function queueAndApplyConstraintsUpdate(
    entries: any[],
    strictMode: boolean,
    vault: PublicKey,
    policy: PublicKey,
    constraints: PublicKey,
    pendingConstraints: PublicKey,
    timelockSeconds: number = 1800,
  ) {
    await program.methods
      .queueConstraintsUpdate(entries, strictMode)
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        constraints,
        pendingConstraints,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    advanceTime(svm, timelockSeconds + 1);
    await program.methods
      .applyConstraintsUpdate()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        constraints,
        pendingConstraints,
      } as any)
      .rpc();
  }

  // Helper: queue close constraints + advance time + apply (replaces closeInstructionConstraints)
  async function queueAndApplyCloseConstraints(
    vault: PublicKey,
    policy: PublicKey,
    constraints: PublicKey,
    pendingCloseConstraints: PublicKey,
    timelockSeconds: number = 1800,
  ) {
    await program.methods
      .queueCloseConstraints()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        constraints,
        pendingCloseConstraints,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    advanceTime(svm, timelockSeconds + 1);
    await program.methods
      .applyCloseConstraints()
      .accounts({
        owner: owner.publicKey,
        vault,
        policy,
        constraints,
        pendingCloseConstraints,
      } as any)
      .rpc();
  }

  // =======================================================================
  // CRUD
  // =======================================================================
  describe("CRUD", () => {
    it("creates constraints PDA and sets has_constraints=true", async () => {
      const entries = [
        {
          programId: jupiterProgramId,
          dataConstraints: [
            {
              offset: 0,
              operator: { eq: {} },
              value: Buffer.from([0xaa, 0xbb]),
            },
          ],
          accountConstraints: [],
        },
      ];

      await program.methods
        .createInstructionConstraints(entries, false)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Verify constraints PDA
      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.vault.toString()).to.equal(vaultPda.toString());
      expect(constraintsAcct.entries.length).to.equal(1);
      expect(constraintsAcct.entries[0].programId.toString()).to.equal(
        jupiterProgramId.toString(),
      );
      expect(constraintsAcct.entries[0].dataConstraints.length).to.equal(1);

      // Verify has_constraints flag set
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.hasConstraints).to.equal(true);
    });

    it("updates constraints via queue+apply", async () => {
      const newEntries = [
        {
          programId: jupiterProgramId,
          dataConstraints: [
            {
              offset: 8,
              operator: { gte: {} },
              value: Buffer.from(new BN(100).toArray("le", 8)),
            },
          ],
          accountConstraints: [],
        },
      ];

      await queueAndApplyConstraintsUpdate(
        newEntries,
        false,
        vaultPda,
        policyPda,
        constraintsPda,
        pendingConstraintsPda,
      );

      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.entries[0].dataConstraints[0].offset).to.equal(8);
    });

    it("closes constraints PDA and sets has_constraints=false", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      expect(accountExists(svm, constraintsPda)).to.equal(false);

      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.hasConstraints).to.equal(false);
    });
  });

  // =======================================================================
  // Enforcement
  // =======================================================================
  describe("enforcement", () => {
    // Re-create constraints for enforcement tests
    before(async () => {
      const entries = [
        {
          programId: jupiterProgramId,
          dataConstraints: [
            {
              offset: 0,
              operator: { eq: {} },
              value: Buffer.from([0x01, 0x02]),
            },
          ],
          accountConstraints: [],
        },
      ];

      await program.methods
        .createInstructionConstraints(entries, false)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("backward compat: no constraints PDA + has_constraints=false works", async () => {
      // First close constraints to set has_constraints=false
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      // Validate without remaining accounts — should succeed
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);

      // Re-create constraints for subsequent tests
      const entries = [
        {
          programId: jupiterProgramId,
          dataConstraints: [
            {
              offset: 0,
              operator: { eq: {} },
              value: Buffer.from([0x01, 0x02]),
            },
          ],
          accountConstraints: [],
        },
      ];
      await program.methods
        .createInstructionConstraints(entries, false)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("spending action with matching Eq constraint passes", async () => {
      // The constraint requires ix.data[0..2] == [0x01, 0x02]
      // We pass constraints PDA as remaining account
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);

      // The composed tx has [validate, finalize] — there are no intermediate
      // instructions to check constraints against, so this should pass.
      const result = sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      recordCU("constraints:spending_with_pda", result);
    });

    it("non-spending action with constraints PDA succeeds when no intermediate ix", async () => {
      const validateIx = await buildValidateIx(
        new BN(0),
        { closePosition: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);

      // Need to open a position first so we can close it
      // Actually for non-spending, we just need open_positions > 0.
      // Let's use syncPositions to set it.
      await program.methods
        .syncPositions(1)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      const result = sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      recordCU("constraints:non_spending_with_pda", result);

      // Reset position count
      await program.methods
        .syncPositions(0)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();
    });
  });

  // =======================================================================
  // Bypass prevention
  // =======================================================================
  describe("bypass prevention", () => {
    it("agent omits constraints PDA when has_constraints=true → InvalidConstraintsPda", async () => {
      // has_constraints is true (constraints exist), but we don't pass remaining accounts
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        // NO remaining accounts — bypass attempt
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);

      try {
        sendVersionedTx(svm, [validateIx, finalizeIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintsPda");
      }
    });

    it("agent passes wrong PDA as constraints → InvalidConstraintsPda", async () => {
      // Create a second vault with constraints, then try to use its PDA
      const vaultId2 = new BN(401);
      const [vault2Pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vaultId2.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [policy2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), vault2Pda.toBuffer()],
        program.programId,
      );
      const [tracker2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), vault2Pda.toBuffer()],
        program.programId,
      );
      const [constraints2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("constraints"), vault2Pda.toBuffer()],
        program.programId,
      );

      // Init vault 2
      const [vault2Overlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), vault2Pda.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      await program.methods
        .initializeVault(
          vaultId2,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(1800),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: vault2Pda,
          policy: policy2Pda,
          tracker: tracker2Pda,
          agentSpendOverlay: vault2Overlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create constraints on vault 2
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vault2Pda,
          policy: policy2Pda,
          constraints: constraints2Pda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Try to use vault 2's constraints PDA on vault 1 → wrong PDA
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraints2Pda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);

      try {
        sendVersionedTx(svm, [validateIx, finalizeIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintsPda");
      }
    });
  });

  // =======================================================================
  // Bounds validation
  // =======================================================================
  describe("bounds validation", () => {
    it("rejects >16 constraint entries → InvalidConstraintConfig", async () => {
      // Close existing constraints first (if they exist)
      if (accountExists(svm, constraintsPda)) {
        await queueAndApplyCloseConstraints(
          vaultPda,
          policyPda,
          constraintsPda,
          pendingCloseConstraintsPda,
        );
      }

      const entries = [];
      for (let i = 0; i < 17; i++) {
        entries.push({
          programId: Keypair.generate().publicKey,
          dataConstraints: [
            { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
          ],
          accountConstraints: [],
        });
      }

      try {
        await program.methods
          .createInstructionConstraints(entries, false)
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintConfig");
      }
    });

    it("rejects >8 data constraints per entry → InvalidConstraintConfig", async () => {
      const dataConstraints = [];
      for (let i = 0; i < 9; i++) {
        dataConstraints.push({
          offset: i,
          operator: { eq: {} },
          value: Buffer.from([0x01]),
        });
      }

      try {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints,
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintConfig");
      }
    });

    it("rejects >32 byte constraint value → InvalidConstraintConfig", async () => {
      const bigValue = Buffer.alloc(33, 0xff);

      try {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  {
                    offset: 0,
                    operator: { eq: {} },
                    value: bigValue,
                  },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintConfig");
      }
    });

    // P2 #30: Verify exactly 32 bytes is accepted (boundary success case)
    it("accepts exactly 32-byte constraint value (boundary)", async () => {
      const exactValue = Buffer.alloc(32, 0xab);
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: exactValue },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct = await program.account.instructionConstraints.fetch(constraintsPda);
      expect(Buffer.from(acct.entries[0].dataConstraints[0].value).length).to.equal(32);

      // Clean up for subsequent tests
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );
    });

    // Re-create constraints for remaining tests
    after(async () => {
      // Policy may show has_constraints=false, recreate
      const policy = await program.account.policyConfig.fetch(policyPda);
      if (!policy.hasConstraints) {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  {
                    offset: 0,
                    operator: { eq: {} },
                    value: Buffer.from([0x01, 0x02]),
                  },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
      }
    });
  });

  // =======================================================================
  // Timelock
  // =======================================================================
  describe("timelock", () => {
    const tlVaultId = new BN(402);
    let tlVaultPda: PublicKey;
    let tlPolicyPda: PublicKey;
    let tlTrackerPda: PublicKey;
    let tlConstraintsPda: PublicKey;
    let tlPendingConstraintsPda: PublicKey;

    before(async () => {
      [tlVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          tlVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [tlPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), tlVaultPda.toBuffer()],
        program.programId,
      );
      [tlTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), tlVaultPda.toBuffer()],
        program.programId,
      );
      [tlConstraintsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("constraints"), tlVaultPda.toBuffer()],
        program.programId,
      );
      [tlPendingConstraintsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_constraints"), tlVaultPda.toBuffer()],
        program.programId,
      );

      const [tlOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), tlVaultPda.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      // Init vault with timelock = 1800 seconds (MIN_TIMELOCK_DURATION)
      await program.methods
        .initializeVault(
          tlVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(1800), // 1800s timelock (MIN_TIMELOCK_DURATION)
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          agentSpendOverlay: tlOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create constraints (allowed — additive change)
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0xff]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          constraints: tlConstraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    // NOTE: "direct update rejected → TimelockActive" and "close rejected → TimelockActive"
    // tests removed — updateInstructionConstraints and closeInstructionConstraints are deleted.
    // All updates/closes now go through the queue+apply path.

    it("queue → apply after timelock expires", async () => {
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

      // Queue
      await program.methods
        .queueConstraintsUpdate(newEntries, false)
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          constraints: tlConstraintsPda,
          pendingConstraints: tlPendingConstraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      expect(accountExists(svm, tlPendingConstraintsPda)).to.equal(true);

      // Apply before timelock → should fail
      try {
        await program.methods
          .applyConstraintsUpdate()
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            constraints: tlConstraintsPda,
            pendingConstraints: tlPendingConstraintsPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "TimelockNotExpired");
      }

      // Advance time past timelock
      advanceTime(svm, 1801);

      // Apply after timelock → success
      await program.methods
        .applyConstraintsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          constraints: tlConstraintsPda,
          pendingConstraints: tlPendingConstraintsPda,
        } as any)
        .rpc();

      // Verify updated
      const constraints =
        await program.account.instructionConstraints.fetch(tlConstraintsPda);
      expect(constraints.entries[0].dataConstraints[0].offset).to.equal(0);

      // Pending PDA closed
      expect(accountExists(svm, tlPendingConstraintsPda)).to.equal(false);
    });

    it("cancel pending constraints update", async () => {
      // Queue another update
      await program.methods
        .queueConstraintsUpdate(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          constraints: tlConstraintsPda,
          pendingConstraints: tlPendingConstraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      expect(accountExists(svm, tlPendingConstraintsPda)).to.equal(true);

      // Cancel
      await program.methods
        .cancelConstraintsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          pendingConstraints: tlPendingConstraintsPda,
        } as any)
        .rpc();

      expect(accountExists(svm, tlPendingConstraintsPda)).to.equal(false);
    });

    it("initializeVault rejects timelockDuration: 0 → TimelockTooShort", async () => {
      // With mandatory MIN_TIMELOCK_DURATION, zero-timelock vaults can't exist.
      // This replaces the old "queue fails when timelock = 0" test.
      const noTlVaultId = new BN(403);
      const [noTlVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), noTlVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId,
      );
      const [noTlPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), noTlVault.toBuffer()],
        program.programId,
      );
      const [noTlTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), noTlVault.toBuffer()],
        program.programId,
      );
      const [noTlOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), noTlVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );

      try {
        await program.methods
          .initializeVault(
            noTlVaultId, new BN(500_000_000), new BN(100_000_000),
            0, [], new BN(0) as any, 3, 0, 100,
            new BN(0), // timelockDuration: 0 — NEGATIVE TEST (should fail)
            [], [],
          )
          .accounts({
            owner: owner.publicKey, vault: noTlVault, policy: noTlPolicy,
            tracker: noTlTracker, agentSpendOverlay: noTlOverlay,
            feeDestination: feeDestination.publicKey, systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "TimelockTooShort");
      }
    });
  });

  // =======================================================================
  // Operator tests (Eq/Ne/Gte/Lte enforcement via composed TX)
  // =======================================================================
  describe("operator enforcement via composed TX", () => {
    // These tests use a mock DeFi program approach — we need intermediate
    // instructions between validate and finalize that match constraint entries.
    // Since the scan loop only checks spending actions, and we need Jupiter
    // program ID constraints, we test by verifying constraint violations.
    // The simplest test: create constraints with impossible Eq match
    // on the program's own ID, then verify validate+finalize still works
    // when no intermediate instruction exists for that program.

    it("empty data_constraints for a program → passthrough (no violation)", async () => {
      // Close and recreate with empty data constraints for Jupiter
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [], // No data constraints — any instruction from Jupiter passes
              accountConstraints: [{ index: 0, expected: jupiterProgramId }],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // This should succeed — constraints PDA exists but no data constraints
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("constraint on unrelated program → no match → passthrough", async () => {
      // Close and recreate with constraints on a program that isn't in the TX
      const unrelatedProgram = Keypair.generate().publicKey;

      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: unrelatedProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0xff]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Should succeed — unrelated program not in TX, no constraint check fires
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });
  });

  // =======================================================================
  // Access control
  // =======================================================================
  describe("access control", () => {
    it("non-owner cannot create constraints → UnauthorizedOwner", async () => {
      const attacker = Keypair.generate();
      airdropSol(svm, attacker.publicKey, 5 * LAMPORTS_PER_SOL);

      // Close existing constraints so we can test init
      if (accountExists(svm, constraintsPda)) {
        await queueAndApplyCloseConstraints(
          vaultPda,
          policyPda,
          constraintsPda,
          pendingCloseConstraintsPda,
        );
      }

      // Attacker's vault PDA derivation uses attacker.publicKey → ConstraintSeeds
      try {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  {
                    offset: 0,
                    operator: { eq: {} },
                    value: Buffer.from([0x01]),
                  },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accountsPartial({
            owner: attacker.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Fails on vault PDA seed derivation (owner mismatch) or has_one check
        expect(err.toString()).to.match(
          /ConstraintSeeds|UnauthorizedOwner|2006|has_one/,
        );
      }

      // Re-create constraints for subsequent tests
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0x01, 0x02]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("non-owner cannot update constraints", async () => {
      const attacker = Keypair.generate();
      airdropSol(svm, attacker.publicKey, 5 * LAMPORTS_PER_SOL);

      try {
        await program.methods
          .queueConstraintsUpdate(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  {
                    offset: 0,
                    operator: { eq: {} },
                    value: Buffer.from([0x01]),
                  },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accountsPartial({
            owner: attacker.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            pendingConstraints: pendingConstraintsPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.match(
          /ConstraintSeeds|UnauthorizedOwner|2006|has_one/,
        );
      }
    });
  });

  // =======================================================================
  // V2: OR logic, strict_mode, validation
  // =======================================================================
  describe("V2: OR logic", () => {
    before(async () => {
      // Close existing constraints if present
      if (accountExists(svm, constraintsPda)) {
        await queueAndApplyCloseConstraints(
          vaultPda,
          policyPda,
          constraintsPda,
          pendingCloseConstraintsPda,
        );
      }
    });

    it("per-discriminator OR: any entry passes", async () => {
      // Two entries for same program_id with different discriminator constraints
      const entries = [
        {
          programId: jupiterProgramId,
          dataConstraints: [
            { offset: 0, operator: { eq: {} }, value: Buffer.from([0xff]) },
          ],
          accountConstraints: [],
        },
        {
          programId: jupiterProgramId,
          dataConstraints: [
            {
              offset: 0,
              operator: { eq: {} },
              value: Buffer.from([0x01, 0x02]),
            },
          ],
          accountConstraints: [],
        },
      ];

      await program.methods
        .createInstructionConstraints(entries, false)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Instruction data [0x01, 0x02] matches second entry → should pass
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("per-discriminator OR: first entry passes", async () => {
      // Update constraints: first entry matches [0x01, 0x02]
      await queueAndApplyConstraintsUpdate(
        [
          {
            programId: jupiterProgramId,
            dataConstraints: [
              {
                offset: 0,
                operator: { eq: {} },
                value: Buffer.from([0x01, 0x02]),
              },
            ],
            accountConstraints: [],
          },
          {
            programId: jupiterProgramId,
            dataConstraints: [
              { offset: 0, operator: { eq: {} }, value: Buffer.from([0xff]) },
            ],
            accountConstraints: [],
          },
        ],
        false,
        vaultPda,
        policyPda,
        constraintsPda,
        pendingConstraintsPda,
      );

      // Instruction data [0x01, 0x02] matches first entry → should pass
      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("strict_mode=false allows unconstrained program", async () => {
      // Constraints only cover jupiterProgramId. strict_mode=false.
      // Using a different protocol (SystemProgram.transfer is whitelisted,
      // but the point is: no constraints PDA entry for the actual DeFi program).
      // Since the test TX has [validate, finalize] with no intermediate DeFi ix,
      // strict_mode doesn't fire. Verify that strict_mode=false is stored.
      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.strictMode).to.equal(false);
    });

    it("recreate constraints after close", async () => {
      // Close and recreate (strict_mode not settable on rebrand branch)
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0x01, 0x02]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      // strict_mode is always false on this branch (not settable via instruction)
      expect(constraintsAcct.strictMode).to.equal(false);
    });

    it("zero-length constraint value rejected → InvalidConstraintConfig", async () => {
      // Close and try to create with empty value
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      try {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  { offset: 0, operator: { eq: {} }, value: Buffer.from([]) },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintConfig");
      }
    });

    it("empty entry rejected → InvalidConstraintConfig", async () => {
      try {
        await program.methods
          .createInstructionConstraints(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expectSigilError(err.toString(), "InvalidConstraintConfig");
      }
    });

    it("16 entries allowed", async () => {
      // Create with exactly 16 entries (new limit)
      const entries = [];
      for (let i = 0; i < 16; i++) {
        entries.push({
          programId: Keypair.generate().publicKey,
          dataConstraints: [
            { offset: 0, operator: { eq: {} }, value: Buffer.from([i]) },
          ],
          accountConstraints: [],
        });
      }

      await program.methods
        .createInstructionConstraints(entries, false)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.entries.length).to.equal(16);
    });

    it("8 data constraints per entry allowed", async () => {
      // Update with exactly 8 data constraints per entry (new limit)
      const dataConstraints = [];
      for (let i = 0; i < 8; i++) {
        dataConstraints.push({
          offset: i,
          operator: { eq: {} },
          value: Buffer.from([i + 1]),
        });
      }

      await queueAndApplyConstraintsUpdate(
        [
          {
            programId: jupiterProgramId,
            dataConstraints,
            accountConstraints: [],
          },
        ],
        false,
        vaultPda,
        policyPda,
        constraintsPda,
        pendingConstraintsPda,
      );

      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.entries[0].dataConstraints.length).to.equal(8);
    });
  });

  // =======================================================================
  // V2 Phase 2: Signed + Bitmask operators
  // =======================================================================
  describe("V2 Phase 2: Signed + Bitmask operators", () => {
    const signedTestProgram = Keypair.generate().publicKey;
    const bitmaskTestProgram = Keypair.generate().publicKey;

    it("creates constraints with GteSigned operator", async () => {
      // Close existing constraints first
      if (accountExists(svm, constraintsPda)) {
        await queueAndApplyCloseConstraints(
          vaultPda,
          policyPda,
          constraintsPda,
          pendingCloseConstraintsPda,
        );
      }

      // GteSigned(-10 as i64 LE bytes) — minimum threshold of -10
      const negTen = Buffer.alloc(8);
      negTen.writeBigInt64LE(-10n);

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 8,
                  operator: { gteSigned: {} },
                  value: negTen,
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(acct.entries.length).to.equal(1);
      const dc = acct.entries[0].dataConstraints[0];
      expect(dc.offset).to.equal(8);
      expect("gteSigned" in dc.operator).to.equal(true);
      expect(Buffer.from(dc.value).equals(negTen)).to.equal(true);
    });

    it("creates constraints with LteSigned operator", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      // LteSigned(1000 as i64 LE) — maximum threshold of 1000
      const thousand = Buffer.alloc(8);
      thousand.writeBigInt64LE(1000n);

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { lteSigned: {} },
                  value: thousand,
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      const dc = acct.entries[0].dataConstraints[0];
      expect("lteSigned" in dc.operator).to.equal(true);
      expect(Buffer.from(dc.value).equals(thousand)).to.equal(true);
    });

    it("creates constraints with Bitmask operator", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      // Bitmask: require bits 0 and 2 set (0x05)
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: bitmaskTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { bitmask: {} },
                  value: Buffer.from([0x05]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      const dc = acct.entries[0].dataConstraints[0];
      expect("bitmask" in dc.operator).to.equal(true);
      expect(Buffer.from(dc.value).equals(Buffer.from([0x05]))).to.equal(true);
    });

    // NOTE: Finding 7 (contains operator) was a FALSE FINDING.
    // ConstraintOperator enum has exactly 7 variants: Eq, Ne, Gte, Lte, GteSigned, LteSigned, Bitmask.
    // There is no "contains" operator — the audit agent miscounted.
    // All 7 actual operators ARE tested in this file.

    it("GteSigned passthrough — constrained program not in TX", async () => {
      // Constraints exist for signedTestProgram, but no instruction from it
      // → passthrough, validate+finalize succeeds
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      const negFive = Buffer.alloc(8);
      negFive.writeBigInt64LE(-5n);

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { gteSigned: {} },
                  value: negFive,
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("Bitmask passthrough — constrained program not in TX", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: bitmaskTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { bitmask: {} },
                  value: Buffer.from([0x0f]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const validateIx = await buildValidateIx(
        new BN(10_000_000),
        { swap: {} },
        jupiterProgramId,
        [{ pubkey: constraintsPda, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildFinalizeIx(agent.publicKey, usdcMint);
      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("Signed + Bitmask in OR entries — second entry passes", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      const negHundred = Buffer.alloc(8);
      negHundred.writeBigInt64LE(-100n);

      // Two entries for same program: GteSigned OR Bitmask (OR logic)
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { gteSigned: {} },
                  value: negHundred,
                },
              ],
              accountConstraints: [],
            },
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { bitmask: {} },
                  value: Buffer.from([0x01, 0x80]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Verify both entries stored with OR structure
      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(acct.entries.length).to.equal(2);
      expect(acct.entries[0].programId.toString()).to.equal(
        signedTestProgram.toString(),
      );
      expect(acct.entries[1].programId.toString()).to.equal(
        signedTestProgram.toString(),
      );
      expect(
        "gteSigned" in acct.entries[0].dataConstraints[0].operator,
      ).to.equal(true);
      expect("bitmask" in acct.entries[1].dataConstraints[0].operator).to.equal(
        true,
      );
    });

    it("mixed unsigned + signed constraints AND", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      const posFifty = Buffer.alloc(8);
      posFifty.writeBigInt64LE(50n);

      // Eq on discriminator (offset 0) + GteSigned on amount (offset 8) — AND
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
                },
                {
                  offset: 8,
                  operator: { gteSigned: {} },
                  value: posFifty,
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Verify both constraints stored with AND
      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(acct.entries.length).to.equal(1);
      expect(acct.entries[0].dataConstraints.length).to.equal(2);
      expect("eq" in acct.entries[0].dataConstraints[0].operator).to.equal(
        true,
      );
      expect(
        "gteSigned" in acct.entries[0].dataConstraints[1].operator,
      ).to.equal(true);
    });

    it("all 7 operators in a single entry round-trip correctly", async () => {
      await queueAndApplyCloseConstraints(
        vaultPda,
        policyPda,
        constraintsPda,
        pendingCloseConstraintsPda,
      );

      // Create entry with all 7 operators (max 8 per entry)
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: signedTestProgram,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
                { offset: 1, operator: { ne: {} }, value: Buffer.from([0x02]) },
                {
                  offset: 2,
                  operator: { gte: {} },
                  value: Buffer.from([0x03]),
                },
                {
                  offset: 3,
                  operator: { lte: {} },
                  value: Buffer.from([0x04]),
                },
                {
                  offset: 4,
                  operator: { gteSigned: {} },
                  value: Buffer.from([0x05]),
                },
                {
                  offset: 5,
                  operator: { lteSigned: {} },
                  value: Buffer.from([0x06]),
                },
                {
                  offset: 6,
                  operator: { bitmask: {} },
                  value: Buffer.from([0x07]),
                },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const acct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      const dcs = acct.entries[0].dataConstraints;
      expect(dcs.length).to.equal(7);
      expect("eq" in dcs[0].operator).to.equal(true);
      expect("ne" in dcs[1].operator).to.equal(true);
      expect("gte" in dcs[2].operator).to.equal(true);
      expect("lte" in dcs[3].operator).to.equal(true);
      expect("gteSigned" in dcs[4].operator).to.equal(true);
      expect("lteSigned" in dcs[5].operator).to.equal(true);
      expect("bitmask" in dcs[6].operator).to.equal(true);
    });
  });

  // =======================================================================
  // Audit remediation: critical security paths (C-4, C-7, H-5)
  // =======================================================================
  describe("audit remediation: constraint enforcement & timelock edge cases", () => {
    // Separate vault (protocolMode=0) with sigil program as mock "DeFi program"
    // (sigil is deployed in LiteSVM, unlike random keypair program IDs)
    const cvVaultId = new BN(450);
    let cvVault: PublicKey;
    let cvPolicy: PublicKey;
    let cvTracker: PublicKey;
    let cvOverlay: PublicKey;
    let cvConstraints: PublicKey;
    let cvPendingCloseConstraints: PublicKey;
    let cvVaultAta: PublicKey;
    const cvAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, cvAgent.publicKey, 10 * LAMPORTS_PER_SOL);
      [cvVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          cvVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [cvPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cvVault.toBuffer()],
        program.programId,
      );
      [cvTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cvVault.toBuffer()],
        program.programId,
      );
      [cvOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), cvVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      [cvConstraints] = PublicKey.findProgramAddressSync(
        [Buffer.from("constraints"), cvVault.toBuffer()],
        program.programId,
      );
      [cvPendingCloseConstraints] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_close_constraints"), cvVault.toBuffer()],
        program.programId,
      );

      // Init vault with protocolMode=0, timelock=1800 (MIN_TIMELOCK_DURATION)
      await program.methods
        .initializeVault(
          cvVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(1800),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: cvVault,
          policy: cvPolicy,
          tracker: cvTracker,
          agentSpendOverlay: cvOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(cvAgent.publicKey, FULL_PERMISSIONS, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: cvVault,
          agentSpendOverlay: cvOverlay,
        } as any)
        .rpc();

      cvVaultAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        cvVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(500_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: cvVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: cvVaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    async function buildCvValidateIx(
      amount: BN,
      actionType: any,
      targetProtocol: PublicKey,
      remainingAccounts?: {
        pubkey: PublicKey;
        isSigner: boolean;
        isWritable: boolean;
      }[],
    ) {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          cvVault.toBuffer(),
          cvAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      let builder = program.methods
        .validateAndAuthorize(
          actionType,
          usdcMint,
          amount,
          targetProtocol,
          null,
          await pv(cvPolicy),
        )
        .accounts({
          agent: cvAgent.publicKey,
          vault: cvVault,
          policy: cvPolicy,
          tracker: cvTracker,
          session: sessionPda,
          agentSpendOverlay: cvOverlay,
          vaultTokenAccount: cvVaultAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any);
      if (remainingAccounts)
        builder = builder.remainingAccounts(remainingAccounts);
      return builder.instruction();
    }

    function buildCvFinalizeIx() {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          cvVault.toBuffer(),
          cvAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
      return program.methods
        .finalizeSession()
        .accountsPartial({
          payer: cvAgent.publicKey,
          vault: cvVault,
          session: sessionPda,
          sessionRentRecipient: cvAgent.publicKey,
          policy: cvPolicy,
          tracker: cvTracker,
          agentSpendOverlay: cvOverlay,
          vaultTokenAccount: cvVaultAta,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
    }

    // C-4: ConstraintViolated via composed TX
    it("ConstraintViolated when intermediate ix data mismatches constraint (C-4)", async () => {
      // Create constraints requiring data[0]==0xAA for the sigil program
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: program.programId,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0xaa]) },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: cvVault,
          policy: cvPolicy,
          constraints: cvConstraints,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Intermediate ix targets sigil program with data[0]=0xBB (violates Eq 0xAA)
      const mockDeFiIx = new TransactionInstruction({
        programId: program.programId,
        keys: [],
        data: Buffer.from([0xbb]),
      });
      const validateIx = await buildCvValidateIx(
        new BN(10_000_000),
        { swap: {} },
        program.programId,
        [{ pubkey: cvConstraints, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildCvFinalizeIx();

      try {
        sendVersionedTx(svm, [validateIx, mockDeFiIx, finalizeIx], cvAgent);
        expect.fail("Should have thrown ConstraintViolated");
      } catch (err: any) {
        expectSigilError(err.toString(), "ConstraintViolated");
      }

      // Clean up: close constraints for next test
      await queueAndApplyCloseConstraints(
        cvVault,
        cvPolicy,
        cvConstraints,
        cvPendingCloseConstraints,
      );
    });

    // C-7: UnconstrainedProgramBlocked via strict_mode=true
    // P0 Finding 8: strict_mode enforcement — previously skipped, now enabled
    it("UnconstrainedProgramBlocked when strict_mode=true and unknown program (C-7)", async () => {
      // Create strict_mode=true constraints only for jupiterProgramId
      // The intermediate ix targets sigil program (not in constraints) → blocked
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId, // only constrained program
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
              ],
              accountConstraints: [],
            },
          ],
          true, // strict_mode=true — reject programs without constraint entries
        )
        .accounts({
          owner: owner.publicKey,
          vault: cvVault,
          policy: cvPolicy,
          constraints: cvConstraints,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Intermediate ix targets sigil program (not in constraints → strict blocks it)
      const mockDeFiIx = new TransactionInstruction({
        programId: program.programId,
        keys: [],
        data: Buffer.from([0x01]),
      });
      const validateIx = await buildCvValidateIx(
        new BN(10_000_000),
        { swap: {} },
        program.programId,
        [{ pubkey: cvConstraints, isSigner: false, isWritable: false }],
      );
      const finalizeIx = await buildCvFinalizeIx();

      try {
        sendVersionedTx(svm, [validateIx, mockDeFiIx, finalizeIx], cvAgent);
        expect.fail("Should have thrown UnconstrainedProgramBlocked");
      } catch (err: any) {
        expectSigilError(err.toString(), "UnconstrainedProgramBlocked");
      }

      // Clean up
      await queueAndApplyCloseConstraints(
        cvVault,
        cvPolicy,
        cvConstraints,
        cvPendingCloseConstraints,
      );
    });

    // H-5a: cancelConstraintsUpdate when none queued → account-not-found (Anchor error)
    it("cancelConstraintsUpdate when none queued → account-not-found (H-5a)", async () => {
      // No pending update exists for the main vault (timelock=0 can't queue anyway)
      // Use the timelock vault — make sure no pending exists
      // Actually, the simplest: just try to cancel on main vault
      try {
        await program.methods
          .cancelConstraintsUpdate()
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            pendingConstraints: pendingConstraintsPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown account-not-found error");
      } catch (err: any) {
        // The PDA doesn't exist, so we get AccountNotInitialized or similar
        // Anchor will fail because the account doesn't exist
        const errStr = err.toString();
        expect(
          errStr.includes("AccountNotInitialized") ||
            errStr.includes("not found") ||
            errStr.includes("3012"),
          `Expected account-not-found error, got: ${errStr}`,
        ).to.equal(true);
      }
    });

    // H-5b: queueConstraintsUpdate when already queued → already-in-use (Anchor error)
    it("queueConstraintsUpdate when already queued → already-in-use (H-5b)", async () => {
      // Need a vault with timelock > 0 and constraints
      const tlVaultId = new BN(410);
      const [tlVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          tlVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [tlPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), tlVault.toBuffer()],
        program.programId,
      );
      const [tlTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), tlVault.toBuffer()],
        program.programId,
      );
      const [tlOverlay] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent_spend"), tlVault.toBuffer(), Buffer.from([0])],
        program.programId,
      );
      const [tlConstraints] = PublicKey.findProgramAddressSync(
        [Buffer.from("constraints"), tlVault.toBuffer()],
        program.programId,
      );
      const [tlPending] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_constraints"), tlVault.toBuffer()],
        program.programId,
      );

      // Init vault with timelock=1800 (MIN_TIMELOCK_DURATION)
      await program.methods
        .initializeVault(
          tlVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          0,
          [],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(1800),
          [],
          [], // protocolCaps
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVault,
          policy: tlPolicy,
          tracker: tlTracker,
          agentSpendOverlay: tlOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create constraints
      await program.methods
        .createInstructionConstraints(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                { offset: 0, operator: { eq: {} }, value: Buffer.from([0x01]) },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVault,
          policy: tlPolicy,
          constraints: tlConstraints,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Queue first update
      await program.methods
        .queueConstraintsUpdate(
          [
            {
              programId: jupiterProgramId,
              dataConstraints: [
                { offset: 0, operator: { ne: {} }, value: Buffer.from([0x00]) },
              ],
              accountConstraints: [],
            },
          ],
          false,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVault,
          policy: tlPolicy,
          constraints: tlConstraints,
          pendingConstraints: tlPending,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Queue second update → should fail
      try {
        await program.methods
          .queueConstraintsUpdate(
            [
              {
                programId: jupiterProgramId,
                dataConstraints: [
                  {
                    offset: 0,
                    operator: { eq: {} },
                    value: Buffer.from([0x02]),
                  },
                ],
                accountConstraints: [],
              },
            ],
            false,
          )
          .accounts({
            owner: owner.publicKey,
            vault: tlVault,
            policy: tlPolicy,
            constraints: tlConstraints,
            pendingConstraints: tlPending,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown already-in-use error");
      } catch (err: any) {
        const errStr = err.toString();
        expect(
          errStr.includes("already in use") ||
            errStr.includes("AccountNotInitialized") ||
            errStr.includes("0x0"),
          `Expected already-in-use error, got: ${errStr}`,
        ).to.equal(true);
      }

      // Clean up: cancel the pending update
      await program.methods
        .cancelConstraintsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault: tlVault,
          pendingConstraints: tlPending,
        } as any)
        .rpc();
    });
  });
});
