/**
 * T2 Protocol Handlers — Kit-native
 *
 * Drift (compat bridge), Flash Trade (Codama), Kamino (Codama), Squads (stub).
 */

import type { Address } from "@solana/kit";
import type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
  ProtocolComposeResult,
  ProtocolContext,
} from "./protocol-handler.js";
import { ActionType } from "../generated/types/actionType.js";
import { dispatchDriftCompose } from "./drift-compose.js";
import { dispatchFlashTradeCompose } from "./flash-compose.js";
import { dispatchKaminoCompose } from "./kamino-api.js";

// ─── Program IDs ────────────────────────────────────────────────────────────

const DRIFT_PROGRAM: Address = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH" as Address;
const FLASH_TRADE_PROGRAM: Address = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn" as Address;
const KAMINO_LEND_PROGRAM: Address = "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;
const SQUADS_V4_PROGRAM: Address = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" as Address;

// ─── Drift Handler ──────────────────────────────────────────────────────────

const DRIFT_METADATA: ProtocolHandlerMetadata = {
  protocolId: "drift",
  displayName: "Drift Protocol",
  programIds: [DRIFT_PROGRAM],
  supportedActions: new Map([
    ["deposit", { actionType: ActionType.Deposit, isSpending: true }],
    ["withdraw", { actionType: ActionType.Withdraw, isSpending: false }],
    ["placePerpOrder", { actionType: ActionType.OpenPosition, isSpending: true }],
    ["placeSpotOrder", { actionType: ActionType.Swap, isSpending: true }],
    ["cancelOrder", { actionType: ActionType.CancelLimitOrder, isSpending: false }],
  ]),
};

export class DriftHandler implements ProtocolHandler {
  readonly metadata = DRIFT_METADATA;

  async compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult> {
    return dispatchDriftCompose(ctx, action, params);
  }

  summarize(action: string, params: Record<string, unknown>): string {
    switch (action) {
      case "deposit": return `Drift deposit ${params.amount} of ${params.mint}`;
      case "withdraw": return `Drift withdraw ${params.amount} of ${params.mint}`;
      case "placePerpOrder": return `Drift perp ${params.side} ${params.marketIndex}`;
      case "placeSpotOrder": return `Drift spot ${params.side} ${params.marketIndex}`;
      case "cancelOrder": return `Drift cancel order #${params.orderId}`;
      default: return `Drift: ${action}`;
    }
  }
}

// ─── Flash Trade Handler ────────────────────────────────────────────────────

const FLASH_TRADE_METADATA: ProtocolHandlerMetadata = {
  protocolId: "flash-trade",
  displayName: "Flash Trade",
  programIds: [FLASH_TRADE_PROGRAM],
  supportedActions: new Map([
    ["openPosition", { actionType: ActionType.OpenPosition, isSpending: true }],
    ["closePosition", { actionType: ActionType.ClosePosition, isSpending: false }],
    ["increasePosition", { actionType: ActionType.IncreasePosition, isSpending: true }],
    ["decreasePosition", { actionType: ActionType.DecreasePosition, isSpending: false }],
    ["addCollateral", { actionType: ActionType.AddCollateral, isSpending: true }],
    ["removeCollateral", { actionType: ActionType.RemoveCollateral, isSpending: false }],
    ["placeTriggerOrder", { actionType: ActionType.PlaceTriggerOrder, isSpending: false }],
    ["editTriggerOrder", { actionType: ActionType.EditTriggerOrder, isSpending: false }],
    ["cancelTriggerOrder", { actionType: ActionType.CancelTriggerOrder, isSpending: false }],
    ["placeLimitOrder", { actionType: ActionType.PlaceLimitOrder, isSpending: true }],
    ["editLimitOrder", { actionType: ActionType.EditLimitOrder, isSpending: false }],
    ["cancelLimitOrder", { actionType: ActionType.CancelLimitOrder, isSpending: false }],
    ["swapAndOpen", { actionType: ActionType.SwapAndOpenPosition, isSpending: true }],
    ["closeAndSwap", { actionType: ActionType.CloseAndSwapPosition, isSpending: false }],
  ]),
};

export class FlashTradeHandler implements ProtocolHandler {
  readonly metadata = FLASH_TRADE_METADATA;

  async compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult> {
    return dispatchFlashTradeCompose(ctx, action, params);
  }

