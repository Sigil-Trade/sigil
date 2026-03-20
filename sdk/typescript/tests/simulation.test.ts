import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  simulateTransaction,
  isHeliusConnection,
  ANCHOR_ERROR_MAP,
  type SimulationResult,
} from "../src/simulation";
import { TransactionSimulationError } from "../src/wrapper/errors";

describe("simulation", () => {
  describe("ANCHOR_ERROR_MAP", () => {
    it("has all 70 error codes (6000-6069)", () => {
      for (let code = 6000; code <= 6069; code++) {
        expect(ANCHOR_ERROR_MAP[code], `Missing error code ${code}`).to.exist;
        expect(ANCHOR_ERROR_MAP[code].name).to.be.a("string");
        expect(ANCHOR_ERROR_MAP[code].suggestion).to.be.a("string");
      }
    });

    it("maps 6000 to VaultNotActive", () => {
      expect(ANCHOR_ERROR_MAP[6000].name).to.equal("VaultNotActive");
    });

    it("maps 6006 to SpendingCapExceeded", () => {
      expect(ANCHOR_ERROR_MAP[6006].name).to.equal("SpendingCapExceeded");
    });

    it("maps 6024 to Overflow", () => {
      expect(ANCHOR_ERROR_MAP[6024].name).to.equal("Overflow");
    });

    it("maps 6043 to MaxAgentsReached", () => {
      expect(ANCHOR_ERROR_MAP[6043].name).to.equal("MaxAgentsReached");
    });

    it("maps 6046 to EscrowNotActive", () => {
      expect(ANCHOR_ERROR_MAP[6046].name).to.equal("EscrowNotActive");
    });

    it("maps 6052 to InvalidConstraintConfig", () => {
      expect(ANCHOR_ERROR_MAP[6052].name).to.equal("InvalidConstraintConfig");
    });

    it("maps 6056 to AgentSpendLimitExceeded", () => {
      expect(ANCHOR_ERROR_MAP[6056].name).to.equal("AgentSpendLimitExceeded");
    });

    it("has no entries outside 6000-6069", () => {
      const codes = Object.keys(ANCHOR_ERROR_MAP).map(Number);
      for (const code of codes) {
        expect(code).to.be.at.least(6000);
        expect(code).to.be.at.most(6069);
      }
      expect(codes).to.have.lengthOf(70);
    });
  });

  describe("isHeliusConnection", () => {
    it("returns true for helius endpoint", () => {
      const conn = new Connection(
        "https://mainnet.helius-rpc.com/?api-key=test",
      );
      expect(isHeliusConnection(conn)).to.be.true;
    });

    it("returns true for helius endpoint (case insensitive)", () => {
      const conn = new Connection("https://rpc.HELIUS.xyz/?api-key=test");
      expect(isHeliusConnection(conn)).to.be.true;
    });

    it("returns false for non-helius endpoint", () => {
      const conn = new Connection("https://api.mainnet-beta.solana.com");
      expect(isHeliusConnection(conn)).to.be.false;
    });

    it("returns false for devnet endpoint", () => {
      const conn = new Connection("https://api.devnet.solana.com");
      expect(isHeliusConnection(conn)).to.be.false;
    });
  });

  describe("simulateTransaction", () => {
    it("returns success for successful simulation", async () => {
      // Create a mock connection that returns success
      const mockConnection = {
        simulateTransaction: async () => ({
          value: {
            err: null,
            logs: ["Program log: success"],
            unitsConsumed: 5000,
            returnData: null,
            accounts: null,
          },
        }),
      } as unknown as Connection;

      // Create a minimal versioned transaction
      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const result = await simulateTransaction(mockConnection, tx);
      expect(result.success).to.be.true;
      expect(result.unitsConsumed).to.equal(5000);
      expect(result.logs).to.deep.equal(["Program log: success"]);
      expect(result.error).to.be.undefined;
    });

    it("parses Anchor error from named log pattern", async () => {
      const mockConnection = {
        simulateTransaction: async () => ({
          value: {
            err: { InstructionError: [0, { Custom: 6000 }] },
            logs: [
              "Program log: AnchorError occurred",
              "Program log: Error Code: VaultNotActive. Error Number: 6000. Error Message: Vault is not active.",
            ],
            unitsConsumed: 3000,
            returnData: null,
            accounts: null,
          },
        }),
      } as unknown as Connection;

      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const result = await simulateTransaction(mockConnection, tx);
      expect(result.success).to.be.false;
      expect(result.error).to.exist;
      expect(result.error!.anchorCode).to.equal(6000);
      expect(result.error!.anchorName).to.equal("VaultNotActive");
      expect(result.error!.suggestion).to.include("vault status");
    });

    it("parses hex custom program error", async () => {
      const mockConnection = {
        simulateTransaction: async () => ({
          value: {
            err: { InstructionError: [0, { Custom: 6006 }] },
            logs: ["Program log: custom program error: 0x1776"],
            unitsConsumed: 2000,
            returnData: null,
            accounts: null,
          },
        }),
      } as unknown as Connection;

      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const result = await simulateTransaction(mockConnection, tx);
      expect(result.success).to.be.false;
      expect(result.error!.anchorCode).to.equal(0x1776); // 6006
      expect(result.error!.anchorName).to.equal("SpendingCapExceeded");
      expect(result.error!.suggestion).to.include("spending cap");
    });

    it("handles raw error without anchor logs", async () => {
      const mockConnection = {
        simulateTransaction: async () => ({
          value: {
            err: "AccountNotFound",
            logs: ["Program log: some random error"],
            unitsConsumed: 100,
            returnData: null,
            accounts: null,
          },
        }),
      } as unknown as Connection;

      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const result = await simulateTransaction(mockConnection, tx);
      expect(result.success).to.be.false;
      expect(result.error!.message).to.include("AccountNotFound");
      expect(result.error!.anchorCode).to.be.undefined;
      expect(result.error!.suggestion).to.be.undefined;
    });

    it("defaults replaceRecentBlockhash to true", async () => {
      let capturedConfig: any;
      const mockConnection = {
        simulateTransaction: async (_tx: any, config: any) => {
          capturedConfig = config;
          return {
            value: {
              err: null,
              logs: [],
              unitsConsumed: 0,
              returnData: null,
              accounts: null,
            },
          };
        },
      } as unknown as Connection;

      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      await simulateTransaction(mockConnection, tx);
      expect(capturedConfig.replaceRecentBlockhash).to.be.true;
    });

    it("passes accountAddresses through to config", async () => {
      let capturedConfig: any;
      const mockConnection = {
        simulateTransaction: async (_tx: any, config: any) => {
          capturedConfig = config;
          return {
            value: {
              err: null,
              logs: [],
              unitsConsumed: 0,
              returnData: null,
              accounts: null,
            },
          };
        },
      } as unknown as Connection;

      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      const addresses = [Keypair.generate().publicKey.toBase58()];
      await simulateTransaction(mockConnection, tx, {
        accountAddresses: addresses,
      });
      expect(capturedConfig.accounts.addresses).to.deep.equal(addresses);
    });
  });

  describe("TransactionSimulationError", () => {
    it("constructs with suggestion message", () => {
      const result: SimulationResult = {
        success: false,
        error: {
          message: "error",
          anchorCode: 6000,
          anchorName: "VaultNotActive",
          suggestion: "Check vault status — it may be frozen or closed.",
        },
      };
      const err = new TransactionSimulationError(result);
      expect(err.message).to.equal(
        "Check vault status — it may be frozen or closed.",
      );
      expect(err.name).to.equal("TransactionSimulationError");
      expect(err.anchorCode).to.equal(6000);
      expect(err.anchorName).to.equal("VaultNotActive");
      expect(err.result).to.equal(result);
    });

    it("falls back to anchorName when no suggestion", () => {
      const result: SimulationResult = {
        success: false,
        error: {
          message: "error",
          anchorName: "CustomError",
        },
      };
      const err = new TransactionSimulationError(result);
      expect(err.message).to.equal("CustomError");
    });

    it("falls back to generic message", () => {
      const result: SimulationResult = {
        success: false,
        error: {
          message: "some raw error",
        },
      };
      const err = new TransactionSimulationError(result);
      expect(err.message).to.equal("Transaction simulation failed");
    });

    it("is instanceof Error", () => {
      const result: SimulationResult = {
        success: false,
        error: { message: "test" },
      };
      const err = new TransactionSimulationError(result);
      expect(err).to.be.instanceOf(Error);
    });
  });
});
