import { expect } from "chai";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ShieldDeniedError,
  ShieldState,
  parseSpendLimit,
  ShieldConfigError,
  TeeRequiredError,
  analyzeTransaction,
  evaluatePolicy,
  resolvePolicies,
  resolveTransactionAddressLookupTables,
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  isSystemProgram,
  isKnownProtocol,
  getTokenInfo,
  getProtocolName,
  mapPoliciesToVaultParams,
  isTeeWallet,
} from "../src";
import type {
  WalletLike,
  ShieldStorage,
  ResolvedPolicies,
  TeeWallet,
} from "../src";
import { harden, withVault } from "../src/wrapper/harden";
import type { HardenOptions, HardenResult } from "../src/wrapper/harden";
// shield() is internal — import from source for testing
import { shield } from "../src/wrapper/shield";

// --- Test Helpers ---

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const JUPITER_PROGRAM = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);
const UNKNOWN_PROGRAM = Keypair.generate().publicKey;

/** Create a mock wallet for testing */
function createMockWallet(): WalletLike & { signCount: number } {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signCount: 0,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      this.signCount++;
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      this.signCount += txs.length;
      return txs;
    },
  };
}

/** Create an in-memory storage for testing */
function createMemoryStorage(): ShieldStorage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
  };
}

/**
 * Build a fake SPL Token TransferChecked instruction.
 * Layout: [disc=12][8 bytes amount LE][1 byte decimals]
 * Accounts: [source, mint, destination, authority]
 */
function buildTransferCheckedIx(
  authority: PublicKey,
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked discriminator
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Build a transaction with a system transfer (no SPL) */
function buildSystemTx(from: PublicKey): Transaction {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000,
    }),
  );
  tx.recentBlockhash = "EETubP5AKHgjPAhzPkA6E6Q25CUVpCzSEbNqhU7vBd8b";
  tx.feePayer = from;
  return tx;
}

/** Build a transaction with a SPL TransferChecked instruction */
function buildSplTransferTx(
  authority: PublicKey,
  mint: PublicKey,
  amount: bigint,
  decimals: number,
): Transaction {
  const tx = new Transaction();
  tx.add(
    buildTransferCheckedIx(
      authority,
      Keypair.generate().publicKey, // source ATA
      mint,
      Keypair.generate().publicKey, // dest ATA
      amount,
      decimals,
    ),
  );
  tx.recentBlockhash = "EETubP5AKHgjPAhzPkA6E6Q25CUVpCzSEbNqhU7vBd8b";
  tx.feePayer = authority;
  return tx;
}

/** Build a transaction interacting with a specific program */
function buildProgramTx(payer: PublicKey, programId: PublicKey): Transaction {
  const tx = new Transaction();
  tx.add(
    new TransactionInstruction({
      programId,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    }),
  );
  tx.recentBlockhash = "EETubP5AKHgjPAhzPkA6E6Q25CUVpCzSEbNqhU7vBd8b";
  tx.feePayer = payer;
  return tx;
}

// --- Tests ---

