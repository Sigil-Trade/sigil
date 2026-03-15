/**
 * Kamino API Client + Verification Tests
 *
 * Tests deserialization, config, HTTPS enforcement, verification, and error handling.
 * Mirrors jupiter-handler.test.ts patterns — no live API calls.
 */

import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  configureKaminoApi,
  getKaminoApiConfig,
  resetKaminoApiConfig,
  deserializeKaminoInstruction,
  KaminoApiError,
  type KaminoSerializedInstruction,
} from "../src/integrations/kamino-api.js";
import { verifyKaminoInstructions } from "../src/integrations/kamino-verify.js";
import {
  DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR,
  BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR,
  WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR,
} from "../src/constraints/protocols/kamino-schema.js";

const FAKE_VAULT = "11111111111111111111111111111111" as Address;
const KAMINO_PROGRAM = "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;

// ─── Helper: Build a fake serialized instruction ─────────────────────────────

function fakeSerializedIx(
  programId: string,
  isSigner = false,
  isWritable = true,
  data = "AAAAAAAAAAAAAAAAAAA=", // 16 zero bytes base64
): KaminoSerializedInstruction {
  return {
    programId,
    accounts: [
      { pubkey: FAKE_VAULT, isSigner, isWritable },
      { pubkey: "22222222222222222222222222222222", isSigner: false, isWritable: true },
    ],
    data,
  };
}

