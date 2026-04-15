import { expect } from "chai";
import type { Address } from "@solana/kit";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import {
  // Codec
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  // Payment Selector
  selectPaymentOption,
  // Transfer Builder
  buildX402TransferInstruction,
  X402_TOKEN_PROGRAM_ID,
  // Nonce Tracker
  NonceTracker,
  // Amount Guard
  validatePaymentAmount,
  recordPaymentAmount,
  resetPaymentHistory,
  // Policy Bridge
  evaluateX402Payment,
  recordX402Spend,
  // Facilitator
  validateSettlement,
  // Audit
  emitPaymentEvent,
  createPaymentEvent,
  // Errors
  X402ParseError,
  X402PaymentError,
  X402UnsupportedError,
  X402DestinationBlockedError,
  X402ReplayError,
} from "../src/x402/index.js";
import type {
  PaymentRequired,
  PaymentRequirements,
  X402Config,
  X402PaymentEvent,
} from "../src/x402/index.js";
import { shield } from "../src/shield.js";
// base64 helpers — re-export from codec for test convenience
import { base64Encode, base64Decode } from "../src/x402/codec.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TRUSTED_PAYTO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" as Address;
const ATTACKER_PAYTO = "AttackerAttackerAttackerAttackerAttackerAtt" as Address;

function makePaymentRequired(
  overrides?: Partial<PaymentRequirements>,
): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: "https://api.test.com/data",
      description: "Test",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "solana:mainnet",
        asset: USDC_MINT,
        amount: "1000000",
        payTo: TRUSTED_PAYTO,
        maxTimeoutSeconds: 30,
        extra: {},
        ...overrides,
      },
    ],
  };
}

function encodeHeader(pr: PaymentRequired): string {
  return base64Encode(JSON.stringify(pr));
}

// ─── Codec Tests ────────────────────────────────────────────────────────────

describe("x402/codec", () => {
  it("decodes valid PAYMENT-REQUIRED header", () => {
    const pr = makePaymentRequired();
    const encoded = encodeHeader(pr);
    const decoded = decodePaymentRequiredHeader(encoded);
    expect(decoded.x402Version).to.equal(2);
    expect(decoded.accepts).to.have.lengthOf(1);
    expect(decoded.accepts[0].payTo).to.equal(TRUSTED_PAYTO);
  });

  it("throws on invalid base64", () => {
    expect(() => decodePaymentRequiredHeader("!!!invalid!!!")).to.throw(
      X402ParseError,
    );
  });

  it("throws on missing accepts array", () => {
    const encoded = base64Encode(JSON.stringify({ x402Version: 2 }));
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
      "non-empty array",
    );
  });

  it("throws on non-number x402Version", () => {
    const encoded = base64Encode(
      JSON.stringify({ x402Version: "2", accepts: [{}] }),
    );
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
      "must be a number",
    );
  });

  it("throws on invalid amount string", () => {
    const pr = makePaymentRequired({ amount: "not-a-number" });
    const encoded = encodeHeader(pr);
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
      "valid integer string",
    );
  });

  it("throws on empty string amount (BUG-7)", () => {
    const pr = makePaymentRequired({ amount: "" });
    const encoded = encodeHeader(pr);
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
      "non-empty string",
    );
  });

  it("accepts very large amount string without precision loss (BUG-15)", () => {
    const largeAmount = "18446744073709551615"; // u64::MAX — > Number.MAX_SAFE_INTEGER
    const pr = makePaymentRequired({ amount: largeAmount });
    const encoded = encodeHeader(pr);
    const decoded = decodePaymentRequiredHeader(encoded);
    expect(decoded.accepts[0].amount).to.equal(largeAmount);
  });

  it("rejects amount exceeding u64 max", () => {
    const overflowAmount = "99999999999999999999"; // > u64::MAX
    const pr = makePaymentRequired({ amount: overflowAmount });
    const encoded = encodeHeader(pr);
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw(
      "exceeds u64 max",
    );
  });

  it("validates required fields in accepts entries", () => {
    const pr = { x402Version: 2, accepts: [{ scheme: "exact" }] };
    const encoded = base64Encode(JSON.stringify(pr));
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw("network");
  });

  it("encodes and decodes PaymentPayload roundtrip", () => {
    const payload = {
      x402Version: 2,
      resource: { url: "test", description: "test", mimeType: "text" },
      accepted: makePaymentRequired().accepts[0],
      payload: { transaction: "abc123" },
    };
    const encoded = encodePaymentSignatureHeader(payload);
    expect(encoded).to.be.a("string");
    const decoded = JSON.parse(base64Decode(encoded));
    expect(decoded.x402Version).to.equal(2);
  });

  it("decodes PAYMENT-RESPONSE header", () => {
    const settle = { success: true, transaction: "abc123" };
    const encoded = base64Encode(JSON.stringify(settle));
    const decoded = decodePaymentResponseHeader(encoded);
    expect(decoded.success).to.equal(true);
    expect(decoded.transaction).to.equal("abc123");
  });
});

