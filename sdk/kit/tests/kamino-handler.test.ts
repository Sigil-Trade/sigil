/**
 * Kamino Handler Tests — API-backed with 7 actions
 *
 * Tests handler metadata, summarize, compose dispatch, and error cases.
 * No live API calls — tests handler structure and error paths.
 */

import { expect } from "chai";
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import type { ProtocolContext } from "../src/integrations/protocol-handler.js";
import { KaminoHandler } from "../src/integrations/t2-handlers.js";
import { KaminoComposeError, COMPOSE_ERROR_CODES } from "../src/integrations/compose-errors.js";
import { dispatchKaminoCompose } from "../src/integrations/kamino-api.js";
import { ActionType } from "../src/generated/types/actionType.js";

// ─── Test Context ────────────────────────────────────────────────────────────

const FAKE_VAULT = "11111111111111111111111111111111" as Address;
const FAKE_OWNER = "22222222222222222222222222222222" as Address;
const FAKE_AGENT = "33333333333333333333333333333333" as Address;

function makeCtx(): ProtocolContext {
  return {
    rpc: {} as Rpc<SolanaRpcApi>,
    network: "mainnet-beta",
    vault: FAKE_VAULT,
    owner: FAKE_OWNER,
    vaultId: 1n,
    agent: FAKE_AGENT,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Kamino Handler (API-backed)", () => {
  const handler = new KaminoHandler();

  describe("Metadata", () => {
    it("has protocolId 'kamino-lending'", () => {
      expect(handler.metadata.protocolId).to.equal("kamino-lending");
    });

    it("has displayName 'Kamino Lending'", () => {
      expect(handler.metadata.displayName).to.equal("Kamino Lending");
    });

    it("has KLend program ID", () => {
      expect(handler.metadata.programIds[0]).to.equal(
        "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM",
      );
    });

    it("supports 7 actions", () => {
      expect(handler.metadata.supportedActions.size).to.equal(7);
    });

    it("has correct action names", () => {
      const actions = [...handler.metadata.supportedActions.keys()];
      expect(actions).to.include.members([
        "deposit", "withdraw", "borrow", "repay",
        "vaultDeposit", "vaultWithdraw", "multiply",
      ]);
    });

    it("deposit is spending", () => {
      const desc = handler.metadata.supportedActions.get("deposit");
      expect(desc?.isSpending).to.be.true;
      expect(desc?.actionType).to.equal(ActionType.Deposit);
    });

    it("borrow is non-spending", () => {
      const desc = handler.metadata.supportedActions.get("borrow");
      expect(desc?.isSpending).to.be.false;
      expect(desc?.actionType).to.equal(ActionType.Withdraw);
    });

    it("repay is spending", () => {
      const desc = handler.metadata.supportedActions.get("repay");
      expect(desc?.isSpending).to.be.true;
      expect(desc?.actionType).to.equal(ActionType.Deposit);
    });

    it("withdraw is non-spending", () => {
      const desc = handler.metadata.supportedActions.get("withdraw");
      expect(desc?.isSpending).to.be.false;
      expect(desc?.actionType).to.equal(ActionType.Withdraw);
    });

    it("vaultDeposit is spending", () => {
      const desc = handler.metadata.supportedActions.get("vaultDeposit");
      expect(desc?.isSpending).to.be.true;
      expect(desc?.actionType).to.equal(ActionType.Deposit);
    });

    it("vaultWithdraw is non-spending", () => {
      const desc = handler.metadata.supportedActions.get("vaultWithdraw");
      expect(desc?.isSpending).to.be.false;
      expect(desc?.actionType).to.equal(ActionType.Withdraw);
    });

    it("multiply is spending", () => {
      const desc = handler.metadata.supportedActions.get("multiply");
      expect(desc?.isSpending).to.be.true;
      expect(desc?.actionType).to.equal(ActionType.Deposit);
    });
  });

  describe("summarize()", () => {
    it("deposit", () => {
      const s = handler.summarize("deposit", { amount: "1000000", tokenMint: "USDC" });
      expect(s).to.include("Kamino deposit");
      expect(s).to.include("1000000");
      expect(s).to.include("USDC");
    });

    it("borrow", () => {
      const s = handler.summarize("borrow", { amount: "500000", tokenMint: "SOL" });
      expect(s).to.include("Kamino borrow");
    });

    it("repay", () => {
      const s = handler.summarize("repay", { amount: "250000", tokenMint: "USDC" });
      expect(s).to.include("Kamino repay");
    });

    it("withdraw", () => {
      const s = handler.summarize("withdraw", { amount: "100000", tokenMint: "SOL" });
      expect(s).to.include("Kamino withdraw");
    });

    it("vaultDeposit", () => {
      const s = handler.summarize("vaultDeposit", { amount: "1000000", kvault: "ABC123" });
      expect(s).to.include("Kamino vault deposit");
    });

    it("vaultWithdraw", () => {
      const s = handler.summarize("vaultWithdraw", { amount: "1000000", kvault: "ABC123" });
      expect(s).to.include("Kamino vault withdraw");
    });

    it("multiply", () => {
      const s = handler.summarize("multiply", {
        amount: "1000000",
        depositToken: "USDC",
        targetLeverage: 3,
      });
      expect(s).to.include("Kamino multiply");
      expect(s).to.include("3x");
    });

    it("unknown action fallback", () => {
      const s = handler.summarize("unknownAction", {});
      expect(s).to.include("Kamino unknownAction");
    });
  });

  describe("Error cases (dispatchKaminoCompose)", () => {
    const ctx = makeCtx();

    it("throws KaminoComposeError for unsupported action", async () => {
      try {
        await dispatchKaminoCompose(ctx, "liquidate", {});
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.UNSUPPORTED_ACTION);
        expect(e.message).to.include("liquidate");
      }
    });

    it("throws for missing tokenMint on deposit", async () => {
      try {
        await dispatchKaminoCompose(ctx, "deposit", { amount: "100" });
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.MISSING_PARAM);
      }
    });

    it("throws for missing amount on deposit", async () => {
      try {
        await dispatchKaminoCompose(ctx, "deposit", { tokenMint: "USDC" });
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.MISSING_PARAM);
      }
    });

    it("throws for invalid bigint on deposit", async () => {
      try {
        await dispatchKaminoCompose(ctx, "deposit", {
          tokenMint: "USDC",
          amount: "not-a-number",
        });
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.INVALID_BIGINT);
      }
    });

    it("throws for missing kvault on vaultDeposit", async () => {
      try {
        await dispatchKaminoCompose(ctx, "vaultDeposit", { amount: "100" });
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.MISSING_PARAM);
      }
    });

    it("throws for missing depositToken on multiply", async () => {
      try {
        await dispatchKaminoCompose(ctx, "multiply", {
          borrowToken: "SOL",
          amount: "1000000",
        });
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.name).to.equal("KaminoComposeError");
        expect(e.code).to.equal(COMPOSE_ERROR_CODES.MISSING_PARAM);
      }
    });

    it("error message lists supported actions", async () => {
      try {
        await dispatchKaminoCompose(ctx, "badAction", {});
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("deposit");
        expect(e.message).to.include("vaultDeposit");
        expect(e.message).to.include("multiply");
      }
    });
  });
});
