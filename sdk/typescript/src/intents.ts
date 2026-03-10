import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { randomUUID } from "crypto";
import type { ActionType } from "./types";
import type { ProtocolRegistry } from "./integrations/protocol-registry";

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
  // ─── Drift Protocol ──────────────────────────────────────────────────
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
  // ─── Kamino Lending ──────────────────────────────────────────────────
  | {
      type: "kaminoDeposit";
      params: {
        mint: string;
        amount: string;
        market?: string;
      };
    }
  | {
      type: "kaminoBorrow";
      params: {
        mint: string;
        amount: string;
        market?: string;
      };
    }
  | {
      type: "kaminoRepay";
      params: {
        mint: string;
        amount: string;
        market?: string;
      };
    }
  | {
      type: "kaminoWithdraw";
      params: {
        mint: string;
        amount: string;
        market?: string;
      };
    }
  // ─── Generic Protocol (escape hatch for registry-based dispatch) ────
  | {
      type: "protocol";
      params: {
        protocolId: string;
        action: string;
        [key: string]: unknown;
      };
    };

/** All supported intent action type strings */
export type IntentActionType = IntentAction["type"];

/** Maps an intent action type string to the on-chain ActionType object */
export const ACTION_TYPE_MAP: Record<
  IntentActionType,
  { actionType: ActionType; isSpending: boolean }
> = {
  swap: { actionType: { swap: {} }, isSpending: true },
  openPosition: { actionType: { openPosition: {} }, isSpending: true },
  closePosition: { actionType: { closePosition: {} }, isSpending: false },
  increasePosition: {
    actionType: { increasePosition: {} },
    isSpending: true,
  },
  decreasePosition: {
    actionType: { decreasePosition: {} },
    isSpending: false,
  },
  deposit: { actionType: { deposit: {} }, isSpending: true },
  withdraw: { actionType: { withdraw: {} }, isSpending: false },
  transfer: { actionType: { transfer: {} }, isSpending: true },
  addCollateral: { actionType: { addCollateral: {} }, isSpending: true },
  removeCollateral: {
    actionType: { removeCollateral: {} },
    isSpending: false,
  },
  placeTriggerOrder: {
    actionType: { placeTriggerOrder: {} },
    isSpending: false,
  },
  editTriggerOrder: {
    actionType: { editTriggerOrder: {} },
    isSpending: false,
  },
  cancelTriggerOrder: {
    actionType: { cancelTriggerOrder: {} },
    isSpending: false,
  },
  placeLimitOrder: { actionType: { placeLimitOrder: {} }, isSpending: true },
  editLimitOrder: { actionType: { editLimitOrder: {} }, isSpending: false },
  cancelLimitOrder: {
    actionType: { cancelLimitOrder: {} },
    isSpending: false,
  },
  swapAndOpenPosition: {
    actionType: { swapAndOpenPosition: {} },
    isSpending: true,
  },
  closeAndSwapPosition: {
    actionType: { closeAndSwapPosition: {} },
    isSpending: false,
  },
  createEscrow: { actionType: { createEscrow: {} }, isSpending: true },
  settleEscrow: { actionType: { settleEscrow: {} }, isSpending: false },
  refundEscrow: { actionType: { refundEscrow: {} }, isSpending: false },
  // Drift
  driftDeposit: { actionType: { deposit: {} }, isSpending: true },
  driftWithdraw: { actionType: { withdraw: {} }, isSpending: false },
  driftPerpOrder: { actionType: { openPosition: {} }, isSpending: true },
  driftSpotOrder: { actionType: { swap: {} }, isSpending: true },
  driftCancelOrder: { actionType: { cancelLimitOrder: {} }, isSpending: false },
  // Kamino
  kaminoDeposit: { actionType: { deposit: {} }, isSpending: true },
  kaminoBorrow: { actionType: { withdraw: {} }, isSpending: false },
  kaminoRepay: { actionType: { deposit: {} }, isSpending: true },
  kaminoWithdraw: { actionType: { withdraw: {} }, isSpending: false },
  // Generic protocol (resolved dynamically via registry)
  protocol: { actionType: { swap: {} }, isSpending: true },
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
  details: {
    permission: {
      passed: boolean;
      requiredBit: string;
      agentHas: boolean;
    };
    spendingCap?: {
      passed: boolean;
      spent24h: number;
      cap: number;
      remaining: number;
    };
    protocol: { passed: boolean; inAllowlist: boolean };
    slippage?: {
      passed: boolean;
      intentBps: number;
      vaultMaxBps: number;
    };
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
  vault: PublicKey;
  agent: PublicKey;
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
    vault?: PublicKey;
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
      return `Kamino deposit ${action.params.amount} of ${action.params.mint}`;
    case "kaminoBorrow":
      return `Kamino borrow ${action.params.amount} of ${action.params.mint}`;
    case "kaminoRepay":
      return `Kamino repay ${action.params.amount} of ${action.params.mint}`;
    case "kaminoWithdraw":
      return `Kamino withdraw ${action.params.amount} of ${action.params.mint}`;
    // Generic protocol
    case "protocol":
      return `${action.params.protocolId}: ${action.params.action}`;
  }
}