  summarize(action: string, params: Record<string, unknown>): string {
    const target = params.targetSymbol ?? "unknown";
    const side = params.side ?? "";
    switch (action) {
      case "openPosition": return `Flash open ${side} ${target}`;
      case "closePosition": return `Flash close ${target}`;
      case "increasePosition": return `Flash increase ${side} ${target}`;
      case "decreasePosition": return `Flash decrease ${target}`;
      case "addCollateral": return `Flash add collateral ${target}`;
      case "removeCollateral": return `Flash remove collateral ${target}`;
      case "placeTriggerOrder": return `Flash trigger order ${side} ${target}`;
      case "editTriggerOrder": return `Flash edit trigger ${target}`;
      case "cancelTriggerOrder": return `Flash cancel trigger`;
      case "placeLimitOrder": return `Flash limit ${side} ${target}`;
      case "editLimitOrder": return `Flash edit limit ${target}`;
      case "cancelLimitOrder": return `Flash cancel limit ${target}`;
      case "swapAndOpen": return `Flash swap+open ${side} ${target}`;
      case "closeAndSwap": return `Flash close+swap ${target}`;
      default: return `Flash Trade: ${action}`;
    }
  }
}

// ─── Kamino Handler ─────────────────────────────────────────────────────────

const KAMINO_METADATA: ProtocolHandlerMetadata = {
  protocolId: "kamino-lending",
  displayName: "Kamino Lending",
  programIds: [KAMINO_LEND_PROGRAM],
  supportedActions: new Map([
    ["deposit", { actionType: ActionType.Deposit, isSpending: true }],
    ["borrow", { actionType: ActionType.Withdraw, isSpending: false }],
    ["repay", { actionType: ActionType.Deposit, isSpending: true }],
    ["withdraw", { actionType: ActionType.Withdraw, isSpending: false }],
    ["vaultDeposit", { actionType: ActionType.Deposit, isSpending: true }],
    ["vaultWithdraw", { actionType: ActionType.Withdraw, isSpending: false }],
    ["multiply", { actionType: ActionType.Deposit, isSpending: true }],
  ]),
};

export class KaminoHandler implements ProtocolHandler {
  readonly metadata = KAMINO_METADATA;

  async compose(
    ctx: ProtocolContext,
    action: string,
    params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult> {
    return dispatchKaminoCompose(ctx, action, params);
  }

  summarize(action: string, params: Record<string, unknown>): string {
    switch (action) {
      case "deposit": return `Kamino deposit ${params.amount ?? ""} ${params.tokenMint ?? ""}`.trim();
      case "withdraw": return `Kamino withdraw ${params.amount ?? ""} ${params.tokenMint ?? ""}`.trim();
      case "borrow": return `Kamino borrow ${params.amount ?? ""} ${params.tokenMint ?? ""}`.trim();
      case "repay": return `Kamino repay ${params.amount ?? ""} ${params.tokenMint ?? ""}`.trim();
      case "vaultDeposit": return `Kamino vault deposit ${params.amount ?? ""} to ${params.kvault ?? ""}`.trim();
      case "vaultWithdraw": return `Kamino vault withdraw ${params.amount ?? ""} from ${params.kvault ?? ""}`.trim();
      case "multiply": return `Kamino multiply ${params.amount ?? ""} ${params.depositToken ?? ""} @ ${params.targetLeverage ?? "2"}x`.trim();
      default: return `Kamino ${action}`;
    }
  }
}

// ─── Squads Handler ─────────────────────────────────────────────────────────

const SQUADS_METADATA: ProtocolHandlerMetadata = {
  protocolId: "squads",
  displayName: "Squads V4",
  programIds: [SQUADS_V4_PROGRAM],
  supportedActions: new Map([
    ["propose", { actionType: ActionType.Swap, isSpending: false }],
    ["approve", { actionType: ActionType.Swap, isSpending: false }],
    ["execute", { actionType: ActionType.Swap, isSpending: true }],
  ]),
};

export class SquadsHandler implements ProtocolHandler {
  readonly metadata = SQUADS_METADATA;

  async compose(
    _ctx: ProtocolContext,
    _action: string,
    _params: Record<string, unknown>,
  ): Promise<ProtocolComposeResult> {
    throw new Error(
      "SquadsHandler.compose() not yet implemented — requires @sqds/multisig. " +
      "Use compat.ts bridge when wiring up.",
    );
  }

  summarize(action: string, params: Record<string, unknown>): string {
    return `Squads ${action} ${params.multisig ?? ""}`.trim();
  }
}

// ─── Singleton instances ────────────────────────────────────────────────────

export const driftHandler = new DriftHandler();
export const flashTradeHandler = new FlashTradeHandler();
export const kaminoHandler = new KaminoHandler();
export const squadsHandler = new SquadsHandler();