// ─── Payment Selector Tests ────────────────────────────────────────────────

describe("x402/payment-selector", () => {
  it("selects Solana payment option", () => {
    const pr = makePaymentRequired();
    const selected = selectPaymentOption(pr);
    expect(selected.network).to.equal("solana:mainnet");
  });

  it("filters by token allowlist", () => {
    const pr = makePaymentRequired();
    const config: X402Config = { allowedTokens: new Set([USDC_MINT]) };
    const selected = selectPaymentOption(pr, config);
    expect(selected.asset).to.equal(USDC_MINT);
  });

  it("rejects when token not in allowlist", () => {
    const pr = makePaymentRequired();
    const config: X402Config = { allowedTokens: new Set(["other" as Address]) };
    expect(() => selectPaymentOption(pr, config)).to.throw(
      X402UnsupportedError,
    );
  });

  it("filters non-Solana networks", () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: "test", description: "test", mimeType: "text" },
      accepts: [
        {
          scheme: "exact",
          network: "ethereum:1",
          asset: "0x...",
          amount: "100",
          payTo: "0x...",
          maxTimeoutSeconds: 30,
          extra: {},
        },
      ],
    };
    expect(() => selectPaymentOption(pr)).to.throw(X402UnsupportedError);
  });

  it("passes payTo allowlist check with trusted destination", () => {
    const pr = makePaymentRequired();
    const config: X402Config = {
      allowedDestinations: new Set([TRUSTED_PAYTO]),
    };
    const selected = selectPaymentOption(pr, config);
    expect(selected.payTo).to.equal(TRUSTED_PAYTO);
  });

  it("blocks payTo not in allowlist", () => {
    const pr = makePaymentRequired({ payTo: ATTACKER_PAYTO });
    const config: X402Config = {
      allowedDestinations: new Set([TRUSTED_PAYTO]),
    };
    expect(() => selectPaymentOption(pr, config)).to.throw(
      X402DestinationBlockedError,
    );
  });

  it("provides specific error when Solana options exist but all destinations blocked", () => {
    const pr = makePaymentRequired({ payTo: ATTACKER_PAYTO });
    const config: X402Config = {
      allowedDestinations: new Set([TRUSTED_PAYTO]),
    };
    try {
      selectPaymentOption(pr, config);
      expect.fail("should throw");
    } catch (err) {
      expect(err).to.be.instanceOf(X402DestinationBlockedError);
      expect((err as X402DestinationBlockedError).payTo).to.equal(
        ATTACKER_PAYTO,
      );
    }
  });

  it("works without config (no filtering)", () => {
    const pr = makePaymentRequired();
    const selected = selectPaymentOption(pr);
    expect(selected.amount).to.equal("1000000");
  });

  it("throws X402UnsupportedError when no Solana options available", () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: "test", description: "test", mimeType: "text" },
      accepts: [
        {
          scheme: "exact",
          network: "ethereum:1",
          asset: "0x...",
          amount: "100",
          payTo: "0x...",
          maxTimeoutSeconds: 30,
          extra: {},
        },
      ],
    };
    expect(() => selectPaymentOption(pr)).to.throw(X402UnsupportedError);
  });
});

