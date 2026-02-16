import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  shield,
  ShieldDeniedError,
  ShieldState,
  parseSpendLimit,
  ShieldConfigError,
  analyzeTransaction,
  evaluatePolicy,
  resolvePolicies,
  KNOWN_PROTOCOLS,
  KNOWN_TOKENS,
  isSystemProgram,
  isKnownProtocol,
  getTokenInfo,
  getProtocolName,
} from "../src";
import type { WalletLike, ShieldStorage } from "../src";

// --- Test Helpers ---

const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
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
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      this.signCount++;
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
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
function buildProgramTx(
  payer: PublicKey,
  programId: PublicKey,
): Transaction {
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

describe("@agent-shield/solana", () => {
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
      expect(
        KNOWN_PROTOCOLS.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
      ).to.be.true;
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
        allowedProtocols: [
          "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu",
        ],
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
  });
});
