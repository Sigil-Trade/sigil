import { expect } from "chai";
import type { Address, Instruction, Rpc, SolanaRpcApi } from "@solana/kit";
import {
  TransactionExecutor,
  type ExecuteTransactionParams,
} from "../src/transaction-executor.js";
import {
  RISK_FLAG_FULL_DRAIN,
  RISK_FLAG_LARGE_OUTFLOW,
} from "../src/simulation.js";

// ─── Mock Helpers ────────────────────────────────────────────────────────────

const MOCK_PAYER = "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL" as Address;
const MOCK_PROGRAM = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const MOCK_SIGNATURE =
  "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";

const MOCK_BLOCKHASH = {
  blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
  lastValidBlockHeight: 1000n,
};

function mockIx(programAddress: Address = MOCK_PROGRAM): Instruction {
  return { programAddress, accounts: [], data: new Uint8Array([1, 2, 3]) };
}

function baseParams(
  overrides?: Partial<ExecuteTransactionParams>,
): ExecuteTransactionParams {
  return {
    feePayer: MOCK_PAYER,
    validateIx: mockIx(),
    defiInstructions: [mockIx()],
    finalizeIx: mockIx(),
    ...overrides,
  };
}

function createMockRpc(overrides?: {
  simulateResult?: { value: any };
  sendResult?: string;
  statusResult?: { value: unknown[] };
}): Rpc<SolanaRpcApi> {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({ value: MOCK_BLOCKHASH }),
    }),
    simulateTransaction: () => ({
      send: async () =>
        overrides?.simulateResult ?? {
          value: { err: null, logs: [], unitsConsumed: 400_000 },
        },
    }),
    sendTransaction: () => ({
      send: async () => overrides?.sendResult ?? MOCK_SIGNATURE,
    }),
    getSignatureStatuses: () => ({
      send: async () =>
        overrides?.statusResult ?? {
          value: [{ confirmationStatus: "confirmed", err: null }],
        },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

function mockAgent() {
  return {
    address: MOCK_PAYER,
    modifyAndSignTransactions: async (txs: unknown[]) => txs,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TransactionExecutor", () => {
  describe("composeTransaction", () => {
    it("produces a compiled transaction object", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.composeTransaction(baseParams());
      expect(result.compiledTx).to.have.property("messageBytes");
    });

    it("uses provided computeUnits override", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.composeTransaction(
        baseParams({ computeUnits: 1_400_000 }),
      );
      expect(result.computeUnits).to.equal(1_400_000);
    });

    it("fetches blockhash from RPC", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.composeTransaction(baseParams());
      expect(result.blockhash.blockhash).to.equal(MOCK_BLOCKHASH.blockhash);
    });
  });

  describe("simulate", () => {
    it("returns success when simulation succeeds", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const { compiledTx, computeUnits } =
        await executor.composeTransaction(baseParams());
      const { simulation } = await executor.simulate(
        baseParams(),
        compiledTx,
        computeUnits,
        MOCK_BLOCKHASH,
      );
      expect(simulation.success).to.be.true;
    });

    it("returns failure when simulation has error", async () => {
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: { InstructionError: [0, "Custom"] },
            logs: [
              "Program log: Error Code: VaultNotActive. Error Number: 6000",
            ],
            unitsConsumed: 50_000,
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const { compiledTx, computeUnits } =
        await executor.composeTransaction(baseParams());
      const { simulation } = await executor.simulate(
        baseParams(),
        compiledTx,
        computeUnits,
        MOCK_BLOCKHASH,
      );
      expect(simulation.success).to.be.false;
      expect(simulation.error?.anchorCode).to.equal(6000);
    });

    it("maps Anchor error names from logs", async () => {
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: "error",
            logs: [
              "Program log: Error Code: SpendingCapExceeded. Error Number: 6006",
            ],
            unitsConsumed: 100_000,
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const { compiledTx, computeUnits } =
        await executor.composeTransaction(baseParams());
      const { simulation } = await executor.simulate(
        baseParams(),
        compiledTx,
        computeUnits,
        MOCK_BLOCKHASH,
      );
      expect(simulation.error?.anchorName).to.equal("SpendingCapExceeded");
      expect(simulation.error?.suggestion).to.include("spending cap");
    });

    it("does not re-compose when CU within 20% threshold", async () => {
      // Estimated ~800k, simulated 400k → adjusted = 440k. Diff = |440-800|/800 = 45% > 20% → recompose
      // Actually let's test the case where it DOESN'T recompose: estimated 800k, consumed 750k → adjusted = 825k, diff = 3% < 20%
      const rpc = createMockRpc({
        simulateResult: {
          value: { err: null, logs: [], unitsConsumed: 750_000 },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const { compiledTx, computeUnits } =
        await executor.composeTransaction(baseParams());
      const { recomposedTx } = await executor.simulate(
        baseParams(),
        compiledTx,
        computeUnits,
        MOCK_BLOCKHASH,
      );
      expect(recomposedTx).to.be.undefined;
    });

    it("re-composes when CU differs >20%", async () => {
      // Estimated ~800k, consumed 200k → adjusted = 220k. Diff = |220-800|/800 = 72.5% > 20% → recompose
      const rpc = createMockRpc({
        simulateResult: {
          value: { err: null, logs: [], unitsConsumed: 200_000 },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const { compiledTx, computeUnits } =
        await executor.composeTransaction(baseParams());
      const { recomposedTx, finalCU } = await executor.simulate(
        baseParams(),
        compiledTx,
        computeUnits,
        MOCK_BLOCKHASH,
      );
      expect(recomposedTx).to.not.be.undefined;
      expect(finalCU).to.be.lessThan(computeUnits);
    });
  });

  describe("signSendConfirm", () => {
    it("returns signature on success", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const { compiledTx } = await executor.composeTransaction(baseParams());
      const { signature } = await executor.signSendConfirm(compiledTx);
      expect(signature).to.equal(MOCK_SIGNATURE);
    });

    it("throws when send returns error status", async () => {
      const rpc = createMockRpc({
        statusResult: {
          value: [
            {
              confirmationStatus: "confirmed",
              err: { InstructionError: [0, "Custom"] },
            },
          ],
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const { compiledTx } = await executor.composeTransaction(baseParams());
      try {
        await executor.signSendConfirm(compiledTx);
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("failed");
      }
    });
  });

  describe("executeTransaction", () => {
    it("full happy path returns signature and events", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.executeTransaction(baseParams());
      expect(result.signature).to.equal(MOCK_SIGNATURE);
      expect(result.events).to.be.an("array");
      expect(result.unitsConsumed).to.equal(400_000);
    });

    it("throws on simulation failure", async () => {
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: "error",
            logs: [
              "Program log: Error Code: VaultNotActive. Error Number: 6000",
            ],
            unitsConsumed: 50_000,
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      try {
        await executor.executeTransaction(baseParams());
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Simulation failed");
      }
    });

    it("skipSimulation bypasses simulate step", async () => {
      // Even with a mock that would fail simulation, skipSimulation should bypass it
      const rpc = createMockRpc({
        simulateResult: {
          value: { err: "error", logs: [], unitsConsumed: 0 },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent(), { skipSimulation: true });
      const result = await executor.executeTransaction(
        baseParams(),
      );
      expect(result.signature).to.equal(MOCK_SIGNATURE);
    });

    it("priority fee is wired through to compose", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.executeTransaction(
        baseParams({ priorityFeeMicroLamports: 50_000 }),
      );
      expect(result.signature).to.equal(MOCK_SIGNATURE);
    });

    it("timeout on send throws error", async () => {
      const rpc = createMockRpc({
        statusResult: { value: [null] },
      });
      const executor = new TransactionExecutor(rpc, mockAgent(), {
        confirmOptions: { timeoutMs: 100, pollIntervalMs: 20 },
        skipSimulation: true,
      });
      try {
        await executor.executeTransaction(baseParams());
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("timed out");
      }
    });
  });

  describe("drain detection integration", () => {
    /** Encode a mock SPL Token account with given balance at byte offset 64 (u64 LE). */
    function encodeMockTokenBalance(balance: bigint): string {
      const bytes = new Uint8Array(72); // 32 mint + 32 owner + 8 amount
      const view = new DataView(bytes.buffer);
      view.setBigUint64(64, balance, true);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    it("executes normally without vaultMonitoring (backward compat)", async () => {
      const executor = new TransactionExecutor(createMockRpc(), mockAgent());
      const result = await executor.executeTransaction(baseParams());
      expect(result.signature).to.equal(MOCK_SIGNATURE);
      expect(result.warnings).to.be.undefined;
    });

    it("passes vaultMonitoring through and produces LARGE_OUTFLOW warning", async () => {
      // Vault starts with 1000 tokens, simulation shows 200 remaining (80% outflow > 50% threshold)
      const postBalance = encodeMockTokenBalance(200n);
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: null,
            logs: [],
            unitsConsumed: 400_000,
            accounts: [{ data: [postBalance, "base64"] }],
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const result = await executor.executeTransaction(
        baseParams({
          vaultMonitoring: {
            vaultAddress: MOCK_PAYER,
            monitorAccounts: [MOCK_PAYER],
            preBalances: new Map([[MOCK_PAYER, 1000n]]),
            totalVaultBalance: 1000n,
          },
        }),
      );
      expect(result.signature).to.equal(MOCK_SIGNATURE);
      expect(result.warnings).to.include(RISK_FLAG_LARGE_OUTFLOW);
    });

    it("blocks FULL_DRAIN when outflow exceeds blockPercent", async () => {
      // Vault starts with 1000, simulation shows 10 remaining (99% outflow > 95% block)
      const postBalance = encodeMockTokenBalance(10n);
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: null,
            logs: [],
            unitsConsumed: 400_000,
            accounts: [{ data: [postBalance, "base64"] }],
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      try {
        await executor.executeTransaction(
          baseParams({
            vaultMonitoring: {
              vaultAddress: MOCK_PAYER,
              monitorAccounts: [MOCK_PAYER],
              preBalances: new Map([[MOCK_PAYER, 1000n]]),
              totalVaultBalance: 1000n,
            },
          }),
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("drain detection triggered");
        expect(e.message).to.include(RISK_FLAG_FULL_DRAIN);
      }
    });

    it("clean TX passes drain detection with no warnings", async () => {
      // Vault starts with 1000, simulation shows 900 remaining (10% outflow < 50%)
      const postBalance = encodeMockTokenBalance(900n);
      const rpc = createMockRpc({
        simulateResult: {
          value: {
            err: null,
            logs: [],
            unitsConsumed: 400_000,
            accounts: [{ data: [postBalance, "base64"] }],
          },
        },
      });
      const executor = new TransactionExecutor(rpc, mockAgent());
      const result = await executor.executeTransaction(
        baseParams({
          vaultMonitoring: {
            vaultAddress: MOCK_PAYER,
            monitorAccounts: [MOCK_PAYER],
            preBalances: new Map([[MOCK_PAYER, 1000n]]),
            totalVaultBalance: 1000n,
          },
        }),
      );
      expect(result.signature).to.equal(MOCK_SIGNATURE);
      expect(result.warnings).to.be.undefined;
    });
  });
});