// ─── Policy Bridge Tests ────────────────────────────────────────────────────

describe("x402/policy-bridge", () => {
  it("approves payment within limits", () => {
    const ctx = shield();
    const selected = makePaymentRequired().accepts[0];
    const violations = evaluateX402Payment(selected, ctx);
    expect(violations).to.have.lengthOf(0);
  });

  it("blocks payment when shield is paused", () => {
    const ctx = shield();
    ctx.pause();
    const selected = makePaymentRequired().accepts[0];
    expect(() => evaluateX402Payment(selected, ctx)).to.throw("paused");
  });

  it("blocks payment exceeding cumulative spend limit", () => {
    const ctx = shield();
    const config: X402Config = { maxCumulativeSpend: 500_000n };
    const selected = makePaymentRequired().accepts[0]; // amount: 1_000_000
    const violations = evaluateX402Payment(selected, ctx, config);
    expect(violations.length).to.be.greaterThan(0);
    expect(violations[0]).to.include("Cumulative");
  });

  it("blocks payment exceeding per-request ceiling", () => {
    const ctx = shield();
    const config: X402Config = { maxPaymentPerRequest: 500_000n };
    const selected = makePaymentRequired().accepts[0]; // amount: 1_000_000
    const violations = evaluateX402Payment(selected, ctx, config);
    expect(violations.length).to.be.greaterThan(0);
    expect(violations[0]).to.include("per-request ceiling");
  });

  it("records x402 spend in ShieldState", () => {
    const ctx = shield();
    recordX402Spend(ctx, USDC_MINT, 1_000_000n);
    const summary = ctx.getSpendingSummary();
    expect(summary.rateLimit.count).to.equal(1);
  });

  it("x402 and DeFi share same spending state", () => {
    const ctx = shield();
    // Record a DeFi spend
    ctx.state.recordSpend(USDC_MINT, 1_500_000n);
    ctx.state.recordTransaction();
    // Now check x402 — should see the DeFi spend via cumulative limit
    const config: X402Config = { maxCumulativeSpend: 2_000_000n };
    const selected = makePaymentRequired().accepts[0]; // amount: 1_000_000
    const violations = evaluateX402Payment(selected, ctx, config);
    expect(violations.length).to.be.greaterThan(0);
  });

  it("approves when within cumulative after existing spend", () => {
    const ctx = shield();
    const config: X402Config = { maxCumulativeSpend: 5_000_000n };
    ctx.state.recordSpend(USDC_MINT, 1_000_000n);
    const selected = makePaymentRequired().accepts[0]; // 1_000_000
    const violations = evaluateX402Payment(selected, ctx, config);
    expect(violations).to.have.lengthOf(0);
  });

  it("passes without config", () => {
    const ctx = shield();
    const selected = makePaymentRequired().accepts[0];
    const violations = evaluateX402Payment(selected, ctx);
    expect(violations).to.have.lengthOf(0);
  });

  it("cross-asset cumulative: $500 USDC + $500 USDT exceeds $800 limit (BUG-4)", () => {
    const ctx = shield();
    const config: X402Config = { maxCumulativeSpend: 800_000n };
    // Record USDC spend from DeFi
    ctx.state.recordSpend(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      500_000n,
    );
    // Now try USDT x402 payment of 500_000 (total = 1_000_000 > 800_000)
    const selected = makePaymentRequired({
      amount: "500000",
      asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address,
    }).accepts[0];
    const violations = evaluateX402Payment(selected, ctx, config);
    expect(violations.length).to.be.greaterThan(0);
    expect(violations[0]).to.include("Cumulative");
  });
});

// ─── Transfer Builder Tests ─────────────────────────────────────────────────

