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
  deriveSessionPda,
  getTokenBalance,
  calculateFees,
  createFullVault,
  queueOperatorGrant,
  applyOperatorGrants,
  type OperatorGrantHandle,
  MOCK_DEFI_PROGRAM_ID,
  buildMockDefiNoopIx,
} from "../helpers/devnet-setup";
import {
  buildExpectedIntentDigest,
  digestAsArgs,
} from "../helpers/intent-digest-fixture";

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
// Phase 7 multi-agent pair (module scope: their grants are queued/applied by
// the top-level before alongside every other vault's).
const multiAgent1 = Keypair.generate();
const multiAgent2 = Keypair.generate();

// V2: the protocol allowlist gate applies to ALL actions
// (validate_and_authorize.rs "Protocol must be allowed — ALL actions") and a
// spending sandwich must carry EXACTLY ONE counted, EXECUTABLE DeFi
// instruction whose program_id == target_protocol (F-Q2). A random pubkey
// can't execute, so every composed-TX path targets the deployed mock-defi
// fixture program and uses its `open_position` no-op as the counted leg.

// ─── Helpers ───────────────────────────────────────────────────────────────

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
  /**
   * F-Q6: the agent's OPERATOR grant is QUEUED here, not applied — a
   * single-key vault can never seat a spending grant instantly (6107). The
   * top-level before() batches every handle into ONE applyOperatorGrants()
   * call (a single ~600s cluster-clock wait for the whole file).
   */
  operatorGrant: OperatorGrantHandle;
}> {
  // createFullVault routes the init through sendInitVault's processed+offset
  // slot-bind retry (initialize_vault recomputes the owner-signed TA-19 digest
  // with the EXACT slot it executes in — a digest built without a live slot
  // always reverts with PolicyPreviewMismatch 6071), and uses ALLOWLIST mode:
  // V2 deleted protocolMode 0 (initialize_vault.rs requires mode == 1) and
  // F-11 requires an active vault to allowlist at least one protocol or
  // destination. skipAgent: the grant is queued separately below so the
  // per-agent spend limit (Phase 5/7) can be forwarded.
  const r = await createFullVault({
    program,
    connection,
    owner,
    agent: opts.agent,
    feeDestination: feeDestination.publicKey,
    mint: usdcMint,
    vaultId: nextVaultId(1),
    dailyCap: opts.dailyCap,
    maxTx: opts.maxTx,
    allowedProtocols: [MOCK_DEFI_PROGRAM_ID],
    allowedDestinations: opts.destinations ?? [],
    devFeeRate: opts.devFeeRate ?? 0,
    depositAmount: opts.deposit,
    skipDeposit: opts.deposit.lte(new BN(0)),
    skipAgent: true,
  });

  const operatorGrant = await queueOperatorGrant(
    program,
    connection,
    owner,
    r.vaultPda,
    opts.agent.publicKey,
    2, // CAPABILITY_OPERATOR — spending tests need a seated operator
    opts.agentSpendLimit ?? new BN(0),
  );

  return {
    vault: r.vaultPda,
    policy: r.policyPda,
    tracker: r.trackerPda,
    overlay: r.overlayPda,
    vaultAta: r.vaultTokenAta,
    operatorGrant,
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
    .agentTransfer(
      amount,
      // Live read: agent_transfer pins expected_policy_version exactly like
      // validate (agent_transfer.rs:95) and the operator-grant apply bumped
      // the version — a hardcoded 0 always trips PolicyVersionMismatch (6052).
      ((await program.account.policyConfig.fetch(policy))
        .policyVersion as BN) ?? new BN(0),
    )
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
    .validateAndAuthorize(
      usdcMint,
      amount,
      MOCK_DEFI_PROGRAM_ID,
      // Live read: queue→apply of the operator grant bumps policy_version, so
      // a hardcoded 0 always trips PolicyVersionMismatch (6052).
      ((await program.account.policyConfig.fetch(policy))
        .policyVersion as BN) ?? new BN(0),
      new BN(0), // AC-10 expectedNonce (each sandwich opens a FRESH session)
      digestAsArgs(
        buildExpectedIntentDigest({
          vault,
          agent: agent.publicKey,
          tokenMint: usdcMint,
          amount,
          targetProtocol: MOCK_DEFI_PROGRAM_ID,
        }),
      ),
    )
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
      outputSwapAccount: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    } as any)
    // F-Q1a completeness: the mock-defi no-op lists the agent signer — the
    // writable fee payer in the compiled message — so validate's destination
    // walk requires it resolvable in remaining_accounts (mirrors sigil.ts).
    .remainingAccounts([
      { pubkey: agent.publicKey, isSigner: false, isWritable: false },
    ])
    .instruction();

  // F-Q2: a spending sandwich must carry EXACTLY ONE counted DeFi instruction
  // whose program_id == target_protocol. SystemProgram is classified as
  // infrastructure (count 0 → TooManyDeFiInstructions), so the counted leg is
  // the deployed mock-defi fixture's `open_position` no-op — executable,
  // counted, and zero token movement (finalize measures actual_spend from the
  // vault balance delta, so the charge is the protocol fee only).
  const deFiIx = buildMockDefiNoopIx(agent.publicKey);

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
      outputSwapAccount: null,
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

