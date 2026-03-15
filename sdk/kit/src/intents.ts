/**
 * Kit-native Intent System for Phalnx.
 *
 * Defines the IntentAction union (31+ variants), the ACTION_TYPE_MAP that
 * resolves intent action strings to Codama-generated ActionType enum values,
 * and the TransactionIntent / IntentStorage interfaces.
 *
 * Zero web3.js dependency — uses `Address` (branded string) from @solana/kit.
 */

import type { Address } from "@solana/kit";
import { ActionType } from "./generated/types/actionType.js";

export const DEFAULT_INTENT_TTL_MS = 3_600_000; // 1 hour

export type IntentAction =
  | {
      type: "swap";
      params: {
        inputMint: string;
        outputMint: string;
        amount: string;
        slippageBps?: number;
      };
    }
  | {
      type: "openPosition";
      params: {
        market: string;
        side: "long" | "short";
        collateral: string;
        leverage: number;
      };
    }
  | { type: "closePosition"; params: { market: string; positionId?: string } }
  | {
      type: "transfer";
      params: { destination: string; mint: string; amount: string };
    }
  | { type: "deposit"; params: { mint: string; amount: string } }
  | { type: "withdraw"; params: { mint: string; amount: string } }
  | {
      type: "increasePosition";
      params: {
        market: string;
        positionId?: string;
        side: "long" | "short";
        sizeDelta: string;
        collateralAmount: string;
        leverageBps?: number;
      };
    }
  | {
      type: "decreasePosition";
      params: {
        market: string;
        positionId?: string;
        side: "long" | "short";
        sizeDelta: string;
      };
    }
  | {
      type: "addCollateral";
      params: {
        market: string;
        positionId?: string;
        side: "long" | "short";
        collateralAmount: string;
      };
    }
  | {
      type: "removeCollateral";
      params: {
        market: string;
        positionId?: string;
        side: "long" | "short";
        collateralDeltaUsd: string;
      };
    }
  | {
      type: "placeTriggerOrder";
      params: {
        market: string;
        side: "long" | "short";
        triggerPrice: string;
        deltaSizeAmount: string;
        isStopLoss: boolean;
      };
    }
  | {
      type: "editTriggerOrder";
      params: {
        market: string;
        side: "long" | "short";
        orderId: string;
        triggerPrice: string;
        deltaSizeAmount: string;
        isStopLoss: boolean;
      };
    }
  | {
      type: "cancelTriggerOrder";
      params: {
        market: string;
        side: "long" | "short";
        orderId: string;
        isStopLoss: boolean;
      };
    }
  | {
      type: "placeLimitOrder";
      params: {
        market: string;
        side: "long" | "short";
        reserveAmount: string;
        sizeAmount: string;
        limitPrice: string;
        stopLossPrice?: string;
        takeProfitPrice?: string;
        leverageBps?: number;
      };
    }
  | {
      type: "editLimitOrder";
      params: {
        market: string;
        side: "long" | "short";
        orderId: string;
        reserveAmount: string;
        sizeAmount: string;
        limitPrice: string;
        stopLossPrice?: string;
        takeProfitPrice?: string;
        leverageBps?: number;
      };
    }
  | {
      type: "cancelLimitOrder";
      params: {
        market: string;
        side: "long" | "short";
        orderId: string;
      };
    }
  | {
      type: "swapAndOpenPosition";
      params: {
        inputMint: string;
        outputMint: string;
        amount: string;
        slippageBps?: number;
        market: string;
        side: "long" | "short";
        sizeAmount: string;
        leverageBps: number;
      };
    }
  | {
      type: "closeAndSwapPosition";
      params: {
        market: string;
        positionId?: string;
        side: "long" | "short";
        outputMint: string;
        slippageBps?: number;
      };
    }
  | {
      type: "createEscrow";
      params: {
        destinationVault: string;
        amount: string;
        mint: string;
        expiresInSeconds: number;
        conditionHash?: string;
      };
    }
  | {
      type: "settleEscrow";
      params: {
        sourceVault: string;
        escrowId: string;
        conditionProof?: string;
      };
    }
  | {
      type: "refundEscrow";
      params: {
        destinationVault: string;
        escrowId: string;
      };
    }
  // --- Drift Protocol ---
  | {
      type: "driftDeposit";
      params: {
        mint: string;
        amount: string;
        marketIndex: number;
        subAccountId?: number;
      };
    }
  | {
      type: "driftWithdraw";
      params: {
        mint: string;
        amount: string;
        marketIndex: number;
        subAccountId?: number;
      };
    }
  | {
      type: "driftPerpOrder";
      params: {
        marketIndex: number;
        side: "long" | "short";
        amount: string;
        price?: string;
        orderType: "market" | "limit" | "triggerMarket" | "triggerLimit";
        subAccountId?: number;
      };
    }
  | {
      type: "driftSpotOrder";
      params: {
        marketIndex: number;
        side: "long" | "short";
        amount: string;
        price?: string;
        orderType: "market" | "limit";
      };
    }
  | {
      type: "driftCancelOrder";
      params: {
        orderId: number;
        subAccountId?: number;
      };
    }
  // --- Kamino Lending ---
  | {
      type: "kaminoDeposit";
      params: {
        tokenMint: string;
        amount: string;
        obligation: string;
        market?: string;
      };
    }
  | {
      type: "kaminoBorrow";
      params: {
        tokenMint: string;
        amount: string;
        obligation: string;
        market?: string;
      };
    }
  | {
      type: "kaminoRepay";
      params: {
        tokenMint: string;
        amount: string;
        obligation: string;
        market?: string;
      };
    }
  | {
      type: "kaminoWithdraw";
      params: {
        tokenMint: string;
        amount: string;
        obligation: string;
        market?: string;
      };
    }
  | {
      type: "kaminoVaultDeposit";
      params: {
        kvault: string;
        amount: string;
      };
    }
  | {
      type: "kaminoVaultWithdraw";
      params: {
        kvault: string;
        amount: string;
      };
    }
  | {
      type: "kaminoMultiply";
      params: {
        depositToken: string;
        borrowToken: string;
        amount: string;
        targetLeverage?: number;
        maxLoops?: number;
        market?: string;
      };
    }
  // --- Generic Protocol (escape hatch for registry-based dispatch) ---
  | {
      type: "protocol";
      params: {
        protocolId: string;
        action: string;
        [key: string]: unknown;
      };
    }
  // --- Passthrough (raw instructions + on-chain constraint validation) ---
  | {
      type: "passthrough";
      params: {
        programId: string;
        instructions: {
          programId: string;
          keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
          data: string;
        }[];
        actionType: string;
        amount?: string;
        tokenMint?: string;
      };
    };