describe("wrapper — shieldWallet() & harden()", () => {
  describe("parseSpendLimit", () => {
    it("parses '500 USDC/day'", () => {
      const limit = parseSpendLimit("500 USDC/day");
      expect(limit.mint).to.equal(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );
      expect(limit.amount).to.equal(BigInt(500_000_000));
      expect(limit.windowMs).to.equal(86_400_000);
    });

    it("parses '10 SOL/hour'", () => {
      const limit = parseSpendLimit("10 SOL/hour");
      expect(limit.mint).to.equal(
        "So11111111111111111111111111111111111111112",
      );
      expect(limit.amount).to.equal(BigInt(10_000_000_000));
      expect(limit.windowMs).to.equal(3_600_000);
    });

    it("parses '0.5 wBTC/day'", () => {
      const limit = parseSpendLimit("0.5 wBTC/day");
      expect(limit.amount).to.equal(BigInt(50_000_000));
    });

    it("defaults to /day when no window specified", () => {
      const limit = parseSpendLimit("100 USDC");
      expect(limit.windowMs).to.equal(86_400_000);
    });

    it("throws on invalid format", () => {
      expect(() => parseSpendLimit("garbage")).to.throw(ShieldConfigError);
    });

    it("throws on unknown token symbol", () => {
      expect(() => parseSpendLimit("500 DOGE/day")).to.throw(ShieldConfigError);
    });

    it("throws on unknown time window", () => {
      expect(() => parseSpendLimit("500 USDC/week")).to.throw(
        ShieldConfigError,
      );
    });
  });

  describe("registry", () => {
    it("has Jupiter in KNOWN_PROTOCOLS", () => {
      expect(KNOWN_PROTOCOLS.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"))
        .to.be.true;
    });

    it("has USDC in KNOWN_TOKENS", () => {
      const info = getTokenInfo(USDC_MINT);
      expect(info).to.not.be.undefined;
      expect(info!.symbol).to.equal("USDC");
      expect(info!.decimals).to.equal(6);
    });

    it("isSystemProgram returns true for system program", () => {
      expect(isSystemProgram("11111111111111111111111111111111")).to.be.true;
    });

    it("isKnownProtocol returns true for Jupiter", () => {
      expect(isKnownProtocol(JUPITER_PROGRAM)).to.be.true;
    });

    it("getProtocolName returns name for known program", () => {
      expect(getProtocolName(JUPITER_PROGRAM)).to.equal("Jupiter V6");
    });

    it("returns undefined for unknown program", () => {
      expect(getProtocolName(UNKNOWN_PROGRAM)).to.be.undefined;
    });
  });

  describe("analyzeTransaction", () => {
    it("detects system program instruction", () => {
      const wallet = createMockWallet();
      const tx = buildSystemTx(wallet.publicKey);
      const analysis = analyzeTransaction(tx, wallet.publicKey);

      expect(analysis.programIds.length).to.be.greaterThanOrEqual(1);
      const hasSystemProgram = analysis.programIds.some((p) =>
        p.equals(SystemProgram.programId),
      );
      expect(hasSystemProgram).to.be.true;
    });

    it("detects SPL TransferChecked instruction", () => {
      const wallet = createMockWallet();
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(100_000_000),
        6,
      );
      const analysis = analyzeTransaction(tx, wallet.publicKey);

      expect(analysis.transfers.length).to.equal(1);
      expect(analysis.transfers[0].direction).to.equal("outgoing");
      expect(analysis.transfers[0].amount).to.equal(BigInt(100_000_000));
      expect(analysis.transfers[0].mint.equals(USDC_MINT)).to.be.true;
    });

    it("detects non-system program IDs", () => {
      const wallet = createMockWallet();
      const tx = buildProgramTx(wallet.publicKey, UNKNOWN_PROGRAM);
      const analysis = analyzeTransaction(tx, wallet.publicKey);

      const hasUnknown = analysis.programIds.some((p) =>
        p.equals(UNKNOWN_PROGRAM),
      );
      expect(hasUnknown).to.be.true;
    });
  });

  describe("ShieldState", () => {
    it("tracks spending in rolling window", () => {
      const state = new ShieldState();
      const mint = USDC_MINT.toBase58();

      state.recordSpend(mint, BigInt(100_000_000));
      state.recordSpend(mint, BigInt(200_000_000));

      const total = state.getSpendInWindow(mint, 86_400_000);
      expect(total).to.equal(BigInt(300_000_000));
    });

    it("tracks transaction count for rate limiting", () => {
      const state = new ShieldState();

      state.recordTransaction();
      state.recordTransaction();
      state.recordTransaction();

      const count = state.getTransactionCountInWindow(3_600_000);
      expect(count).to.equal(3);
    });

    it("resets state", () => {
      const state = new ShieldState();
      state.recordSpend(USDC_MINT.toBase58(), BigInt(100));
      state.recordTransaction();

      state.reset();

      expect(state.getSpendInWindow(USDC_MINT.toBase58(), 86_400_000)).to.equal(
        BigInt(0),
      );
      expect(state.getTransactionCountInWindow(3_600_000)).to.equal(0);
    });

    it("persists to storage and reloads", () => {
      const storage = createMemoryStorage();
      const mint = USDC_MINT.toBase58();

      // Write
      const state1 = new ShieldState(storage);
      state1.recordSpend(mint, BigInt(500_000_000));
      state1.recordTransaction();

      // Read back via new instance
      const state2 = new ShieldState(storage);
      expect(state2.getSpendInWindow(mint, 86_400_000)).to.equal(
        BigInt(500_000_000),
      );
      expect(state2.getTransactionCountInWindow(3_600_000)).to.equal(1);
    });
  });

  describe("evaluatePolicy", () => {
    it("allows transaction within spending cap", () => {
      const wallet = createMockWallet();
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(100_000_000), // 100 USDC
        6,
      );
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const policies = resolvePolicies({ maxSpend: "500 USDC/day" });
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.equal(0);
    });

    it("blocks transaction exceeding spending cap", () => {
      const wallet = createMockWallet();
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(600_000_000), // 600 USDC
        6,
      );
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const policies = resolvePolicies({ maxSpend: "500 USDC/day" });
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("spending_cap");
    });

    it("blocks transaction after cumulative spend exceeds cap", () => {
      const wallet = createMockWallet();
      const policies = resolvePolicies({ maxSpend: "500 USDC/day" });
      const state = new ShieldState();
      const mint = USDC_MINT.toBase58();

      // Simulate prior spend of 400 USDC
      state.recordSpend(mint, BigInt(400_000_000));

      // Try to spend 200 more USDC (total 600, cap 500)
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const violations = evaluatePolicy(analysis, policies, state);

      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("spending_cap");
    });

    it("blocks unknown program by default", () => {
      const wallet = createMockWallet();
      const tx = buildProgramTx(wallet.publicKey, UNKNOWN_PROGRAM);
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const policies = resolvePolicies();
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("unknown_program");
    });

    it("allows unknown program when blockUnknownPrograms is false", () => {
      const wallet = createMockWallet();
      const tx = buildProgramTx(wallet.publicKey, UNKNOWN_PROGRAM);
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const policies = resolvePolicies({ blockUnknownPrograms: false });
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.equal(0);
    });

    it("allows known protocol (Jupiter)", () => {
      const wallet = createMockWallet();
      const tx = buildProgramTx(wallet.publicKey, JUPITER_PROGRAM);
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const policies = resolvePolicies();
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.equal(0);
    });

    it("blocks protocol not in explicit allowlist", () => {
      const wallet = createMockWallet();
      const tx = buildProgramTx(wallet.publicKey, JUPITER_PROGRAM);
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      // Only allow Flash Trade, not Jupiter
      const policies = resolvePolicies({
        allowedProtocols: ["PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"],
      });
      const state = new ShieldState();

      const violations = evaluatePolicy(analysis, policies, state);
      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("protocol_not_allowed");
    });

    it("enforces rate limit", () => {
      const wallet = createMockWallet();
      const policies = resolvePolicies({
        rateLimit: { maxTransactions: 3, windowMs: 3_600_000 },
        blockUnknownPrograms: false,
      });
      const state = new ShieldState();

      // Simulate 3 prior transactions
      state.recordTransaction();
      state.recordTransaction();
      state.recordTransaction();

      const tx = buildSystemTx(wallet.publicKey);
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const violations = evaluatePolicy(analysis, policies, state);

      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("rate_limit");
    });

    it("enforces token allowlist", () => {
      const wallet = createMockWallet();
      const policies = resolvePolicies({
        allowedTokens: [SOL_MINT], // Only SOL allowed
      });
      const state = new ShieldState();

      // Try USDC transfer
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(100_000_000),
        6,
      );
      const analysis = analyzeTransaction(tx, wallet.publicKey);
      const violations = evaluatePolicy(analysis, policies, state);

      expect(violations.length).to.be.greaterThan(0);
      expect(violations[0].rule).to.equal("token_not_allowed");
    });
  });

  describe("shield()", () => {
    it("signs transaction within policy", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        blockUnknownPrograms: false,
      });

      const tx = buildSystemTx(wallet.publicKey);
      await protected_.signTransaction(tx);

      expect(wallet.signCount).to.equal(1);
    });

    it("blocks transaction exceeding spending cap", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "100 USDC/day",
      });

      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000), // 200 USDC, cap is 100
        6,
      );

      try {
        await protected_.signTransaction(tx);
        expect.fail("Should have thrown ShieldDeniedError");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
        const err = e as ShieldDeniedError;
        expect(err.violations[0].rule).to.equal("spending_cap");
      }

      expect(wallet.signCount).to.equal(0);
    });

    it("blocks unknown program by default", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet);

      const tx = buildProgramTx(wallet.publicKey, UNKNOWN_PROGRAM);

      try {
        await protected_.signTransaction(tx);
        expect.fail("Should have thrown ShieldDeniedError");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
        const err = e as ShieldDeniedError;
        expect(err.violations[0].rule).to.equal("unknown_program");
      }

      expect(wallet.signCount).to.equal(0);
    });

    it("allows known protocol (Jupiter)", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet);

      const tx = buildProgramTx(wallet.publicKey, JUPITER_PROGRAM);
      await protected_.signTransaction(tx);

      expect(wallet.signCount).to.equal(1);
    });

    it("tracks cumulative spend across transactions", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "500 USDC/day",
      });

      // First tx: 300 USDC — should pass
      const tx1 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(300_000_000),
        6,
      );
      await protected_.signTransaction(tx1);
      expect(wallet.signCount).to.equal(1);

      // Second tx: 300 USDC — should fail (total 600 > 500 cap)
      const tx2 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(300_000_000),
        6,
      );

      try {
        await protected_.signTransaction(tx2);
        expect.fail("Should have thrown ShieldDeniedError");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
      }

      expect(wallet.signCount).to.equal(1);
    });

    it("calls onDenied callback when blocked", async () => {
      const wallet = createMockWallet();
      let deniedError: ShieldDeniedError | null = null;

      const protected_ = shield(
        wallet,
        { maxSpend: "100 USDC/day" },
        { onDenied: (err) => (deniedError = err) },
      );

      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );

      try {
        await protected_.signTransaction(tx);
      } catch {
        // expected
      }

      expect(deniedError).to.not.be.null;
      expect(deniedError!.violations[0].rule).to.equal("spending_cap");
    });

    it("signAllTransactions evaluates all before signing any", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "500 USDC/day",
      });

      // 3 txs of 200 USDC each = 600 total, exceeds 500 cap
      const txs = [
        buildSplTransferTx(wallet.publicKey, USDC_MINT, BigInt(200_000_000), 6),
        buildSplTransferTx(wallet.publicKey, USDC_MINT, BigInt(200_000_000), 6),
        buildSplTransferTx(wallet.publicKey, USDC_MINT, BigInt(200_000_000), 6),
      ];

      try {
        await protected_.signAllTransactions!(txs);
        expect.fail("Should have thrown ShieldDeniedError");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
      }

      // None should have been signed since evaluation happens first
      expect(wallet.signCount).to.equal(0);
    });

    it("updatePolicies changes enforcement at runtime", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "100 USDC/day",
      });

      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );

      // Should fail with 100 USDC cap
      try {
        await protected_.signTransaction(tx);
        expect.fail("Should have thrown");
      } catch {
        // expected
      }

      // Update policy to 500 USDC cap
      protected_.updatePolicies({ maxSpend: "500 USDC/day" });

      // Should now pass
      const tx2 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );
      await protected_.signTransaction(tx2);
      expect(wallet.signCount).to.equal(1);
    });

    it("resetState clears spending history", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "200 USDC/day",
      });

      // Spend 150 USDC
      const tx1 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(150_000_000),
        6,
      );
      await protected_.signTransaction(tx1);

      // Reset state
      protected_.resetState();

      // Should now be able to spend 150 again (cap is 200)
      const tx2 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(150_000_000),
        6,
      );
      await protected_.signTransaction(tx2);
      expect(wallet.signCount).to.equal(2);
    });

    it("exposes innerWallet and shieldState", () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet);

      expect(protected_.innerWallet).to.equal(wallet);
      expect(protected_.shieldState).to.be.instanceOf(ShieldState);
      expect(protected_.isHardened).to.be.false;
      expect(protected_.publicKey.equals(wallet.publicKey)).to.be.true;
    });

    it("pause() allows transaction that would normally be blocked", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "100 USDC/day",
      });

      protected_.pause();

      // This 200 USDC tx would normally be blocked by the 100 USDC cap
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );
      await protected_.signTransaction(tx);
      expect(wallet.signCount).to.equal(1);
    });

    it("resume() re-enables enforcement after pause", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "100 USDC/day",
      });

      protected_.pause();
      protected_.resume();

      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );

      try {
        await protected_.signTransaction(tx);
        expect.fail("Should have thrown ShieldDeniedError");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
      }
      expect(wallet.signCount).to.equal(0);
    });

    it("isPaused reflects correct state", () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet);

      expect(protected_.isPaused).to.be.false;
      protected_.pause();
      expect(protected_.isPaused).to.be.true;
      protected_.resume();
      expect(protected_.isPaused).to.be.false;
    });

    it("spending is NOT tracked while paused", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "500 USDC/day",
        blockUnknownPrograms: false,
      });

      protected_.pause();

      // Sign a 300 USDC tx while paused — should not be tracked
      const tx1 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(300_000_000),
        6,
      );
      await protected_.signTransaction(tx1);

      protected_.resume();

      // Now try 300 USDC — should pass since paused spend wasn't tracked
      const tx2 = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(300_000_000),
        6,
      );
      await protected_.signTransaction(tx2);
      expect(wallet.signCount).to.equal(2);
    });

    it("getSpendingSummary() returns correct token spend and rate limit", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "500 USDC/day",
        blockUnknownPrograms: false,
      });

      // Spend 200 USDC
      const tx = buildSplTransferTx(
        wallet.publicKey,
        USDC_MINT,
        BigInt(200_000_000),
        6,
      );
      await protected_.signTransaction(tx);

      const summary = protected_.getSpendingSummary();

      expect(summary.isPaused).to.be.false;
      expect(summary.tokens.length).to.equal(1);
      expect(summary.tokens[0].mint).to.equal(USDC_MINT.toBase58());
      expect(summary.tokens[0].symbol).to.equal("USDC");
      expect(summary.tokens[0].spent).to.equal(BigInt(200_000_000));
      expect(summary.tokens[0].limit).to.equal(BigInt(500_000_000));
      expect(summary.tokens[0].remaining).to.equal(BigInt(300_000_000));

      expect(summary.rateLimit.count).to.equal(1);
      expect(summary.rateLimit.remaining).to.equal(summary.rateLimit.limit - 1);
    });

    it("onPause callback fires on pause", () => {
      const wallet = createMockWallet();
      let pauseCalled = false;
      const protected_ = shield(wallet, undefined, {
        onPause: () => {
          pauseCalled = true;
        },
      });

      protected_.pause();
      expect(pauseCalled).to.be.true;
    });

    it("onResume callback fires on resume", () => {
      const wallet = createMockWallet();
      let resumeCalled = false;
      const protected_ = shield(wallet, undefined, {
        onResume: () => {
          resumeCalled = true;
        },
      });

      protected_.pause();
      protected_.resume();
      expect(resumeCalled).to.be.true;
    });

    it("onPolicyUpdate callback fires on updatePolicies", () => {
      const wallet = createMockWallet();
      let updatedPolicies: any = null;
      const protected_ = shield(wallet, undefined, {
        onPolicyUpdate: (p) => {
          updatedPolicies = p;
        },
      });

      const newPolicies = { maxSpend: "1000 USDC/day" as const };
      protected_.updatePolicies(newPolicies);
      expect(updatedPolicies).to.deep.equal(newPolicies);
    });

    it("applies secure defaults with no config", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet);

      // Unknown program should be blocked
      const tx = buildProgramTx(wallet.publicKey, UNKNOWN_PROGRAM);
      try {
        await protected_.signTransaction(tx);
        expect.fail("Should block unknown program by default");
      } catch (e) {
        expect(e).to.be.instanceOf(ShieldDeniedError);
      }
    });

    it("supports custom policy check", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        blockUnknownPrograms: false,
        customCheck: (analysis) => {
          // Block if more than 2 programs
          if (analysis.programIds.length > 2) {
            return { allowed: false, reason: "Too many programs" };
          }
          return { allowed: true };
        },
      });

      // Simple tx should pass
      const tx = buildSystemTx(wallet.publicKey);
      await protected_.signTransaction(tx);
      expect(wallet.signCount).to.equal(1);
    });

    it("amount = 0n → allowed (below any cap)", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        maxSpend: "100 USDC/day",
      });

      const tx = buildSplTransferTx(wallet.publicKey, USDC_MINT, BigInt(0), 6);
      await protected_.signTransaction(tx);
      expect(wallet.signCount).to.equal(1);
    });

    it("amount = BigInt(Number.MAX_SAFE_INTEGER) → works without precision loss", async () => {
      const wallet = createMockWallet();
      const large = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991
      const protected_ = shield(wallet, {
        blockUnknownPrograms: false,
      });

      const tx = buildSplTransferTx(wallet.publicKey, USDC_MINT, large, 6);

      const analysis = analyzeTransaction(tx, wallet.publicKey);
      expect(analysis.transfers[0].amount).to.equal(large);
    });

    it("signAllTransactions([]) → returns empty array without error", async () => {
      const wallet = createMockWallet();
      const protected_ = shield(wallet, {
        blockUnknownPrograms: false,
      });

      const result = await protected_.signAllTransactions!([]);
      expect(result).to.deep.equal([]);
      expect(wallet.signCount).to.equal(0);
    });
  });

  // --- VersionedTransaction Helpers ---

  const RECENT_BLOCKHASH = "EETubP5AKHgjPAhzPkA6E6Q25CUVpCzSEbNqhU7vBd8b";

  /** Build a VersionedTransaction (V0 message, no ALTs) with system transfer */
  function buildVersionedSystemTx(from: PublicKey): VersionedTransaction {
    const ix = SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000,
    });
    const messageV0 = new TransactionMessage({
      payerKey: from,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(messageV0);
  }

  /** Build a VersionedTransaction with SPL TransferChecked */
  function buildVersionedSplTransferTx(
    authority: PublicKey,
    mint: PublicKey,
    amount: bigint,
    decimals: number,
  ): VersionedTransaction {
    const ix = buildTransferCheckedIx(
      authority,
      Keypair.generate().publicKey,
      mint,
      Keypair.generate().publicKey,
      amount,
      decimals,
    );
    const messageV0 = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(messageV0);
  }

  /** Build a VersionedTransaction interacting with a specific program */
  function buildVersionedProgramTx(
    payer: PublicKey,
    programId: PublicKey,
  ): VersionedTransaction {
    const ix = new TransactionInstruction({
      programId,
      keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    });
    const messageV0 = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(messageV0);
  }

  /** Build a VersionedTransaction with Address Lookup Tables */
  function buildVersionedTxWithALT(
    payer: PublicKey,
    instructions: TransactionInstruction[],
    addressLookupTableAccounts: AddressLookupTableAccount[],
  ): VersionedTransaction {
    const messageV0 = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions,
    }).compileToV0Message(addressLookupTableAccounts);
    return new VersionedTransaction(messageV0);
  }

  /** Create a mock AddressLookupTableAccount */
  function createMockALT(
    tableKey: PublicKey,
    addresses: PublicKey[],
  ): AddressLookupTableAccount {
    return new AddressLookupTableAccount({
      key: tableKey,
      state: {
        deactivationSlot: BigInt("18446744073709551615"), // u64::MAX = active
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses,
      },
    });
  }

  // --- VersionedTransaction Tests ---

  describe("VersionedTransaction Support", () => {
    describe("analyzeTransaction — VersionedTransaction (no ALTs)", () => {
      it("extracts system program from V0 message", () => {
        const wallet = createMockWallet();
        const tx = buildVersionedSystemTx(wallet.publicKey);
        const analysis = analyzeTransaction(tx, wallet.publicKey);

        const hasSystemProgram = analysis.programIds.some((p) =>
          p.equals(SystemProgram.programId),
        );
        expect(hasSystemProgram).to.be.true;
      });

      it("extracts SPL TransferChecked from V0 message", () => {
        const wallet = createMockWallet();
        const tx = buildVersionedSplTransferTx(
          wallet.publicKey,
          USDC_MINT,
          BigInt(100_000_000),
          6,
        );
        const analysis = analyzeTransaction(tx, wallet.publicKey);

        expect(analysis.transfers.length).to.equal(1);
        expect(analysis.transfers[0].mint.equals(USDC_MINT)).to.be.true;
        expect(analysis.transfers[0].amount).to.equal(BigInt(100_000_000));
      });

      it("detects outgoing transfer amount from V0 message", () => {
        const wallet = createMockWallet();
        const tx = buildVersionedSplTransferTx(
          wallet.publicKey,
          USDC_MINT,
          BigInt(50_000_000),
          6,
        );
        const analysis = analyzeTransaction(tx, wallet.publicKey);

        expect(analysis.transfers[0].direction).to.equal("outgoing");
        expect(analysis.estimatedValueLamports).to.equal(BigInt(50_000_000));
      });

      it("extracts DeFi program ID from V0 message", () => {
        const wallet = createMockWallet();
        const tx = buildVersionedProgramTx(wallet.publicKey, JUPITER_PROGRAM);
        const analysis = analyzeTransaction(tx, wallet.publicKey);

        const hasJupiter = analysis.programIds.some((p) =>
          p.equals(JUPITER_PROGRAM),
        );
        expect(hasJupiter).to.be.true;
      });
    });

    describe("analyzeTransaction — VersionedTransaction with ALTs", () => {
      it("resolves program IDs referenced through ALT", () => {
        const wallet = createMockWallet();
        const programId = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [programId]);

        // Build an instruction referencing the program from the ALT
        const ix = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.from([1, 2, 3]),
        });
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);

        // Without ALTs — program should fallback (may not resolve correctly)
        const withoutALT = analyzeTransaction(tx, wallet.publicKey);
        // With ALTs — program should resolve correctly
        const withALT = analyzeTransaction(tx, wallet.publicKey, [alt]);

        const hasProgram = withALT.programIds.some((p) => p.equals(programId));
        expect(hasProgram).to.be.true;
      });

      it("resolves SPL transfer mint referenced through ALT", () => {
        const wallet = createMockWallet();
        const source = Keypair.generate().publicKey;
        const destination = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [source, USDC_MINT, destination]);

        const ix = buildTransferCheckedIx(
          wallet.publicKey,
          source,
          USDC_MINT,
          destination,
          BigInt(250_000_000),
          6,
        );
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);
        const analysis = analyzeTransaction(tx, wallet.publicKey, [alt]);

        expect(analysis.transfers.length).to.equal(1);
        expect(analysis.transfers[0].mint.equals(USDC_MINT)).to.be.true;
        expect(analysis.transfers[0].amount).to.equal(BigInt(250_000_000));
      });

      it("resolves transfer destination referenced through ALT", () => {
        const wallet = createMockWallet();
        const source = Keypair.generate().publicKey;
        const destination = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [source, USDC_MINT, destination]);

        const ix = buildTransferCheckedIx(
          wallet.publicKey,
          source,
          USDC_MINT,
          destination,
          BigInt(100_000_000),
          6,
        );
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);
        const analysis = analyzeTransaction(tx, wallet.publicKey, [alt]);

        expect(analysis.transfers[0].direction).to.equal("outgoing");
        expect(analysis.transfers[0].destination!.equals(destination)).to.be
          .true;
      });

      it("handles mixed static + ALT accounts correctly", () => {
        const wallet = createMockWallet();
        const altKey1 = Keypair.generate().publicKey;
        const altKey2 = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [altKey1, altKey2]);

        // System transfer uses only static keys
        const systemIx = SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1_000,
        });
        // Custom ix with account from ALT
        const customIx = new TransactionInstruction({
          programId: JUPITER_PROGRAM,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: altKey1, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([0]),
        });

        const tx = buildVersionedTxWithALT(
          wallet.publicKey,
          [systemIx, customIx],
          [alt],
        );
        const analysis = analyzeTransaction(tx, wallet.publicKey, [alt]);

        // Should see both system program and Jupiter
        const hasSystem = analysis.programIds.some((p) =>
          p.equals(SystemProgram.programId),
        );
        const hasJupiter = analysis.programIds.some((p) =>
          p.equals(JUPITER_PROGRAM),
        );
        expect(hasSystem).to.be.true;
        expect(hasJupiter).to.be.true;
      });

      it("falls back to static keys when no ALTs provided", () => {
        const wallet = createMockWallet();
        // Simple V0 tx with no ALT references — should work fine without ALTs
        const tx = buildVersionedSystemTx(wallet.publicKey);
        const analysis = analyzeTransaction(tx, wallet.publicKey);

        expect(analysis.programIds.length).to.be.greaterThanOrEqual(1);
        const hasSystem = analysis.programIds.some((p) =>
          p.equals(SystemProgram.programId),
        );
        expect(hasSystem).to.be.true;
      });
    });

    describe("shield() — VersionedTransaction", () => {
      it("signs V0 transaction within policy", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet, {
          blockUnknownPrograms: false,
        });

        const tx = buildVersionedSystemTx(wallet.publicKey);
        await protected_.signTransaction(tx);
        expect(wallet.signCount).to.equal(1);
      });

      it("blocks V0 transaction over spending cap", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet, {
          maxSpend: "100 USDC/day",
        });

        const tx = buildVersionedSplTransferTx(
          wallet.publicKey,
          USDC_MINT,
          BigInt(200_000_000), // 200 USDC > 100 cap
          6,
        );

        try {
          await protected_.signTransaction(tx);
          expect.fail("Should have thrown ShieldDeniedError");
        } catch (e) {
          expect(e).to.be.instanceOf(ShieldDeniedError);
          const err = e as ShieldDeniedError;
          expect(err.violations[0].rule).to.equal("spending_cap");
        }
        expect(wallet.signCount).to.equal(0);
      });

      it("blocks V0 transaction with unknown program", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet);
        const unknownProg = Keypair.generate().publicKey;

        const tx = buildVersionedProgramTx(wallet.publicKey, unknownProg);

        try {
          await protected_.signTransaction(tx);
          expect.fail("Should have thrown ShieldDeniedError");
        } catch (e) {
          expect(e).to.be.instanceOf(ShieldDeniedError);
          const err = e as ShieldDeniedError;
          expect(err.violations[0].rule).to.equal("unknown_program");
        }
        expect(wallet.signCount).to.equal(0);
      });

      it("allows V0 transaction with known Jupiter program", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet);

        const tx = buildVersionedProgramTx(wallet.publicKey, JUPITER_PROGRAM);
        await protected_.signTransaction(tx);
        expect(wallet.signCount).to.equal(1);
      });

      it("tracks cumulative spend across V0 transactions", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet, {
          maxSpend: "500 USDC/day",
        });

        // First: 300 USDC — should pass
        const tx1 = buildVersionedSplTransferTx(
          wallet.publicKey,
          USDC_MINT,
          BigInt(300_000_000),
          6,
        );
        await protected_.signTransaction(tx1);
        expect(wallet.signCount).to.equal(1);

        // Second: 300 USDC — total 600 > 500, should fail
        const tx2 = buildVersionedSplTransferTx(
          wallet.publicKey,
          USDC_MINT,
          BigInt(300_000_000),
          6,
        );

        try {
          await protected_.signTransaction(tx2);
          expect.fail("Should have thrown ShieldDeniedError");
        } catch (e) {
          expect(e).to.be.instanceOf(ShieldDeniedError);
        }
        expect(wallet.signCount).to.equal(1);
      });

      it("handles V0 in signAllTransactions batch", async () => {
        const wallet = createMockWallet();
        const protected_ = shield(wallet, {
          blockUnknownPrograms: false,
        });

        const txs = [
          buildVersionedSystemTx(wallet.publicKey),
          buildVersionedSystemTx(wallet.publicKey),
        ];
        const result = await protected_.signAllTransactions!(txs);
        expect(result.length).to.equal(2);
        expect(wallet.signCount).to.equal(2);
      });
    });

    describe("shield() — VersionedTransaction with ALTs", () => {
      it("resolves ALT accounts when connection provided", async () => {
        const wallet = createMockWallet();
        const altAddr = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [altAddr]);

        // Build a V0 tx that references accounts from the ALT
        const ix = new TransactionInstruction({
          programId: JUPITER_PROGRAM,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: altAddr, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([0]),
        });
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);

        // Mock connection that returns our ALT
        const mockConnection = {
          getAddressLookupTable: async (key: PublicKey) => {
            if (key.equals(tableKey)) {
              return { context: { slot: 0 }, value: alt };
            }
            return { context: { slot: 0 }, value: null };
          },
        } as unknown as Connection;

        const protected_ = shield(wallet, undefined, {
          connection: mockConnection,
        });
        await protected_.signTransaction(tx);
        expect(wallet.signCount).to.equal(1);
      });

      it("correctly identifies program from ALT for allowlist check", async () => {
        const wallet = createMockWallet();
        const unknownProg = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [unknownProg]);

        const ix = new TransactionInstruction({
          programId: unknownProg,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          ],
          data: Buffer.from([1]),
        });
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);

        const mockConnection = {
          getAddressLookupTable: async (key: PublicKey) => {
            if (key.equals(tableKey)) {
              return { context: { slot: 0 }, value: alt };
            }
            return { context: { slot: 0 }, value: null };
          },
        } as unknown as Connection;

        // Default policy blocks unknown programs
        const protected_ = shield(wallet, undefined, {
          connection: mockConnection,
        });

        try {
          await protected_.signTransaction(tx);
          expect.fail("Should have thrown ShieldDeniedError");
        } catch (e) {
          expect(e).to.be.instanceOf(ShieldDeniedError);
          const err = e as ShieldDeniedError;
          expect(err.violations[0].rule).to.equal("unknown_program");
        }
        expect(wallet.signCount).to.equal(0);
      });

      it("correctly identifies token from ALT for spending cap", async () => {
        const wallet = createMockWallet();
        const source = Keypair.generate().publicKey;
        const destination = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [source, USDC_MINT, destination]);

        const ix = buildTransferCheckedIx(
          wallet.publicKey,
          source,
          USDC_MINT,
          destination,
          BigInt(200_000_000), // 200 USDC
          6,
        );
        const tx = buildVersionedTxWithALT(wallet.publicKey, [ix], [alt]);

        const mockConnection = {
          getAddressLookupTable: async (key: PublicKey) => {
            if (key.equals(tableKey)) {
              return { context: { slot: 0 }, value: alt };
            }
            return { context: { slot: 0 }, value: null };
          },
        } as unknown as Connection;

        // 100 USDC cap — 200 USDC tx should be blocked
        const protected_ = shield(
          wallet,
          { maxSpend: "100 USDC/day" },
          { connection: mockConnection },
        );

        try {
          await protected_.signTransaction(tx);
          expect.fail("Should have thrown ShieldDeniedError");
        } catch (e) {
          expect(e).to.be.instanceOf(ShieldDeniedError);
          const err = e as ShieldDeniedError;
          expect(err.violations[0].rule).to.equal("spending_cap");
        }
        expect(wallet.signCount).to.equal(0);
      });

      it("works without connection (static-key fallback)", async () => {
        const wallet = createMockWallet();
        // Simple V0 tx with no ALT references, no connection
        const protected_ = shield(wallet, {
          blockUnknownPrograms: false,
        });

        const tx = buildVersionedSystemTx(wallet.publicKey);
        await protected_.signTransaction(tx);
        expect(wallet.signCount).to.equal(1);
      });
    });

    describe("resolveTransactionAddressLookupTables", () => {
      it("returns empty array for tx with no ALT lookups", async () => {
        const tx = buildVersionedSystemTx(Keypair.generate().publicKey);
        const mockConnection = {
          getAddressLookupTable: async () => {
            throw new Error("Should not be called");
          },
        } as unknown as Connection;

        const result = await resolveTransactionAddressLookupTables(
          tx,
          mockConnection,
        );
        expect(result).to.deep.equal([]);
      });

      it("returns resolved ALT accounts from connection", async () => {
        const payer = Keypair.generate().publicKey;
        const altAddr = Keypair.generate().publicKey;
        const tableKey = Keypair.generate().publicKey;
        const alt = createMockALT(tableKey, [altAddr]);

        const ix = new TransactionInstruction({
          programId: JUPITER_PROGRAM,
          keys: [
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: altAddr, isSigner: false, isWritable: true },
          ],
          data: Buffer.from([0]),
        });
        const tx = buildVersionedTxWithALT(payer, [ix], [alt]);

        const mockConnection = {
          getAddressLookupTable: async (key: PublicKey) => {
            if (key.equals(tableKey)) {
              return { context: { slot: 0 }, value: alt };
            }
            return { context: { slot: 0 }, value: null };
          },
        } as unknown as Connection;

        const result = await resolveTransactionAddressLookupTables(
          tx,
          mockConnection,
        );
        expect(result.length).to.equal(1);
        expect(result[0].key.equals(tableKey)).to.be.true;
      });
    });
  });

  // --- harden() Tests ---

  describe("mapPoliciesToVaultParams()", () => {
    const FEE_DEST = Keypair.generate().publicKey;

    it("collapses multiple SpendLimits to the largest as dailySpendingCap", () => {
      const resolved = resolvePolicies({
        maxSpend: [
          "500 USDC/day", // 500_000_000
          "10 SOL/day", // 10_000_000_000
        ],
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.dailySpendingCap).to.equal(BigInt(10_000_000_000));
    });

    it("sets protocolMode=1 (allowlist) when protocols are specified", () => {
      const resolved = resolvePolicies({
        allowedProtocols: [Keypair.generate().publicKey],
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.protocolMode).to.equal(1);
      expect(params.protocols.length).to.equal(1);
    });

    it("sets protocolMode=0 (all allowed) when no protocols specified", () => {
      const resolved = resolvePolicies({
        maxSpend: "500 USDC/day",
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.protocolMode).to.equal(0);
      expect(params.protocols.length).to.equal(0);
    });

    it("caps protocols at 10", () => {
      const protocols = Array.from(
        { length: 15 },
        () => Keypair.generate().publicKey,
      );
      const resolved = resolvePolicies({
        allowedProtocols: protocols,
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.protocols.length).to.be.at.most(10);
    });

    it("maps maxTransactionSize directly", () => {
      const resolved = resolvePolicies({
        maxSpend: "500 USDC/day",
        maxTransactionSize: BigInt(100_000_000),
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.maxTransactionSize).to.equal(BigInt(100_000_000));
    });

    it("falls back maxTransactionSize to dailySpendingCap when not set", () => {
      const resolved = resolvePolicies({
        maxSpend: "500 USDC/day",
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.maxTransactionSize).to.equal(params.dailySpendingCap);
    });

    it("does NOT reflect blockUnknownPrograms in vault params", () => {
      const resolved = resolvePolicies({
        blockUnknownPrograms: true,
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      // blockUnknownPrograms is client-side only — no corresponding field in params
      expect(params).to.not.have.property("blockUnknownPrograms");
    });

    it("does NOT reflect rateLimit in vault params", () => {
      const resolved = resolvePolicies({
        rateLimit: { maxTransactions: 10, windowMs: 3_600_000 },
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params).to.not.have.property("rateLimit");
    });

    it("does NOT reflect customCheck in vault params", () => {
      const resolved = resolvePolicies({
        customCheck: () => ({ allowed: true }),
      });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params).to.not.have.property("customCheck");
    });

    it("maps default policies to reasonable vault params", () => {
      const resolved = resolvePolicies();
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.dailySpendingCap).to.be.a("bigint");
      expect(params.dailySpendingCap > BigInt(0)).to.be.true;
      expect(params.maxLeverageBps).to.equal(0);
      expect(params.maxConcurrentPositions).to.equal(5);
      expect(params.developerFeeRate).to.equal(0);
      expect(params.feeDestination.equals(FEE_DEST)).to.be.true;
    });

    it("maps string policies ('500 USDC/day') correctly", () => {
      const resolved = resolvePolicies({ maxSpend: "500 USDC/day" });
      const params = mapPoliciesToVaultParams(resolved, 0, FEE_DEST);
      expect(params.dailySpendingCap).to.equal(BigInt(500_000_000));
    });

    it("passes optional parameters through", () => {
      const resolved = resolvePolicies();
      const params = mapPoliciesToVaultParams(resolved, 42, FEE_DEST, {
        developerFeeRate: 25,
        maxLeverageBps: 10000,
        maxConcurrentPositions: 3,
      });
      expect(params.vaultId).to.equal(42);
      expect(params.developerFeeRate).to.equal(25);
      expect(params.maxLeverageBps).to.equal(10000);
      expect(params.maxConcurrentPositions).to.equal(3);
    });
  });

  describe("harden() — vault creation", () => {
    it("shielded wallet is not hardened before harden()", async () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });
      expect(shielded.isHardened).to.be.false;
    });

    it("throws when owner === agent", async () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      const mockConnection = {} as Connection;
      try {
        await harden(shielded, {
          connection: mockConnection,
          ownerWallet: wallet, // same key as agent
        });
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Owner and agent must be different");
      }
    });

    it("auto-generates owner keypair when ownerWallet is omitted", async () => {
      // We can verify the auto-generation path by checking that the
      // function proceeds past the owner != agent check.
      // Full vault creation requires RPC, so we just verify the keypair logic.
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      // The full harden() will fail at RPC level, but we verify it gets
      // past the validation step by checking the error is about RPC, not ownership.
      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await harden(shielded, {
          connection: mockConnection,
          unsafeSkipTeeCheck: true,
        });
        expect.fail("Should have thrown (no real RPC)");
      } catch (e: any) {
        // Should NOT be about owner === agent
        expect(e.message).to.not.include("Owner and agent must be different");
      }
    });

    it("uses provided ownerWallet when given", async () => {
      const agentWallet = createMockWallet();
      const ownerWallet = createMockWallet(); // different key
      const shielded = shield(agentWallet, { maxSpend: "500 USDC/day" });

      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await harden(shielded, {
          connection: mockConnection,
          ownerWallet,
          unsafeSkipTeeCheck: true,
        });
        expect.fail("Should have thrown (no real RPC)");
      } catch (e: any) {
        // Should NOT be about owner === agent
        expect(e.message).to.not.include("Owner and agent must be different");
      }
    });

    it("feeDestination defaults to owner pubkey in mapPoliciesToVaultParams", () => {
      const ownerPk = Keypair.generate().publicKey;
      const resolved = resolvePolicies({ maxSpend: "500 USDC/day" });
      const params = mapPoliciesToVaultParams(resolved, 0, ownerPk);
      expect(params.feeDestination.equals(ownerPk)).to.be.true;
    });
  });

  describe("harden() — ShieldedWallet interface", () => {
    it("resolvedPolicies getter returns current policies", () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      const rp = shielded.resolvedPolicies;
      expect(rp).to.not.be.undefined;
      expect(rp.spendLimits.length).to.be.greaterThan(0);
      expect(rp.spendLimits[0].amount).to.equal(BigInt(500_000_000));
    });

    it("resolvedPolicies updates after updatePolicies()", () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      shielded.updatePolicies({ maxSpend: "1000 USDC/day" });
      const rp = shielded.resolvedPolicies;
      expect(rp.spendLimits[0].amount).to.equal(BigInt(1_000_000_000));
    });

    it("spending state is shared via shieldState reference", () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      // Record spend on the state
      const mint = USDC_MINT.toBase58();
      shielded.shieldState.recordSpend(mint, BigInt(100_000_000));

      // Should be reflected in summary
      const summary = shielded.getSpendingSummary();
      expect(summary.tokens[0].spent).to.equal(BigInt(100_000_000));
    });

    it("isHardened is false for shield() wallet", () => {
      const wallet = createMockWallet();
      const shielded = shield(wallet);
      expect(shielded.isHardened).to.be.false;
    });
  });

  describe("withVault()", () => {
    it("creates shield + passes to harden", async () => {
      const wallet = createMockWallet();
      const mockConnection = {} as Connection;

      // withVault will fail at harden() level (no real RPC), but we verify
      // it creates a shielded wallet internally by checking the error
      try {
        await withVault(
          wallet,
          { maxSpend: "500 USDC/day" },
          {
            connection: mockConnection,
            ownerWallet: wallet, // same as agent — triggers owner===agent check
            unsafeSkipTeeCheck: true,
          },
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Owner and agent must be different");
      }
    });

    it("passes policies correctly through shield to harden", async () => {
      const agentWallet = createMockWallet();
      const ownerWallet = createMockWallet();

      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await withVault(
          agentWallet,
          { maxSpend: "500 USDC/day" },
          {
            connection: mockConnection,
            ownerWallet,
            unsafeSkipTeeCheck: true,
          },
        );
        expect.fail("Should have thrown (no real RPC)");
      } catch (e: any) {
        // Should get past validation to the RPC stage
        expect(e.message).to.not.include("Owner and agent must be different");
      }
    });
  });

  describe("TeeWallet detection", () => {
    it("isTeeWallet returns true for wallet with provider field", () => {
      const kp = Keypair.generate();
      const teeWallet: TeeWallet = {
        publicKey: kp.publicKey,
        provider: "crossmint",
        async signTransaction<T extends Transaction | VersionedTransaction>(
          tx: T,
        ): Promise<T> {
          return tx;
        },
      };
      expect(isTeeWallet(teeWallet)).to.be.true;
    });

    it("isTeeWallet returns false for plain wallet", () => {
      const wallet = createMockWallet();
      expect(isTeeWallet(wallet)).to.be.false;
    });

    it("isTeeWallet returns false for wallet with non-string provider", () => {
      const kp = Keypair.generate();
      const wallet = {
        publicKey: kp.publicKey,
        provider: 42, // not a string
        async signTransaction<T extends Transaction | VersionedTransaction>(
          tx: T,
        ): Promise<T> {
          return tx;
        },
      };
      expect(isTeeWallet(wallet as any)).to.be.false;
    });
  });

  describe("TEE enforcement", () => {
    it("harden() throws TeeRequiredError for non-TEE wallet without opt-out", async () => {
      const wallet = createMockWallet();
      const ownerWallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await harden(shielded, {
          connection: mockConnection,
          ownerWallet,
        });
        expect.fail("Should have thrown TeeRequiredError");
      } catch (e: any) {
        expect(e).to.be.instanceOf(TeeRequiredError);
        expect(e.name).to.equal("TeeRequiredError");
        expect(e.message).to.include("TEE wallet required");
      }
    });

    it("harden() skips TEE check with unsafeSkipTeeCheck: true", async () => {
      const wallet = createMockWallet();
      const ownerWallet = createMockWallet();
      const shielded = shield(wallet, { maxSpend: "500 USDC/day" });

      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await harden(shielded, {
          connection: mockConnection,
          ownerWallet,
          unsafeSkipTeeCheck: true,
        });
        expect.fail("Should have thrown (no real RPC)");
      } catch (e: any) {
        // Should NOT be TeeRequiredError — should get past TEE check to RPC
        expect(e).to.not.be.instanceOf(TeeRequiredError);
      }
    });

    it("harden() accepts TEE wallet without opt-out", async () => {
      const kp = Keypair.generate();
      const teeWallet: TeeWallet = {
        publicKey: kp.publicKey,
        provider: "crossmint",
        async signTransaction<T extends Transaction | VersionedTransaction>(
          tx: T,
        ): Promise<T> {
          return tx;
        },
      };
      const ownerWallet = createMockWallet();
      const shielded = shield(teeWallet, { maxSpend: "500 USDC/day" });

      const mockConnection = {
        getAccountInfo: async () => null,
      } as unknown as Connection;

      try {
        await harden(shielded, {
          connection: mockConnection,
          ownerWallet,
        });
        expect.fail("Should have thrown (no real RPC)");
      } catch (e: any) {
        // Should NOT be TeeRequiredError — TEE wallet passes the check
        expect(e).to.not.be.instanceOf(TeeRequiredError);
      }
    });

    it("withVault() enforces TEE requirement", async () => {
      const wallet = createMockWallet();
      const ownerWallet = createMockWallet();
      const mockConnection = {} as Connection;

      try {
        await withVault(
          wallet,
          { maxSpend: "500 USDC/day" },
          {
            connection: mockConnection,
            ownerWallet,
          },
        );
        expect.fail("Should have thrown TeeRequiredError");
      } catch (e: any) {
        expect(e).to.be.instanceOf(TeeRequiredError);
      }
    });

    it("TeeRequiredError has correct name and message", () => {
      const err = new TeeRequiredError();
      expect(err.name).to.equal("TeeRequiredError");
      expect(err.message).to.include("TEE wallet required");
      expect(err.message).to.include("Crossmint");
      expect(err.message).to.include("unsafeSkipTeeCheck");
    });
  });
});