/**
 * Resolve the correct on-chain ActionType for a generic protocol action.
 *
 * Looks up the protocol handler's supportedActions to find the correct
 * ActionType instead of defaulting to { swap: {} } for all protocol actions.
 *
 * @returns The resolved ActionType mapping, or the default from ACTION_TYPE_MAP
 */
export function resolveProtocolActionType(
  registry: ProtocolRegistry,
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
  // Fall back to the static default (swap) — only for truly unknown actions
  return ACTION_TYPE_MAP.protocol;
}

/**
 * Create a new transaction intent with "pending" status.
 */
export function createIntent(
  action: IntentAction,
  vault: PublicKey,
  agent: PublicKey,
  options?: { ttlMs?: number },
): TransactionIntent {
  const now = Date.now();
  const ttl = options?.ttlMs ?? DEFAULT_INTENT_TTL_MS;

  return {
    id: randomUUID(),
    action,
    vault,
    agent,
    status: "pending",
    createdAt: now,
    expiresAt: now + ttl,
    updatedAt: now,
    summary: summarizeAction(action),
  };
}

/**
 * In-memory intent storage with defensive copies.
 */
export class MemoryIntentStorage implements IntentStorage {
  private readonly _intents = new Map<string, TransactionIntent>();

  private _clone(intent: TransactionIntent): TransactionIntent {
    return {
      ...intent,
      action: {
        ...intent.action,
        params: { ...intent.action.params },
      } as IntentAction,
      vault: new PublicKey(intent.vault.toBytes()),
      agent: new PublicKey(intent.agent.toBytes()),
    };
  }

  async save(intent: TransactionIntent): Promise<void> {
    this._intents.set(intent.id, this._clone(intent));
  }

  async get(id: string): Promise<TransactionIntent | null> {
    const intent = this._intents.get(id);
    return intent ? this._clone(intent) : null;
  }

  async list(filter?: {
    status?: IntentStatus;
    vault?: PublicKey;
  }): Promise<TransactionIntent[]> {
    let results = Array.from(this._intents.values());

    if (filter?.status) {
      results = results.filter((i) => i.status === filter.status);
    }
    if (filter?.vault) {
      const vaultKey = filter.vault.toBase58();
      results = results.filter((i) => i.vault.toBase58() === vaultKey);
    }

    return results.map((i) => this._clone(i));
  }

  async update(
    id: string,
    updates: Partial<Pick<TransactionIntent, "status" | "updatedAt" | "error">>,
  ): Promise<void> {
    const existing = this._intents.get(id);
    if (!existing) {
      throw new Error(`Intent not found: ${id}`);
    }
    if (updates.status !== undefined) existing.status = updates.status;
    if (updates.updatedAt !== undefined) existing.updatedAt = updates.updatedAt;
    if (updates.error !== undefined) existing.error = updates.error;
  }
}
