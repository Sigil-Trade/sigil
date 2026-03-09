import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DRIFT_PROGRAM_ID_STR,
  DRIFT_QUOTE_PRECISION,
  DRIFT_BASE_PRECISION,
  DRIFT_PRICE_PRECISION,
  DRIFT_PERP_MARKETS,
  DRIFT_SPOT_MARKETS,
} from "../src/integrations/drift";
import { ProtocolRegistry } from "../src/integrations/protocol-registry";
import { DriftHandler } from "../src/integrations/drift-handler";

describe("Drift adapter", () => {
  describe("constants", () => {
    it("DRIFT_PROGRAM_ID_STR is a valid base58 public key", () => {
      const pk = new PublicKey(DRIFT_PROGRAM_ID_STR);
      expect(pk.toBase58()).to.equal(DRIFT_PROGRAM_ID_STR);
    });

    it("DRIFT_QUOTE_PRECISION is 10^6", () => {
      expect(DRIFT_QUOTE_PRECISION).to.equal(1_000_000);
    });

    it("DRIFT_BASE_PRECISION is 10^9", () => {
      expect(DRIFT_BASE_PRECISION).to.equal(1_000_000_000);
    });

    it("DRIFT_PRICE_PRECISION is 10^6", () => {
      expect(DRIFT_PRICE_PRECISION).to.equal(1_000_000);
    });
  });

  describe("market lookup tables", () => {
    it("DRIFT_PERP_MARKETS has SOL-PERP at index 0", () => {
      expect(DRIFT_PERP_MARKETS["SOL-PERP"]).to.equal(0);
    });

    it("DRIFT_PERP_MARKETS has BTC-PERP at index 1", () => {
      expect(DRIFT_PERP_MARKETS["BTC-PERP"]).to.equal(1);
    });

    it("DRIFT_PERP_MARKETS has ETH-PERP at index 2", () => {
      expect(DRIFT_PERP_MARKETS["ETH-PERP"]).to.equal(2);
    });

    it("DRIFT_SPOT_MARKETS has USDC at index 0", () => {
      expect(DRIFT_SPOT_MARKETS["USDC"]).to.equal(0);
    });

    it("DRIFT_SPOT_MARKETS has SOL at index 1", () => {
      expect(DRIFT_SPOT_MARKETS["SOL"]).to.equal(1);
    });

    it("DRIFT_SPOT_MARKETS has DRIFT at index 14", () => {
      expect(DRIFT_SPOT_MARKETS["DRIFT"]).to.equal(14);
    });
  });

  describe("DriftHandler", () => {
    let handler: DriftHandler;

    beforeEach(() => {
      handler = new DriftHandler();
    });

    it("has correct metadata.protocolId", () => {
      expect(handler.metadata.protocolId).to.equal("drift");
    });

    it("has correct metadata.displayName", () => {
      expect(handler.metadata.displayName).to.equal("Drift Protocol");
    });

    it("has correct programIds", () => {
      expect(handler.metadata.programIds).to.have.length(1);
      expect(handler.metadata.programIds[0].toBase58()).to.equal(
        DRIFT_PROGRAM_ID_STR,
      );
    });

    it("supports 7 actions", () => {
      expect(handler.metadata.supportedActions.size).to.equal(7);
    });

    describe("ActionType mappings", () => {
      it("deposit maps to deposit ActionType (spending)", () => {
        const desc = handler.metadata.supportedActions.get("deposit");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ deposit: {} });
        expect(desc!.isSpending).to.be.true;
      });

      it("withdraw maps to withdraw ActionType (non-spending)", () => {
        const desc = handler.metadata.supportedActions.get("withdraw");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ withdraw: {} });
        expect(desc!.isSpending).to.be.false;
      });

      it("placePerpOrder maps to openPosition ActionType (spending)", () => {
        const desc = handler.metadata.supportedActions.get("placePerpOrder");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ openPosition: {} });
        expect(desc!.isSpending).to.be.true;
      });

      it("placeSpotOrder maps to swap ActionType (spending)", () => {
        const desc = handler.metadata.supportedActions.get("placeSpotOrder");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ swap: {} });
        expect(desc!.isSpending).to.be.true;
      });

      it("cancelOrder maps to cancelLimitOrder ActionType (non-spending)", () => {
        const desc = handler.metadata.supportedActions.get("cancelOrder");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ cancelLimitOrder: {} });
        expect(desc!.isSpending).to.be.false;
      });

      it("modifyOrder maps to editLimitOrder ActionType (non-spending)", () => {
        const desc = handler.metadata.supportedActions.get("modifyOrder");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ editLimitOrder: {} });
        expect(desc!.isSpending).to.be.false;
      });

      it("settlePnl maps to closePosition ActionType (non-spending)", () => {
        const desc = handler.metadata.supportedActions.get("settlePnl");
        expect(desc).to.not.be.undefined;
        expect(desc!.actionType).to.deep.equal({ closePosition: {} });
        expect(desc!.isSpending).to.be.false;
      });
    });

    describe("summarize", () => {
      it("summarizes deposit action", () => {
        const summary = handler.summarize("deposit", {
          amount: "1000000",
          marketIndex: 0,
        });
        expect(summary).to.include("Drift deposit");
        expect(summary).to.include("market 0");
      });

      it("summarizes placePerpOrder action", () => {
        const summary = handler.summarize("placePerpOrder", {
          side: "long",
          marketIndex: 0,
          orderType: "limit",
          amount: "1000000000",
        });
        expect(summary).to.include("Drift long perp order");
        expect(summary).to.include("limit");
      });

      it("summarizes cancelOrder action", () => {
        const summary = handler.summarize("cancelOrder", { orderId: 42 });
        expect(summary).to.include("cancel order #42");
      });

      it("summarizes unknown action with fallback", () => {
        const summary = handler.summarize("unknownAction", {});
        expect(summary).to.equal("Drift unknownAction");
      });
    });

    describe("compose rejects unknown action", () => {
      it("throws for unsupported action", async () => {
        const ctx = {
          program: {} as any,
          connection: {} as any,
          vault: Keypair.generate().publicKey,
          owner: Keypair.generate().publicKey,
          vaultId: {} as any,
          agent: Keypair.generate().publicKey,
        };
        try {
          await handler.compose(ctx, "unknownAction", {});
          expect.fail("Should have thrown");
        } catch (e: any) {
          expect(e.message).to.include('unsupported action "unknownAction"');
        }
      });
    });

    describe("registry integration", () => {
      it("DriftHandler can be registered and looked up by protocol ID", () => {
        const registry = new ProtocolRegistry();
        const h = new DriftHandler();
        registry.register(h);
        expect(registry.getByProtocolId("drift")).to.equal(h);
      });

      it("DriftHandler can be looked up by program ID", () => {
        const registry = new ProtocolRegistry();
        const h = new DriftHandler();
        registry.register(h);
        const found = registry.getByProgramId(
          new PublicKey(DRIFT_PROGRAM_ID_STR),
        );
        expect(found).to.equal(h);
      });
    });
  });
});