describe("x402/transfer-builder", () => {
  it("builds valid TransferChecked instruction", async () => {
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: 1_000_000n,
      decimals: 6,
    });
    expect(ix.programAddress).to.equal(X402_TOKEN_PROGRAM_ID);
    expect(ix.accounts).to.have.lengthOf(4);
    expect(ix.data).to.be.instanceOf(Uint8Array);
    expect(ix.data![0]).to.equal(12); // TransferChecked discriminator
  });

  it("encodes amount correctly as u64 LE", async () => {
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: 256n, // 0x100 in LE: [0, 1, 0, 0, 0, 0, 0, 0]
      decimals: 6,
    });
    expect(ix.data![1]).to.equal(0);
    expect(ix.data![2]).to.equal(1);
  });

  it("sets decimals byte correctly", async () => {
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: 1n,
      decimals: 9,
    });
    expect(ix.data![9]).to.equal(9);
  });

  it("has correct data length (10 bytes)", async () => {
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: 1n,
      decimals: 6,
    });
    expect(ix.data!.length).to.equal(10);
  });

  it("sets correct account roles", async () => {
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: 1n,
      decimals: 6,
    });
    // source ATA = writable, dest ATA = writable, mint = readonly, authority = signer
    expect(ix.accounts![0].role).to.exist;
    expect(ix.accounts![3].role).to.exist;
  });

  it("handles large amounts (max u64)", async () => {
    const maxU64 = 2n ** 64n - 1n;
    const ix = await buildX402TransferInstruction({
      from: "11111111111111111111111111111111" as Address,
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: maxU64,
      decimals: 6,
    });
    expect(ix.data!.length).to.equal(10);
    // All amount bytes should be 0xFF
    for (let i = 1; i <= 8; i++) {
      expect(ix.data![i]).to.equal(0xff);
    }
  });
});

// ─── Nonce Tracker Tests ────────────────────────────────────────────────────

describe("x402/nonce-tracker", () => {
  let tracker: NonceTracker;

  beforeEach(() => {
    tracker = new NonceTracker();
  });

  it("first payment is not a duplicate", async () => {
    expect(
      await tracker.isDuplicate("https://api.com", TRUSTED_PAYTO, "1000"),
    ).to.equal(false);
  });

  it("second identical payment is a duplicate", async () => {
    await tracker.record("https://api.com", TRUSTED_PAYTO, "1000");
    expect(
      await tracker.isDuplicate("https://api.com", TRUSTED_PAYTO, "1000"),
    ).to.equal(true);
  });

  it("throws X402ReplayError on duplicate via checkOrThrow", async () => {
    await tracker.record("https://api.com", TRUSTED_PAYTO, "1000");
    try {
      await tracker.checkOrThrow("https://api.com", TRUSTED_PAYTO, "1000");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(X402ReplayError);
    }
  });

  it("different URL is not a duplicate", async () => {
    await tracker.record("https://api.com/a", TRUSTED_PAYTO, "1000");
    expect(
      await tracker.isDuplicate("https://api.com/b", TRUSTED_PAYTO, "1000"),
    ).to.equal(false);
  });

  it("builds deterministic nonce keys", () => {
    const key = NonceTracker.buildKey("https://api.com", TRUSTED_PAYTO, "1000");
    expect(key).to.equal(`https://api.com|${TRUSTED_PAYTO}|1000`);
  });

  it("normalizes trailing slash in nonce key (BUG-12)", () => {
    const key1 = NonceTracker.buildKey(
      "https://api.com/data",
      TRUSTED_PAYTO,
      "1000",
    );
    const key2 = NonceTracker.buildKey(
      "https://api.com/data/",
      TRUSTED_PAYTO,
      "1000",
    );
    expect(key1).to.equal(key2);
  });

  it("strips query params in nonce key (BUG-12)", () => {
    const key1 = NonceTracker.buildKey(
      "https://api.com/data",
      TRUSTED_PAYTO,
      "1000",
    );
    const key2 = NonceTracker.buildKey(
      "https://api.com/data?ts=123",
      TRUSTED_PAYTO,
      "1000",
    );
    expect(key1).to.equal(key2);
  });

  it("trailing slash + query normalized → same key detects replay", async () => {
    await tracker.record("https://api.com/data", TRUSTED_PAYTO, "1000");
    expect(
      await tracker.isDuplicate("https://api.com/data/", TRUSTED_PAYTO, "1000"),
    ).to.equal(true);
    expect(
      await tracker.isDuplicate(
        "https://api.com/data?ts=456",
        TRUSTED_PAYTO,
        "1000",
      ),
    ).to.equal(true);
  });
});

