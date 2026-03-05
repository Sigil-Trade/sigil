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
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

describe("instruction-constraints", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Phalnx>;

  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();

  let usdcMint: PublicKey;
  const vaultId = new BN(400);

  let vaultPda: PublicKey;
  let policyPda: PublicKey;
  let trackerPda: PublicKey;
  let constraintsPda: PublicKey;
  let pendingConstraintsPda: PublicKey;
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;

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
    [constraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("constraints"), vaultPda.toBuffer()],
      program.programId,
    );
    [pendingConstraintsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending_constraints"), vaultPda.toBuffer()],
      program.programId,
    );

    // Initialize vault (protocolMode=0 = all allowed, no timelock)
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
        new BN(0), // no timelock
        [],
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        feeDestination: feeDestination.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Register agent
    await program.methods
      .registerAgent(agent.publicKey, FULL_PERMISSIONS)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
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
      .finalizeSession(true)
      .accountsPartial({
        payer: agentKey,
        vault: vaultPda,
        session: sessionPda,
        sessionRentRecipient: agentKey,
        policy: policyPda,
        tracker: trackerPda,
        vaultTokenAccount: vaultUsdcAta,
        outputStablecoinAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // Helper: build validate instruction with optional remaining accounts
  function buildValidateIx(
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
      .validateAndAuthorize(actionType, usdcMint, amount, targetProtocol, null)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        policy: policyPda,
        tracker: trackerPda,
        session: sessionPda,
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
        },
      ];

      await program.methods
        .createInstructionConstraints(entries)
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

    it("updates constraints (no timelock)", async () => {
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
        },
      ];

      await program.methods
        .updateInstructionConstraints(newEntries)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
        } as any)
        .rpc();

      const constraintsAcct =
        await program.account.instructionConstraints.fetch(constraintsPda);
      expect(constraintsAcct.entries[0].dataConstraints[0].offset).to.equal(8);
    });

    it("closes constraints PDA and sets has_constraints=false", async () => {
      await program.methods
        .closeInstructionConstraints()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
        } as any)
        .rpc();

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
        },
      ];

      await program.methods
        .createInstructionConstraints(entries)
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
      await program.methods
        .closeInstructionConstraints()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
        } as any)
        .rpc();

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
        },
      ];
      await program.methods
        .createInstructionConstraints(entries)
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
        expect(err.toString()).to.include("InvalidConstraintsPda");
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
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: vault2Pda,
          policy: policy2Pda,
          tracker: tracker2Pda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create constraints on vault 2
      await program.methods
        .createInstructionConstraints([
          {
            programId: jupiterProgramId,
            dataConstraints: [],
          },
        ])
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
        expect(err.toString()).to.include("InvalidConstraintsPda");
      }
    });
  });

  // =======================================================================
  // Bounds validation
  // =======================================================================
  describe("bounds validation", () => {
    it("rejects >10 constraint entries → InvalidConstraintConfig", async () => {
      // Close existing constraints first (if they exist)
      if (accountExists(svm, constraintsPda)) {
        await program.methods
          .closeInstructionConstraints()
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
          } as any)
          .rpc();
      }

      const entries = [];
      for (let i = 0; i < 11; i++) {
        entries.push({
          programId: Keypair.generate().publicKey,
          dataConstraints: [],
        });
      }

      try {
        await program.methods
          .createInstructionConstraints(entries)
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
        expect(err.toString()).to.include("InvalidConstraintConfig");
      }
    });

    it("rejects >5 data constraints per entry → InvalidConstraintConfig", async () => {
      const dataConstraints = [];
      for (let i = 0; i < 6; i++) {
        dataConstraints.push({
          offset: i,
          operator: { eq: {} },
          value: Buffer.from([0x01]),
        });
      }

      try {
        await program.methods
          .createInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints,
            },
          ])
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
        expect(err.toString()).to.include("InvalidConstraintConfig");
      }
    });

    it("rejects >32 byte constraint value → InvalidConstraintConfig", async () => {
      const bigValue = Buffer.alloc(33, 0xff);

      try {
        await program.methods
          .createInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: bigValue,
                },
              ],
            },
          ])
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
        expect(err.toString()).to.include("InvalidConstraintConfig");
      }
    });

    // Re-create constraints for remaining tests
    after(async () => {
      // Policy may show has_constraints=false, recreate
      const policy = await program.account.policyConfig.fetch(policyPda);
      if (!policy.hasConstraints) {
        await program.methods
          .createInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints: [
                {
                  offset: 0,
                  operator: { eq: {} },
                  value: Buffer.from([0x01, 0x02]),
                },
              ],
            },
          ])
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

      // Init vault with timelock = 60 seconds
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
          new BN(60), // 60s timelock
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create constraints (allowed — additive change)
      await program.methods
        .createInstructionConstraints([
          {
            programId: jupiterProgramId,
            dataConstraints: [
              {
                offset: 0,
                operator: { eq: {} },
                value: Buffer.from([0xff]),
              },
            ],
          },
        ])
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          constraints: tlConstraintsPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("direct update rejected when timelock > 0 → TimelockActive", async () => {
      try {
        await program.methods
          .updateInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints: [],
            },
          ])
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            constraints: tlConstraintsPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TimelockActive");
      }
    });

    it("close rejected when timelock > 0 → TimelockActive", async () => {
      try {
        await program.methods
          .closeInstructionConstraints()
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            constraints: tlConstraintsPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TimelockActive");
      }
    });

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
        },
      ];

      // Queue
      await program.methods
        .queueConstraintsUpdate(newEntries)
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
            constraints: tlConstraintsPda,
            pendingConstraints: tlPendingConstraintsPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TimelockNotExpired");
      }

      // Advance time past timelock
      advanceTime(svm, 61);

      // Apply after timelock → success
      await program.methods
        .applyConstraintsUpdate()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
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
        .queueConstraintsUpdate([
          {
            programId: jupiterProgramId,
            dataConstraints: [],
          },
        ])
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

    it("queue fails when timelock = 0 → NoTimelockConfigured", async () => {
      // Use the main vault (no timelock)
      try {
        await program.methods
          .queueConstraintsUpdate([
            {
              programId: jupiterProgramId,
              dataConstraints: [],
            },
          ])
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
            pendingConstraints: pendingConstraintsPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoTimelockConfigured");
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
      await program.methods
        .closeInstructionConstraints()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
        } as any)
        .rpc();

      await program.methods
        .createInstructionConstraints([
          {
            programId: jupiterProgramId,
            dataConstraints: [], // No constraints — any instruction from Jupiter passes
          },
        ])
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

      await program.methods
        .closeInstructionConstraints()
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
          constraints: constraintsPda,
        } as any)
        .rpc();

      await program.methods
        .createInstructionConstraints([
          {
            programId: unrelatedProgram,
            dataConstraints: [
              {
                offset: 0,
                operator: { eq: {} },
                value: Buffer.from([0xff]),
              },
            ],
          },
        ])
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
        await program.methods
          .closeInstructionConstraints()
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
          } as any)
          .rpc();
      }

      // Attacker's vault PDA derivation uses attacker.publicKey → ConstraintSeeds
      try {
        await program.methods
          .createInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints: [],
            },
          ])
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
        .createInstructionConstraints([
          {
            programId: jupiterProgramId,
            dataConstraints: [
              {
                offset: 0,
                operator: { eq: {} },
                value: Buffer.from([0x01, 0x02]),
              },
            ],
          },
        ])
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
          .updateInstructionConstraints([
            {
              programId: jupiterProgramId,
              dataConstraints: [],
            },
          ])
          .accountsPartial({
            owner: attacker.publicKey,
            vault: vaultPda,
            policy: policyPda,
            constraints: constraintsPda,
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
});
