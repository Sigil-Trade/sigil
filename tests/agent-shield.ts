import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../target/types/agent_shield";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";
import {
  createTestEnv,
  airdropSol,
  createMintHelper,
  createAtaHelper,
  createAtaIdempotentHelper,
  mintToHelper,
  getTokenBalance,
  getBalance,
  accountExists,
  advancePastSlot,
  TestEnv,
  LiteSVM,
} from "./helpers/litesvm-setup";

describe("agent-shield", () => {
  let env: TestEnv;
  let svm: LiteSVM;
  let program: Program<AgentShield>;

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
  const protocolTreasury = new PublicKey("ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT");
  let protocolTreasuryUsdcAta: PublicKey;

  before(async () => {
    env = createTestEnv();
    svm = env.svm;
    program = env.program;
    owner = env.provider.wallet;

    // Airdrop to test accounts
    airdropSol(svm, agent.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, unauthorizedUser.publicKey, 10 * LAMPORTS_PER_SOL);
    airdropSol(svm, feeDestination.publicKey, 2 * LAMPORTS_PER_SOL);

    // Create USDC-like mint (6 decimals)
    usdcMint = createMintHelper(
      svm,
      (owner as any).payer,
      owner.publicKey,
      6
    );

    // Create a second mint for testing disallowed tokens
    solMint = createMintHelper(
      svm,
      (owner as any).payer,
      owner.publicKey,
      9
    );

    // Create owner's USDC ATA and mint tokens
    ownerUsdcAta = createAtaHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      owner.publicKey
    );
    mintToHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      1_000_000_000n // 1000 USDC
    );

    // Create protocol treasury ATA (needed for fee transfers)
    // Protocol treasury is an off-curve address, so we need allowOwnerOffCurve=true
    protocolTreasuryUsdcAta = createAtaIdempotentHelper(
      svm,
      (owner as any).payer,
      usdcMint,
      protocolTreasury,
      true
    );

    // Derive PDAs
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        owner.publicKey.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [policyPda, policyBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), vaultPda.toBuffer()],
      program.programId
    );

    [trackerPda, trackerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("tracker"), vaultPda.toBuffer()],
      program.programId
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
          [usdcMint],
          [jupiterProgramId],
          new BN(0) as any, // max_leverage_bps (u16)
          3, // max_concurrent_positions
          0 // developer_fee_rate
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
      expect(vault.agent.toString()).to.equal(PublicKey.default.toString());
      expect(vault.feeDestination.toString()).to.equal(feeDestination.publicKey.toString());
      expect(vault.vaultId.toNumber()).to.equal(1);
      expect(vault.totalTransactions.toNumber()).to.equal(0);
      expect(vault.totalVolume.toNumber()).to.equal(0);
      expect(vault.openPositions).to.equal(0);
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);

      // Verify policy state
      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.vault.toString()).to.equal(vaultPda.toString());
      expect(policy.dailySpendingCap.toNumber()).to.equal(500_000_000);
      expect(policy.maxTransactionSize.toNumber()).to.equal(100_000_000);
      expect(policy.allowedTokens.length).to.equal(1);
      expect(policy.allowedTokens[0].toString()).to.equal(usdcMint.toString());
      expect(policy.allowedProtocols.length).to.equal(1);
      expect(policy.allowedProtocols[0].toString()).to.equal(jupiterProgramId.toString());
      expect(policy.canOpenPositions).to.equal(true);
      expect(policy.maxConcurrentPositions).to.equal(3);
      expect(policy.developerFeeRate).to.equal(0);

      // Verify tracker state
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.vault.toString()).to.equal(vaultPda.toString());
      expect(tracker.rollingSpends.length).to.equal(0);
      expect(tracker.recentTransactions.length).to.equal(0);
    });

    it("rejects duplicate vault_id (PDA already exists)", async () => {
      try {
        await program.methods
          .initializeVault(
            vaultId, // same vault_id
            new BN(100),
            new BN(100),
            [],
            [],
            new BN(0) as any,
            1,
            0
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

    it("rejects too many allowed tokens", async () => {
      const vaultId2 = new BN(99);
      const [vault2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), vaultId2.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [policy2] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), vault2.toBuffer()],
        program.programId
      );
      const [tracker2] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), vault2.toBuffer()],
        program.programId
      );

      // 11 tokens exceeds MAX_ALLOWED_TOKENS (10)
      const tooManyTokens = Array.from({ length: 11 }, () => Keypair.generate().publicKey);
      try {
        await program.methods
          .initializeVault(vaultId2, new BN(100), new BN(100), tooManyTokens, [], new BN(0) as any, 1, 0)
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
        expect(err.toString()).to.include("TooManyAllowedTokens");
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
          program.programId
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
        // Seeds constraint or has_one will fail
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("ConstraintSeeds") || s.includes("Unauthorized") || s.includes("2006") || s.includes("has_one")
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
        .registerAgent(agent.publicKey)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
        } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.agent.toString()).to.equal(agent.publicKey.toString());
    });

    it("rejects double registration", async () => {
      try {
        await program.methods
          .registerAgent(Keypair.generate().publicKey)
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), vid.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId
      );

      // First create the vault
      await program.methods
        .initializeVault(vid, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
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
          .registerAgent(agent.publicKey)
          .accounts({
            owner: unauthorizedUser.publicKey,
            vault: v,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Unauthorized") || s.includes("ConstraintSeeds") || s.includes("has_one") || s.includes("2006")
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
          null,                // keep max_transaction_size
          null,                // keep allowed_tokens
          null,                // keep allowed_protocols
          null,                // keep max_leverage_bps
          null,                // keep can_open_positions
          null,                // keep max_concurrent_positions
          null                 // keep developer_fee_rate
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          policy: policyPda,
        } as any)
        .rpc();

      const policy = await program.account.policyConfig.fetch(policyPda);
      expect(policy.dailySpendingCap.toNumber()).to.equal(200_000_000);
      // Other fields unchanged
      expect(policy.maxTransactionSize.toNumber()).to.equal(100_000_000);
      expect(policy.allowedTokens.length).to.equal(1);
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .updatePolicy(new BN(999), null, null, null, null, null, null, null)
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
          (s: string) => s.includes("Unauthorized") || s.includes("ConstraintSeeds") || s.includes("has_one") || s.includes("2006")
        );
      }
    });

    it("rejects too many allowed protocols", async () => {
      const tooManyProtocols = Array.from({ length: 11 }, () => Keypair.generate().publicKey);
      try {
        await program.methods
          .updatePolicy(null, null, null, tooManyProtocols, null, null, null, null)
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), revokeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), revokeVaultPda.toBuffer()],
        program.programId
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), revokeVaultPda.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(revokeVaultId, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
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
        .registerAgent(agent.publicKey)
        .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
        .rpc();
    });

    it("freezes the vault", async () => {
      await program.methods
        .revokeAgent()
        .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(revokeVaultPda);
      // VaultStatus::Frozen is represented as { frozen: {} }
      expect(JSON.stringify(vault.status)).to.include("frozen");
    });

    it("is idempotent (can freeze already-frozen vault)", async () => {
      await program.methods
        .revokeAgent()
        .accounts({ owner: owner.publicKey, vault: revokeVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(revokeVaultPda);
      expect(JSON.stringify(vault.status)).to.include("frozen");
    });

    it("rejects non-owner signer", async () => {
      try {
        await program.methods
          .revokeAgent()
          .accounts({ owner: unauthorizedUser.publicKey, vault: revokeVaultPda } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Unauthorized") || s.includes("ConstraintSeeds") || s.includes("has_one") || s.includes("2006")
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), reactVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), reactVaultPda.toBuffer()],
        program.programId
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), reactVaultPda.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(reactVaultId, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
        .accounts({
          owner: owner.publicKey,
          vault: reactVaultPda,
          policy: rp,
          tracker: rt,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Freeze it first
      await program.methods
        .revokeAgent()
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();
    });

    it("reactivates a frozen vault", async () => {
      await program.methods
        .reactivateVault(null)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(JSON.stringify(vault.status)).to.include("active");
    });

    it("rejects reactivating an already-active vault", async () => {
      try {
        await program.methods
          .reactivateVault(null)
          .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultNotFrozen");
      }
    });

    it("optionally rotates agent key on reactivation", async () => {
      // Freeze again
      await program.methods
        .revokeAgent()
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const newAgent = Keypair.generate();
      await program.methods
        .reactivateVault(newAgent.publicKey)
        .accounts({ owner: owner.publicKey, vault: reactVaultPda } as any)
        .rpc();

      const vault = await program.account.agentVault.fetch(reactVaultPda);
      expect(vault.agent.toString()).to.equal(newAgent.publicKey.toString());
      expect(JSON.stringify(vault.status)).to.include("active");
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
          (s: string) => s.includes("Unauthorized") || s.includes("ConstraintSeeds") || s.includes("has_one") || s.includes("2006")
        );
      }
    });
  });

  // =========================================================================
  // validate_and_authorize
  // =========================================================================
  describe("validate_and_authorize", () => {
    let sessionPda: PublicKey;

    before(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), vaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );
    });

    it("authorizes a valid swap action", async () => {
      const amount = new BN(50_000_000); // 50 USDC

      await program.methods
        .validateAndAuthorize(
          { swap: {} },    // ActionType::Swap
          usdcMint,
          amount,
          jupiterProgramId,
          null               // no leverage
        )
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // Verify session was created
      const session = await program.account.sessionAuthority.fetch(sessionPda);
      expect(session.vault.toString()).to.equal(vaultPda.toString());
      expect(session.agent.toString()).to.equal(agent.publicKey.toString());
      expect(session.authorized).to.equal(true);
      expect(session.authorizedAmount.toNumber()).to.equal(50_000_000);
      expect(session.authorizedToken.toString()).to.equal(usdcMint.toString());
      expect(session.authorizedProtocol.toString()).to.equal(jupiterProgramId.toString());

      // Verify spend was tracked
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.rollingSpends.length).to.equal(1);
      expect(tracker.rollingSpends[0].amountSpent.toNumber()).to.equal(50_000_000);
    });

    it("prevents double-authorization (session already exists)", async () => {
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // init constraint fails because session PDA already exists
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // =========================================================================
  // finalize_session
  // =========================================================================
  describe("finalize_session", () => {
    let sessionPda: PublicKey;

    before(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), vaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );
    });

    it("finalizes a session and records audit log", async () => {
      // Protocol fee = 50_000_000 * 20 / 1_000_000 = 1000 (> 0), so we need token accounts
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: agent.publicKey,
          vault: vaultPda,
          policy: policyPda,
          tracker: trackerPda,
          session: sessionPda,
          sessionRentRecipient: agent.publicKey,
          vaultTokenAccount: vaultUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // Session should be closed (fetch should fail)
      try {
        await program.account.sessionAuthority.fetch(sessionPda);
        expect.fail("Session should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Account does not exist") || s.includes("Could not find")
        );
      }

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(vaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      expect(vault.totalVolume.toNumber()).to.equal(50_000_000);

      // Verify audit log
      const tracker = await program.account.spendTracker.fetch(trackerPda);
      expect(tracker.recentTransactions.length).to.equal(1);
      expect(tracker.recentTransactions[0].success).to.equal(true);
      expect(tracker.recentTransactions[0].amount.toNumber()).to.equal(50_000_000);
    });
  });

  // =========================================================================
  // validate_and_authorize — error paths
  // =========================================================================
  describe("validate_and_authorize error paths", () => {
    let sessionPda: PublicKey;

    beforeEach(async () => {
      [sessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), vaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );
    });

    it("rejects disallowed token", async () => {
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            solMint, // not in allowed_tokens
            new BN(1_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TokenNotAllowed");
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
            fakeProtocol, // not in allowed_protocols
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
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
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("TransactionTooLarge");
      }
    });

    it("rejects when daily spending cap would be exceeded", async () => {
      // Current daily cap is 200 USDC, already spent 50 USDC
      // Trying to spend 160 USDC would put us at 210 > 200
      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(100_000_000), // 100 USDC — within max_tx_size but 50+100=150 which is under 200 cap
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();

        // This should succeed (50 + 100 = 150 < 200 cap)
        // Finalize it so we can test the cap
        await program.methods
          .finalizeSession(true)
          .accounts({
            payer: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            sessionRentRecipient: agent.publicKey,
            vaultTokenAccount: vaultUsdcAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();

        // Now try to spend another 100 USDC — total would be 250 > 200 cap
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(100_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DailyCapExceeded");
      }
    });

    it("rejects unauthorized agent", async () => {
      const fakeAgent = Keypair.generate();
      airdropSol(svm, fakeAgent.publicKey, LAMPORTS_PER_SOL);

      const [fakeSession] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), vaultPda.toBuffer(), fakeAgent.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: fakeAgent.publicKey,
            vault: vaultPda,
            policy: policyPda,
            tracker: trackerPda,
            session: fakeSession,
            systemProgram: SystemProgram.programId,
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), frozenVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [frozenPolicy] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), frozenVault.toBuffer()],
        program.programId
      );
      const [frozenTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), frozenVault.toBuffer()],
        program.programId
      );
      const [frozenSession] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), frozenVault.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: frozenVault,
            policy: frozenPolicy,
            tracker: frozenTracker,
            session: frozenSession,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // revoke_agent clears the agent key, so the constraint fires UnauthorizedAgent
        // before the handler's VaultNotActive check — both indicate the vault is locked down
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("VaultNotActive") || s.includes("UnauthorizedAgent")
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), closeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [closePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), closeVaultPda.toBuffer()],
        program.programId
      );
      [closeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), closeVaultPda.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(closeVaultId, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), vid.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(vid, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
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
          (s: string) => s.includes("Unauthorized") || s.includes("ConstraintSeeds") || s.includes("has_one") || s.includes("2006")
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), feeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [feePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeVaultPda.toBuffer()],
        program.programId
      );
      [feeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeVaultPda.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(
          feeVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          [usdcMint],
          [jupiterProgramId],
          new BN(0) as any,
          3,
          30 // developer_fee_rate = 30 (0.3 BPS)
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

    it("init vault with developer_fee_rate 51 → rejects DeveloperFeeTooHigh", async () => {
      const badVaultId = new BN(31);
      const [bv] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), badVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [bp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), bv.toBuffer()],
        program.programId
      );
      const [bt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), bv.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .initializeVault(badVaultId, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 51)
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
        .updatePolicy(null, null, null, null, null, null, null, 0)
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
        .updatePolicy(null, null, null, null, null, null, null, 30)
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      policy = await program.account.policyConfig.fetch(feePolicyPda);
      expect(policy.developerFeeRate).to.equal(30);
    });

    it("update_policy with developer_fee_rate 51 → rejects", async () => {
      try {
        await program.methods
          .updatePolicy(null, null, null, null, null, null, null, 51)
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

    it("finalize with developer_fee=0 → only protocol fee transferred", async () => {
      // Set developer fee to 0
      await program.methods
        .updatePolicy(null, null, null, null, null, null, null, 0)
        .accounts({
          owner: owner.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
        } as any)
        .rpc();

      // Register agent on fee vault
      await program.methods
        .registerAgent(agent.publicKey)
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

      // Authorize action
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), feeVaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // protocol_fee = 10_000_000 * 20 / 1_000_000 = 200 (> 0), needs token accounts
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          vaultTokenAccount: feeVaultUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // Verify vault stats updated
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      // developer fees should be 0
      expect(vault.totalFeesCollected.toNumber()).to.equal(0);
    });

    it("finalize with developer_fee=50 → both fees transferred", async () => {
      // Set developer fee to 50 (max, 0.5 BPS)
      await program.methods
        .updatePolicy(null, null, null, null, null, null, null, 50)
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
          feeDestination.publicKey
        );
      } catch {
        // ATA may already exist
        feeDestUsdcAta = anchor.utils.token.associatedAddress({
          mint: usdcMint,
          owner: feeDestination.publicKey,
        });
      }

      // Authorize
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), feeVaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // Finalize with both fee accounts
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          vaultTokenAccount: feeVaultUsdcAta,
          feeDestinationTokenAccount: feeDestUsdcAta,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      // developer fee = 10_000_000 * 50 / 1_000_000 = 500
      const vault = await program.account.agentVault.fetch(feeVaultPda);
      expect(vault.totalFeesCollected.toNumber()).to.equal(500);
    });

    it("finalize with success=false → no fees", async () => {
      // Authorize
      [feeSessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), feeVaultPda.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      const vaultBefore = await program.account.agentVault.fetch(feeVaultPda);
      const feesBefore = vaultBefore.totalFeesCollected.toNumber();

      // Finalize with success=false
      await program.methods
        .finalizeSession(false)
        .accounts({
          payer: agent.publicKey,
          vault: feeVaultPda,
          policy: feePolicyPda,
          tracker: feeTrackerPda,
          session: feeSessionPda,
          sessionRentRecipient: agent.publicKey,
          vaultTokenAccount: null,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([agent])
        .rpc();

      const vault = await program.account.agentVault.fetch(feeVaultPda);
      // No new fees collected on failure
      expect(vault.totalFeesCollected.toNumber()).to.equal(feesBefore);
    });

    it("init vault with developer_fee_rate at max (50) succeeds", async () => {
      const maxFeeVaultId = new BN(32);
      const [mv] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), maxFeeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [mp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), mv.toBuffer()],
        program.programId
      );
      const [mt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), mv.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(maxFeeVaultId, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 50)
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
      expect(policy.developerFeeRate).to.equal(50);
    });
  });

  // =========================================================================
  // Tier 1a: Session expiry & permissionless crank
  // =========================================================================
  describe("session expiry & permissionless crank", () => {
    const expiryVaultId = new BN(40);
    let expiryVaultPda: PublicKey;
    let expiryPolicyPda: PublicKey;
    let expiryTrackerPda: PublicKey;
    let expirySessionPda: PublicKey;
    let expiryVaultUsdcAta: PublicKey;
    const expiryAgent = Keypair.generate();

    before(async () => {
      // Airdrop to new agent
      airdropSol(svm, expiryAgent.publicKey, 5 * LAMPORTS_PER_SOL);

      [expiryVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), expiryVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [expiryPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), expiryVaultPda.toBuffer()],
        program.programId
      );
      [expiryTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), expiryVaultPda.toBuffer()],
        program.programId
      );
      [expirySessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), expiryVaultPda.toBuffer(), expiryAgent.publicKey.toBuffer()],
        program.programId
      );

      // Create vault with USDC allowed
      await program.methods
        .initializeVault(
          expiryVaultId,
          new BN(500_000_000),
          new BN(100_000_000),
          [usdcMint],
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0
        )
        .accounts({
          owner: owner.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Register agent
      await program.methods
        .registerAgent(expiryAgent.publicKey)
        .accounts({ owner: owner.publicKey, vault: expiryVaultPda } as any)
        .rpc();

      // Deposit USDC to vault
      expiryVaultUsdcAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: expiryVaultPda,
      });

      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: expiryVaultPda,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: expiryVaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    });

    it("finalize expired session → success=false, rent returned to agent", async () => {
      // Create session
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(10_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();

      // Get session expiry slot
      const sessionData = await program.account.sessionAuthority.fetch(expirySessionPda);
      const expiresAt = sessionData.expiresAtSlot.toNumber();

      // Advance clock past expiry (instant, no polling needed)
      advancePastSlot(svm, expiresAt);

      const agentBalBefore = getBalance(svm, expiryAgent.publicKey);

      // Finalize expired session — agent as payer, success is forced to false
      await program.methods
        .finalizeSession(true) // even though we pass true, expired sessions → false
        .accounts({
          payer: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          sessionRentRecipient: expiryAgent.publicKey,
          vaultTokenAccount: null,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();

      // Session should be closed
      try {
        await program.account.sessionAuthority.fetch(expirySessionPda);
        expect.fail("Session should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Account does not exist") || s.includes("Could not find")
        );
      }

      // Agent should have received rent back
      const agentBalAfter = getBalance(svm, expiryAgent.publicKey);
      expect(agentBalAfter).to.be.greaterThan(agentBalBefore - 10000); // minus small tx fee

      // Audit log should record success=false
      const tracker = await program.account.spendTracker.fetch(expiryTrackerPda);
      const lastTx = tracker.recentTransactions[tracker.recentTransactions.length - 1];
      expect(lastTx.success).to.equal(false);
    });

    it("permissionless crank: third-party finalizes expired session", async () => {
      // Create a new session
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(5_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();

      // Get session expiry and advance past it
      const sessionData = await program.account.sessionAuthority.fetch(expirySessionPda);
      const expiresAt = sessionData.expiresAtSlot.toNumber();
      advancePastSlot(svm, expiresAt);

      // Third-party (unauthorizedUser) can clean up expired session
      await program.methods
        .finalizeSession(false)
        .accounts({
          payer: unauthorizedUser.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          sessionRentRecipient: expiryAgent.publicKey, // rent still goes to agent
          vaultTokenAccount: null,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([unauthorizedUser])
        .rpc();

      // Session should be closed
      try {
        await program.account.sessionAuthority.fetch(expirySessionPda);
        expect.fail("Session should have been closed");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Account does not exist") || s.includes("Could not find")
        );
      }
    });

    it("non-expired session: rejects non-agent payer", async () => {
      // Create session
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(5_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();

      // Try to finalize immediately (not expired) as non-agent
      try {
        await program.methods
          .finalizeSession(true)
          .accounts({
            payer: unauthorizedUser.publicKey,
            vault: expiryVaultPda,
            policy: expiryPolicyPda,
            tracker: expiryTrackerPda,
            session: expirySessionPda,
            sessionRentRecipient: expiryAgent.publicKey,
            vaultTokenAccount: null,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UnauthorizedAgent");
      }

      // Clean up: finalize with proper agent
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          sessionRentRecipient: expiryAgent.publicKey,
          vaultTokenAccount: expiryVaultUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();
    });

    it("session rent recipient ≠ agent → rejects InvalidSession", async () => {
      // Create session
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(5_000_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();

      // Try to redirect rent to someone else
      try {
        await program.methods
          .finalizeSession(true)
          .accounts({
            payer: expiryAgent.publicKey,
            vault: expiryVaultPda,
            policy: expiryPolicyPda,
            tracker: expiryTrackerPda,
            session: expirySessionPda,
            sessionRentRecipient: unauthorizedUser.publicKey, // wrong recipient
            vaultTokenAccount: null,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([expiryAgent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidSession");
      }

      // Clean up
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: expiryAgent.publicKey,
          vault: expiryVaultPda,
          policy: expiryPolicyPda,
          tracker: expiryTrackerPda,
          session: expirySessionPda,
          sessionRentRecipient: expiryAgent.publicKey,
          vaultTokenAccount: expiryVaultUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([expiryAgent])
        .rpc();
    });
  });

  // =========================================================================
  // Tier 1c: Agent registration security
  // =========================================================================
  describe("agent registration security", () => {
    it("rejects owner as agent → AgentIsOwner", async () => {
      const vid = new BN(50);
      const [v] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), vid.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [p] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), v.toBuffer()],
        program.programId
      );
      const [t] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), v.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(vid, new BN(1000), new BN(1000), [], [], new BN(0) as any, 1, 0)
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
          .registerAgent(owner.publicKey) // owner = agent → reject
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), revokeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [rp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), rv.toBuffer()],
        program.programId
      );
      const [rt] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), rv.toBuffer()],
        program.programId
      );

      // Reactivate so status is Active but with a NEW agent, not our test agent
      const newAgent = Keypair.generate();
      airdropSol(svm, newAgent.publicKey, LAMPORTS_PER_SOL);

      // First reactivate with newAgent
      try {
        // May already be active from earlier test, so freeze first
        await program.methods
          .revokeAgent()
          .accounts({ owner: owner.publicKey, vault: rv } as any)
          .rpc();
      } catch {
        // ignore if already frozen
      }

      await program.methods
        .reactivateVault(newAgent.publicKey)
        .accounts({ owner: owner.publicKey, vault: rv } as any)
        .rpc();

      // Now try to use the ORIGINAL agent (who was revoked)
      const [oldSession] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), rv.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000),
            jupiterProgramId,
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: rv,
            policy: rp,
            tracker: rt,
            session: oldSession,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UnauthorizedAgent");
      }
    });
  });

  // =========================================================================
  // Tier 1d: Vault status transitions
  // =========================================================================
  describe("vault status transitions", () => {
    it("deposit to frozen vault → should succeed (only checks VaultAlreadyClosed)", async () => {
      const frozenVaultId = new BN(60);
      const [fv] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), frozenVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [fp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), fv.toBuffer()],
        program.programId
      );
      const [ft] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), fv.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(frozenVaultId, new BN(1000), new BN(1000), [usdcMint], [], new BN(0) as any, 1, 0)
        .accounts({
          owner: owner.publicKey,
          vault: fv,
          policy: fp,
          tracker: ft,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      // Freeze the vault
      await program.methods
        .revokeAgent()
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), closedVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(closedVaultId, new BN(1000), new BN(1000), [usdcMint], [], new BN(0) as any, 1, 0)
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
        // Vault account no longer exists after close
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("VaultAlreadyClosed") || s.includes("AccountNotInitialized") || s.includes("not found") || s.includes("does not exist") || s.includes("Could not find")
        );
      }
    });

    it("validate_and_authorize on closed vault → rejects", async () => {
      const closedVaultId = new BN(62);
      const [cv] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer(), closedVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [cp] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), cv.toBuffer()],
        program.programId
      );
      const [ct] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), cv.toBuffer()],
        program.programId
      );
      const [cs] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), cv.toBuffer(), agent.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .initializeVault(closedVaultId, new BN(1000), new BN(1000), [usdcMint], [jupiterProgramId], new BN(0) as any, 1, 0)
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
        .registerAgent(agent.publicKey)
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
            null
          )
          .accounts({
            agent: agent.publicKey,
            vault: cv,
            policy: cp,
            tracker: ct,
            session: cs,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([agent])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Vault PDA closed — account not found
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("VaultNotActive") || s.includes("AccountNotInitialized") || s.includes("not found") || s.includes("does not exist") || s.includes("Could not find")
        );
      }
    });
  });

  // =========================================================================
  // Tier 2a: Audit log ring buffer (MAX_RECENT_TRANSACTIONS = 50)
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), ringVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [ringPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), ringVaultPda.toBuffer()],
        program.programId
      );
      [ringTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), ringVaultPda.toBuffer()],
        program.programId
      );

      // Large daily cap to allow many transactions
      await program.methods
        .initializeVault(
          ringVaultId,
          new BN(999_000_000_000), // 999k USDC daily cap
          new BN(100_000_000),     // 100 USDC max tx
          [usdcMint],
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0
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
        .registerAgent(ringAgent.publicKey)
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
        [Buffer.from("session"), ringVaultPda.toBuffer(), ringAgent.publicKey.toBuffer()],
        program.programId
      );

      // Execute 51 authorize+finalize cycles
      for (let i = 0; i < 51; i++) {
        await program.methods
          .validateAndAuthorize(
            { swap: {} },
            usdcMint,
            new BN(1_000_000), // 1 USDC each
            jupiterProgramId,
            null
          )
          .accounts({
            agent: ringAgent.publicKey,
            vault: ringVaultPda,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            session: sessionPda,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([ringAgent])
          .rpc();

        await program.methods
          .finalizeSession(true)
          .accounts({
            payer: ringAgent.publicKey,
            vault: ringVaultPda,
            policy: ringPolicyPda,
            tracker: ringTrackerPda,
            session: sessionPda,
            sessionRentRecipient: ringAgent.publicKey,
            vaultTokenAccount: ringVaultUsdcAta,
            feeDestinationTokenAccount: null,
            protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([ringAgent])
          .rpc();
      }

      const tracker = await program.account.spendTracker.fetch(ringTrackerPda);
      // Ring buffer capped at 50
      expect(tracker.recentTransactions.length).to.equal(50);

      // Newest entry should be the last one we added
      const newest = tracker.recentTransactions[tracker.recentTransactions.length - 1];
      expect(newest.success).to.equal(true);
      expect(newest.amount.toNumber()).to.equal(1_000_000);

      // Vault should show 51 total transactions
      const vault = await program.account.agentVault.fetch(ringVaultPda);
      expect(vault.totalTransactions.toNumber()).to.equal(51);
    });
  });

  // =========================================================================
  // Tier 2b: Fee precision edge cases
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
        [Buffer.from("vault"), owner.publicKey.toBuffer(), feeEdgeVaultId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      [feeEdgePolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("policy"), feeEdgeVaultPda.toBuffer()],
        program.programId
      );
      [feeEdgeTrackerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("tracker"), feeEdgeVaultPda.toBuffer()],
        program.programId
      );

      // developer_fee_rate = 0 to isolate protocol fee
      await program.methods
        .initializeVault(
          feeEdgeVaultId,
          new BN(999_000_000),
          new BN(100_000_000),
          [usdcMint],
          [jupiterProgramId],
          new BN(0) as any,
          3,
          0 // developer_fee_rate = 0
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
        .registerAgent(feeEdgeAgent.publicKey)
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
        [Buffer.from("session"), feeEdgeVaultPda.toBuffer(), feeEdgeAgent.publicKey.toBuffer()],
        program.programId
      );

      // protocol_fee = 1 * 20 / 1_000_000 = 0
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(1), // 1 lamport
          jupiterProgramId,
          null
        )
        .accounts({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);

      // Finalize — no token accounts needed since fees are 0
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          vaultTokenAccount: null,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      // Vault balance unchanged (no fee deducted)
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      expect(Number(vaultBalAfter)).to.equal(Number(vaultBalBefore));
    });

    it("amount = 49999 → fee = 0; amount = 50000 → fee = 1", async () => {
      const [sessionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), feeEdgeVaultPda.toBuffer(), feeEdgeAgent.publicKey.toBuffer()],
        program.programId
      );

      // Test amount = 49999: protocol_fee = 49999 * 20 / 1_000_000 = 0 (integer division)
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(49_999),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      // Finalize with no token accounts (fee=0)
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          vaultTokenAccount: null,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      // Test amount = 50000: protocol_fee = 50000 * 20 / 1_000_000 = 1
      await program.methods
        .validateAndAuthorize(
          { swap: {} },
          usdcMint,
          new BN(50_000),
          jupiterProgramId,
          null
        )
        .accounts({
          agent: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      const vaultBalBefore = getTokenBalance(svm, feeEdgeVaultUsdcAta);

      // Finalize — needs token accounts since fee = 1
      await program.methods
        .finalizeSession(true)
        .accounts({
          payer: feeEdgeAgent.publicKey,
          vault: feeEdgeVaultPda,
          policy: feeEdgePolicyPda,
          tracker: feeEdgeTrackerPda,
          session: sessionPda,
          sessionRentRecipient: feeEdgeAgent.publicKey,
          vaultTokenAccount: feeEdgeVaultUsdcAta,
          feeDestinationTokenAccount: null,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([feeEdgeAgent])
        .rpc();

      // Vault balance should decrease by exactly 1 (protocol fee)
      const vaultBalAfter = getTokenBalance(svm, feeEdgeVaultUsdcAta);
      expect(Number(vaultBalBefore) - Number(vaultBalAfter)).to.equal(1);
    });
  });
});
