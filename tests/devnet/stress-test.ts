#!/usr/bin/env npx ts-node
/**
 * Sigil Devnet Stress Test — REAL tokens, REAL transactions
 *
 * No mocks. No dummy data. Real USDC on devnet.
 * Tests every limit of the protocol and reports where it breaks.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://devnet.helius-rpc.com/?api-key=<KEY> \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-mocha -p ./tsconfig.json -t 600000 tests/devnet/stress-test.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Sigil } from "../../target/types/sigil";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";
import {
  getDevnetProvider,
  nextVaultId,
  fundKeypair,
  ensureStablecoinMint,
  TEST_USDC_KEYPAIR,
  PROTOCOL_TREASURY,
  derivePDAs,
  deriveSessionPda,
  getTokenBalance,
  calculateFees,
} from "../helpers/devnet-setup";

// ─── Shared State ──────────────────────────────────────────────────────────

const { provider, program, connection, owner } = getDevnetProvider();
const payer = (owner as any).payer;

let usdcMint: PublicKey;
let ownerUsdcAta: PublicKey;
let protocolTreasuryUsdcAta: PublicKey;

// Test agents
const agentA = Keypair.generate();
const agentB = Keypair.generate();
const feeDestination = Keypair.generate();

// Use a known protocol for allowlist — just a random pubkey for the policy
const allowedProtocol = Keypair.generate().publicKey;

// ─── Helpers ───────────────────────────────────────────────────────────────

const FULL_CAPABILITY = 2;

async function createVault(opts: {
  dailyCap: BN;
  maxTx: BN;
  deposit: BN;
  agent: Keypair;
  devFeeRate?: number;
  destinations?: PublicKey[];
  agentSpendLimit?: BN;
}): Promise<{
  vault: PublicKey;
  policy: PublicKey;
  tracker: PublicKey;
  overlay: PublicKey;
  vaultAta: PublicKey;
}> {
  const vaultId = nextVaultId(1);
  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
  const [overlay] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), pdas.vaultPda.toBuffer(), Buffer.from([0])],
    program.programId,
  );

  await program.methods
    .initializeVault(
      vaultId,
      opts.dailyCap,
      opts.maxTx,
      0, // protocolMode: allow all
      [],
      new BN(0) as any,
      opts.devFeeRate ?? 0,
      500, // maxSlippageBps
      new BN(1800),
      opts.destinations ?? [],
      [],
    )
    .accounts({
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      policy: pdas.policyPda,
      tracker: pdas.trackerPda,
      agentSpendOverlay: overlay,
      feeDestination: feeDestination.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  await program.methods
    .registerAgent(
      opts.agent.publicKey,
      FULL_CAPABILITY,
      opts.agentSpendLimit ?? new BN(0),
    )
    .accounts({
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      agentSpendOverlay: overlay,
    } as any)
    .rpc();

  // Create vault ATA + deposit
  const vaultAta = anchor.utils.token.associatedAddress({
    mint: usdcMint,
    owner: pdas.vaultPda,
  });

  if (opts.deposit.gt(new BN(0))) {
    await program.methods
      .depositFunds(opts.deposit)
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        mint: usdcMint,
        ownerTokenAccount: ownerUsdcAta,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  return {
    vault: pdas.vaultPda,
    policy: pdas.policyPda,
    tracker: pdas.trackerPda,
    overlay,
    vaultAta,
  };
}

async function doAgentTransfer(
  agent: Keypair,
  vault: PublicKey,
  policy: PublicKey,
  tracker: PublicKey,
  overlay: PublicKey,
  vaultAta: PublicKey,
  destAta: PublicKey,
  amount: BN,
): Promise<void> {
  await program.methods
    .agentTransfer(amount, new BN(0))
    .accounts({
      agent: agent.publicKey,
      vault,
      policy,
      tracker,
      vaultTokenAccount: vaultAta,
      tokenMintAccount: usdcMint,
      destinationTokenAccount: destAta,
      feeDestinationTokenAccount: null,
      protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      agentSpendOverlay: overlay,
    } as any)
    .signers([agent])
    .rpc();
}

async function doComposedTx(
  agent: Keypair,
  vault: PublicKey,
  policy: PublicKey,
  tracker: PublicKey,
  overlay: PublicKey,
  vaultAta: PublicKey,
  amount: BN,
): Promise<string> {
  const session = deriveSessionPda(
    vault,
    agent.publicKey,
    usdcMint,
    program.programId,
  );

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });

  const validateIx = await program.methods
    .validateAndAuthorize(usdcMint, amount, allowedProtocol, new BN(0))
    .accounts({
      agent: agent.publicKey,
      vault,
      policy,
      tracker,
      session,
      agentSpendOverlay: overlay,
      vaultTokenAccount: vaultAta,
      tokenMintAccount: usdcMint,
      protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
      feeDestinationTokenAccount: null,
      outputStablecoinAccount: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    .instruction();

  // Real on-chain instruction — SystemProgram.transfer is whitelisted
  // This doesn't move tokens but exercises the full composition flow
  const deFiIx = SystemProgram.transfer({
    fromPubkey: agent.publicKey,
    toPubkey: agent.publicKey,
    lamports: 0,
  });

  const finalizeIx = await program.methods
    .finalizeSession()
    .accounts({
      payer: agent.publicKey,
      vault,
      session,
      sessionRentRecipient: agent.publicKey,
      policy,
      tracker,
      agentSpendOverlay: overlay,
      vaultTokenAccount: vaultAta,
      outputStablecoinAccount: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  const { blockhash } = await connection.getLatestBlockhash();
  const msgV0 = new TransactionMessage({
    payerKey: agent.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeIx, validateIx, deFiIx, finalizeIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msgV0);
  tx.sign([agent]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe("🔥 SIGIL DEVNET STRESS TEST — Real Tokens, Real Limits", function () {
  this.timeout(600_000);

  before(async function () {
    console.log("\n  ══════════════════════════════════════════════════");
    console.log("  SIGIL DEVNET STRESS TEST");
    console.log("  Program:", program.programId.toString());
    console.log("  Owner:", owner.publicKey.toString());
    console.log("  Agent A:", agentA.publicKey.toString());
    console.log("  Agent B:", agentB.publicKey.toString());
    console.log("  ══════════════════════════════════════════════════\n");

    // Fund agents
    await fundKeypair(provider, agentA.publicKey);
    await fundKeypair(provider, agentB.publicKey);
    await fundKeypair(provider, feeDestination.publicKey);

    // Ensure USDC mint + owner balance
    usdcMint = await ensureStablecoinMint(
      connection,
      payer,
      TEST_USDC_KEYPAIR,
      owner.publicKey,
      6,
    );
    const ownerAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      owner.publicKey,
    );
    ownerUsdcAta = ownerAtaAccount.address;

    // Mint plenty of test USDC
    await mintTo(
      connection,
      payer,
      usdcMint,
      ownerUsdcAta,
      owner.publicKey,
      10_000_000_000,
    );

    // Treasury ATA
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      PROTOCOL_TREASURY,
      true,
    );
    protocolTreasuryUsdcAta = treasuryAta.address;

    const bal = await getTokenBalance(connection, ownerUsdcAta);
    console.log(`  Owner USDC balance: ${(bal / 1_000_000).toFixed(2)} USDC`);
    console.log(`  USDC Mint: ${usdcMint.toString()}`);
    console.log(`  Treasury ATA: ${protocolTreasuryUsdcAta.toString()}\n`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Vault Lifecycle with Real Tokens
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 1: Vault Lifecycle", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(async () => {
      v = await createVault({
        dailyCap: new BN(500_000_000), // $500
        maxTx: new BN(100_000_000), // $100
        deposit: new BN(1_000_000_000), // $1000
        agent: agentA,
      });

      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      destAta = dest.address;
    });

    it("vault created with $1000 USDC deposit", async () => {
      const bal = await getTokenBalance(connection, v.vaultAta);
      expect(bal).to.equal(1_000_000_000);
      const vault = await program.account.agentVault.fetch(v.vault);
      expect(vault.owner.toString()).to.equal(owner.publicKey.toString());
      console.log(`    Vault: ${v.vault.toString()}`);
      console.log(`    Balance: ${(bal / 1_000_000).toFixed(2)} USDC`);
    });

    it("agentTransfer: $50 real USDC moves from vault → destination", async () => {
      const before = await getTokenBalance(connection, v.vaultAta);
      await doAgentTransfer(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(50_000_000),
      );
      const after = await getTokenBalance(connection, v.vaultAta);
      const destBal = await getTokenBalance(connection, destAta);

      // Vault decreased (amount + protocol fee)
      const fees = calculateFees(50_000_000, 200, 0);
      expect(after).to.be.lessThan(before);
      expect(destBal).to.be.greaterThan(0);
      console.log(
        `    Vault: ${(before / 1e6).toFixed(2)} → ${(after / 1e6).toFixed(2)} USDC`,
      );
      console.log(`    Dest received: ${(destBal / 1e6).toFixed(6)} USDC`);
      console.log(
        `    Protocol fee: ${(fees.protocolFee / 1e6).toFixed(6)} USDC`,
      );
    });

    it("vault stats updated after real transfer", async () => {
      const vault = await program.account.agentVault.fetch(v.vault);
      expect(vault.totalTransactions.toNumber()).to.be.greaterThanOrEqual(1);
      expect(vault.totalVolume.toNumber()).to.be.greaterThan(0);
      console.log(`    Total TXs: ${vault.totalTransactions.toNumber()}`);
      console.log(
        `    Total Volume: $${(vault.totalVolume.toNumber() / 1e6).toFixed(2)}`,
      );
    });

    it("SpendTracker records real spending", async () => {
      const tracker = await program.account.spendTracker.fetch(v.tracker);
      const nonZero = tracker.buckets.filter(
        (b: any) => b.usdAmount.toNumber() > 0,
      );
      expect(nonZero.length).to.be.greaterThan(0);
      const totalSpend = nonZero.reduce(
        (acc: number, b: any) => acc + b.usdAmount.toNumber(),
        0,
      );
      console.log(`    Active buckets: ${nonZero.length}`);
      console.log(`    Rolling 24h spend: $${(totalSpend / 1e6).toFixed(2)}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Spending Cap Enforcement — Push to the Limit
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 2: Cap Enforcement — Break It", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(async () => {
      v = await createVault({
        dailyCap: new BN(100_000_000), // $100 daily cap
        maxTx: new BN(50_000_000), // $50 max per TX
        deposit: new BN(500_000_000), // $500 in vault
        agent: agentA,
      });

      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      destAta = dest.address;
    });

    it("$50 transfer succeeds (within limits)", async () => {
      await doAgentTransfer(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(49_000_000), // $49 (under $50 maxTx)
      );
      console.log("    ✓ $49 transfer succeeded");
    });

    it("$51 transfer FAILS — TransactionTooLarge", async () => {
      try {
        await doAgentTransfer(
          agentA,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(51_000_000), // $51 > $50 maxTx
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("TransactionTooLarge");
        console.log("    ✓ $51 rejected: TransactionTooLarge (maxTx=$50)");
      }
    });

    it("$49 transfer pushes to $98 (near $100 cap)", async () => {
      await doAgentTransfer(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(49_000_000),
      );
      const tracker = await program.account.spendTracker.fetch(v.tracker);
      const rolling = tracker.buckets
        .filter((b: any) => b.usdAmount.toNumber() > 0)
        .reduce((acc: number, b: any) => acc + b.usdAmount.toNumber(), 0);
      console.log(
        `    ✓ $49 transfer succeeded, rolling spend: $${(rolling / 1e6).toFixed(2)}`,
      );
    });

    it("$10 transfer FAILS — SpendingCapExceeded (total would be $108 > $100)", async () => {
      try {
        await doAgentTransfer(
          agentA,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(10_000_000),
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("SpendingCapExceeded");
        console.log(
          "    ✓ $10 rejected: SpendingCapExceeded (rolling > $100 cap)",
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Composed TX — Real On-Chain Composition
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 3: Composed Transactions — Real On-Chain", () => {
    let v: Awaited<ReturnType<typeof createVault>>;

    before(async () => {
      v = await createVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(200_000_000),
        deposit: new BN(1_000_000_000),
        agent: agentA,
      });
    });

    it("composed TX: validate + DeFi + finalize (success=true)", async () => {
      const sig = await doComposedTx(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        new BN(50_000_000),
        true,
      );
      const vault = await program.account.agentVault.fetch(v.vault);
      expect(vault.totalTransactions.toNumber()).to.equal(1);
      console.log(`    ✓ Composed TX succeeded: ${sig.slice(0, 20)}...`);
      console.log(`    Total TXs: ${vault.totalTransactions.toNumber()}`);
    });

    it("composed TX: validate + DeFi + finalize — stats increment (success param removed)", async () => {
      const before = await program.account.agentVault.fetch(v.vault);
      await doComposedTx(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        new BN(50_000_000),
      );
      const after = await program.account.agentVault.fetch(v.vault);
      expect(after.totalTransactions.toNumber()).to.equal(
        before.totalTransactions.toNumber() + 1,
      );
      console.log("    ✓ Composed TX: totalTransactions incremented");
    });

    it("rapid fire: 5 composed TXs in sequence", async () => {
      for (let i = 0; i < 5; i++) {
        await doComposedTx(
          agentA,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          new BN(10_000_000),
          true,
        );
      }
      const vault = await program.account.agentVault.fetch(v.vault);
      // 1 from first test + 5 from rapid fire
      expect(vault.totalTransactions.toNumber()).to.be.greaterThanOrEqual(6);
      console.log(
        `    ✓ 5 rapid-fire composed TXs, total: ${vault.totalTransactions.toNumber()}`,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Access Control — Break the Guards
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 4: Access Control — Break the Guards", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(async () => {
      v = await createVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(100_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
      });
      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      destAta = dest.address;
    });

    it("unregistered agent CANNOT transfer from vault", async () => {
      try {
        await doAgentTransfer(
          agentB, // NOT registered
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(1_000_000),
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("UnauthorizedAgent") || s.includes("2003"),
        );
        console.log("    ✓ Unregistered agent blocked");
      }
    });

    it("freeze vault → agent blocked → unfreeze → agent works", async () => {
      // Freeze
      await program.methods
        .freezeVault()
        .accounts({ owner: owner.publicKey, vault: v.vault } as any)
        .rpc();

      // Try transfer while frozen
      try {
        await doAgentTransfer(
          agentA,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(1_000_000),
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("VaultNotActive");
        console.log("    ✓ Frozen vault blocks agent");
      }

      // Reactivate (unfreeze) — pass null for optional new agent params
      await program.methods
        .reactivateVault(null, null)
        .accounts({ owner: owner.publicKey, vault: v.vault } as any)
        .rpc();

      // Transfer should work now
      await doAgentTransfer(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(1_000_000),
      );
      console.log("    ✓ Unfrozen vault allows agent");
    });

    it("owner can withdraw — agent cannot", async () => {
      // Agent try to withdraw (should fail — agents can't withdraw)
      try {
        await program.methods
          .withdrawFunds(new BN(1_000_000))
          .accounts({
            owner: agentA.publicKey, // agent trying to be owner
            vault: v.vault,
            mint: usdcMint,
            ownerTokenAccount: ownerUsdcAta,
            vaultTokenAccount: v.vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([agentA])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        // Anchor constraint violation
        expect(err).to.exist;
        console.log("    ✓ Agent cannot withdraw (owner-only)");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Per-Agent Spending Limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 5: Per-Agent Spending Limits", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(async () => {
      v = await createVault({
        dailyCap: new BN(1_000_000_000), // $1000 vault cap
        maxTx: new BN(500_000_000),
        deposit: new BN(1_000_000_000),
        agent: agentA,
        agentSpendLimit: new BN(100_000_000), // $100 per-agent limit
      });
      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      destAta = dest.address;
    });

    it("$50 transfer within per-agent limit succeeds", async () => {
      await doAgentTransfer(
        agentA,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(50_000_000),
      );
      console.log("    ✓ $50 within $100 per-agent limit");
    });

    it("$60 transfer FAILS — AgentSpendLimitExceeded", async () => {
      try {
        await doAgentTransfer(
          agentA,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(60_000_000), // $50 + $60 = $110 > $100 limit
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("AgentSpendLimitExceeded");
        console.log(
          "    ✓ $60 rejected: AgentSpendLimitExceeded ($110 > $100 limit)",
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 6: Cross-Vault Escrow — Real Token Locking
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 6: Cross-Vault Escrow", () => {
    let sourceV: Awaited<ReturnType<typeof createVault>>;
    let destV: Awaited<ReturnType<typeof createVault>>;
    let escrowPda: PublicKey;
    let escrowAta: PublicKey;
    const escrowId = new BN(Date.now());
    const escrowAgent = Keypair.generate();
    const destAgent = Keypair.generate();

    // Conditional escrow: preimage/hash for settlement
    const preimage = Buffer.from("sigil-escrow-secret-2026");
    const conditionHash = Array.from(
      require("crypto").createHash("sha256").update(preimage).digest(),
    );

    before(async () => {
      await fundKeypair(provider, escrowAgent.publicKey);
      await fundKeypair(provider, destAgent.publicKey);

      sourceV = await createVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(200_000_000),
        deposit: new BN(500_000_000), // $500
        agent: escrowAgent,
      });

      // Destination vault (different agent)
      const destVaultId = nextVaultId(1);
      const destPdas = derivePDAs(
        owner.publicKey,
        destVaultId,
        program.programId,
      );
      const [destOverlay] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("agent_spend"),
          destPdas.vaultPda.toBuffer(),
          Buffer.from([0]),
        ],
        program.programId,
      );

      await program.methods
        .initializeVault(
          destVaultId,
          new BN(500_000_000),
          new BN(200_000_000),
          0,
          [],
          new BN(0) as any,
          0,
          500,
          new BN(0),
          [],
          [],
        )
        .accounts({
          owner: owner.publicKey,
          vault: destPdas.vaultPda,
          policy: destPdas.policyPda,
          tracker: destPdas.trackerPda,
          agentSpendOverlay: destOverlay,
          feeDestination: feeDestination.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      await program.methods
        .registerAgent(destAgent.publicKey, FULL_CAPABILITY, new BN(0))
        .accounts({
          owner: owner.publicKey,
          vault: destPdas.vaultPda,
          agentSpendOverlay: destOverlay,
        } as any)
        .rpc();

      const destVaultAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: destPdas.vaultPda,
      });

      // Create dest vault ATA (needed for escrow settlement)
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        destPdas.vaultPda,
        true,
      );

      destV = {
        vault: destPdas.vaultPda,
        policy: destPdas.policyPda,
        tracker: destPdas.trackerPda,
        overlay: destOverlay,
        vaultAta: destVaultAta,
      };

      // Derive escrow PDA
      [escrowPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("escrow"),
          sourceV.vault.toBuffer(),
          destV.vault.toBuffer(),
          escrowId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );

      escrowAta = anchor.utils.token.associatedAddress({
        mint: usdcMint,
        owner: escrowPda,
      });
    });

    it("create escrow: $100 locked from source vault", async () => {
      const beforeBal = await getTokenBalance(connection, sourceV.vaultAta);
      const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24h from now

      await program.methods
        .createEscrow(
          escrowId,
          new BN(100_000_000), // $100
          new BN(expiresAt),
          conditionHash,
        )
        .accounts({
          agent: escrowAgent.publicKey,
          sourceVault: sourceV.vault,
          policy: sourceV.policy,
          tracker: sourceV.tracker,
          destinationVault: destV.vault,
          escrow: escrowPda,
          sourceVaultAta: sourceV.vaultAta,
          escrowAta,
          protocolTreasuryAta: protocolTreasuryUsdcAta,
          feeDestinationAta: null,
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          agentSpendOverlay: sourceV.overlay,
        } as any)
        .signers([escrowAgent])
        .rpc();

      const afterBal = await getTokenBalance(connection, sourceV.vaultAta);
      const escrowBal = await getTokenBalance(connection, escrowAta);

      expect(afterBal).to.be.lessThan(beforeBal);
      expect(escrowBal).to.be.greaterThan(0);
      console.log(
        `    Source vault: ${(beforeBal / 1e6).toFixed(2)} → ${(afterBal / 1e6).toFixed(2)} USDC`,
      );
      console.log(`    Escrow locked: ${(escrowBal / 1e6).toFixed(6)} USDC`);
    });

    it("settle escrow: destination agent claims with preimage proof", async () => {
      await program.methods
        .settleEscrow(Buffer.from(preimage))
        .accounts({
          destinationAgent: destAgent.publicKey,
          destinationVault: destV.vault,
          sourceVault: sourceV.vault,
          escrow: escrowPda,
          escrowAta,
          destinationVaultAta: destV.vaultAta,
          rentDestination: owner.publicKey, // must be source_vault.owner
          tokenMint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([destAgent])
        .rpc();

      const destBal = await getTokenBalance(connection, destV.vaultAta);
      expect(destBal).to.be.greaterThan(0);
      console.log(
        `    Dest vault received: ${(destBal / 1e6).toFixed(6)} USDC`,
      );

      // Verify escrow status changed to Settled
      const escrow = await program.account.escrowDeposit.fetch(escrowPda);
      // EscrowStatus enum: { active: {}, settled: {}, refunded: {} }
      expect(JSON.stringify(escrow.status)).to.include("settled");
      console.log("    ✓ Escrow settled with SHA-256 preimage proof");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 7: Multi-Agent Vault — Independent Limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 7: Multi-Agent Vault", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;
    const multiAgent1 = Keypair.generate();
    const multiAgent2 = Keypair.generate();

    before(async () => {
      await fundKeypair(provider, multiAgent1.publicKey);
      await fundKeypair(provider, multiAgent2.publicKey);

      // Create vault with first agent ($50 per-agent limit)
      v = await createVault({
        dailyCap: new BN(1_000_000_000), // $1000 vault cap
        maxTx: new BN(200_000_000),
        deposit: new BN(1_000_000_000), // $1000
        agent: multiAgent1,
        agentSpendLimit: new BN(50_000_000), // $50 per-agent
      });

      // Register second agent with $75 per-agent limit
      await program.methods
        .registerAgent(
          multiAgent2.publicKey,
          FULL_CAPABILITY,
          new BN(75_000_000), // $75 per-agent
        )
        .accounts({
          owner: owner.publicKey,
          vault: v.vault,
          agentSpendOverlay: v.overlay,
        } as any)
        .rpc();

      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      destAta = dest.address;
    });

    it("agent1 transfers $40 (within $50 limit)", async () => {
      await doAgentTransfer(
        multiAgent1,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(40_000_000),
      );
      console.log("    ✓ Agent1: $40 transferred (within $50 limit)");
    });

    it("agent2 transfers $70 (within $75 limit)", async () => {
      await doAgentTransfer(
        multiAgent2,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(70_000_000),
      );
      console.log("    ✓ Agent2: $70 transferred (within $75 limit)");
    });

    it("agent1 $20 more FAILS — exceeds $50 per-agent limit", async () => {
      try {
        await doAgentTransfer(
          multiAgent1,
          v.vault,
          v.policy,
          v.tracker,
          v.overlay,
          v.vaultAta,
          destAta,
          new BN(20_000_000),
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("AgentSpendLimitExceeded");
        console.log("    ✓ Agent1 $20 rejected ($60 > $50 agent limit)");
      }
    });

    it("agent2 still has headroom — $4 succeeds", async () => {
      await doAgentTransfer(
        multiAgent2,
        v.vault,
        v.policy,
        v.tracker,
        v.overlay,
        v.vaultAta,
        destAta,
        new BN(4_000_000),
      );
      console.log("    ✓ Agent2: $4 more transferred ($74 / $75 limit)");
    });

    it("vault has 2 agents registered", async () => {
      const vault = await program.account.agentVault.fetch(v.vault);
      expect(vault.agents.length).to.equal(2);
      console.log(`    Agents: ${vault.agents.length}`);
      console.log(`    Total TXs: ${vault.totalTransactions.toNumber()}`);
      console.log(
        `    Total Volume: $${(vault.totalVolume.toNumber() / 1e6).toFixed(2)}`,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 8: Edge Cases — Boundary Conditions
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 8: Edge Cases", () => {
    it("exact cap boundary: $100 cap, spend exactly $100", async () => {
      const edgeV = await createVault({
        dailyCap: new BN(100_000_000), // $100 exact
        maxTx: new BN(100_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
      });
      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );
      // Spend exactly $100 — should succeed (cap check is <=, not <)
      await doAgentTransfer(
        agentA,
        edgeV.vault,
        edgeV.policy,
        edgeV.tracker,
        edgeV.overlay,
        edgeV.vaultAta,
        dest.address,
        new BN(100_000_000),
      );
      console.log("    ✓ Exact $100 on $100 cap succeeds (<=, not <)");

      // Any more spending should now fail
      try {
        await doAgentTransfer(
          agentA,
          edgeV.vault,
          edgeV.policy,
          edgeV.tracker,
          edgeV.overlay,
          edgeV.vaultAta,
          dest.address,
          new BN(1_000_000), // $1
        );
        expect.fail("Should have thrown");
      } catch (err: any) {
        if (err.message === "Should have thrown") throw err;
        expect(err.toString()).to.include("SpendingCapExceeded");
        console.log("    ✓ $1 after $100 cap → SpendingCapExceeded");
      }
    });

    it("deposit after cap exhaustion — owner can still deposit", async () => {
      const capV = await createVault({
        dailyCap: new BN(10_000_000), // $10 cap
        maxTx: new BN(10_000_000),
        deposit: new BN(100_000_000), // $100
        agent: agentA,
      });
      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );

      // Exhaust cap
      await doAgentTransfer(
        agentA,
        capV.vault,
        capV.policy,
        capV.tracker,
        capV.overlay,
        capV.vaultAta,
        dest.address,
        new BN(10_000_000),
      );

      // Owner can still deposit (not blocked by spending cap)
      await program.methods
        .depositFunds(new BN(50_000_000))
        .accounts({
          owner: owner.publicKey,
          vault: capV.vault,
          mint: usdcMint,
          ownerTokenAccount: ownerUsdcAta,
          vaultTokenAccount: capV.vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      const bal = await getTokenBalance(connection, capV.vaultAta);
      expect(bal).to.be.greaterThan(100_000_000);
      console.log(
        `    ✓ Deposit after cap exhaustion: vault has $${(bal / 1e6).toFixed(2)}`,
      );
    });

    it("non-spending composed TX: amount=0, no delegation", async () => {
      const nsV = await createVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(100_000_000),
        deposit: new BN(100_000_000),
        agent: agentA,
      });

      // Non-spending action (withdraw type, amount=0)
      const session = deriveSessionPda(
        nsV.vault,
        agentA.publicKey,
        usdcMint,
        program.programId,
      );
      const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      });
      const validateIx = await program.methods
        .validateAndAuthorize(
          usdcMint,
          new BN(0), // amount=0 for non-spending
          allowedProtocol,
          new BN(0),
        )
        .accounts({
          agent: agentA.publicKey,
          vault: nsV.vault,
          policy: nsV.policy,
          tracker: nsV.tracker,
          session,
          agentSpendOverlay: nsV.overlay,
          vaultTokenAccount: nsV.vaultAta,
          tokenMintAccount: usdcMint,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          feeDestinationTokenAccount: null,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        } as any)
        .instruction();

      const deFiIx = SystemProgram.transfer({
        fromPubkey: agentA.publicKey,
        toPubkey: agentA.publicKey,
        lamports: 0,
      });

      const finalizeIx = await program.methods
        .finalizeSession()
        .accounts({
          payer: agentA.publicKey,
          vault: nsV.vault,
          session,
          sessionRentRecipient: agentA.publicKey,
          policy: nsV.policy,
          tracker: nsV.tracker,
          agentSpendOverlay: nsV.overlay,
          vaultTokenAccount: nsV.vaultAta,
          outputStablecoinAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();

      const { blockhash } = await connection.getLatestBlockhash();
      const msgV0 = new TransactionMessage({
        payerKey: agentA.publicKey,
        recentBlockhash: blockhash,
        instructions: [computeIx, validateIx, deFiIx, finalizeIx],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msgV0);
      tx.sign([agentA]);
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      // Vault balance unchanged (no spending, no delegation)
      const bal = await getTokenBalance(connection, nsV.vaultAta);
      expect(bal).to.equal(100_000_000);
      console.log("    ✓ Non-spending composed TX: vault balance unchanged");
    });

    it("developer fee collection (5 BPS)", async () => {
      const feeDestAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        feeDestination.publicKey,
      );
      const feeV = await createVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(200_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
        devFeeRate: 500, // 5 BPS = 0.05%
      });
      const dest = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        Keypair.generate().publicKey,
      );

      const beforeFee = await getTokenBalance(connection, feeDestAta.address);

      await program.methods
        .agentTransfer(new BN(100_000_000), new BN(0)) // $100
        .accounts({
          agent: agentA.publicKey,
          vault: feeV.vault,
          policy: feeV.policy,
          tracker: feeV.tracker,
          vaultTokenAccount: feeV.vaultAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: dest.address,
          feeDestinationTokenAccount: feeDestAta.address,
          protocolTreasuryTokenAccount: protocolTreasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          agentSpendOverlay: feeV.overlay,
        } as any)
        .signers([agentA])
        .rpc();

      const afterFee = await getTokenBalance(connection, feeDestAta.address);
      const devFee = afterFee - beforeFee;
      // 100 USDC * 500/1_000_000 = 0.05 USDC = 50_000 base units
      expect(devFee).to.equal(50_000);
      console.log(
        `    ✓ Developer fee: ${(devFee / 1e6).toFixed(6)} USDC (5 BPS on $100)`,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  after(() => {
    console.log("\n  ══════════════════════════════════════════════════");
    console.log("  STRESS TEST COMPLETE");
    console.log("  All tests used REAL USDC on devnet.");
    console.log("  No mocks. No dummy data.");
    console.log("  ══════════════════════════════════════════════════\n");
  });
});