/** All supported intent action type strings */
export type IntentActionType = IntentAction["type"];

/**
 * Maps an intent action type string to the on-chain ActionType enum value.
 *
 * The Kit SDK uses Codama-generated `ActionType` enum (e.g. `ActionType.Swap`)
 * instead of the old Anchor IDL object style (`{ swap: {} }`).
 */
export const ACTION_TYPE_MAP: Record<
  IntentActionType,
  { actionType: ActionType; isSpending: boolean }
> = {
  swap: { actionType: ActionType.Swap, isSpending: true },
  openPosition: { actionType: ActionType.OpenPosition, isSpending: true },
  closePosition: { actionType: ActionType.ClosePosition, isSpending: false },
  increasePosition: {
    actionType: ActionType.IncreasePosition,
    isSpending: true,
  },
  decreasePosition: {
    actionType: ActionType.DecreasePosition,
    isSpending: false,
  },
  deposit: { actionType: ActionType.Deposit, isSpending: true },
  withdraw: { actionType: ActionType.Withdraw, isSpending: false },
  transfer: { actionType: ActionType.Transfer, isSpending: true },
  addCollateral: { actionType: ActionType.AddCollateral, isSpending: true },
  removeCollateral: {
    actionType: ActionType.RemoveCollateral,
    isSpending: false,
  },
  placeTriggerOrder: {
    actionType: ActionType.PlaceTriggerOrder,
    isSpending: false,
  },
  editTriggerOrder: {
    actionType: ActionType.EditTriggerOrder,
    isSpending: false,
  },
  cancelTriggerOrder: {
    actionType: ActionType.CancelTriggerOrder,
    isSpending: false,
  },
  placeLimitOrder: {
    actionType: ActionType.PlaceLimitOrder,
    isSpending: true,
  },
  editLimitOrder: {
    actionType: ActionType.EditLimitOrder,
    isSpending: false,
  },
  cancelLimitOrder: {
    actionType: ActionType.CancelLimitOrder,
    isSpending: false,
  },
  swapAndOpenPosition: {
    actionType: ActionType.SwapAndOpenPosition,
    isSpending: true,
  },
  closeAndSwapPosition: {
    actionType: ActionType.CloseAndSwapPosition,
    isSpending: false,
  },
  createEscrow: { actionType: ActionType.CreateEscrow, isSpending: true },
  settleEscrow: { actionType: ActionType.SettleEscrow, isSpending: false },
  refundEscrow: { actionType: ActionType.RefundEscrow, isSpending: false },
  // Drift
  driftDeposit: { actionType: ActionType.Deposit, isSpending: true },
  driftWithdraw: { actionType: ActionType.Withdraw, isSpending: false },
  driftPerpOrder: { actionType: ActionType.OpenPosition, isSpending: true },
  driftSpotOrder: { actionType: ActionType.Swap, isSpending: true },
  driftCancelOrder: {
    actionType: ActionType.CancelLimitOrder,
    isSpending: false,
  },
  // Kamino
  kaminoDeposit: { actionType: ActionType.Deposit, isSpending: true },
  kaminoBorrow: { actionType: ActionType.Withdraw, isSpending: false },
  kaminoRepay: { actionType: ActionType.Deposit, isSpending: true },
  kaminoWithdraw: { actionType: ActionType.Withdraw, isSpending: false },
  kaminoVaultDeposit: { actionType: ActionType.Deposit, isSpending: true },
  kaminoVaultWithdraw: { actionType: ActionType.Withdraw, isSpending: false },
  kaminoMultiply: { actionType: ActionType.Deposit, isSpending: true },
  // Generic protocol (resolved dynamically via registry)
  protocol: { actionType: ActionType.Swap, isSpending: true },
  // Passthrough (raw instructions validated on-chain via constraints)
  passthrough: { actionType: ActionType.Swap, isSpending: true },
};

