/**
 * `@usesigil/kit/post-assertions/presets/flash-trade` — Flash Trade leverage cap preset.
 *
 * Convenience wrapper around `leverageCapLteBps` that fills in the byte offsets
 * of a Flash Trade Position account's `size_usd` and `collateral_usd` fields.
 *
 * Callers provide a position account address + a leverage cap expressed in
 * "x" (multiples), and the preset returns a `PostAssertionEntry` that the
 * on-chain program enforces as:
 *
 *     size_usd × 10000 ≤ maxLeverage × 10000 × collateral_usd
 *     ⇔ leverage (= size_usd / collateral_usd) ≤ maxLeverage
 *
 * ## Field offsets (pinned to flash-sdk@15.x Perpetuals IDL)
 *
 * Derived from the Anchor IDL shipped with `flash-sdk@^15.14.1`
 * (`node_modules/flash-sdk/dist/idl/perpetuals.json`). Position account
 * Borsh layout, starting after the 8-byte Anchor discriminator:
 *
 *     offset  field                  type   size
 *         8   owner                  pubkey 32
 *        40   market                 pubkey 32
 *        72   delegate               pubkey 32
 *       104   open_time              i64    8
 *       112   update_time            i64    8
 *       120   entry_price            OraclePrice { price: u64, exponent: i32 } 12
 *       132   size_amount            u64    8
 *    → 140   size_usd                u64    8
 *       148   locked_amount          u64    8
 *       156   locked_usd             u64    8
 *       164   price_impact_usd       u64    8
 *    → 172   collateral_usd          u64    8
 *       ...
 *
 * A drift-check unit test (`presets/flash-trade.test.ts`) reloads the Anchor
 * IDL from `flash-sdk` at test time and recomputes offsets — any future
 * flash-sdk bump that shifts these fields fails the test before a broken
 * preset can ship.
 *
 * ## Jupiter Perps is NOT supported here
 *
 * Flash Trade executes position changes synchronously in the user's tx, so
 * post-execution assertions are meaningful. Jupiter Perpetuals uses a 2-tx
 * keeper-fulfillment model that silently bypasses post-assertions — that gate
 * is enforced upstream in `leverageCapLteBps` via
 * `JupiterPerpsPostAssertionUnsupportedError`, so a caller who mistakenly
 * plugs a Jupiter Perps Position address here gets an explicit error.
 *
 * ## Bounds on `maxLeverage`
 *
 * `maxLeverage` is an integer multiplier (e.g., 5 = 5x cap). We reject
 * values outside [1, 100]:
 *   - 0 would encode `size_usd ≤ 0` — any non-zero position fails, effectively
 *     a kill-switch. Safer to reject and let callers use `closePostAssertions`
 *     if they want to disable the cap entirely.
 *   - Values > 100 exceed any practical Flash Trade leverage (current mainnet
 *     caps sit around 25-50x) and are almost certainly caller bugs.
 *
 * @see programs/sigil/src/state/post_assertions.rs — on-chain CrossFieldLte enforcer
 * @see `@usesigil/kit/post-assertions/cross-field-lte.ts` — underlying builder
 */

import type { Address } from "@solana/kit";
import type { PostAssertionEntry } from "../../generated/types/postAssertionEntry.js";
import { leverageCapLteBps } from "../cross-field-lte.js";

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Flash Trade Perpetuals program address (mainnet-beta). Owner of Position
 * accounts that this preset targets.
 *
 * Source: `constants` module in `flash-sdk@^15.14.1`. Hard-coded here so the
 * preset is importable without loading the full flash-sdk runtime.
 */
export const FLASH_TRADE_PROGRAM_ADDRESS =
  "FLaSh6f6Y5bLsmcfiaxvqRJC3WQLKYh1iCfAsh7uMH8z" as Address;

/**
 * Byte offset of `size_usd` (u64, little-endian) inside Flash Trade Position
 * account data, starting from byte 0 of the account (NOT after discriminator).
 *
 * Pinned to flash-sdk@^15.14.1 Perpetuals IDL. A drift-check unit test
 * reloads the IDL and asserts this value matches.
 */
export const FLASH_TRADE_POSITION_SIZE_USD_OFFSET = 140;