function buildKaminoIx(discriminator: Uint8Array, amount: bigint, signerVault = true): Instruction {
  const data = new Uint8Array(16);
  data.set(discriminator, 0);
  // Write amount as u64 LE at offset 8
  let val = amount;
  for (let i = 0; i < 8; i++) {
    data[8 + i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  return {
    programAddress: KAMINO_PROGRAM,
    accounts: [
      {
        address: FAKE_VAULT,
        role: signerVault ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE,
      },
    ],
    data,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Kamino API Client", () => {
  afterEach(() => {
    resetKaminoApiConfig();
  });

  describe("Configuration", () => {
    it("has sensible defaults", () => {
      const config = getKaminoApiConfig();
      expect(config.baseUrl).to.equal("https://api.kamino.finance");
      expect(config.maxRetries).to.equal(3);
      expect(config.retryDelayMs).to.equal(1000);
      expect(config.timeoutMs).to.equal(30_000);
      expect(config.env).to.equal("mainnet-beta");
    });

    it("freezes config (immutable)", () => {
      const config = getKaminoApiConfig();
      expect(Object.isFrozen(config)).to.be.true;
    });

    it("configureKaminoApi updates values", () => {
      configureKaminoApi({ env: "devnet", maxRetries: 5 });
      const config = getKaminoApiConfig();
      expect(config.env).to.equal("devnet");
      expect(config.maxRetries).to.equal(5);
    });

    it("resetKaminoApiConfig restores defaults", () => {
      configureKaminoApi({ env: "devnet" });
      resetKaminoApiConfig();
      expect(getKaminoApiConfig().env).to.equal("mainnet-beta");
    });

    it("enforces HTTPS for non-localhost URLs", () => {
      expect(() => configureKaminoApi({ baseUrl: "http://api.kamino.finance" }))
        .to.throw("HTTPS");
    });

    it("allows http://localhost for testing", () => {
      expect(() => configureKaminoApi({ baseUrl: "http://localhost:8080" }))
        .to.not.throw();
    });

    it("allows http://127.0.0.1 for testing", () => {
      expect(() => configureKaminoApi({ baseUrl: "http://127.0.0.1:8080" }))
        .to.not.throw();
    });

    it("strips trailing slashes from baseUrl", () => {
      configureKaminoApi({ baseUrl: "https://api.kamino.finance/" });
      expect(getKaminoApiConfig().baseUrl).to.equal("https://api.kamino.finance");
    });
  });

  describe("Deserialization", () => {
    it("maps programId to programAddress", () => {
      const ix = deserializeKaminoInstruction(fakeSerializedIx(KAMINO_PROGRAM));
      expect(ix.programAddress).to.equal(KAMINO_PROGRAM);
    });

    it("maps isSigner+isWritable to WRITABLE_SIGNER", () => {
      const ix = deserializeKaminoInstruction(
        fakeSerializedIx(KAMINO_PROGRAM, true, true),
      );
      expect(ix.accounts![0].role).to.equal(AccountRole.WRITABLE_SIGNER);
    });

    it("maps isSigner+!isWritable to READONLY_SIGNER", () => {
      const ix = deserializeKaminoInstruction(
        fakeSerializedIx(KAMINO_PROGRAM, true, false),
      );
      expect(ix.accounts![0].role).to.equal(AccountRole.READONLY_SIGNER);
    });

    it("maps !isSigner+isWritable to WRITABLE", () => {
      const ix = deserializeKaminoInstruction(
        fakeSerializedIx(KAMINO_PROGRAM, false, true),
      );
      expect(ix.accounts![0].role).to.equal(AccountRole.WRITABLE);
    });

    it("maps !isSigner+!isWritable to READONLY", () => {
      const ix = deserializeKaminoInstruction(
        fakeSerializedIx(KAMINO_PROGRAM, false, false),
      );
      expect(ix.accounts![0].role).to.equal(AccountRole.READONLY);
    });

    it("decodes base64 data to Uint8Array", () => {
      // "AQID" = [1, 2, 3]
      const ix = deserializeKaminoInstruction({
        programId: KAMINO_PROGRAM,
        accounts: [],
        data: "AQID",
      });
      expect(ix.data).to.deep.equal(new Uint8Array([1, 2, 3]));
    });
  });

  describe("KaminoApiError", () => {
    it("has statusCode and body", () => {
      const err = new KaminoApiError(429, "rate limited");
      expect(err.statusCode).to.equal(429);
      expect(err.body).to.equal("rate limited");
      expect(err.name).to.equal("KaminoApiError");
    });

    it("includes status code in message", () => {
      const err = new KaminoApiError(500, "internal");
      expect(err.message).to.include("500");
    });
  });
});

describe("Kamino Verification", () => {
  describe("Program ID check", () => {
    it("accepts instructions with allowed programs", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 1000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.not.throw();
    });

    it("rejects instructions with unexpected programs", () => {
      const ixs: Instruction[] = [{
        programAddress: "BADPROGRAM1111111111111111111111111111111" as Address,
        accounts: [{ address: FAKE_VAULT, role: AccountRole.WRITABLE_SIGNER }],
        data: new Uint8Array(16),
      }];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.throw("Unexpected program");
    });
  });

  describe("Discriminator check", () => {
    it("passes when discriminator matches deposit", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 1000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.not.throw();
    });

    it("fails when discriminator mismatches", () => {
      // Use borrow discriminator but claim deposit action
      const ixs = [buildKaminoIx(BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR, 1000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.throw("Discriminator mismatch");
    });

    it("validates all 4 KLend discriminators", () => {
      const cases: [Uint8Array, string][] = [
        [DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, "deposit"],
        [BORROW_OBLIGATION_LIQUIDITY_DISCRIMINATOR, "borrow"],
        [REPAY_OBLIGATION_LIQUIDITY_DISCRIMINATOR, "repay"],
        [WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_DISCRIMINATOR, "withdraw"],
      ];
      for (const [disc, action] of cases) {
        const ixs = [buildKaminoIx(disc, 1000n)];
        expect(() => verifyKaminoInstructions(ixs, action, 1000n, FAKE_VAULT))
          .to.not.throw();
      }
    });
  });

  describe("Amount check", () => {
    it("passes when amount matches", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 500_000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 500_000n, FAKE_VAULT))
        .to.not.throw();
    });

    it("fails when amount mismatches", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 500_000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 999_999n, FAKE_VAULT))
        .to.throw("Amount mismatch");
    });

    it("skips amount check for zero expected amount", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 500_000n)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 0n, FAKE_VAULT))
        .to.not.throw();
    });
  });

  describe("Signer check", () => {
    it("passes when vault is signer", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 1000n, true)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.not.throw();
    });

    it("fails when vault is not signer", () => {
      const ixs = [buildKaminoIx(DEPOSIT_OBLIGATION_COLLATERAL_DISCRIMINATOR, 1000n, false)];
      expect(() => verifyKaminoInstructions(ixs, "deposit", 1000n, FAKE_VAULT))
        .to.throw("not found as signer");
    });
  });

  describe("Empty instructions", () => {
    it("throws for zero instructions", () => {
      expect(() => verifyKaminoInstructions([], "deposit", 1000n, FAKE_VAULT))
        .to.throw("zero instructions");
    });
  });
});