// Per-phase pre-created vault (see the top-level before): the base vault plus
// a pre-allowlisted destination — V2's TA-02 enforces the destination
// allowlist on agent_transfer, so each phase's transfer destination is baked
// into its vault's policy at init (init-time destinations are NOT graylisted).
type StressVault = Awaited<ReturnType<typeof createVault>> & {
  destOwner: PublicKey;
  destAta: PublicKey;
};

describe("🔥 SIGIL DEVNET STRESS TEST — Real Tokens, Real Limits", function () {
  // 30 min ceiling: the top-level before() creates EVERY phase's vault
  // up-front (init slot-bind retries + deposits), queues all F-Q6 operator
  // grants, and pays ONE batched ~600s cluster-clock wait — plus Phase 4's
  // real 301s reactivate cooldown and Phase 7's amortized second grant.
  this.timeout(1_800_000);

  let vaults: Record<
    | "p1"
    | "p2"
    | "p3"
    | "p4"
    | "p5"
    | "p7"
    | "p8edge"
    | "p8cap"
    | "p8ns"
    | "p8fee",
    StressVault
  >;
  // Phase 7's SECOND grant on the same vault: a vault has ONE pending-grant
  // slot, so multiAgent2's grant can only be queued after the batch applies.
  let p7Agent2Grant: OperatorGrantHandle;

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
    await fundKeypair(provider, multiAgent1.publicKey);
    await fundKeypair(provider, multiAgent2.publicKey);

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

    // Pre-create EVERY phase's vault and QUEUE its operator grant, then pay
    // ONE batched F-Q6 wait for the whole file (the established per-file
    // batching pattern — see devnet-spending.ts). Each vault also gets a
    // pre-allowlisted transfer destination (TA-02).
    const buildVault = async (cfg: {
      dailyCap: BN;
      maxTx: BN;
      deposit: BN;
      agent: Keypair;
      devFeeRate?: number;
      agentSpendLimit?: BN;
    }): Promise<StressVault> => {
      const destOwner = Keypair.generate().publicKey;
      const destAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          usdcMint,
          destOwner,
        )
      ).address;
      const v = await createVault({ ...cfg, destinations: [destOwner] });
      return { ...v, destOwner, destAta };
    };

    vaults = {
      p1: await buildVault({
        dailyCap: new BN(500_000_000), // $500
        maxTx: new BN(100_000_000), // $100
        deposit: new BN(1_000_000_000), // $1000
        agent: agentA,
      }),
      p2: await buildVault({
        dailyCap: new BN(100_000_000), // $100 daily cap
        maxTx: new BN(50_000_000), // $50 max per TX
        deposit: new BN(500_000_000), // $500 in vault
        agent: agentA,
      }),
      p3: await buildVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(200_000_000),
        deposit: new BN(1_000_000_000),
        agent: agentA,
      }),
      p4: await buildVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(100_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
      }),
      p5: await buildVault({
        dailyCap: new BN(1_000_000_000), // $1000 vault cap
        maxTx: new BN(500_000_000),
        deposit: new BN(1_000_000_000),
        agent: agentA,
        agentSpendLimit: new BN(100_000_000), // $100 per-agent limit
      }),
      p7: await buildVault({
        dailyCap: new BN(1_000_000_000), // $1000 vault cap
        maxTx: new BN(200_000_000),
        deposit: new BN(1_000_000_000), // $1000
        agent: multiAgent1,
        agentSpendLimit: new BN(50_000_000), // $50 per-agent
      }),
      p8edge: await buildVault({
        dailyCap: new BN(100_000_000), // $100 exact
        maxTx: new BN(100_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
      }),
      p8cap: await buildVault({
        dailyCap: new BN(10_000_000), // $10 cap
        maxTx: new BN(10_000_000),
        deposit: new BN(100_000_000), // $100
        agent: agentA,
      }),
      p8ns: await buildVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(100_000_000),
        deposit: new BN(100_000_000),
        agent: agentA,
      }),
      p8fee: await buildVault({
        dailyCap: new BN(500_000_000),
        maxTx: new BN(200_000_000),
        deposit: new BN(500_000_000),
        agent: agentA,
        devFeeRate: 500, // 5 BPS = 0.05%
      }),
    };

    await applyOperatorGrants(
      program,
      connection,
      owner,
      Object.values(vaults).map((v) => v.operatorGrant),
    );
    console.log(
      `  ${Object.keys(vaults).length} vaults created, operators seated\n`,
    );

    // Phase 7's SECOND agent: queued immediately after the batch applies (one
    // pending-grant slot per vault). Its 600s floor amortizes behind Phases
    // 1-5 — incl. Phase 4's real 301s reactivate cooldown — so Phase 7's
    // before() waits only the remainder.
    p7Agent2Grant = await queueOperatorGrant(
      program,
      connection,
      owner,
      vaults.p7.vault,
      multiAgent2.publicKey,
      2, // CAPABILITY_OPERATOR
      new BN(75_000_000), // $75 per-agent
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Vault Lifecycle with Real Tokens
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 1: Vault Lifecycle", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(() => {
      // Pre-created (and operator-seated) by the top-level before().
      v = vaults.p1;
      destAta = vaults.p1.destAta;
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
      // calculateFees(amount, devFeeRate) — protocol fee rate is now the
      // internal PROTOCOL_FEE_RATE (200) constant, not a parameter.
      const fees = calculateFees(50_000_000, 0);
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

    before(() => {
      v = vaults.p2;
      destAta = vaults.p2.destAta;
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

    before(() => {
      v = vaults.p3;
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

    before(() => {
      v = vaults.p4;
      destAta = vaults.p4.destAta;
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

      // Phase 8 Batch 5: devnet uses wall-clock — wait past 5-min reactivate
      // cooldown (ErrReactivateCooldownActive 6097). Devnet stress test runs
      // ad-hoc, not in CI; 5-min wall-clock wait is acceptable here. No clock
      // mocking available on devnet validator.
      console.log(
        "    ⏳ Waiting 301s for reactivate cooldown (devnet wall-clock)...",
      );
      await new Promise((r) => setTimeout(r, 301_000));

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

    before(() => {
      v = vaults.p5;
      destAta = vaults.p5.destAta;
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
  // PHASE 7: Multi-Agent Vault — Independent Limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 7: Multi-Agent Vault", () => {
    let v: Awaited<ReturnType<typeof createVault>>;
    let destAta: PublicKey;

    before(async function () {
      // Vault + multiAgent1's grant were pre-created/seated by the top-level
      // before(). multiAgent2's grant (a vault has ONE pending-grant slot, so
      // it was queued right after the batch applied) has been aging through
      // Phases 1-5 — apply it now, waiting only the remainder of its 600s
      // F-Q6 floor.
      v = vaults.p7;
      destAta = vaults.p7.destAta;
      await applyOperatorGrants(program, connection, owner, [p7Agent2Grant]);
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
      // Pre-created (and operator-seated) by the top-level before().
      const edgeV = vaults.p8edge;
      // Spend exactly $100 — should succeed (cap check is <=, not <)
      await doAgentTransfer(
        agentA,
        edgeV.vault,
        edgeV.policy,
        edgeV.tracker,
        edgeV.overlay,
        edgeV.vaultAta,
        edgeV.destAta,
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
          edgeV.destAta,
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
      // Pre-created (and operator-seated) by the top-level before().
      const capV = vaults.p8cap;

      // Exhaust cap
      await doAgentTransfer(
        agentA,
        capV.vault,
        capV.policy,
        capV.tracker,
        capV.overlay,
        capV.vaultAta,
        capV.destAta,
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
      // Pre-created (and operator-seated) by the top-level before().
      const nsV = vaults.p8ns;

      // Non-spending action (withdraw type, amount=0). The protocol-allowlist
      // gate applies to ALL actions in V2, so even a non-spending validate
      // must target an allowlisted program (the mock-defi fixture). The
      // System self-transfer leg below stays valid HERE: the non-spending
      // window scan only requires finalize be present — the exactly-one-DeFi
      // count (F-Q2) is a SPENDING-path rule.
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
          MOCK_DEFI_PROGRAM_ID,
          // Live read: the operator-grant apply bumped policy_version (6052
          // on a hardcoded 0).
          ((await program.account.policyConfig.fetch(nsV.policy))
            .policyVersion as BN) ?? new BN(0),
          new BN(0), // AC-10 expectedNonce
          digestAsArgs(
            buildExpectedIntentDigest({
              vault: nsV.vault,
              agent: agentA.publicKey,
              tokenMint: usdcMint,
              amount: new BN(0),
              targetProtocol: MOCK_DEFI_PROGRAM_ID,
            }),
          ),
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
          outputSwapAccount: null,
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
          outputSwapAccount: null,
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
      // Pre-created (and operator-seated) by the top-level before().
      const feeV = vaults.p8fee;

      const beforeFee = await getTokenBalance(connection, feeDestAta.address);

      await program.methods
        .agentTransfer(
          new BN(100_000_000), // $100
          // Live read — same 6052 class as doAgentTransfer (agent_transfer.rs:95).
          ((await program.account.policyConfig.fetch(feeV.policy))
            .policyVersion as BN) ?? new BN(0),
        )
        .accounts({
          agent: agentA.publicKey,
          vault: feeV.vault,
          policy: feeV.policy,
          tracker: feeV.tracker,
          vaultTokenAccount: feeV.vaultAta,
          tokenMintAccount: usdcMint,
          destinationTokenAccount: feeV.destAta,
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