/**
 * Byte offset of `collateral_usd` (u64, little-endian) inside Flash Trade
 * Position account data.
 *
 * Pinned to flash-sdk@^15.14.1 Perpetuals IDL. Drift-check test guards this.
 */
export const FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET = 172;

/**
 * Lowest permitted `maxLeverage` input — 1x. Zero would encode a kill-switch.
 */
export const MIN_LEVERAGE_X = 1;

/**
 * Highest permitted `maxLeverage` input. 100x is a generous upper bound above
 * any practical Flash Trade cap.
 */
export const MAX_LEVERAGE_X = 100;

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown when `maxLeverage` is outside [MIN_LEVERAGE_X, MAX_LEVERAGE_X] or
 * not an integer. Carries a DxError-compatible shape so FE can branch on
 * `.code` without `instanceof` checks that break across module realms.
 */
export class FlashTradeLeverageOutOfRangeError extends Error {
  /** DxError-compatible numeric code. 7009 reserved for preset validation. */
  public readonly code: number = 7009;
  public readonly recovery: readonly string[] = [
    `Pass a whole number between ${MIN_LEVERAGE_X} and ${MAX_LEVERAGE_X}.`,
    "To disable an existing leverage cap, call `closePostAssertions(...)`.",
  ];
  /**
   * Always `false` — thrown at CLIENT validation time, before any RPC
   * round-trip. Present to satisfy DxError's structural contract (every
   * DxError carries `onChainReverted`; see v2.2 contract C2).
   */
  public readonly onChainReverted: boolean = false;
  public readonly received: unknown;

  constructor(received: unknown) {
    super(
      `flashTradeLeverageCap: maxLeverage must be an integer in [${MIN_LEVERAGE_X}, ${MAX_LEVERAGE_X}] (got ${String(received)})`,
    );
    this.name = "FlashTradeLeverageOutOfRangeError";
    this.received = received;
    // TS target=ES2020 preserves .name/.message across supers; no extra handling needed.
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface FlashTradeLeverageCapOpts {
  /** Base-58 pubkey of the Flash Trade Position account to monitor. */
  readonly positionAccount: Address;
  /**
   * Maximum leverage in "x" units (e.g. 5 = 5x). Integer in [1, 100].
   * The preset throws `FlashTradeLeverageOutOfRangeError` on anything else.
   */
  readonly maxLeverage: number;
}

// ─── Builder ──────────────────────────────────────────────────────────────

/**
 * Build a post-assertion entry that caps Flash Trade leverage at `maxLeverage` × .
 *
 * Equivalent to calling {@link leverageCapLteBps} with Flash Trade's Position
 * `size_usd` / `collateral_usd` offsets filled in, `targetAccountOwnerProgram`
 * set to {@link FLASH_TRADE_PROGRAM_ADDRESS}, and `maxBps = maxLeverage * 10000`.
 *
 * @throws {FlashTradeLeverageOutOfRangeError} if `maxLeverage` is not an
 * integer in [1, 100].
 * @throws {import("../cross-field-lte.js").JupiterPerpsPostAssertionUnsupportedError}
 * re-thrown by the underlying builder if `targetAccountOwnerProgram` ever
 * drifts to Jupiter Perps (defense-in-depth — Flash Trade's program address
 * is hard-coded here, so this throw indicates either a preset bug or a
 * caller who hand-mutated the returned entry before submitting).
 */
export function flashTradeLeverageCap(
  opts: FlashTradeLeverageCapOpts,
): PostAssertionEntry {
  if (
    !Number.isInteger(opts.maxLeverage) ||
    opts.maxLeverage < MIN_LEVERAGE_X ||
    opts.maxLeverage > MAX_LEVERAGE_X
  ) {
    throw new FlashTradeLeverageOutOfRangeError(opts.maxLeverage);
  }

  const maxBps = opts.maxLeverage * 10_000;

  return leverageCapLteBps({
    targetAccount: opts.positionAccount,
    targetAccountOwnerProgram: FLASH_TRADE_PROGRAM_ADDRESS,
    fieldAOffset: FLASH_TRADE_POSITION_SIZE_USD_OFFSET,
    fieldBOffset: FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET,
    maxBps,
  });
}