export type IntentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "expired"
  | "failed";

export interface PrecheckResult {
  allowed: boolean;
  reason?: string;
  /** On-chain error code for correlation (e.g. 6006 for DailyCapExceeded) */
  errorCode?: number;
  details: {
    permission: {
      passed: boolean;
      requiredBit: string;
      agentHas: boolean;
    };
    spendingCap?: {
      passed: boolean;
      spent24h: bigint;
      cap: bigint;
      remaining: bigint;
      intentAmount?: bigint;
      /** true when non-stablecoin or unresolvable token — cap check deferred to finalize_session */
      deferred?: boolean;
    };
    protocol: { passed: boolean; inAllowlist: boolean };
    slippage?: {
      passed: boolean;
      intentBps: number;
      vaultMaxBps: number;
    };
    transactionSize?: { passed: boolean; maxUsd: bigint; intentUsd: bigint };
    leverage?: { passed: boolean; maxBps: number; intentBps: number };
    positions?: {
      passed: boolean;
      max: number;
      current: number;
      canOpen: boolean;
    };
  };
  budget?: {
    global: { spent24h: bigint; cap: bigint; remaining: bigint };
    agent: { spent24h: bigint; cap: bigint; remaining: bigint } | null;
    protocols: Array<{
      protocol: string;
      spent24h: bigint;
      cap: bigint;
      remaining: bigint;
    }>;
    maxTransactionUsd: bigint;
  };
  summary: string;
  riskFlags: string[];
}

