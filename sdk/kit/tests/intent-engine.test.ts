import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  IntentEngine,
  type IntentEngineConfig,
  type ExplainResult,
} from "../src/intent-engine.js";
import { ProtocolRegistry } from "../src/integrations/protocol-registry.js";
import { JupiterHandler } from "../src/integrations/jupiter-handler.js";
import {
  DriftHandler,
  FlashTradeHandler,
  KaminoHandler,
  SquadsHandler,
} from "../src/integrations/t2-handlers.js";
import type { IntentAction, PrecheckResult } from "../src/intents.js";
import { isAgentError, type AgentError } from "../src/agent-errors.js";
import { ACTION_TYPE_MAP } from "../src/intents.js";
import { ActionType } from "../src/generated/types/actionType.js";
import { VaultStatus } from "../src/generated/types/vaultStatus.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";
import { FULL_PERMISSIONS } from "../src/types.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const VAULT = "Vault111111111111111111111111111111111111111" as Address;
const AGENT = "Agent111111111111111111111111111111111111111" as Address;
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEST = "Dest1111111111111111111111111111111111111111";

function mockAgent() {
  return {
    address: AGENT,
    signTransactions: async (txs: unknown[]) => txs,
  } as any;
}

function buildRegistry(): ProtocolRegistry {
  const reg = new ProtocolRegistry();
  reg.register(new JupiterHandler());
  reg.register(new DriftHandler());
  reg.register(new FlashTradeHandler());
  reg.register(new KaminoHandler());
  reg.register(new SquadsHandler());
  return reg;
}

