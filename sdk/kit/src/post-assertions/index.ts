/**
 * `@usesigil/kit/post-assertions` — builders for post-execution assertion
 * entries.
 *
 * This barrel exposes the typed helpers a dashboard or headless caller
 * needs to author `PostAssertionEntry` values for the
 * `createPostAssertions(...)` mutation without reaching into codegen
 * (covenant D1: no imports from `src/generated/**`).
 *
 * Currently exported:
 * - `leverageCapLteBps({ ... })` — generic CrossFieldLte builder for a
 *   "field_A ≤ maxBps × field_B" ratio check
 * - `JupiterPerpsPostAssertionUnsupportedError` — thrown when a caller
 *   tries to build a leverage cap against a Jupiter Perpetuals Position
 *   account (keeper-fulfillment model breaks post-execution semantics)
 * - `JUPITER_PERPS_PROGRAM_ADDRESS` — re-exported so callers can do their
 *   own pre-check if they prefer reporting over throwing
 *
 * Protocol-specific presets (e.g. `flashTradeLeverageCap`) land in a
 * `./presets/` sub-directory as they ship — one preset per protocol,
 * each backed by a committed IDL with a CI drift-check.
 */
export {
  JUPITER_PERPS_PROGRAM_ADDRESS,
  JupiterPerpsPostAssertionUnsupportedError,
  leverageCapLteBps,
} from "./cross-field-lte.js";
export type { LeverageCapLteOpts } from "./cross-field-lte.js";

// Protocol-specific presets — one file per protocol under `./presets/`.
// Each preset is backed by a committed IDL source with a drift-check test so
// any future SDK bump that shifts field offsets fails before shipping.
export {
  FLASH_TRADE_PROGRAM_ADDRESS,
  FLASH_TRADE_POSITION_SIZE_USD_OFFSET,
  FLASH_TRADE_POSITION_COLLATERAL_USD_OFFSET,
  MIN_LEVERAGE_X,
  MAX_LEVERAGE_X,
  FlashTradeLeverageOutOfRangeError,
  flashTradeLeverageCap,
} from "./presets/flash-trade.js";
export type { FlashTradeLeverageCapOpts } from "./presets/flash-trade.js";

// Re-export the underlying entry type so callers don't have to import from
// two places when composing a batch of entries to pass to
// `createPostAssertions(...)`.
export type { PostAssertionEntry } from "../generated/types/postAssertionEntry.js";
