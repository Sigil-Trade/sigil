/**
 * Intent Input Validation (Anti-Hallucination)
 *
 * Validates IntentAction parameters before they reach RPC.
 * Catches common LLM hallucinations: negative amounts, invalid addresses,
 * out-of-range slippage, and malformed inputs.
 *
 * Returns AgentError[] so agents get structured feedback on what to fix.
 */

import type { IntentAction } from "./intents";
import type { AgentError } from "./agent-errors";
import { MAX_ESCROW_DURATION } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: AgentError[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base58 regex: 32-44 chars from the base58 alphabet */
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** u64 max as BigInt */
const U64_MAX = BigInt("18446744073709551615");

/** Maximum slippage BPS (50% = 5000, but on-chain max is 10000) */
const MAX_SLIPPAGE_BPS = 10_000;

/** Maximum leverage (100x, per plan spec) */
const MAX_LEVERAGE = 100;

/** Maximum leverage in BPS (100x = 1_000_000 BPS) */
const MAX_LEVERAGE_BPS = 1_000_000;

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate an IntentAction's parameters before execution.
 *
 * Catches:
 * - Negative or non-numeric amounts
 * - Invalid base58 addresses
 * - Out-of-range slippage, leverage, and duration
 * - Missing required fields
 *
 * @returns ValidationResult with structured AgentError[] on failure
 */
export function validateIntentInput(intent: IntentAction): ValidationResult {
  const errors: AgentError[] = [];

  switch (intent.type) {
    case "swap":
      validateAddress(errors, intent.params.inputMint, "inputMint");
      validateAddress(errors, intent.params.outputMint, "outputMint");
      validateAmount(errors, intent.params.amount, "amount");
      if (intent.params.slippageBps !== undefined) {
        validateSlippageBps(errors, intent.params.slippageBps, "slippageBps");
      }
      break;

    case "openPosition":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.collateral, "collateral");
      validateLeverage(errors, intent.params.leverage, "leverage");
      break;

    case "closePosition":
      validateNonEmpty(errors, intent.params.market, "market");
      break;

    case "transfer":
      validateAddress(errors, intent.params.destination, "destination");
      validateAddress(errors, intent.params.mint, "mint");
      validateAmount(errors, intent.params.amount, "amount");
      break;

    case "deposit":
    case "withdraw":
      validateAddress(errors, intent.params.mint, "mint");
      validateAmount(errors, intent.params.amount, "amount");
      break;

    case "increasePosition":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.sizeDelta, "sizeDelta");
      validateAmount(
        errors,
        intent.params.collateralAmount,
        "collateralAmount",
      );
      if (intent.params.leverageBps !== undefined) {
        validateLeverageBps(errors, intent.params.leverageBps, "leverageBps");
      }
      break;

    case "decreasePosition":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.sizeDelta, "sizeDelta");
      break;

    case "addCollateral":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(
        errors,
        intent.params.collateralAmount,
        "collateralAmount",
      );
      break;

    case "removeCollateral":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(
        errors,
        intent.params.collateralDeltaUsd,
        "collateralDeltaUsd",
      );
      break;

    case "placeTriggerOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.triggerPrice, "triggerPrice");
      validateAmount(errors, intent.params.deltaSizeAmount, "deltaSizeAmount");
      break;

    case "editTriggerOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateNonEmpty(errors, intent.params.orderId, "orderId");
      validateAmount(errors, intent.params.triggerPrice, "triggerPrice");
      validateAmount(errors, intent.params.deltaSizeAmount, "deltaSizeAmount");
      break;

    case "cancelTriggerOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateNonEmpty(errors, intent.params.orderId, "orderId");
      break;

    case "placeLimitOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.reserveAmount, "reserveAmount");
      validateAmount(errors, intent.params.sizeAmount, "sizeAmount");
      validateAmount(errors, intent.params.limitPrice, "limitPrice");
      if (intent.params.stopLossPrice !== undefined) {
        validateAmount(errors, intent.params.stopLossPrice, "stopLossPrice");
      }
      if (intent.params.takeProfitPrice !== undefined) {
        validateAmount(
          errors,
          intent.params.takeProfitPrice,
          "takeProfitPrice",
        );
      }
      if (intent.params.leverageBps !== undefined) {
        validateLeverageBps(errors, intent.params.leverageBps, "leverageBps");
      }
      break;

    case "editLimitOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateNonEmpty(errors, intent.params.orderId, "orderId");
      validateAmount(errors, intent.params.reserveAmount, "reserveAmount");
      validateAmount(errors, intent.params.sizeAmount, "sizeAmount");
      validateAmount(errors, intent.params.limitPrice, "limitPrice");
      if (intent.params.stopLossPrice !== undefined) {
        validateAmount(errors, intent.params.stopLossPrice, "stopLossPrice");
      }
      if (intent.params.takeProfitPrice !== undefined) {
        validateAmount(
          errors,
          intent.params.takeProfitPrice,
          "takeProfitPrice",
        );
      }
      if (intent.params.leverageBps !== undefined) {
        validateLeverageBps(errors, intent.params.leverageBps, "leverageBps");
      }
      break;

    case "cancelLimitOrder":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateNonEmpty(errors, intent.params.orderId, "orderId");
      break;

    case "swapAndOpenPosition":
      validateAddress(errors, intent.params.inputMint, "inputMint");
      validateAddress(errors, intent.params.outputMint, "outputMint");
      validateAmount(errors, intent.params.amount, "amount");
      if (intent.params.slippageBps !== undefined) {
        validateSlippageBps(errors, intent.params.slippageBps, "slippageBps");
      }
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.sizeAmount, "sizeAmount");
      validateLeverageBps(errors, intent.params.leverageBps, "leverageBps");
      break;

    case "closeAndSwapPosition":
      validateNonEmpty(errors, intent.params.market, "market");
      validateSide(errors, intent.params.side, "side");
      validateAddress(errors, intent.params.outputMint, "outputMint");
      if (intent.params.slippageBps !== undefined) {
        validateSlippageBps(errors, intent.params.slippageBps, "slippageBps");
      }
      break;

    case "createEscrow":
      validateAddress(
        errors,
        intent.params.destinationVault,
        "destinationVault",
      );
      validateAmount(errors, intent.params.amount, "amount");
      validateAddress(errors, intent.params.mint, "mint");
      validateEscrowDuration(
        errors,
        intent.params.expiresInSeconds,
        "expiresInSeconds",
      );
      break;

    case "settleEscrow":
      validateAddress(errors, intent.params.sourceVault, "sourceVault");
      validateNonEmpty(errors, intent.params.escrowId, "escrowId");
      break;

    case "refundEscrow":
      validateAddress(
        errors,
        intent.params.destinationVault,
        "destinationVault",
      );
      validateNonEmpty(errors, intent.params.escrowId, "escrowId");
      break;

    case "driftDeposit":
    case "driftWithdraw":
      validateAddress(errors, intent.params.mint, "mint");
      validateAmount(errors, intent.params.amount, "amount");
      validateNonNegativeInt(errors, intent.params.marketIndex, "marketIndex");
      break;

    case "driftPerpOrder":
      validateNonNegativeInt(errors, intent.params.marketIndex, "marketIndex");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.amount, "amount");
      if (intent.params.price !== undefined) {
        validateAmount(errors, intent.params.price, "price");
      }
      break;

    case "driftSpotOrder":
      validateNonNegativeInt(errors, intent.params.marketIndex, "marketIndex");
      validateSide(errors, intent.params.side, "side");
      validateAmount(errors, intent.params.amount, "amount");
      if (intent.params.price !== undefined) {
        validateAmount(errors, intent.params.price, "price");
      }
      break;

    case "driftCancelOrder":
      validateNonNegativeInt(errors, intent.params.orderId, "orderId");
      break;

    case "kaminoDeposit":
    case "kaminoBorrow":
    case "kaminoRepay":
    case "kaminoWithdraw":
      validateAddress(errors, intent.params.mint, "mint");
      validateAmount(errors, intent.params.amount, "amount");
      break;

    case "protocol":
      validateNonEmpty(errors, intent.params.protocolId, "protocolId");
      validateNonEmpty(errors, intent.params.action, "action");
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateAmount(
  errors: AgentError[],
  value: string,
  field: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(
      makeError(field, value, "Amount must be a non-empty numeric string"),
    );
    return;
  }

  // Must be a valid number
  const num = Number(value);
  if (isNaN(num)) {
    errors.push(makeError(field, value, `"${value}" is not a valid number`));
    return;
  }

  // Must be positive
  if (num <= 0) {
    errors.push(
      makeError(field, value, "Amount must be positive", {
        action: "fix_amount",
        description: `Set ${field} to a positive value`,
      }),
    );
    return;
  }

  // Check u64 range for integer amounts (base unit amounts)
  // Allow decimals (human-readable amounts) but check integer amounts against u64
  if (Number.isInteger(num)) {
    try {
      const bigVal = BigInt(value);
      if (bigVal > U64_MAX) {
        errors.push(
          makeError(
            field,
            value,
            "Amount exceeds u64 maximum (18446744073709551615)",
            {
              action: "reduce_amount",
              description: "Use a smaller amount within u64 range",
            },
          ),
        );
      }
    } catch {
      // BigInt conversion failed — already caught by Number check above
    }
  }
}