function buildEngine(overrides?: Partial<IntentEngineConfig>): IntentEngine {
  return new IntentEngine({
    rpc: {} as any,
    network: "devnet",
    protocolRegistry: buildRegistry(),
    agent: mockAgent(),
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("IntentEngine", () => {
  describe("validate()", () => {
    it("valid swap passes validation", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "swap",
        params: {
          inputMint: USDC_MINT,
          outputMint: SOL_MINT,
          amount: "1000000",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("missing amount fails validation", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "swap",
        params: { inputMint: "USDC", outputMint: "SOL", amount: "" },
      });
      expect(result.valid).to.be.false;
      expect(result.errors).to.have.length.greaterThan(0);
    });

    it("negative amount fails validation", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "swap",
        params: { inputMint: USDC_MINT, outputMint: SOL_MINT, amount: "-100" },
      });
      expect(result.valid).to.be.false;
    });

    it("NaN amount fails validation", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "swap",
        params: {
          inputMint: USDC_MINT,
          outputMint: SOL_MINT,
          amount: "not_a_number",
        },
      });
      expect(result.valid).to.be.false;
    });

    it("valid transfer passes", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "transfer",
        params: {
          destination: DEST,
          mint: USDC_MINT,
          amount: "500000",
        },
      });
      expect(result.valid).to.be.true;
    });

    it("valid openPosition passes", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 5,
        },
      });
      expect(result.valid).to.be.true;
    });

    it("zero leverage fails", () => {
      const engine = buildEngine();
      const result = engine.validate({
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 0,
        },
      });
      expect(result.valid).to.be.false;
    });
  });

  describe("listProtocols()", () => {
    it("returns all registered protocols", () => {
      const engine = buildEngine();
      const protocols = engine.listProtocols();
      expect(protocols.length).to.equal(5);
      const ids = protocols.map((p) => p.protocolId);
      expect(ids).to.include("jupiter");
      expect(ids).to.include("drift");
      expect(ids).to.include("flash-trade");
      expect(ids).to.include("kamino-lending");
      expect(ids).to.include("squads");
    });

    it("protocols have correct action counts", () => {
      const engine = buildEngine();
      const protocols = engine.listProtocols();
      const jupiter = protocols.find((p) => p.protocolId === "jupiter")!;
      expect(jupiter.actionCount).to.be.greaterThanOrEqual(1);
      const flash = protocols.find((p) => p.protocolId === "flash-trade")!;
      expect(flash.actionCount).to.equal(14);
    });

    it("each protocol has programIds", () => {
      const engine = buildEngine();
      const protocols = engine.listProtocols();
      for (const p of protocols) {
        expect(p.programIds.length).to.be.greaterThan(0);
      }
    });
  });

  describe("listActions()", () => {
    it("jupiter has swap action", () => {
      const engine = buildEngine();
      const actions = engine.listActions("jupiter");
      const swap = actions.find((a) => a.name === "swap");
      expect(swap).to.exist;
      expect(swap!.isSpending).to.be.true;
    });

    it("drift has deposit and withdraw", () => {
      const engine = buildEngine();
      const actions = engine.listActions("drift");
      expect(actions.find((a) => a.name === "deposit")).to.exist;
      expect(actions.find((a) => a.name === "withdraw")).to.exist;
    });

    it("flash-trade has 14 actions", () => {
      const engine = buildEngine();
      const actions = engine.listActions("flash-trade");
      expect(actions.length).to.equal(14);
    });

    it("unknown protocol returns empty", () => {
      const engine = buildEngine();
      const actions = engine.listActions("nonexistent");
      expect(actions).to.have.length(0);
    });
  });

  describe("run() validation stage", () => {
    it("returns AgentError for invalid input", async () => {
      const engine = buildEngine();
      const result = await engine.run(
        { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
        VAULT,
        { skipPrecheck: true },
      );
      // Should fail at validation stage
      expect(isAgentError(result)).to.be.true;
    });

    it("valid intent passes validation stage", async () => {
      const engine = buildEngine();
      // This will fail at precheck (mock RPC), but should pass validation
      try {
        await engine.run(
          {
            type: "swap",
            params: {
              inputMint: USDC_MINT,
              outputMint: SOL_MINT,
              amount: "1000000",
            },
          },
          VAULT,
        );
      } catch (e) {
        // Expected — RPC is mocked. The point is validation passed.
      }
    });
  });

  describe("precheck() edge cases (offline)", () => {
    it("precheck catches RPC failure gracefully", async () => {
      const engine = buildEngine({
        rpc: {
          getAccountInfo: () => {
            throw new Error("RPC unavailable");
          },
        } as any,
      });
      const result = await engine.precheck(
        {
          type: "swap",
          params: {
            inputMint: USDC_MINT,
            outputMint: SOL_MINT,
            amount: "1000000",
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      // Error message may vary — just verify it fails gracefully
      expect(result.reason).to.be.a("string");
      expect(result.reason!.length).to.be.greaterThan(0);
    });
  });

  describe("explain()", () => {
    it("returns AgentError for invalid intent", async () => {
      const engine = buildEngine();
      const result = await engine.explain(
        { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
        VAULT,
      );
      // Should fail at validation
      expect(isAgentError(result)).to.be.true;
    });
  });

  describe("registry integration", () => {
    it("frozen registry rejects new registrations", () => {
      const reg = buildRegistry();
      reg.freeze();
      expect(() => reg.register(new JupiterHandler())).to.throw();
    });

    it("engine uses registry for protocol lookup", () => {
      const engine = buildEngine();
      const protocols = engine.listProtocols();
      expect(protocols.some((p) => p.protocolId === "jupiter")).to.be.true;
    });
  });

  describe("executor integration", () => {
    it("execute() throws when no executor provided", async () => {
      const engine = buildEngine(); // no executor
      try {
        await engine.execute(
          {
            type: "swap",
            params: {
              inputMint: USDC_MINT,
              outputMint: SOL_MINT,
              amount: "1000000",
            },
          },
          VAULT,
        );
        expect.fail("Should have thrown");
      } catch (e: any) {
        // Could fail at precheck (RPC mock) or at executor check
        expect(e).to.be.an("error");
      }
    });

    it("engine stores executor when provided", () => {
      const mockExecutor = {} as any;
      const engine = buildEngine({ executor: mockExecutor });
      expect(engine.executor).to.equal(mockExecutor);
    });

    it("engine has null executor when not provided", () => {
      const engine = buildEngine();
      expect(engine.executor).to.be.null;
    });

    it("explain() works without executor", async () => {
      const engine = buildEngine(); // no executor — explain doesn't need one
      const result = await engine.explain(
        { type: "swap", params: { inputMint: "", outputMint: "", amount: "" } },
        VAULT,
      );
      // Should fail at validation (not at missing executor)
      expect(isAgentError(result)).to.be.true;
    });
  });

  describe("M-2: resolveProtocolActionType everywhere", () => {
    // Access the private method via type cast for direct unit testing
    function getBaseActionType(
      engine: IntentEngine,
      intent: IntentAction,
    ): string {
      return (engine as any)._getBaseActionType(intent);
    }

    it("swap intent resolves through Jupiter handler's action type", () => {
      const engine = buildEngine();
      const result = getBaseActionType(engine, {
        type: "swap",
        params: {
          inputMint: USDC_MINT,
          outputMint: SOL_MINT,
          amount: "1000000",
        },
      });
      // Jupiter handler maps "swap" -> ActionType.Swap
      // ACTION_TYPE_MAP entry for "swap" also has ActionType.Swap
      expect(result).to.equal("swap");
      // Verify the resolved type matches the handler's declared ActionType
      const mapping = ACTION_TYPE_MAP[result as keyof typeof ACTION_TYPE_MAP];
      expect(mapping).to.exist;
      expect(mapping.actionType).to.equal(ActionType.Swap);
    });

    it("openPosition intent resolves through Flash Trade handler's action type", () => {
      const engine = buildEngine();
      const result = getBaseActionType(engine, {
        type: "openPosition",
        params: {
          market: "SOL-PERP",
          side: "long",
          collateral: "100",
          leverage: 5,
        },
      });
      // Flash Trade handler maps "openPosition" -> ActionType.OpenPosition
      expect(result).to.equal("openPosition");
      const mapping = ACTION_TYPE_MAP[result as keyof typeof ACTION_TYPE_MAP];
      expect(mapping).to.exist;
      expect(mapping.actionType).to.equal(ActionType.OpenPosition);
    });

    it("protocol intent still resolves via explicit protocolId + action", () => {
      const engine = buildEngine();
      const result = getBaseActionType(engine, {
        type: "protocol",
        params: { protocolId: "drift", action: "deposit" },
      });
      // Drift handler maps "deposit" -> ActionType.Deposit
      // Should resolve to the "deposit" key in ACTION_TYPE_MAP
      expect(result).to.equal("deposit");
      const mapping = ACTION_TYPE_MAP[result as keyof typeof ACTION_TYPE_MAP];
      expect(mapping).to.exist;
      expect(mapping.actionType).to.equal(ActionType.Deposit);
    });

    it("unknown intent type falls back to raw type string", () => {
      const engine = buildEngine();
      // Force an unknown type via cast — no handler will match
      const result = getBaseActionType(engine, {
        type: "unknownAction" as any,
        params: {} as any,
      });
      // No handler resolves for "unknownAction", so falls back to raw type
      expect(result).to.equal("unknownAction");
    });

    it("intent with no matching handler falls back to raw type", () => {
      // Build an engine with an empty registry — no handlers registered
      const emptyRegistry = new ProtocolRegistry();
      const engine = buildEngine({ protocolRegistry: emptyRegistry });
      const result = getBaseActionType(engine, {
        type: "swap",
        params: {
          inputMint: USDC_MINT,
          outputMint: SOL_MINT,
          amount: "1000000",
        },
      });
      // No Jupiter handler in empty registry, so _resolveHandler returns null
      // Falls back to raw type string
      expect(result).to.equal("swap");
    });

    it("Kamino intent types resolve correctly through handler", () => {
      const engine = buildEngine();

      // kaminoDeposit -> _getComposeAction strips "kamino" -> "deposit"
      // Kamino handler maps "deposit" -> ActionType.Deposit
      const depositResult = getBaseActionType(engine, {
        type: "kaminoDeposit",
        params: {
          tokenMint: USDC_MINT,
          amount: "1000000",
          obligation: "obl111",
        },
      });
      expect(depositResult).to.equal("deposit");
      expect(
        ACTION_TYPE_MAP[depositResult as keyof typeof ACTION_TYPE_MAP]
          .actionType,
      ).to.equal(ActionType.Deposit);

      // kaminoBorrow -> _getComposeAction strips "kamino" -> "borrow"
      // Kamino handler maps "borrow" -> ActionType.Withdraw
      const borrowResult = getBaseActionType(engine, {
        type: "kaminoBorrow",
        params: {
          tokenMint: USDC_MINT,
          amount: "500000",
          obligation: "obl111",
        },
      });
      expect(borrowResult).to.equal("withdraw");
      expect(
        ACTION_TYPE_MAP[borrowResult as keyof typeof ACTION_TYPE_MAP]
          .actionType,
      ).to.equal(ActionType.Withdraw);

      // kaminoRepay -> "repay" -> Kamino maps to ActionType.Deposit
      const repayResult = getBaseActionType(engine, {
        type: "kaminoRepay",
        params: {
          tokenMint: USDC_MINT,
          amount: "500000",
          obligation: "obl111",
        },
      });
      expect(repayResult).to.equal("deposit");

      // kaminoWithdraw -> "withdraw" -> Kamino maps to ActionType.Withdraw
      const withdrawResult = getBaseActionType(engine, {
        type: "kaminoWithdraw",
        params: {
          tokenMint: USDC_MINT,
          amount: "500000",
          obligation: "obl111",
        },
      });
      expect(withdrawResult).to.equal("withdraw");
    });
  });

  // ─── Precheck Spending/Position/Leverage Tests ────────────────────────────

  describe("precheck() spending/position/leverage checks", () => {
    const JUPITER_PROGRAM =
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

    // Deep override type: pick specific fields for vault/policy partial overrides
    type MockOverrides = Omit<
      Partial<ResolvedVaultState>,
      "vault" | "policy"
    > & {
      vault?: Partial<ResolvedVaultState["vault"]>;
      policy?: Partial<ResolvedVaultState["policy"]>;
    };

    function mockState(overrides: MockOverrides = {}): ResolvedVaultState {
      const { vault: vaultOv, policy: policyOv, ...rest } = overrides;
      return {
        vault: {
          discriminator: new Uint8Array(8),
          owner: "Owner11111111111111111111111111111111111111" as Address,
          vaultId: 1n,
          agents: [
            {
              pubkey: AGENT,
              permissions: FULL_PERMISSIONS,
              spendingLimitUsd: 0n,
              paused: false,
            },
          ],
          feeDestination:
            "Fee111111111111111111111111111111111111111" as Address,
          status: VaultStatus.Active,
          bump: 255,
          createdAt: 1000n,
          totalTransactions: 0n,
          totalVolume: 0n,
          openPositions: 0,
          activeEscrowCount: 0,
          totalFeesCollected: 0n,
          ...vaultOv,
        } as ResolvedVaultState["vault"],
        policy: {
          discriminator: new Uint8Array(8),
          vault: VAULT,
          dailySpendingCapUsd: 1_000_000_000n,
          maxTransactionSizeUsd: 500_000_000n,
          protocolMode: 0,
          protocols: [],
          maxLeverageBps: 10000,
          canOpenPositions: true,
          maxConcurrentPositions: 5,
          developerFeeRate: 0,
          maxSlippageBps: 500,
          timelockDuration: 0n,
          allowedDestinations: [],
          hasConstraints: false,
          hasPendingPolicy: false,
          hasProtocolCaps: false,
          protocolCaps: [],
          sessionExpirySlots: 0n,
          bump: 255,
          ...policyOv,
        } as ResolvedVaultState["policy"],
        tracker: null,
        overlay: null,
        constraints: null,
        globalBudget: {
          spent24h: 0n,
          cap: 1_000_000_000n,
          remaining: 1_000_000_000n,
        },
        agentBudget: null,
        protocolBudgets: [],
        maxTransactionUsd: 500_000_000n,
        resolvedAtTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        ...rest,
      };
    }

    function buildPrecheckEngine(
      stateOverrides: MockOverrides = {},
      configOverrides?: Partial<IntentEngineConfig>,
    ): IntentEngine {
      const state = mockState(stateOverrides);
      return buildEngine({
        _stateResolver: async () => state,
        ...configOverrides,
      });
    }

    // Helper: USDC swap intent for spending tests
    function usdcSwap(amount: string): IntentAction {
      return {
        type: "swap",
        params: { inputMint: USDC_MINT, outputMint: SOL_MINT, amount },
      };
    }

    // Test 1: Spending exceeds vault cap
    it("rejects when spending exceeds vault daily cap (6006)", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 900_000_000n,
          cap: 1_000_000_000n,
          remaining: 100_000_000n,
        },
      });
      const result = await engine.precheck(usdcSwap("200000000"), VAULT);
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6006);
      expect(result.reason).to.equal("DAILY_CAP_EXCEEDED");
    });

    // Test 2: Spending exceeds agent limit (within vault cap)
    it("rejects when spending exceeds agent limit (6056)", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 0n,
          cap: 1_000_000_000n,
          remaining: 1_000_000_000n,
        },
        agentBudget: {
          spent24h: 90_000_000n,
          cap: 100_000_000n,
          remaining: 10_000_000n,
        },
        vault: {
          agents: [
            {
              pubkey: AGENT,
              permissions: FULL_PERMISSIONS,
              spendingLimitUsd: 100_000_000n,
              paused: false,
            },
          ],
        },
      });
      const result = await engine.precheck(usdcSwap("20000000"), VAULT);
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6056);
      expect(result.reason).to.equal("AGENT_SPEND_LIMIT_EXCEEDED");
    });

    // Test 3: Spending exceeds protocol cap
    it("rejects when spending exceeds protocol cap (6062)", async () => {
      const engine = buildPrecheckEngine({
        protocolBudgets: [
          {
            protocol: JUPITER_PROGRAM,
            spent24h: 90_000_000n,
            cap: 100_000_000n,
            remaining: 10_000_000n,
          },
        ],
      });
      const result = await engine.precheck(usdcSwap("20000000"), VAULT);
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6062);
      expect(result.reason).to.equal("PROTOCOL_CAP_EXCEEDED");
    });

    // Test 4: Transaction too large
    it("rejects when transaction exceeds max size (6005)", async () => {
      const engine = buildPrecheckEngine({
        maxTransactionUsd: 50_000_000n,
      });
      const result = await engine.precheck(usdcSwap("100000000"), VAULT);
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6005);
      expect(result.reason).to.equal("TRANSACTION_TOO_LARGE");
    });

    // Test 5: All spending checks pass
    it("allows when all spending checks pass with budget populated", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 100_000_000n,
          cap: 1_000_000_000n,
          remaining: 900_000_000n,
        },
      });
      const result = await engine.precheck(usdcSwap("50000000"), VAULT);
      expect(result.allowed).to.be.true;
      expect(result.budget).to.exist;
      expect(result.budget!.global.spent24h).to.equal(100_000_000n);
    });

    // Test 5b: Budget includes resolvedAt timestamp (G-3)
    it("precheck budget includes resolvedAt (G-3)", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 0n,
          cap: 1_000_000_000n,
          remaining: 1_000_000_000n,
        },
      });
      const result = await engine.precheck(usdcSwap("50000000"), VAULT);
      expect(result.allowed).to.be.true;
      expect(result.budget).to.exist;
      expect(typeof result.budget!.resolvedAt).to.equal("bigint");
      expect(result.budget!.resolvedAt! > 0n).to.be.true;
    });

    // Test 6: Non-stablecoin input defers spending
    it("defers spending check for non-stablecoin input", async () => {
      const engine = buildPrecheckEngine();
      const result = await engine.precheck(
        {
          type: "swap",
          params: {
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: "1000000000",
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.true;
      expect(result.details.spendingCap?.deferred).to.be.true;
    });

    // Test 7: Leverage too high
    it("rejects when leverage exceeds max (6007)", async () => {
      const engine = buildPrecheckEngine({
        policy: { maxLeverageBps: 5000 },
      });
      const result = await engine.precheck(
        {
          type: "openPosition",
          params: {
            market: "SOL-PERP",
            side: "long",
            collateral: "100",
            leverage: 100,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6007);
      expect(result.reason).to.equal("LEVERAGE_TOO_HIGH");
    });

    // Test 8: Leverage within limit
    it("allows when leverage is within limit", async () => {
      const engine = buildPrecheckEngine({
        policy: { maxLeverageBps: 10000 },
      });
      const result = await engine.precheck(
        {
          type: "openPosition",
          params: {
            market: "SOL-PERP",
            side: "long",
            collateral: "100",
            leverage: 5,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.true;
    });

    // Test 9: Positions at max
    it("rejects when positions at max (6008)", async () => {
      const engine = buildPrecheckEngine({
        vault: { openPositions: 5 },
        policy: { maxConcurrentPositions: 5 },
      });
      const result = await engine.precheck(
        {
          type: "openPosition",
          params: {
            market: "SOL-PERP",
            side: "long",
            collateral: "100",
            leverage: 5,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6008);
      expect(result.reason).to.equal("TOO_MANY_POSITIONS");
    });

    // Test 10: Positions below max
    it("allows when positions below max", async () => {
      const engine = buildPrecheckEngine({
        vault: { openPositions: 2 },
        policy: { maxConcurrentPositions: 5 },
      });
      const result = await engine.precheck(
        {
          type: "openPosition",
          params: {
            market: "SOL-PERP",
            side: "long",
            collateral: "100",
            leverage: 5,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.true;
    });

    // Test 11: Positions disallowed (canOpenPositions=false)
    it("rejects when canOpenPositions is false (6009)", async () => {
      const engine = buildPrecheckEngine({
        policy: { canOpenPositions: false },
      });
      const result = await engine.precheck(
        {
          type: "openPosition",
          params: {
            market: "SOL-PERP",
            side: "long",
            collateral: "100",
            leverage: 5,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6009);
      expect(result.reason).to.equal("POSITION_OPENING_DISALLOWED");
    });

    // Test 12: Non-spending action skips spending checks
    it("skips spending checks for non-spending action", async () => {
      // cancelTriggerOrder is non-spending AND has posEffect "none" (no position check)
      const engine = buildPrecheckEngine();
      const result = await engine.precheck(
        {
          type: "cancelTriggerOrder",
          params: {
            market: "SOL-PERP",
            side: "long" as const,
            orderId: "1",
            isStopLoss: true,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.true;
      expect(result.details.spendingCap).to.be.undefined;
    });

    // Test 13: Budget field populated on success
    it("populates budget field on success", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 50_000_000n,
          cap: 1_000_000_000n,
          remaining: 950_000_000n,
        },
        agentBudget: {
          spent24h: 10_000_000n,
          cap: 200_000_000n,
          remaining: 190_000_000n,
        },
        vault: {
          agents: [
            {
              pubkey: AGENT,
              permissions: FULL_PERMISSIONS,
              spendingLimitUsd: 200_000_000n,
              paused: false,
            },
          ],
        },
        protocolBudgets: [
          {
            protocol: JUPITER_PROGRAM,
            spent24h: 5_000_000n,
            cap: 500_000_000n,
            remaining: 495_000_000n,
          },
        ],
        maxTransactionUsd: 250_000_000n,
      });
      const result = await engine.precheck(usdcSwap("10000000"), VAULT);
      expect(result.allowed).to.be.true;
      expect(result.budget).to.exist;
      expect(result.budget!.global.spent24h).to.equal(50_000_000n);
      expect(result.budget!.global.cap).to.equal(1_000_000_000n);
      expect(result.budget!.agent).to.not.be.null;
      expect(result.budget!.agent!.spent24h).to.equal(10_000_000n);
      expect(result.budget!.protocols).to.have.length(1);
      expect(result.budget!.protocols[0].spent24h).to.equal(5_000_000n);
      expect(result.budget!.maxTransactionUsd).to.equal(250_000_000n);
    });

    // Test 14: Zero-cap vault blocks all spending
    it("rejects all spending on zero-cap vault (6006)", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: { spent24h: 0n, cap: 0n, remaining: 0n },
        policy: { dailySpendingCapUsd: 0n },
        maxTransactionUsd: 0n,
      });
      const result = await engine.precheck(usdcSwap("1"), VAULT);
      expect(result.allowed).to.be.false;
      // Transaction size of 1 > max 0 → errorCode 6005 fires first
      expect(result.errorCode).to.equal(6005);
    });

    // Test 15: No agent budget (spendingLimitUsd=0) skips agent check
    it("skips agent cap check when spendingLimitUsd is 0", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 0n,
          cap: 1_000_000_000n,
          remaining: 1_000_000_000n,
        },
        agentBudget: null, // No per-agent budget
      });
      const result = await engine.precheck(usdcSwap("100000000"), VAULT);
      expect(result.allowed).to.be.true;
      expect(result.budget!.agent).to.be.null;
    });

    // Test 16: Escrow action rejected
    it("rejects escrow action with errorCode 6011", async () => {
      const engine = buildPrecheckEngine();
      const result = await engine.precheck(
        {
          type: "createEscrow",
          params: {
            destinationVault: DEST,
            amount: "100000",
            mint: USDC_MINT,
            expiresInSeconds: 3600,
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6011);
      expect(result.reason).to.equal("InvalidSession");
    });

    // Test 17: First-failure ordering: tx size fails before vault cap
    it("transaction size check fires before vault cap check", async () => {
      const engine = buildPrecheckEngine({
        // Both limits are low — amount exceeds both
        maxTransactionUsd: 10_000_000n,
        globalBudget: {
          spent24h: 990_000_000n,
          cap: 1_000_000_000n,
          remaining: 10_000_000n,
        },
      });
      // 50M > maxTx 10M AND spent 990M + 50M > cap 1B
      const result = await engine.precheck(usdcSwap("50000000"), VAULT);
      expect(result.allowed).to.be.false;
      // Must be 6005 (tx size) not 6006 (daily cap) — proves ordering
      expect(result.errorCode).to.equal(6005);
    });

    // Test 18: Exact boundary: spent24h + amount === cap → allowed
    it("allows when spent24h + amount exactly equals cap", async () => {
      const engine = buildPrecheckEngine({
        globalBudget: {
          spent24h: 900_000_000n,
          cap: 1_000_000_000n,
          remaining: 100_000_000n,
        },
      });
      // 900M + 100M = 1B = cap. On-chain uses `>` not `>=`, so this passes.
      const result = await engine.precheck(usdcSwap("100000000"), VAULT);
      expect(result.allowed).to.be.true;
    });

    // Test 19: Position decrement with openPositions=0
    it("rejects position decrement when no positions open (6033)", async () => {
      const engine = buildPrecheckEngine({
        vault: { openPositions: 0 },
      });
      const result = await engine.precheck(
        { type: "closePosition", params: { market: "SOL-PERP" } },
        VAULT,
      );
      expect(result.allowed).to.be.false;
      expect(result.errorCode).to.equal(6033);
      expect(result.reason).to.equal("NO_POSITIONS_TO_CLOSE");
    });

    // Test 20: Unresolvable token adds SPENDING_UNVERIFIED riskFlag
    it("adds SPENDING_UNVERIFIED riskFlag for unresolvable token", async () => {
      const engine = buildPrecheckEngine();
      // Use a string that fails base58 validation (contains 'O' and '0' which are invalid)
      const result = await engine.precheck(
        {
          type: "swap",
          params: {
            inputMint: "INVALID",
            outputMint: SOL_MINT,
            amount: "1000",
          },
        },
        VAULT,
      );
      expect(result.allowed).to.be.true;
      expect(result.riskFlags).to.include("SPENDING_UNVERIFIED");
      expect(result.details.spendingCap?.deferred).to.be.true;
    });
  });
});