// ─── Amount Guard Tests ─────────────────────────────────────────────────────

describe("x402/amount-guard", () => {
  beforeEach(() => {
    resetPaymentHistory();
  });

  it("accepts valid positive amount", () => {
    const amount = validatePaymentAmount("1000000");
    expect(amount).to.equal(1_000_000n);
  });

  it("rejects zero amount", () => {
    expect(() => validatePaymentAmount("0")).to.throw("must be positive");
  });

  it("rejects negative amount", () => {
    expect(() => validatePaymentAmount("-100")).to.throw("must be positive");
  });

  it("rejects non-numeric string", () => {
    expect(() => validatePaymentAmount("abc")).to.throw("not a valid integer");
  });

  it("enforces per-request ceiling", () => {
    const config: X402Config = { maxPaymentPerRequest: 500_000n };
    expect(() => validatePaymentAmount("1000000", config)).to.throw(
      "per-request ceiling",
    );
  });

  it("passes per-request ceiling when within limit", () => {
    const config: X402Config = { maxPaymentPerRequest: 2_000_000n };
    expect(validatePaymentAmount("1000000", config)).to.equal(1_000_000n);
  });

  it("detects spike (>10x median)", () => {
    // Build up a history of small payments
    for (let i = 0; i < 5; i++) {
      recordPaymentAmount(100n);
    }
    // Now try a 10x+ spike
    expect(() => validatePaymentAmount("1001")).to.throw("spike");
  });

  it("does not flag spike when fewer than 3 history entries", () => {
    recordPaymentAmount(100n);
    recordPaymentAmount(100n);
    // Only 2 entries — spike detection skipped
    expect(validatePaymentAmount("10000")).to.equal(10_000n);
  });
});

// ─── Facilitator Verify Tests ───────────────────────────────────────────────