export interface ExecuteResult {
  signature: string;
  intent: IntentAction;
  precheck?: PrecheckResult;
  summary: string;
}

export interface TransactionIntent {
  id: string;
  action: IntentAction;
  vault: Address;
  agent: Address;
  status: IntentStatus;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  summary: string;
  error?: string;
}

export interface IntentStorage {
  save(intent: TransactionIntent): Promise<void>;
  get(id: string): Promise<TransactionIntent | null>;
  list(filter?: {
    status?: IntentStatus;
    vault?: Address;
  }): Promise<TransactionIntent[]>;
  update(
    id: string,
    updates: Partial<Pick<TransactionIntent, "status" | "updatedAt" | "error">>,
  ): Promise<void>;
}

/**
 * Produce a human-readable summary of an intent action.
 */
export function summarizeAction(action: IntentAction): string {
  switch (action.type) {
    case "swap":
      return `Swap ${action.params.amount} of ${action.params.inputMint} -> ${action.params.outputMint}`;
    case "openPosition":
      return `Open ${action.params.side} ${action.params.market} position, ${action.params.leverage}x leverage, ${action.params.collateral} collateral`;
    case "closePosition":
      return `Close position on ${action.params.market}${action.params.positionId ? ` (${action.params.positionId})` : ""}`;
    case "transfer":
      return `Transfer ${action.params.amount} of ${action.params.mint} to ${action.params.destination}`;
    case "deposit":
      return `Deposit ${action.params.amount} of ${action.params.mint}`;
    case "withdraw":
      return `Withdraw ${action.params.amount} of ${action.params.mint}`;
    case "increasePosition":
      return `Increase ${action.params.side} ${action.params.market} position by ${action.params.sizeDelta}, ${action.params.collateralAmount} collateral`;
    case "decreasePosition":
      return `Decrease ${action.params.side} ${action.params.market} position by ${action.params.sizeDelta}`;
    case "addCollateral":
      return `Add ${action.params.collateralAmount} collateral to ${action.params.side} ${action.params.market} position`;
    case "removeCollateral":
      return `Remove ${action.params.collateralDeltaUsd} USD collateral from ${action.params.side} ${action.params.market} position`;
    case "placeTriggerOrder":
      return `Place ${action.params.isStopLoss ? "stop-loss" : "take-profit"} on ${action.params.side} ${action.params.market} at ${action.params.triggerPrice}`;
    case "editTriggerOrder":
      return `Edit ${action.params.isStopLoss ? "stop-loss" : "take-profit"} #${action.params.orderId} on ${action.params.side} ${action.params.market}`;
    case "cancelTriggerOrder":
      return `Cancel ${action.params.isStopLoss ? "stop-loss" : "take-profit"} #${action.params.orderId} on ${action.params.side} ${action.params.market}`;
    case "placeLimitOrder":
      return `Place ${action.params.side} limit order on ${action.params.market} at ${action.params.limitPrice}, size ${action.params.sizeAmount}`;
    case "editLimitOrder":
      return `Edit limit order #${action.params.orderId} on ${action.params.side} ${action.params.market}`;
    case "cancelLimitOrder":
      return `Cancel limit order #${action.params.orderId} on ${action.params.side} ${action.params.market}`;
    case "swapAndOpenPosition":
      return `Swap ${action.params.amount} ${action.params.inputMint} -> ${action.params.outputMint} then open ${action.params.side} ${action.params.market} position`;
    case "closeAndSwapPosition":
      return `Close ${action.params.side} ${action.params.market} position then swap to ${action.params.outputMint}`;
    case "createEscrow":
      return `Create escrow: ${action.params.amount} ${action.params.mint} to vault ${action.params.destinationVault}, expires in ${action.params.expiresInSeconds}s`;
    case "settleEscrow":
      return `Settle escrow #${action.params.escrowId} from vault ${action.params.sourceVault}`;
    case "refundEscrow":
      return `Refund escrow #${action.params.escrowId} to vault ${action.params.destinationVault}`;
    // Drift
    case "driftDeposit":
      return `Drift deposit ${action.params.amount} of ${action.params.mint} to market ${action.params.marketIndex}`;
    case "driftWithdraw":
      return `Drift withdraw ${action.params.amount} of ${action.params.mint} from market ${action.params.marketIndex}`;
    case "driftPerpOrder":
      return `Drift ${action.params.side} perp ${action.params.orderType} order on market ${action.params.marketIndex}, amount ${action.params.amount}`;
    case "driftSpotOrder":
      return `Drift ${action.params.side} spot ${action.params.orderType} order on market ${action.params.marketIndex}, amount ${action.params.amount}`;
    case "driftCancelOrder":
      return `Drift cancel order #${action.params.orderId}`;
    // Kamino
    case "kaminoDeposit":
      return `Kamino deposit ${action.params.amount} of ${action.params.tokenMint}`;
    case "kaminoBorrow":
      return `Kamino borrow ${action.params.amount} of ${action.params.tokenMint}`;
    case "kaminoRepay":
      return `Kamino repay ${action.params.amount} of ${action.params.tokenMint}`;
    case "kaminoWithdraw":
      return `Kamino withdraw ${action.params.amount} of ${action.params.tokenMint}`;
    case "kaminoVaultDeposit":
      return `Kamino vault deposit ${action.params.amount} to ${action.params.kvault}`;
    case "kaminoVaultWithdraw":
      return `Kamino vault withdraw ${action.params.amount} from ${action.params.kvault}`;
    case "kaminoMultiply":
      return `Kamino multiply ${action.params.amount} ${action.params.depositToken} @ ${action.params.targetLeverage ?? 2}x leverage`;
    // Generic protocol
    case "protocol":
      return `${action.params.protocolId}: ${action.params.action}`;
    // Passthrough
    case "passthrough":
      return `Passthrough to ${action.params.programId} (${action.params.actionType})`;
  }
}