function validateAddress(
  errors: AgentError[],
  value: string,
  field: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(makeError(field, value, "Address must be a non-empty string"));
    return;
  }

  if (!BASE58_REGEX.test(value)) {
    errors.push(
      makeError(
        field,
        value,
        "Invalid Solana address (must be 32-44 base58 characters)",
        {
          action: "fix_address",
          description: `Provide a valid base58-encoded Solana public key for ${field}`,
        },
      ),
    );
  }
}

function validateSlippageBps(
  errors: AgentError[],
  value: number,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(makeError(field, value, "Slippage must be a finite number"));
    return;
  }
  if (!Number.isInteger(value)) {
    errors.push(makeError(field, value, "Slippage BPS must be an integer"));
    return;
  }
  if (value < 0 || value > MAX_SLIPPAGE_BPS) {
    errors.push(
      makeError(
        field,
        value,
        `Slippage BPS must be between 0 and ${MAX_SLIPPAGE_BPS}`,
        {
          action: "fix_slippage",
          description: "Common values: 50 (0.5%), 100 (1%), 300 (3%)",
        },
      ),
    );
  }
}

function validateLeverage(
  errors: AgentError[],
  value: number,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(makeError(field, value, "Leverage must be a finite number"));
    return;
  }
  if (value <= 0 || value > MAX_LEVERAGE) {
    errors.push(
      makeError(field, value, `Leverage must be > 0 and <= ${MAX_LEVERAGE}`, {
        action: "fix_leverage",
        description: `Set leverage between 1 and ${MAX_LEVERAGE}`,
      }),
    );
  }
}

