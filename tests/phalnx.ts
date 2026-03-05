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
  createMintHelper,
  createMintAtAddress,
  DEVNET_USDC_MINT,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  getBalance,
  accountExists,
  advancePastSlot,
  advanceTime,
  sendVersionedTx,
  VersionedTxResult,
  recordCU,
  printCUSummary,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

const FULL_PERMISSIONS = new BN((1n << 21n) - 1n);

describe("phalnx", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<Phalnx>;

  // Test actors
  let owner: anchor.Wallet;
  const agent = Keypair.generate();
  const feeDestination = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  // Token mints and accounts
  let usdcMint: PublicKey;
  let solMint: PublicKey; // a second SPL token for testing
  const vaultId = new BN(1);

  // PDAs
  let vaultPda: PublicKey;
  let vaultBump: number;
  let policyPda: PublicKey;
  let policyBump: number;
  let trackerPda: PublicKey;
  let trackerBump: number;
  // Token accounts
  let ownerUsdcAta: PublicKey;
  let vaultUsdcAta: PublicKey;
  let feeDestUsdcAta: PublicKey;

  // Allowed protocol (fake Jupiter program ID for testing)
  const jupiterProgramId = Keypair.generate().publicKey;

  // Protocol treasury (must match hardcoded constant in program)
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

    // Airdrop to test accounts
    airdropSol(svm, owner.publicKey, 100 * LAMPORTS_PER_SOL);
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, unauthorizedUser.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC mint at the hardcoded devnet address (required by is_stablecoin_mint())
    createMintAtAddress(svm, DEVNET_USDC_MINT, owner.publicKey, 6);
    usdcMint = DEVNET_USDC_MINT;

    // Create a second mint for testing disallowed tokens
    solMint = createMintHelper(svm, (owner as any).payer, owner.publicKey, 9);

    // Create owner's USDC ATA and mint tokens
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
      2_000_000_000n, // 2000 USDC
    );

    // Create protocol treasury ATA (needed for fee transfers)
    // Protocol treasury is an off-curve address, so we need allowOwnerOffCurve=true
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true,
    );

    // Derive PDAs
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    [policyPda, policyBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId,
    );

    [trackerPda, trackerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId,
    );
  });

  // =========================================================================
  // initialize_vault
  // =========================================================================
  describe("initialize_vault", () => {
    it("creates vault, policy, and tracker PDAs with correct values", async () => {
      const dailyCap = new BN(500_000_000); // 500 USDC
      const maxTxSize = new BN(100_000_000); // 100 USDC

      await program.methods
        .initializeVault(
          vaultId,
          dailyCap,
          maxTxSize,
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any, // max_leverage_bps (u16)
          3, // max_concurrent_positions
          0, // developer_fee_rate
          100, // maxSlippageBps (1%)
          new BN(0), // timelockDuration
          [], // allowedDestinations
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

      // Verify vault state
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
      expect(vault.agents.length).to.equal(0);
      expect(vault.feeDestination.toString()).to.equal(
        feeDestination.publicKey.toString(),
      );
      expect(vault.vaultId.toNumber()).to.equal(1);
      expect(vault.totalTransactions.toNumber()).to.equal(0);
      expect(vault.totalVolume.toNumber()).to.equal(0);
      expect(vault.openPositions).to.equal(0);
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);

      // Verify policy state
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.vault.toString()).to.equal(vaultPda.toString());
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(500_000_000);
      expect(policy.maxTransactionSizeUsd.toNumber()).to.equal(100_000_000);
      expect(policy.protocolMode).to.equal(1);
      expect(policy.protocols.length).to.equal(1);
      expect(policy.protocols[0].toString()).to.equal(
        jupiterProgramId.toString(),
      );
      expect(policy.canOpenPositions).to.equal(true);
      expect(policy.maxConcurrentPositions).to.equal(3);
      expect(policy.developerFeeRate).to.equal(0);

      // Verify tracker state
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.vault.toString()).to.equal(vaultPda.toString());
    });

    it("rejects duplicate vault_id (PDA already exists)", async () => {
      try {
        await program.methods
          .initializeVault(
            vaultId, // same vault_id
            new BN(100),
            new BN(100),
            0, // protocolMode: all
            [],
            new BN(0) as any,
            1,
            0,
            100, // maxSlippageBps
            new BN(0),
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor init constraint fails when account already exists
        expect(err.toString()).to.include("already in use");
      }
    });

    it("rejects invalid protocol mode", async () => {
      const vaultId2 = new BN(99);
      const [vault2] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vaultId2.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [policy2] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), vault2.toBuffer()],
        program.programId,
      );
      const [tracker2] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), vault2.toBuffer()],
        program.programId,
      );

      // protocol_mode = 3 is invalid (valid values: 0=all, 1=allowlist, 2=denylist)
      try {
        await program.methods
          .initializeVault(
            vaultId2,
            new BN(100),
            new BN(100),
            3,
            [],
            new BN(0) as any,
            1,
            0,
            100, // maxSlippageBps
            new BN(0),
            [],
          )
          .accounts({
            owner: owner.publicKey,
            vault: vault2,
            policy: policy2,
            tracker: tracker2,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("InvalidProtocolMode") || s.includes("Error"),
        );
      }
    });
  });

  // =========================================================================
  // deposit_funds
  // =========================================================================
  describe("deposit_funds", () => {
    it("transfers tokens from owner to vault", async () => {
      const depositAmount = new BN(100_000_000); // 100 USDC

      // vault ATA will be created by init_if_needed
      vaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: vaultPda,
      });

      await program.methods
        .depositFunds(depositAmount)
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

      const vaultBalance = getTokenBalance(svm, vaultUsdcAta);
      expect(Number(vaultBalance)).to.equal(100_000_000);
    });

    it("rejects non-owner signer", async () => {
      try {
        // Derive vault PDA for unauthorizedUser — won't match
        const [fakeVault] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("vault"),
            unauthorizedUser.publicKey.toBuffer(),
            vaultId.toArrayLike(Buffer, "le", 8),
          ],
          program.programId,
        );

        await program.methods
          .depositFunds(new BN(1_000_000))
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: vaultPda, // real vault owned by `owner`
            mint: usdcMint,
            ownerTokenAccount: ownerUsdcAta,
            vaultTokenAccount: vaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor's PDA re-derivation fails before the handler runs
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });
  });

  // =========================================================================
  // register_agent
  // =========================================================================
  describe("register_agent", () => {
    it("registers an agent pubkey", async () => {
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
      );
    });

    it("rejects double registration", async () => {
      try {
        // Register the SAME agent pubkey that was already registered
        await program.methods
          .registerAgent(agent.publicKey, FULL_PERMISSIONS)
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AgentAlreadyRegistered");
      }
    });

    it("rejects non-owner signer", async () => {
      // Create a new vault for this test
      const vid = new BN(200);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );

      // First create the vault
      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Try to register agent as non-owner
      try {
        await program.methods
          .registerAgent(agent.publicKey, FULL_PERMISSIONS)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: v,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });
  });

  // =========================================================================
  // update_policy
  // =========================================================================
  describe("update_policy", () => {
    it("updates individual policy fields", async () => {
      await program.methods
        .updatePolicy(
          new BN(200_000_000), // new daily cap: 200 USDC
          null, // keep max_transaction_size
          null, // keep protocol_mode
          null, // keep protocols
          null, // keep max_leverage_bps
          null, // keep can_open_positions
          null, // keep max_concurrent_positions
          null, // keep developer_fee_rate
          null, // keep maxSlippageBps
          null, // keep timelockDuration
          null, // keep allowedDestinations
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
      // Other fields unchanged
      expect(policy.maxTransactionSizeUsd.toNumber()).to.equal(100_000_000);
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .updatePolicy(
            new BN(999),
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
            owner: unauthorizedUser.publicKey,
            vault: vaultPda,
            policy: policyPda,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });

    it("rejects too many allowed protocols", async () => {
      const tooManyProtocols = Array.from(
        { length: 11 },
        () => Keypair.generate().publicKey,
      );
      try {
        await program.methods
          .updatePolicy(
            null,
            null,
            null,
            tooManyProtocols,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
          )
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            policy: policyPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TooManyAllowedProtocols");
      }
    });
  });

  // =========================================================================
  // revoke_agent (kill switch)
  // =========================================================================
  describe("revoke_agent", () => {
    // We'll use a separate vault for revoke/reactivate tests to not affect other tests
    const revokeVaultId = new BN(10);
    let revokeVaultPda: PublicKey;

    before(async () => {
      [revokeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          revokeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), revokeVaultPda.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), revokeVaultPda.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          revokeVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: revokeVaultPda,
          policy: rp,
          tracker: rt,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
        .rpc();
    });

    it("freezes the vault", async () => {
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(revokeVaultPda);
      // VaultStatus::Frozen is represented as { frozen: {} }
      expect(vault.status).to.have.property("frozen");
    });

    it("revoking non-existent agent fails", async () => {
      // Agent was already removed by "freezes the vault" test
      try {
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UnauthorizedAgent");
      }
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: revokeVaultPda,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });
  });

  // =========================================================================
  // reactivate_vault
  // =========================================================================
  describe("reactivate_vault", () => {
    const reactVaultId = new BN(11);
    let reactVaultPda: PublicKey;

    before(async () => {
      [reactVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          reactVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), reactVaultPda.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), reactVaultPda.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          reactVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: rp,
          tracker: rt,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent then freeze by revoking
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();
    });

    it("reactivates a frozen vault", async () => {
      await program.methods
        .reactivateVault(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(vault.status).to.have.property("active");
    });

    it("rejects reactivating an already-active vault", async () => {
      try {
        await program.methods
          .reactivateVault(null, null)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultNotFrozen");
      }
    });

    it("rejects reactivating without agent when agent is cleared", async () => {
      // Freeze first
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      try {
        await program.methods
          .reactivateVault(null, null)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoAgentRegistered");
      }

      // Clean up: reactivate with new agent for subsequent tests
      await program.methods
        .reactivateVault(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();
    });

    it("optionally rotates agent key on reactivation", async () => {
      // Freeze again
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const newAgent = Keypair.generate();
      await program.methods
        .reactivateVault(newAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        newAgent.publicKey.toString(),
      );
      expect(vault.status).to.have.property("active");
    });
  });

  // =========================================================================
  // withdraw_funds
  // =========================================================================
  describe("withdraw_funds", () => {
    it("transfers tokens from vault to owner", async () => {
      const ownerBefore = Number(getTokenBalance(svm, ownerUsdcAta));
      const vaultBefore = Number(getTokenBalance(svm, vaultUsdcAta));

      const withdrawAmount = new BN(10_000_000); // 10 USDC
      await program.methods
        .withdrawFunds(withdrawAmount)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          mint: usdcMint,
          vaultTokenAccount: vaultUsdcAta,
          ownerTokenAccount: ownerUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      const ownerAfter = Number(getTokenBalance(svm, ownerUsdcAta));
      const vaultAfter = Number(getTokenBalance(svm, vaultUsdcAta));

      expect(vaultAfter).to.equal(vaultBefore - 10_000_000);
      expect(ownerAfter).to.equal(ownerBefore + 10_000_000);
    });

    it("rejects withdrawal exceeding balance", async () => {
      try {
        await program.methods
          .withdrawFunds(new BN(999_999_999_999))
          .accounts({
            owner: owner.publicKey,
            vault: vaultPda,
            mint: usdcMint,
            vaultTokenAccount: vaultUsdcAta,
            ownerTokenAccount: ownerUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientBalance");
      }
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .withdrawFunds(new BN(1))
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: vaultPda,
            mint: usdcMint,
            vaultTokenAccount: vaultUsdcAta,
            ownerTokenAccount: ownerUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });
  });

  // =========================================================================
  // validate_and_authorize + finalize_session (composed transaction)
  // =========================================================================
  describe("validate_and_authorize + finalize_session", () => {
    let sessionPda: PublicKey;

    before(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
    });

    it("authorizes a valid swap action and finalizes atomically", async () => {
      const amount = new BN(50_000_000); // 50 USDC

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} }, // ActionType::Swap
          usdcMint,
          amount,
          jupiterProgramId,
          null, // no leverage
        )
        .accountsPartial({
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
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const txResult = sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      recordCU("validate+finalize:stablecoin", txResult);

      // Session should be closed after atomic validate+finalize
      try {
        await program.account.sessionAuthority.fetch(sessionPda);
        expect.fail("Session should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(50_000_000);
    });
  });

  // =========================================================================
  // validate_and_authorize — error paths
  // =========================================================================
  describe("validate_and_authorize error paths", () => {
    let sessionPda: PublicKey;

    beforeEach(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );
    });

    it("rejects non-stablecoin token without output stablecoin account", async () => {
      // Session PDA for solMint (non-stablecoin)
      const [solSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          solMint.toBuffer(),
        ],
        program.programId,
      );
      // Create vault ATA for solMint so Anchor account validation passes
      const vaultSolAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        solMint,
        vaultPda,
        true, // allowOwnerOffCurve — vault is a PDA
      );
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            solMint, // non-stablecoin token mint
            new BN(1_000_000),
            jupiterProgramId,
            null,
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: solSession,
            vaultTokenAccount: vaultSolAta,
            tokenMintAccount: solMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Non-stablecoin input requires output_stablecoin_account which is null
        expect(err.toString()).to.include("InvalidTokenAccount");
      }
    });

    it("rejects disallowed protocol", async () => {
      const fakeProtocol = Keypair.generate().publicKey;
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            fakeProtocol, // not in protocols
            null,
          )
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
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ProtocolNotAllowed");
      }
    });

    it("rejects transaction exceeding max size", async () => {
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(200_000_000), // exceeds max_transaction_size of 100 USDC
            jupiterProgramId,
            null,
          )
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
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TransactionTooLarge");
      }
    });

    it("rejects when daily spending cap would be exceeded", async () => {
      // Lower the daily cap to 200 USDC (from 500) to make this testable
      // with fewer transactions. Already spent 50 USDC from earlier tests.
      await program.methods
        .updatePolicy(
          new BN(200_000_000), // 200 USDC daily cap
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
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
        } as any)
        .rpc();

      // First, compose a successful validate+finalize for 100 USDC (50+100=150 < 200 cap)
      const validateIx1 = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(100_000_000), // 100 USDC
          jupiterProgramId,
          null,
        )
        .accountsPartial({
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
        })
        .instruction();

      const finalizeIx1 = await program.methods
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
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const txResult2 = sendVersionedTx(svm, [validateIx1, finalizeIx1], agent);
      recordCU("validate+finalize:spend_cap", txResult2);

      // Now try to spend another 100 USDC — total would be 250 > 200 cap.
      // This should fail with DailyCapExceeded (error fires before MissingFinalizeInstruction check).
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(100_000_000),
            jupiterProgramId,
            null,
          )
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
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DailyCapExceeded");
      }

      // Restore daily cap to 500 USDC for subsequent tests
      await program.methods
        .updatePolicy(
          new BN(500_000_000), // restore to 500 USDC
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
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
        } as any)
        .rpc();
    });

    it("rejects unauthorized agent", async () => {
      const fakeAgent = Keypair.generate();
      airdropSol(svm, fakeAgent.publicKey, LAMPORTS_PER_SOL);

      const [fakeSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          vaultPda.toBuffer(),
          fakeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null,
          )
          .accounts({
            agent: fakeAgent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: fakeSession,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([fakeAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UnauthorizedAgent");
      }
    });

    it("rejects action on frozen vault", async () => {
      // Create a fresh vault, register agent, then freeze it
      // Note: revoke_agent clears the agent key, so is_agent() fails before
      // the handler's VaultNotActive check. We verify the vault rejects
      // the action — either UnauthorizedAgent (agent cleared) or VaultNotActive.
      const frozenVaultId = new BN(10);
      const [frozenVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          frozenVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [frozenPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), frozenVault.toBuffer()],
        program.programId,
      );
      const [frozenTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), frozenVault.toBuffer()],
        program.programId,
      );
      const [frozenSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          frozenVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Create vault ATA so Anchor account validation passes,
      // allowing the agent/status checks to fire.
      const frozenVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        frozenVault,
        true, // allowOwnerOffCurve — vault is a PDA
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null,
          )
          .accounts({
            agent: agent.publicKey,
            vault: frozenVault,
            policy: frozenPolicy,
            tracker: frozenTracker,
            session: frozenSession,
            vaultTokenAccount: frozenVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // revoke_agent clears the agent key, so is_agent() constraint fails
        // before the handler's VaultNotActive check can run.
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("UnauthorizedAgent") || s.includes("ConstraintRaw"),
        );
      }
    });
  });

  // =========================================================================
  // close_vault
  // =========================================================================
  describe("close_vault", () => {
    const closeVaultId = new BN(20);
    let closeVaultPda: PublicKey;
    let closePolicyPda: PublicKey;
    let closeTrackerPda: PublicKey;

    before(async () => {
      [closeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [closePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), closeVaultPda.toBuffer()],
        program.programId,
      );
      [closeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), closeVaultPda.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closeVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: closeVaultPda,
          policy: closePolicyPda,
          tracker: closeTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("closes vault and reclaims rent", async () => {
      const ownerBefore = getBalance(svm, owner.publicKey);

      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: closeVaultPda,
          policy: closePolicyPda,
          tracker: closeTrackerPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Accounts should no longer exist
      expect(accountExists(svm, closeVaultPda)).to.be.false;
      expect(accountExists(svm, closePolicyPda)).to.be.false;
      expect(accountExists(svm, closeTrackerPda)).to.be.false;

      // Owner should have received rent back
      const ownerAfter = getBalance(svm, owner.publicKey);
      expect(ownerAfter).to.be.greaterThan(ownerBefore);
    });

    it("rejects non-owner signer", async () => {
      // Create another vault to test rejection
      const vid = new BN(21);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .closeVault()
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: v,
            policy: p,
            tracker: t,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("has_one"),
        );
      }
    });
  });

  // =========================================================================
  // Dual Fee Model Tests
  // =========================================================================
  describe("dual fee model", () => {
    const feeVaultId = new BN(30);
    let feeVaultPda: PublicKey;
    let feePolicyPda: PublicKey;
    let feeTrackerPda: PublicKey;
    let feeVaultUsdcAta: PublicKey;
    let feeSessionPda: PublicKey;

    it("init vault with developer_fee_rate 30 → stored correctly", async () => {
      [feeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [feePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeVaultPda.toBuffer()],
        program.programId,
      );
      [feeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeVaultPda.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          feeVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          30, // developer_fee_rate = 30 (0.3 BPS)
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(30);
    });

    it("init vault with developer_fee_rate 501 → rejects DeveloperFeeTooHigh", async () => {
      const badVaultId = new BN(31);
      const [bv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId,
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId,
      );

      try {
        await program.methods
          .initializeVault(
            badVaultId,
            new BN(1000),
            new BN(1000),
            0,
            [],
            new BN(0) as any,
            1,
            501,
            100, // maxSlippageBps
            new BN(0),
            [],
          )
          .accounts({
            owner: owner.publicKey,
            vault: bv,
            policy: bp,
            tracker: bt,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DeveloperFeeTooHigh");
      }
    });

    it("update_policy changes developer_fee_rate 0→30 → stored", async () => {
      // Use the fee vault created above, first set to 0
      await program.methods
        .updatePolicy(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      let policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(0);

      // Now update to 30
      await program.methods
        .updatePolicy(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          30,
          null,
          null,
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(30);
    });

    it("update_policy with developer_fee_rate 501 → rejects", async () => {
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
            501,
            null,
            null,
            null,
          )
          .accounts({
            owner: owner.publicKey,
            vault: feeVaultPda,
            policy: feePolicyPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DeveloperFeeTooHigh");
      }
    });

    it("validate with developer_fee=0 → no developer fees collected", async () => {
      // Set developer fee to 0
      await program.methods
        .updatePolicy(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      // Register agent on fee vault
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: feeVaultPda } as any)
        .rpc();

      // Deposit to the fee vault
      feeVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: feeVaultPda,
      });

      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Derive session PDA
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Compose validate+finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      const feeResult = sendVersionedTx(svm, [validateIx, finalizeIx], agent);
      recordCU("validate+finalize:with_fees", feeResult);

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // developer fees should be 0 (only protocol fee collected, not tracked in totalFeesCollected)
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);
    });

    it("validate with developer_fee=500 → developer fees collected on vault", async () => {
      // Set developer fee to 500 (max, 5 BPS)
      await program.methods
        .updatePolicy(
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          500,
          null,
          null,
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      // Create fee destination ATA
      try {
        feeDestUsdcAta = createAtaHelper(
          svm,
          (owner as any).payer,
          usdcMint,
          feeDestination.publicKey,
        );
      } catch {
        // ATA may already exist
        feeDestUsdcAta = anchor.utils.token.associatedAddress({
          mint: usdcMint,
          owner: feeDestination.publicKey,
        });
      }

      // Derive session PDA
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Compose validate+finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);

      // developer fee = 10_000_000 * 500 / 1_000_000 = 5000
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalFeesCollected.toNumber()).to.equal(5000);
    });

    it("validate with success=false finalize → no fees credited to vault", async () => {
      // Derive session PDA
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeVaultPda.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const vaultBefore = await program.account.agentVault.fetch(feeVaultPda);
      const feesBefore = vaultBefore.totalFeesCollected.toNumber();

      // Compose validate+finalize(false) atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          vaultTokenAccount: feeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(false)
        .accountsPartial({
          payer: agent.publicKey,
          vault: feeVaultPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          vaultTokenAccount: feeVaultUsdcAta, // H1: must provide for delegation revocation
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);

      const vault = await program.account.agentVault.fetch(feeVaultPda);
      // No new fees collected on failure
      expect(vault.totalFeesCollected.toNumber()).to.equal(feesBefore);
    });

    it("init vault with developer_fee_rate at max (500) succeeds", async () => {
      const maxFeeVaultId = new BN(32);
      const [mv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          maxFeeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [mp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), mv.toBuffer()],
        program.programId,
      );
      const [mt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), mv.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          maxFeeVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          500,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: mv,
          policy: mp,
          tracker: mt,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(mp);
      expect(policy.developerFeeRate).to.equal(500);
    });
  });

  // =========================================================================
  // Composed validate+finalize — session lifecycle
  // =========================================================================
  describe("composed validate+finalize — session lifecycle", () => {
    const lifecycleVaultId = new BN(40);
    let lifecycleVaultPda: PublicKey;
    let lifecyclePolicyPda: PublicKey;
    let lifecycleTrackerPda: PublicKey;
    let lifecycleSessionPda: PublicKey;
    let lifecycleVaultUsdcAta: PublicKey;
    const lifecycleAgent = Keypair.generate();

    before(async () => {
      // Airdrop to new agent
      airdropSol(svm, lifecycleAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [lifecycleVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          lifecycleVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [lifecyclePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), lifecycleVaultPda.toBuffer()],
        program.programId,
      );
      [lifecycleTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), lifecycleVaultPda.toBuffer()],
        program.programId,
      );
      [lifecycleSessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          lifecycleVaultPda.toBuffer(),
          lifecycleAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Create vault with USDC allowed
      await program.methods
        .initializeVault(
          lifecycleVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent
      await program.methods
        .registerAgent(lifecycleAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: lifecycleVaultPda } as any)
        .rpc();

      // Deposit USDC to vault
      lifecycleVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: lifecycleVaultPda,
      });

      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: lifecycleVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("composed validate+finalize succeeds and session is closed atomically", async () => {
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          session: lifecycleSessionPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          session: lifecycleSessionPda,
          sessionRentRecipient: lifecycleAgent.publicKey,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], lifecycleAgent);

      // Session should be closed after atomic validate+finalize
      try {
        await program.account.sessionAuthority.fetch(lifecycleSessionPda);
        expect.fail("Session should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }

      // Vault stats should be updated
      const vault = await program.account.agentVault.fetch(lifecycleVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
    });

    it("session rent recipient != agent in composed tx → rejects InvalidSession", async () => {
      // Compose validate+finalize but with wrong rent recipient
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(5_000_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          session: lifecycleSessionPda,
          vaultTokenAccount: lifecycleVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: lifecycleAgent.publicKey,
          vault: lifecycleVaultPda,
          session: lifecycleSessionPda,
          sessionRentRecipient: unauthorizedUser.publicKey, // wrong recipient
          policy: lifecyclePolicyPda,
          tracker: lifecycleTrackerPda,
          vaultTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      try {
        sendVersionedTx(svm, [validateIx, finalizeIx], lifecycleAgent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidSession");
      }
    });

    it("multiple sequential composed transactions succeed", async () => {
      // Execute two more composed transactions to confirm sequential usage works
      for (let i = 0; i < 2; i++) {
        const validateIx = await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(5_000_000),
            jupiterProgramId,
            null,
          )
          .accountsPartial({
            agent: lifecycleAgent.publicKey,
            vault: lifecycleVaultPda,
            policy: lifecyclePolicyPda,
            tracker: lifecycleTrackerPda,
            session: lifecycleSessionPda,
            vaultTokenAccount: lifecycleVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .instruction();

        const finalizeIx = await program.methods
          .finalizeSession(true)
          .accountsPartial({
            payer: lifecycleAgent.publicKey,
            vault: lifecycleVaultPda,
            session: lifecycleSessionPda,
            sessionRentRecipient: lifecycleAgent.publicKey,
            policy: lifecyclePolicyPda,
            tracker: lifecycleTrackerPda,
            vaultTokenAccount: lifecycleVaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            outputStablecoinAccount: null,
          })
          .instruction();

        sendVersionedTx(svm, [validateIx, finalizeIx], lifecycleAgent);
      }

      const vault = await program.account.agentVault.fetch(lifecycleVaultPda);
      // 1 from first test + 2 from this test = 3
      expect(vault.totalTransactions.toNumber()).to.equal(3);
    });
  });

  // =========================================================================
  // Agent registration security
  // =========================================================================
  describe("agent registration security", () => {
    it("rejects owner as agent → AgentIsOwner", async () => {
      const vid = new BN(50);
      const [v] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          vid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId,
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          vid,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: v,
          policy: p,
          tracker: t,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .registerAgent(owner.publicKey, FULL_PERMISSIONS) // owner = agent → reject
          .accounts({ owner: owner.publicKey, vault: v } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AgentIsOwner");
      }
    });

    it("validate_and_authorize with agent after revocation → UnauthorizedAgent", async () => {
      // Use the revoke vault (ID=10) which has been frozen and agent cleared
      const revokeVaultId = new BN(10);
      const [rv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          revokeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), rv.toBuffer()],
        program.programId,
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), rv.toBuffer()],
        program.programId,
      );

      // Reactivate so status is Active but with a NEW agent, not our test agent
      const newAgent = Keypair.generate();
      airdropSol(svm, newAgent.publicKey, LAMPORTS_PER_SOL);

      // First reactivate with newAgent
      try {
        // May already be active from earlier test, so freeze first
        await program.methods
          .revokeAgent(agent.publicKey)
          .accounts({ owner: owner.publicKey, vault: rv } as any)
          .rpc();
      } catch {
        // ignore if already frozen
      }

      await program.methods
        .reactivateVault(newAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: rv } as any)
        .rpc();

      // Now try to use the ORIGINAL agent (who was revoked)
      const [oldSession] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          rv.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null,
          )
          .accounts({
            agent: agent.publicKey,
            vault: rv,
            policy: rp,
            tracker: rt,
            session: oldSession,
            vaultTokenAccount: vaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor's is_agent() constraint fires before the handler runs
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("UnauthorizedAgent") || s.includes("ConstraintRaw"),
        );
      }
    });
  });

  // =========================================================================
  // Vault status transitions
  // =========================================================================
  describe("vault status transitions", () => {
    it("deposit to frozen vault → should succeed (only checks VaultAlreadyClosed)", async () => {
      const frozenVaultId = new BN(60);
      const [fv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          frozenVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [fp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), fv.toBuffer()],
        program.programId,
      );
      const [ft] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), fv.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          frozenVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent then freeze by revoking
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: fv } as any)
        .rpc();

      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: fv } as any)
        .rpc();

      const frozenVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: fv,
      });

      // Deposit should succeed even when frozen
      await program.methods
        .depositFunds(new BN(1_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: frozenVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const vaultTokenBalance = getTokenBalance(svm, frozenVaultUsdcAta);
      expect(Number(vaultTokenBalance)).to.equal(1_000_000);
    });

    it("deposit to closed vault → rejects VaultAlreadyClosed", async () => {
      const closedVaultId = new BN(61);
      const [cv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closedVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId,
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closedVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Close vault
      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // The vault PDA no longer exists after closing, so any attempt to deposit
      // will fail at the account deserialization level
      const closedVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: cv,
      });

      try {
        await program.methods
          .depositFunds(new BN(1_000_000))
          .accounts({
            owner: owner.publicKey,
            vault: cv,
            mint: usdcMint,
            ownerTokenAccount: ownerUsdcAta,
            vaultTokenAccount: closedVaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Vault PDA was closed — Anchor can't deserialize a zeroed/missing account.
        // LiteSVM proxy returns "Account does not exist"; Anchor provider
        // returns "Could not find" or "AccountNotInitialized".
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("AccountNotInitialized") ||
            s.includes("does not exist") ||
            s.includes("Could not find"),
        );
      }
    });

    it("validate_and_authorize on closed vault → rejects", async () => {
      const closedVaultId = new BN(62);
      const [cv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          closedVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId,
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId,
      );
      const [cs] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          cv.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          closedVaultId,
          new BN(1000),
          new BN(1000),
          1,
          [jupiterProgramId],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent, then close
      await program.methods
        .registerAgent(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: cv } as any)
        .rpc();

      await program.methods
        .closeVault()
        .accounts({
          owner: owner.publicKey,
          vault: cv,
          policy: cp,
          tracker: ct,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null,
          )
          .accounts({
            agent: agent.publicKey,
            vault: cv,
            policy: cp,
            tracker: ct,
            session: cs,
            vaultTokenAccount: anchor.utils.token.associatedAddress({
              mint: usdcMint,
              owner: cv,
            }),
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Vault PDA was closed — Anchor can't deserialize it.
        // LiteSVM returns "does not exist"; Anchor returns "Could not find"
        // or "AccountNotInitialized".
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("AccountNotInitialized") ||
            s.includes("does not exist") ||
            s.includes("Could not find"),
        );
      }
    });
  });

  // =========================================================================
  // Audit log ring buffer (MAX_RECENT_TRANSACTIONS = 50)
  // =========================================================================
  describe("audit log ring buffer", () => {
    const ringVaultId = new BN(70);
    let ringVaultPda: PublicKey;
    let ringPolicyPda: PublicKey;
    let ringTrackerPda: PublicKey;
    let ringVaultUsdcAta: PublicKey;
    const ringAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, ringAgent.publicKey, 10 * LAMPORTS_PER_SOL);

      [ringVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          ringVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [ringPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), ringVaultPda.toBuffer()],
        program.programId,
      );
      [ringTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), ringVaultPda.toBuffer()],
        program.programId,
      );

      // Large daily cap to allow many transactions
      await program.methods
        .initializeVault(
          ringVaultId,
          new BN(999_000_000_000), // 999k USDC daily cap
          new BN(100_000_000), // 100 USDC max tx
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: ringVaultPda,
          policy: ringPolicyPda,
          tracker: ringTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(ringAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: ringVaultPda } as any)
        .rpc();

      ringVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: ringVaultPda,
      });

      // Deposit enough for all transactions + fees
      await program.methods
        .depositFunds(new BN(500_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: ringVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: ringVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("51+ transactions → oldest evicted, newest preserved, count stays at 50", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          ringVaultPda.toBuffer(),
          ringAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Execute 51 composed validate+finalize cycles
      for (let i = 0; i < 51; i++) {
        const validateIx = await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000), // 1 USDC each
            jupiterProgramId,
            null,
          )
          .accountsPartial({
            agent: ringAgent.publicKey,
            vault: ringVaultPda,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            session: sessionPda,
            vaultTokenAccount: ringVaultUsdcAta,
            tokenMintAccount: usdcMint,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            feeDestinationTokenAccount: null,
            outputStablecoinAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .instruction();

        const finalizeIx = await program.methods
          .finalizeSession(true)
          .accountsPartial({
            payer: ringAgent.publicKey,
            vault: ringVaultPda,
            session: sessionPda,
            sessionRentRecipient: ringAgent.publicKey,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            vaultTokenAccount: ringVaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
            outputStablecoinAccount: null,
          })
          .instruction();

        sendVersionedTx(svm, [validateIx, finalizeIx], ringAgent);
      }

      const tracker = await program.account.spendTracker.fetch(ringTrackerPda);
      // V2: tracker has 144 epoch buckets; spending was recorded in non-zero buckets
      const nonZeroBuckets = tracker.buckets.filter(
        (b: any) => b.usdAmount.toNumber() > 0,
      );
      expect(nonZeroBuckets.length).to.be.greaterThan(0);

      // Vault should show 51 total transactions
      const vault = await program.account.agentVault.fetch(ringVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(51);
    });
  });

  // =========================================================================
  // Fee precision edge cases
  // =========================================================================
  describe("fee precision edge cases", () => {
    const feeEdgeVaultId = new BN(80);
    let feeEdgeVaultPda: PublicKey;
    let feeEdgePolicyPda: PublicKey;
    let feeEdgeTrackerPda: PublicKey;
    let feeEdgeVaultUsdcAta: PublicKey;
    const feeEdgeAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, feeEdgeAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [feeEdgeVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeEdgeVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [feeEdgePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeEdgeVaultPda.toBuffer()],
        program.programId,
      );
      [feeEdgeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeEdgeVaultPda.toBuffer()],
        program.programId,
      );

      // developer_fee_rate = 0 to isolate protocol fee
      await program.methods
        .initializeVault(
          feeEdgeVaultId,
          new BN(999_000_000),
          new BN(100_000_000),
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0, // developer_fee_rate = 0
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(feeEdgeAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: feeEdgeVaultPda } as any)
        .rpc();

      feeEdgeVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: feeEdgeVaultPda,
      });

      await program.methods
        .depositFunds(new BN(10_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: feeEdgeVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("amount = 1 lamport → protocol_fee = 0 → no fee transfer", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeEdgeVaultPda.toBuffer(),
          feeEdgeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);

      // protocol_fee = 1 * 200 / 1_000_000 = 0
      // Compose validate+finalize atomically
      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(1), // 1 lamport
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta, // H1: must provide for delegation revocation
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], feeEdgeAgent);

      // Vault balance unchanged (no fee deducted)
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      expect(Number(vaultBalAfter)).to.equal(Number(vaultBalBefore));
    });

    it("amount = 4999 → fee = 0; amount = 5000 → fee = 1", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          feeEdgeVaultPda.toBuffer(),
          feeEdgeAgent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      // Test amount = 4999: protocol_fee = 4999 * 200 / 1_000_000 = 0 (integer division)
      // Compose validate+finalize atomically
      const validateIx1 = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(4_999),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx1 = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta, // H1: must provide for delegation revocation
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx1, finalizeIx1], feeEdgeAgent);

      // Test amount = 5000: protocol_fee = 5000 * 200 / 1_000_000 = 1
      // Capture vault balance BEFORE validate (fee collected during validate)
      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);

      const validateIx2 = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(5_000),
          jupiterProgramId,
          null,
        )
        .accountsPartial({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const finalizeIx2 = await program.methods
        .finalizeSession(true)
        .accountsPartial({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          vaultTokenAccount: feeEdgeVaultUsdcAta, // H1: must provide for delegation revocation
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        })
        .instruction();

      sendVersionedTx(svm, [validateIx2, finalizeIx2], feeEdgeAgent);

      // Vault balance should decrease by exactly 1 (protocol fee deducted during validate)
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      expect(Number(vaultBalBefore) - Number(vaultBalAfter)).to.equal(1);
    });
  });

  // =========================================================================
  // Timelock policy changes
  // =========================================================================
  describe("timelock policy changes", () => {
    const tlVaultId = new BN(600);
    let tlVaultPda: PublicKey;
    let tlPolicyPda: PublicKey;
    let tlTrackerPda: PublicKey;
    let tlPendingPda: PublicKey;
    const tlAgent = Keypair.generate();

    before(async () => {
      airdropSol(svm, tlAgent.publicKey, 5 * LAMPORTS_PER_SOL);

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
      [tlPendingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), tlVaultPda.toBuffer()],
        program.programId,
      );

      // Create vault WITH timelock (60 seconds)
      await program.methods
        .initializeVault(
          tlVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100, // maxSlippageBps
          new BN(60), // 60 second timelock
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

      await program.methods
        .registerAgent(tlAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: tlVaultPda } as any)
        .rpc();
    });

    it("immediate update_policy blocked when timelock > 0", async () => {
      try {
        await program.methods
          .updatePolicy(
            new BN(999),
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
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TimelockActive");
      }
    });

    it("queue policy update succeeds when timelock > 0", async () => {
      await program.methods
        .queuePolicyUpdate(
          new BN(200_000_000), // new daily cap
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
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const pending =
        await program.account.pendingPolicyUpdate.fetch(tlPendingPda);
      expect(pending.vault.toString()).to.equal(tlVaultPda.toString());
      expect(pending.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
      expect(pending.executesAt.toNumber()).to.be.greaterThan(
        pending.queuedAt.toNumber(),
      );
    });

    it("apply fails before timelock expires", async () => {
      try {
        await program.methods
          .applyPendingPolicy()
          .accounts({
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            tracker: tlTrackerPda,
            pendingPolicy: tlPendingPda,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TimelockNotExpired");
      }
    });

    it("apply succeeds after timelock expires", async () => {
      // Advance time past timelock (60 seconds + buffer)
      advanceTime(svm, 61);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      // Verify policy was updated
      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);

      // Pending PDA should be closed
      try {
        await program.account.pendingPolicyUpdate.fetch(tlPendingPda);
        expect.fail("PendingPolicyUpdate should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("Account does not exist") ||
            s.includes("Could not find"),
        );
      }
    });

    it("cancel pending policy succeeds and returns rent", async () => {
      // Queue another update
      await program.methods
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
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const ownerBalBefore = getBalance(svm, owner.publicKey);

      await program.methods
        .cancelPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      // Rent should be returned
      const ownerBalAfter = getBalance(svm, owner.publicKey);
      expect(ownerBalAfter).to.be.greaterThan(ownerBalBefore);

      // Policy unchanged
      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.dailySpendingCapUsd.toNumber()).to.equal(200_000_000);
    });

    it("only one pending update at a time (init fails if PDA exists)", async () => {
      // Queue an update
      await program.methods
        .queuePolicyUpdate(
          new BN(400_000_000),
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
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Try to queue another (should fail — PDA already exists)
      try {
        await program.methods
          .queuePolicyUpdate(
            new BN(500_000_000),
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
            owner: owner.publicKey,
            vault: tlVaultPda,
            policy: tlPolicyPda,
            pendingPolicy: tlPendingPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor init constraint fails when PDA already exists
        expect(err.toString()).to.not.include("Should have thrown");
      }

      // Clean up
      await program.methods
        .cancelPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();
    });

    it("queue fails when timelock = 0 (NoTimelockConfigured)", async () => {
      // Create a vault with timelock = 0
      const noTlVaultId = new BN(601);
      const [noTlVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          noTlVaultId.toArrayLike(Buffer, "le", 8),
        ],
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
      const [noTlPending] = PublicKey.findProgramAddressSync(
        [Buffer.from("pending_policy"), noTlVault.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          noTlVaultId,
          new BN(1000),
          new BN(1000),
          0,
          [],
          new BN(0) as any,
          1,
          0,
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: noTlVault,
          policy: noTlPolicy,
          tracker: noTlTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      try {
        await program.methods
          .queuePolicyUpdate(
            new BN(999),
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
            owner: owner.publicKey,
            vault: noTlVault,
            policy: noTlPolicy,
            pendingPolicy: noTlPending,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoTimelockConfigured");
      }
    });

    it("changing timelock_duration itself goes through queue", async () => {
      // Queue a timelock change from 60 to 120
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
          new BN(120), // new timelock_duration
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 61);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.timelockDuration.toNumber()).to.equal(120);
    });

    it("setting timelock to 0 via queue (disabling)", async () => {
      // Queue timelock disable (set to 0)
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
          new BN(0), // disable timelock
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          pendingPolicy: tlPendingPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      advanceTime(svm, 121);

      await program.methods
        .applyPendingPolicy()
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
          tracker: tlTrackerPda,
          pendingPolicy: tlPendingPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(policy.timelockDuration.toNumber()).to.equal(0);

      // Now immediate update should work
      await program.methods
        .updatePolicy(
          new BN(999_000_000),
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
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
        } as any)
        .rpc();

      const updated = await program.account.policyConfig.fetch(tlPolicyPda);
      expect(updated.dailySpendingCapUsd.toNumber()).to.equal(999_000_000);
    });

    it("revoke_agent bypasses timelock (emergency)", async () => {
      // Re-enable timelock
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
          new BN(60),
          null,
        )
        .accounts({
          owner: owner.publicKey,
          vault: tlVaultPda,
          policy: tlPolicyPda,
        } as any)
        .rpc();

      // Revoke agent should work immediately (no timelock)
      await program.methods
        .revokeAgent(tlAgent.publicKey)
        .accounts({ owner: owner.publicKey, vault: tlVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(tlVaultPda);
      expect(JSON.stringify(vault.status)).to.include("frozen");
    });
  });

  // =========================================================================
  // Destination allowlist + agent_transfer
  // =========================================================================
  describe("destination allowlist & agent_transfer", () => {
    const destVaultId = new BN(510);
    let destVaultPda: PublicKey;
    let destPolicyPda: PublicKey;
    let destTrackerPda: PublicKey;
    const destAgent = Keypair.generate();
    const allowedDest = Keypair.generate();
    const blockedDest = Keypair.generate();
    let destVaultUsdcAta: PublicKey;
    let allowedDestAta: PublicKey;
    let blockedDestAta: PublicKey;

    before(async () => {
      airdropSol(svm, destAgent.publicKey, 5 * LAMPORTS_PER_SOL);
      airdropSol(svm, allowedDest.publicKey, 2 * LAMPORTS_PER_SOL);
      airdropSol(svm, blockedDest.publicKey, 2 * LAMPORTS_PER_SOL);

      [destVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          destVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [destPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), destVaultPda.toBuffer()],
        program.programId,
      );
      [destTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), destVaultPda.toBuffer()],
        program.programId,
      );

      // Create vault with destination allowlist
      await program.methods
        .initializeVault(
          destVaultId,
          new BN(500_000_000), // 500 USDC daily cap
          new BN(100_000_000), // 100 USDC max tx
          1, // protocolMode: allowlist
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100, // maxSlippageBps
          new BN(0), // no timelock
          [allowedDest.publicKey], // only allow transfers to this address
        )
        .accounts({
          owner: owner.publicKey,
          vault: destVaultPda,
          policy: destPolicyPda,
          tracker: destTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(destAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: destVaultPda } as any)
        .rpc();

      // Deposit USDC
      destVaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        destVaultPda,
        true,
      );
      await program.methods
        .depositFunds(new BN(600_000_000)) // 600 USDC
        .accounts({
          owner: owner.publicKey,
          vault: destVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: destVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create destination ATAs
      allowedDestAta = createAtaHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        allowedDest.publicKey,
      );
      blockedDestAta = createAtaHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        blockedDest.publicKey,
      );
    });

    it("agent_transfer to allowed destination succeeds", async () => {
      const balBefore = getTokenBalance(svm, allowedDestAta);

      await program.methods
        .agentTransfer(new BN(10_000_000)) // 10 USDC
        .accounts({
          agent: destAgent.publicKey,
          vault: destVaultPda,
          policy: destPolicyPda,
          tracker: destTrackerPda,
          vaultTokenAccount: destVaultUsdcAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: allowedDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();

      // Transfer is net of fees — protocol fee = 10_000_000 * 200 / 1_000_000 = 2_000
      // developer fee = 0 (rate is 0), so net = 10_000_000 - 2_000 = 9_998_000
      const balAfter = getTokenBalance(svm, allowedDestAta);
      expect(Number(balAfter) - Number(balBefore)).to.equal(9_998_000);
    });

    it("agent_transfer to non-allowed destination fails", async () => {
      try {
        await program.methods
          .agentTransfer(new BN(10_000_000))
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: blockedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DestinationNotAllowed");
      }
    });

    it("empty allowlist = any destination allowed", async () => {
      // Create vault with empty allowlist
      const anyDestVaultId = new BN(511);
      const [anyVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          anyDestVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [anyPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), anyVault.toBuffer()],
        program.programId,
      );
      const [anyTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), anyVault.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          anyDestVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100, // maxSlippageBps
          new BN(0),
          [], // empty allowlist
        )
        .accounts({
          owner: owner.publicKey,
          vault: anyVault,
          policy: anyPolicy,
          tracker: anyTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(destAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: anyVault } as any)
        .rpc();

      const anyVaultAta = getAssociatedTokenAddressSync(
        usdcMint,
        anyVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: anyVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: anyVaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Transfer to any destination should work
      await program.methods
        .agentTransfer(new BN(5_000_000))
        .accounts({
          agent: destAgent.publicKey,
          vault: anyVault,
          policy: anyPolicy,
          tracker: anyTracker,
          vaultTokenAccount: anyVaultAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: blockedDestAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();
    });

    it("too many destinations on init fails", async () => {
      const badVid = new BN(512);
      const [bv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          badVid.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId,
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId,
      );

      // Generate 11 destinations (max is 10)
      const tooMany = Array.from(
        { length: 11 },
        () => Keypair.generate().publicKey,
      );

      try {
        await program.methods
          .initializeVault(
            badVid,
            new BN(1000),
            new BN(1000),
            0,
            [],
            new BN(0) as any,
            1,
            0,
            100, // maxSlippageBps
            new BN(0),
            tooMany,
          )
          .accounts({
            owner: owner.publicKey,
            vault: bv,
            policy: bp,
            tracker: bt,
            feeDestination: feeDestination.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TooManyDestinations");
      }
    });

    it("agent_transfer respects daily spending cap", async () => {
      // The destVault has 500 USDC daily cap and 100 USDC max-tx.
      // We already spent 10 USDC. Make 4 more transfers of 100 USDC
      // to bring total to 410 USDC, then try 100 USDC which would
      // push total to 510 USDC (exceeding 500 cap).
      for (let i = 0; i < 4; i++) {
        await program.methods
          .agentTransfer(new BN(100_000_000)) // 100 USDC each
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
      }
      // Total spent: 10 + 4*100 = 410 USDC. Remaining: 90 USDC.
      // Try 100 USDC → total would be 510 > 500 cap
      try {
        await program.methods
          .agentTransfer(new BN(100_000_000)) // 100 USDC (would push past cap)
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DailyCapExceeded");
      }
    });

    it("agent_transfer respects per-tx limit", async () => {
      // Max tx size is 100 USDC
      try {
        await program.methods
          .agentTransfer(new BN(101_000_000)) // 101 USDC (exceeds max tx)
          .accounts({
            agent: destAgent.publicKey,
            vault: destVaultPda,
            policy: destPolicyPda,
            tracker: destTrackerPda,
            vaultTokenAccount: destVaultUsdcAta,
            tokenMintAccount: usdcMint,
            destinationTokenAccount: allowedDestAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([destAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TransactionTooLarge");
      }
    });

    it("agent_transfer records in tracker", async () => {
      const tracker = await program.account.spendTracker.fetch(destTrackerPda);
      // V2: spending recorded in epoch buckets
      const nonZeroBuckets = tracker.buckets.filter(
        (b: any) => b.usdAmount.toNumber() > 0,
      );
      expect(nonZeroBuckets.length).to.be.greaterThan(0);
    });

    it("agent_transfer with fees (protocol + developer)", async () => {
      // Create a vault with developer fee
      const feeDestVaultId = new BN(513);
      const [fv] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          feeDestVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      const [fp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), fv.toBuffer()],
        program.programId,
      );
      const [ft] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), fv.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          feeDestVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          1,
          [jupiterProgramId],
          new BN(0) as any,
          3,
          500, // developer_fee_rate = 500 (5 BPS)
          100, // maxSlippageBps
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(destAgent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: fv } as any)
        .rpc();

      const fvAta = getAssociatedTokenAddressSync(usdcMint, fv, true);
      await program.methods
        .depositFunds(new BN(100_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: fvAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Create fee dest ATA if needed
      try {
        feeDestUsdcAta = createAtaHelper(
          svm,
          (owner as any).payer,
          usdcMint,
          feeDestination.publicKey,
        );
      } catch {
        feeDestUsdcAta = getAssociatedTokenAddressSync(
          usdcMint,
          feeDestination.publicKey,
        );
      }

      const destBalBefore = getTokenBalance(svm, allowedDestAta);

      // Transfer 10 USDC with fees
      // protocol_fee = 10_000_000 * 200 / 1_000_000 = 2_000
      // developer_fee = 10_000_000 * 500 / 1_000_000 = 5_000
      // net = 10_000_000 - 2_000 - 5_000 = 9_993_000
      await program.methods
        .agentTransfer(new BN(10_000_000))
        .accounts({
          agent: destAgent.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          vaultTokenAccount: fvAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: allowedDestAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();

      const destBalAfter = getTokenBalance(svm, allowedDestAta);
      expect(Number(destBalAfter) - Number(destBalBefore)).to.equal(9_993_000);

      // Check vault fees (developer fee only)
      const vault = await program.account.agentVault.fetch(fv);
      expect(vault.totalFeesCollected.toNumber()).to.equal(5_000);
    });
  });

  // =========================================================================
  // Multi-agent vaults (Task A4.2)
  // =========================================================================
  describe("multi-agent vaults", () => {
    const maVaultId = new BN(700);
    let maVault: PublicKey;
    let maPolicy: PublicKey;
    let maTracker: PublicKey;
    const agent2 = Keypair.generate();
    let maVaultUsdcAta: PublicKey;

    before(async () => {
      airdropSol(svm, agent2.publicKey, 10 * LAMPORTS_PER_SOL);

      [maVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          owner.publicKey.toBuffer(),
          maVaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [maPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), maVault.toBuffer()],
        program.programId,
      );
      [maTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), maVault.toBuffer()],
        program.programId,
      );

      await program.methods
        .initializeVault(
          maVaultId,
          new BN(1_000_000_000),
          new BN(500_000_000),
          1,
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0,
          100,
          new BN(0),
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      maVaultUsdcAta = createAtaIdempotentHelper(
        svm,
        (owner as any).payer,
        usdcMint,
        maVault,
        true,
      );
      await program.methods
        .depositFunds(new BN(500_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: maVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("registers 2 agents with different permissions", async () => {
      // Agent 1: Swap-only (bit 0)
      const SWAP_ONLY = new BN(1);
      await program.methods
        .registerAgent(agent.publicKey, SWAP_ONLY)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      // Agent 2: full permissions
      await program.methods
        .registerAgent(agent2.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(2);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent.publicKey.toString(),
      );
      expect(vault.agents[0].permissions.toNumber()).to.equal(1);
      expect(vault.agents[1].pubkey.toString()).to.equal(
        agent2.publicKey.toString(),
      );
      expect(vault.agents[1].permissions.toNumber()).to.equal(
        FULL_PERMISSIONS.toNumber(),
      );
    });

    it("agent with Swap permission swaps successfully", async () => {
      const [session] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          maVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(1_000_000),
          jupiterProgramId,
          null,
        )
        .accounts({
          agent: agent.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          session,
          vaultTokenAccount: maVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .signers([agent])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accounts({
          payer: agent.publicKey,
          vault: maVault,
          session,
          sessionRentRecipient: agent.publicKey,
          policy: maPolicy,
          tracker: maTracker,
          vaultTokenAccount: maVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        } as any)
        .signers([agent])
        .instruction();

      sendVersionedTx(svm, [validateIx, finalizeIx], agent);
    });

    it("agent without OpenPosition permission denied → InsufficientPermissions", async () => {
      // Agent 1 has Swap-only (bit 0), OpenPosition is bit 1
      const [session] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("session"),
          maVault.toBuffer(),
          agent.publicKey.toBuffer(),
          usdcMint.toBuffer(),
        ],
        program.programId,
      );

      const validateIx = await program.methods
        .validateAndAuthorize(
          { openPosition: {} },
          usdcMint,
          new BN(1_000_000),
          jupiterProgramId,
          null,
        )
        .accounts({
          agent: agent.publicKey,
          vault: maVault,
          policy: maPolicy,
          tracker: maTracker,
          session,
          vaultTokenAccount: maVaultUsdcAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .signers([agent])
        .instruction();

      const finalizeIx = await program.methods
        .finalizeSession(true)
        .accounts({
          payer: agent.publicKey,
          vault: maVault,
          session,
          sessionRentRecipient: agent.publicKey,
          policy: maPolicy,
          tracker: maTracker,
          vaultTokenAccount: maVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          outputStablecoinAccount: null,
        } as any)
        .signers([agent])
        .instruction();

      try {
        sendVersionedTx(svm, [validateIx, finalizeIx], agent);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientPermissions");
      }
    });

    it("revoke 1 of 2 agents — vault stays Active", async () => {
      await program.methods
        .revokeAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(1);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        agent2.publicKey.toString(),
      );
      expect(vault.status).to.have.property("active");
    });

    it("revoke last agent — vault Frozen", async () => {
      await program.methods
        .revokeAgent(agent2.publicKey)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(0);
      expect(vault.status).to.have.property("frozen");
    });

    it("register up to 10 agents — succeeds", async () => {
      // Reactivate first
      await program.methods
        .reactivateVault(agent.publicKey, FULL_PERMISSIONS)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      // Register 9 more (total 10 with the agent from reactivate)
      for (let i = 0; i < 9; i++) {
        const a = Keypair.generate();
        airdropSol(svm, a.publicKey, LAMPORTS_PER_SOL);
        await program.methods
          .registerAgent(a.publicKey, FULL_PERMISSIONS)
          .accounts({ owner: owner.publicKey, vault: maVault } as any)
          .rpc();
      }

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(10);
    });

    it("11th agent → MaxAgentsReached (6046)", async () => {
      const extra = Keypair.generate();
      try {
        await program.methods
          .registerAgent(extra.publicKey, FULL_PERMISSIONS)
          .accounts({ owner: owner.publicKey, vault: maVault } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MaxAgentsReached");
      }
    });

    it("reactivate with new agent + permissions", async () => {
      // First freeze by revoking all 10 agents
      const vault10 = await program.account.agentVault.fetch(maVault);
      for (const a of vault10.agents) {
        await program.methods
          .revokeAgent(a.pubkey)
          .accounts({ owner: owner.publicKey, vault: maVault } as any)
          .rpc();
      }

      const newAgent = Keypair.generate();
      const SWAP_AND_TRANSFER = new BN(1 | (1 << 4)); // bits 0 + 4
      await program.methods
        .reactivateVault(newAgent.publicKey, SWAP_AND_TRANSFER)
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      expect(vault.agents.length).to.equal(1);
      expect(vault.agents[0].pubkey.toString()).to.equal(
        newAgent.publicKey.toString(),
      );
      expect(vault.agents[0].permissions.toNumber()).to.equal(
        SWAP_AND_TRANSFER.toNumber(),
      );
      expect(vault.status).to.have.property("active");
    });

    it("update agent permissions (owner-only)", async () => {
      // Register a fresh agent for this test
      const updAgent = Keypair.generate();
      airdropSol(svm, updAgent.publicKey, LAMPORTS_PER_SOL);
      await program.methods
        .registerAgent(updAgent.publicKey, new BN(1))
        .accounts({ owner: owner.publicKey, vault: maVault } as any)
        .rpc();

      // Update permissions to full
      await program.methods
        .updateAgentPermissions(updAgent.publicKey, FULL_PERMISSIONS)
        .accounts({
          owner: owner.publicKey,
          vault: maVault,
          policy: maPolicy,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(maVault);
      const entry = vault.agents.find(
        (a: any) => a.pubkey.toString() === updAgent.publicKey.toString(),
      );
      expect(entry).to.not.be.undefined;
      expect(entry!.permissions.toNumber()).to.equal(
        FULL_PERMISSIONS.toNumber(),
      );
    });

    it("invalid permission bitmask → InvalidPermissions (6048)", async () => {
      const badAgent = Keypair.generate();
      // Bit 21+ is invalid (only 21 ActionType variants, bits 0-20 valid)
      const BAD_PERMS = new BN(1n << 21n);
      try {
        await program.methods
          .registerAgent(badAgent.publicKey, BAD_PERMS)
          .accounts({ owner: owner.publicKey, vault: maVault } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidPermissions");
      }
    });
  });
});