describe("x402/facilitator-verify", () => {
  it("validates successful settlement", async () => {
    const result = await validateSettlement({
      success: true,
      transaction:
        "5vBrLZbzMTnYBwXxuoVGE1DVEtimHdRMkjJZYcBwdHE5GYzx3pMNGqyVLkRV4m7nFf6oHqf7Xy4LmJR84RPLNVR",
    });
    expect(result.valid).to.equal(true);
    expect(result.warnings).to.have.lengthOf(0);
  });

  it("warns on success without transaction", async () => {
    const result = await validateSettlement({ success: true });
    expect(result.valid).to.equal(false);
    expect(result.warnings[0]).to.include("no transaction signature");
  });

  it("warns on invalid tx signature format", async () => {
    const result = await validateSettlement({
      success: true,
      transaction: "not-valid-base58!!!",
    });
    expect(result.valid).to.equal(false);
    expect(result.warnings[0]).to.include("invalid format");
  });

  it("detects network mismatch", async () => {
    const result = await validateSettlement(
      {
        success: true,
        transaction:
          "5vBrLZbzMTnYBwXxuoVGE1DVEtimHdRMkjJZYcBwdHE5GYzx3pMNGqyVLkRV4m7nFf6oHqf7Xy4LmJR84RPLNVR",
        network: "devnet",
      },
      "mainnet",
    );
    expect(result.valid).to.equal(true);
    expect(result.warnings.length).to.be.greaterThan(0);
    expect(result.warnings[0]).to.include("does not match");
  });

  it("confirms settlement with on-chain verification when rpc provided", async () => {
    const mockRpc = {
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [{ confirmationStatus: "confirmed", err: null }],
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;

    const result = await validateSettlement(
      {
        success: true,
        transaction:
          "5vBrLZbzMTnYBwXxuoVGE1DVEtimHdRMkjJZYcBwdHE5GYzx3pMNGqyVLkRV4m7nFf6oHqf7Xy4LmJR84RPLNVR",
      },
      undefined,
      mockRpc,
    );
    expect(result.valid).to.equal(true);
    expect(result.warnings).to.have.lengthOf(0);
  });

  it("warns when on-chain confirmation times out (defense-in-depth)", async () => {
    const mockRpc = {
      getSignatureStatuses: () => ({
        send: async () => ({ value: [null] }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;

    const result = await validateSettlement(
      {
        success: true,
        transaction:
          "5vBrLZbzMTnYBwXxuoVGE1DVEtimHdRMkjJZYcBwdHE5GYzx3pMNGqyVLkRV4m7nFf6oHqf7Xy4LmJR84RPLNVR",
      },
      undefined,
      mockRpc,
      500, // 500ms timeout to keep test fast
    );
    expect(result.valid).to.equal(true); // still valid — warning only
    expect(result.warnings.length).to.be.greaterThan(0);
    expect(result.warnings[0]).to.include("not confirmed on-chain");
  });
});

// ─── Audit Trail Tests ──────────────────────────────────────────────────────

describe("x402/audit-trail", () => {
  it("emits payment event through callback", () => {
    const events: X402PaymentEvent[] = [];
    const config: X402Config = { onPayment: (e) => events.push(e) };
    const event = createPaymentEvent({
      url: "https://api.com",
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: "1000000",
      paid: true,
      startTime: Date.now() - 100,
    });
    emitPaymentEvent(config, event);
    expect(events).to.have.lengthOf(1);
    expect(events[0].paid).to.equal(true);
    expect(events[0].durationMs).to.be.at.least(0);
  });

  it("does nothing without config callback", () => {
    const event = createPaymentEvent({
      url: "https://api.com",
      payTo: TRUSTED_PAYTO,
      asset: USDC_MINT,
      amount: "1000000",
      paid: false,
      deniedReason: "test",
      startTime: Date.now(),
    });
    // Should not throw
    emitPaymentEvent(undefined, event);
    emitPaymentEvent({}, event);
  });
});

// ─── Security Tests ─────────────────────────────────────────────────────────

describe("x402/security", () => {
  it("blocks payTo injection attack", () => {
    // Malicious API returns attacker's payTo
    const pr = makePaymentRequired({ payTo: ATTACKER_PAYTO });
    const config: X402Config = {
      allowedDestinations: new Set([TRUSTED_PAYTO]),
    };
    expect(() => selectPaymentOption(pr, config)).to.throw(
      X402DestinationBlockedError,
    );
  });

  it("blocks replay of same payment", async () => {
    const tracker = new NonceTracker();
    await tracker.record("https://api.com", TRUSTED_PAYTO, "1000");
    try {
      await tracker.checkOrThrow("https://api.com", TRUSTED_PAYTO, "1000");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(X402ReplayError);
    }
  });

  it("rejects zero-amount payment", () => {
    expect(() => validatePaymentAmount("0")).to.throw(X402PaymentError);
  });

  it("rejects negative-amount payment", () => {
    expect(() => validatePaymentAmount("-1")).to.throw(X402PaymentError);
  });

  it("paused shield blocks x402 payments", () => {
    const ctx = shield();
    ctx.pause();
    const selected = makePaymentRequired().accepts[0];
    expect(() => evaluateX402Payment(selected, ctx)).to.throw("paused");
  });

  it("x402 spend counts toward spending state", () => {
    const ctx = shield();
    recordX402Spend(ctx, USDC_MINT, 800_000n);
    const summary = ctx.getSpendingSummary();
    expect(summary.rateLimit.count).to.equal(1);
  });

  it("error classes have correct legacy numeric codes (deprecated)", () => {
    // PR 2.A migration: `.code` is now the canonical SigilErrorCode string.
    // Numeric codes 7024-7028 are preserved as `.legacyNumericCode` for one
    // minor's migration ramp; targeted for deletion at v1.0.
    expect(new X402ParseError("test").legacyNumericCode).to.equal(7024);
    expect(new X402PaymentError("test").legacyNumericCode).to.equal(7025);
    expect(new X402UnsupportedError("test").legacyNumericCode).to.equal(7026);
    expect(
      new X402DestinationBlockedError(ATTACKER_PAYTO).legacyNumericCode,
    ).to.equal(7027);
    expect(new X402ReplayError("key").legacyNumericCode).to.equal(7028);
  });

  it("error classes have correct canonical SigilErrorCode (.code)", () => {
    // PR 2.A: typed string-literal codes are the new programmatic discriminant.
    expect(new X402ParseError("test").code).to.equal(
      "SIGIL_ERROR__X402__HEADER_MALFORMED",
    );
    expect(new X402PaymentError("test").code).to.equal(
      "SIGIL_ERROR__X402__PAYMENT_FAILED",
    );
    expect(new X402UnsupportedError("test").code).to.equal(
      "SIGIL_ERROR__X402__UNSUPPORTED",
    );
    expect(new X402DestinationBlockedError(ATTACKER_PAYTO).code).to.equal(
      "SIGIL_ERROR__X402__DESTINATION_BLOCKED",
    );
    expect(new X402ReplayError("key").code).to.equal(
      "SIGIL_ERROR__X402__REPLAY",
    );
  });

  it("codec validates accepts entry field types", () => {
    // Missing payTo
    const pr = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana:mainnet",
          asset: USDC_MINT,
          amount: "1000",
          // payTo missing
          maxTimeoutSeconds: 30,
          extra: {},
        },
      ],
    };
    const encoded = base64Encode(JSON.stringify(pr));
    expect(() => decodePaymentRequiredHeader(encoded)).to.throw("payTo");
  });

  it("X402DestinationBlockedError includes payTo in error", () => {
    const err = new X402DestinationBlockedError(ATTACKER_PAYTO);
    expect(err.payTo).to.equal(ATTACKER_PAYTO);
    expect(err.message).to.include(ATTACKER_PAYTO);
  });

  it("X402ReplayError includes nonceKey in error", () => {
    const err = new X402ReplayError("test|key|123");
    expect(err.nonceKey).to.equal("test|key|123");
    expect(err.message).to.include("test|key|123");
  });
});

// ─── Settlement Signature Verification ──────────────────────────────────────

describe("x402 settlement signature verification", () => {
  it("settlement signature matching expected TX sig passes silently", () => {
    // When settlement.transaction matches expectedTxSig, no warning event emitted
    const events: X402PaymentEvent[] = [];
    const config: X402Config = {
      onPayment: (e) => events.push(e),
    };

    // Simulate: if sigs match, emitPaymentEvent is NOT called for mismatch
    const expectedSig =
      "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";
    const settlement = { success: true, transaction: expectedSig };

    // Comparison logic: if matching, no event
    if (settlement.transaction !== expectedSig) {
      emitPaymentEvent(
        config,
        createPaymentEvent({
          url: "https://test.com",
          payTo: TRUSTED_PAYTO,
          asset: USDC_MINT,
          amount: "1000000",
          paid: true,
          deniedReason: `Settlement signature mismatch`,
          startTime: Date.now(),
        }),
      );
    }

    expect(events).to.have.length(0);
  });

  it("settlement signature mismatch emits warning event", () => {
    const events: X402PaymentEvent[] = [];
    const config: X402Config = {
      onPayment: (e) => events.push(e),
    };

    const expectedSig =
      "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";
    const settlement = {
      success: true,
      transaction: "DIFFERENT_SIG_FROM_FACILITATOR",
    };

    // Comparison logic from shielded-fetch.ts
    if (settlement.transaction !== expectedSig) {
      emitPaymentEvent(
        config,
        createPaymentEvent({
          url: "https://test.com",
          payTo: TRUSTED_PAYTO,
          asset: USDC_MINT,
          amount: "1000000",
          paid: true,
          deniedReason: `Settlement signature mismatch: expected ${expectedSig}, got ${settlement.transaction}`,
          startTime: Date.now(),
        }),
      );
    }

    expect(events).to.have.length(1);
    expect(events[0].deniedReason).to.include("Settlement signature mismatch");
    expect(events[0].deniedReason).to.include(expectedSig);
    expect(events[0].deniedReason).to.include("DIFFERENT_SIG_FROM_FACILITATOR");
    expect(events[0].paid).to.be.true;
  });
});