function validateLeverageBps(
  errors: AgentError[],
  value: number,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(
      makeError(field, value, "Leverage BPS must be a finite number"),
    );
    return;
  }
  if (!Number.isInteger(value)) {
    errors.push(makeError(field, value, "Leverage BPS must be an integer"));
    return;
  }
  if (value <= 0 || value > MAX_LEVERAGE_BPS) {
    errors.push(
      makeError(
        field,
        value,
        `Leverage BPS must be > 0 and <= ${MAX_LEVERAGE_BPS}`,
        {
          action: "fix_leverage",
          description: `Set leverageBps between 1 and ${MAX_LEVERAGE_BPS} (10000 = 1x)`,
        },
      ),
    );
  }
}

function validateSide(
  errors: AgentError[],
  value: string,
  field: string,
): void {
  if (value !== "long" && value !== "short") {
    errors.push(
      makeError(field, value, 'Side must be "long" or "short"', {
        action: "fix_side",
        description: 'Use exactly "long" or "short" — no other values accepted',
      }),
    );
  }
}

function validateNonEmpty(
  errors: AgentError[],
  value: unknown,
  field: string,
): void {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(makeError(field, value, `${field} must be a non-empty string`));
  }
}

function validateNonNegativeInt(
  errors: AgentError[],
  value: number,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(makeError(field, value, `${field} must be a finite number`));
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    errors.push(
      makeError(field, value, `${field} must be a non-negative integer`),
    );
  }
}

function validateEscrowDuration(
  errors: AgentError[],
  value: number,
  field: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(
      makeError(field, value, "Escrow duration must be a finite number"),
    );
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(
      makeError(
        field,
        value,
        "Escrow duration must be a positive integer (seconds)",
      ),
    );
    return;
  }
  if (value > MAX_ESCROW_DURATION) {
    errors.push(
      makeError(
        field,
        value,
        `Escrow duration exceeds maximum (${MAX_ESCROW_DURATION} seconds = 30 days)`,
        {
          action: "reduce_duration",
          description: `Set expiresInSeconds to ${MAX_ESCROW_DURATION} or less`,
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Error construction helper
// ---------------------------------------------------------------------------

function makeError(
  field: string,
  received: unknown,
  message: string,
  recovery?: { action: string; description: string },
): AgentError {
  return {
    code: "INTENT_VALIDATION_FAILED",
    message,
    category: "INPUT_VALIDATION",
    retryable: false,
    recovery_actions: recovery
      ? [recovery]
      : [
          {
            action: "fix_inputs",
            description: `Fix the ${field} parameter`,
          },
        ],
    context: {
      field,
      received: typeof received === "string" ? received : String(received),
    },
  };
}