/**
 * Duck-typed interface for protocol registry lookup.
 *
 * Avoids a hard dependency on the full ProtocolRegistry class (which lives
 * in the integrations layer). Any object satisfying this shape can be passed.
 */
export interface ProtocolRegistryLike {
  getByProtocolId(
    protocolId: string,
  ):
    | {
        metadata: {
          supportedActions: Map<
            string,
            { actionType: ActionType; isSpending: boolean }
          >;
        };
      }
    | undefined;
}

/**
 * Resolve the correct on-chain ActionType for a generic protocol action.
 *
 * Looks up the protocol handler's supportedActions to find the correct
 * ActionType instead of defaulting to Swap for all protocol actions.
 *
 * @returns The resolved ActionType mapping, or the default from ACTION_TYPE_MAP
 */
export function resolveProtocolActionType(
  registry: ProtocolRegistryLike,
  protocolId: string,
  action: string,
): { actionType: ActionType; isSpending: boolean } {
  const handler = registry.getByProtocolId(protocolId);
  if (handler) {
    const descriptor = handler.metadata.supportedActions.get(action);
    if (descriptor) {
      return {
        actionType: descriptor.actionType,
        isSpending: descriptor.isSpending,
      };
    }
  }
  // Fall back to the static default (Swap) -- only for truly unknown actions
  return ACTION_TYPE_MAP.protocol;
}
