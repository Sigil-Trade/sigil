/**
 * Vault creation presets — two axes:
 *
 *   1. VAULT_PRESETS: use-case templates (jupiter-swap-bot, perps-trader,
 *      lending-optimizer, full-access). Policy + capability configuration
 *      for a specific agent role. Used by the dashboard "Quick Setup" cards.
 *
 *   2. SAFETY_PRESETS: timelock + cap defaults (development, production).
 *      Orthogonal to use-case — either preset can be composed with any
 *      VAULT_PRESET to produce a complete CreateVaultOptions.
 *
 * Runtime fields (rpc, network, owner, agent, feeDestination, vaultId)
 * are NOT included in either axis — the caller supplies those.
 */

import type { Address } from "./kit-adapter.js";
import type { CreateVaultOptions } from "./create-vault.js";
import { usd, type UsdBaseUnits } from "./types.js";
import {
  FULL_CAPABILITY,
  PROTOCOL_MODE_ALLOWLIST,
  MAX_ALLOWED_PROTOCOLS,
  JUPITER_PROGRAM_ADDRESS,
} from "./types.js";
import { RECOGNIZED_PROTOCOLS } from "./protocol-names.js";

// ─── Protocol Addresses ──────────────────────────────────────────────────────

const FLASH_TRADE_PROGRAM =
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn" as Address;
const JUPITER_LEND_PROGRAM =
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu" as Address;
const KAMINO_LEND_PROGRAM =
  "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;

// Full Access allowlist: every Sigil-recognized protocol, capped at the
// on-chain max of 10. The deployed program is ALLOWLIST-ONLY —
// `initialize_vault` hard-rejects protocol_mode 0 (ALL) / 2 (DENYLIST), so
// "full access" is expressed as "all recognized venues allow-listed", NOT an
// unbounded allow-all. Owners can widen this by passing extra program IDs to
// createVault. If the recognized registry ever exceeds 10, the on-chain cap
// wins and the canonical leading set is taken.
const FULL_ACCESS_PROTOCOLS: Address[] = RECOGNIZED_PROTOCOLS.slice(
  0,
  MAX_ALLOWED_PROTOCOLS,
).map((p) => p.id);

// Preset capability is the on-chain 2-bit value (0 = Disabled, 1 = Observer,
// 2 = Operator). All presets that execute trades need `FULL_CAPABILITY` (2n).
// Every preset configures a policy that permits spending, so every preset
// needs Operator. Granular per-action enforcement is the policy allowlist +
// post-execution assertions, not this capability value.

// ─── Types ──────────────────────────────────────────────────────────────────

/** Policy fields from CreateVaultOptions that a preset configures. */
export interface VaultPreset {
  /** Human-readable label for UI display. */
  label: string;
  /** One-sentence description for the wizard card. */
  description: string;
  /**
   * Agent capability — on-chain enum (0 = Disabled, 1 = Observer,
   * 2 = Operator). NOT a bitmask; do not OR with other values. Exceeding
   * `2n` is rejected on-chain with `InvalidArgument`.
   */
  capability: bigint;
  /**
   * @deprecated Use `capability` instead. Alias for backward compatibility
   * with pre-v6 vault creation flows; the on-chain program no longer treats
   * this as a bitmask.
   */
  permissions: bigint;
  /** Rolling 24h spending cap in USD base units (6 decimals). */
  dailySpendingCapUsd: UsdBaseUnits;
  /** Max single transaction size in USD base units. */
  maxTransactionSizeUsd: UsdBaseUnits;
  /**
   * Advisory max slippage in basis points. NOTE: `max_slippage_bps` is stored
   * on-chain and bound into the policy digest, but the program does NOT reject
   * a swap by realized slippage — slippage enforcement is delegated to the
   * off-chain SDK / the DeFi instruction's own guard (e.g. Jupiter's
   * `slippageBps`). On-chain spending enforcement is outcome-based:
   * `finalize_session` measures the actual stablecoin balance delta against
   * the caps. Treat this as a client-side hint, not an on-chain guarantee.
   */
  maxSlippageBps: number;
  /**
   * Protocol mode. The deployed program accepts ONLY 1 = allowlist;
   * `initialize_vault` rejects 0 (all) and 2 (denylist). Kept as `number` to
   * mirror the on-chain field width.
   */
  protocolMode: number;
  /** Allow-listed protocol addresses (required — the on-chain mode is allowlist-only). */
  protocols: Address[];
}

// ─── Presets ────────────────────────────────────────────────────────────────

export const VAULT_PRESETS = {
  "jupiter-swap-bot": {
    label: "Jupiter Swap Bot",
    description:
      "Simple swap bot using Jupiter. Operator capability, conservative caps and Jupiter-only allowlist.",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(500_000_000n), // $500
    maxTransactionSizeUsd: usd(100_000_000n), // $100
    maxSlippageBps: 200, // 2%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS],
  },
  "perps-trader": {
    label: "Perps Trader",
    description:
      "Leveraged trading on Flash Trade and Jupiter. Operator capability, higher caps ($5,000/day, $1,000/tx).",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(5_000_000_000n), // $5,000
    maxTransactionSizeUsd: usd(1_000_000_000n), // $1,000
    maxSlippageBps: 500, // 5%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS, FLASH_TRADE_PROGRAM],
  },
  "lending-optimizer": {
    label: "Lending Optimizer",
    description:
      "Deposit and withdraw across lending protocols. Operator capability, moderate caps ($2,000/day, $500/tx).",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(2_000_000_000n), // $2,000
    maxTransactionSizeUsd: usd(500_000_000n), // $500
    maxSlippageBps: 100, // 1%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [
      JUPITER_PROGRAM_ADDRESS,
      JUPITER_LEND_PROGRAM,
      KAMINO_LEND_PROGRAM,
    ],
  },
  "full-access": {
    label: "Full Access",
    description:
      "Full capability enabled; every Sigil-recognized protocol allow-listed (up to the on-chain max of 10). For experienced users who need maximum flexibility.",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(10_000_000_000n), // $10,000
    maxTransactionSizeUsd: usd(5_000_000_000n), // $5,000
    maxSlippageBps: 500, // 5% (advisory — not enforced on-chain; see VaultPreset.maxSlippageBps)
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: FULL_ACCESS_PROTOCOLS,
  },
} as const satisfies Record<string, VaultPreset>;

export type PresetName = keyof typeof VAULT_PRESETS;

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * Get a vault preset by name.
 * @returns The preset, or undefined if name is not recognized.
 */
export function getPreset(name: string): VaultPreset | undefined {
  if (!Object.prototype.hasOwnProperty.call(VAULT_PRESETS, name))
    return undefined;
  return (VAULT_PRESETS as Record<string, VaultPreset>)[name];
}

/**
 * List all available preset names.
 */
export function listPresets(): PresetName[] {
  return Object.keys(VAULT_PRESETS) as PresetName[];
}

/**
 * Convert a preset into CreateVaultOptions fields (without runtime fields).
 * Merge with your own rpc, network, owner, agent to get a complete CreateVaultOptions.
 *
 * @example
 * ```typescript
 * const preset = presetToCreateVaultFields("jupiter-swap-bot");
 * const opts: CreateVaultOptions = { rpc, network: "devnet", owner, agent, ...preset };
 * const result = await createVault(opts);
 * ```
 */
export function presetToCreateVaultFields(
  name: PresetName,
): Pick<
  CreateVaultOptions,
  | "permissions"
  | "dailySpendingCapUsd"
  | "maxTransactionSizeUsd"
  | "maxSlippageBps"
  | "protocolMode"
  | "protocols"
> {
  const preset = VAULT_PRESETS[name];
  return {
    permissions: preset.permissions,
    dailySpendingCapUsd: preset.dailySpendingCapUsd,
    maxTransactionSizeUsd: preset.maxTransactionSizeUsd,
    maxSlippageBps: preset.maxSlippageBps,
    protocolMode: preset.protocolMode,
    protocols: [...preset.protocols],
  };
}

// ─── Safety Presets ─────────────────────────────────────────────────────────
//
// Orthogonal to VAULT_PRESETS. SAFETY_PRESETS configure timelock + caps,
// not capability or protocol surface. Compose with a VAULT_PRESETS entry
// (or custom fields) to produce a complete CreateVaultOptions.

/**
 * Fields a safety preset can fill. `null` means "caller must supply" —
 * the production preset leaves caps explicit on purpose to force thought
 * about the vault's blast radius before deployment.
 */
export interface SafetyPresetFields {
  /** Timelock duration in seconds — owner-initiated policy changes wait this long. */
  timelockDuration: number;
  /** Per-agent spending cap in USD base units, or null if caller must supply. */
  spendingLimitUsd: UsdBaseUnits | null;
  /** Vault-wide daily cap in USD base units, or null if caller must supply. */
  dailySpendingCapUsd: UsdBaseUnits | null;
}

/**
 * SAFETY_PRESETS — timelock + cap bundles for common deployment contexts.
 *
 * `development` — short timelock and small caps for throwaway devnet
 * vaults. The low caps keep a compromised agent's blast radius under
 * $500/day, and the 30-min timelock keeps iteration fast. Suitable for
 * CI runs and live testing.
 *
 * `production` — a 24-hour timelock to give operators time to notice
 * and cancel unexpected policy changes. Caps are deliberately left as
 * `null` — the consumer must supply them explicitly, which forces a
 * conversation about the vault's blast radius before the first real tx.
 */
export const SAFETY_PRESETS = {
  development: {
    timelockDuration: 1800, // 30 min
    spendingLimitUsd: usd(100_000_000n), // $100/agent
    dailySpendingCapUsd: usd(500_000_000n), // $500/day vault-wide
  },
  production: {
    timelockDuration: 86400, // 24 hours
    spendingLimitUsd: null,
    dailySpendingCapUsd: null,
  },
} as const satisfies Record<string, SafetyPresetFields>;

export type SafetyPresetName = keyof typeof SAFETY_PRESETS;

/**
 * Compose a safety preset with explicit overrides. Overrides win on
 * every field, so callers of `applySafetyPreset("production", { ... })`
 * can narrow the `null` caps with real values while keeping the
 * production timelock.
 *
 * @example
 *   const fields = applySafetyPreset("production", {
 *     spendingLimitUsd: usd(1_000_000_000n),
 *     dailySpendingCapUsd: usd(10_000_000_000n),
 *   });
 *   // → { timelockDuration: 86400, spendingLimitUsd: 1_000_000_000n, dailySpendingCapUsd: 10_000_000_000n }
 */
export function applySafetyPreset(
  name: SafetyPresetName,
  overrides: Partial<SafetyPresetFields> = {},
): SafetyPresetFields {
  const preset = SAFETY_PRESETS[name];
  return {
    timelockDuration: overrides.timelockDuration ?? preset.timelockDuration,
    spendingLimitUsd: overrides.spendingLimitUsd ?? preset.spendingLimitUsd,
    dailySpendingCapUsd:
      overrides.dailySpendingCapUsd ?? preset.dailySpendingCapUsd,
  };
}

/**
 * Ergonomic guard: if a safety preset has `null` caps (production), the
 * consumer must resolve them before calling createVault. This helper
 * narrows the preset type to its fully-resolved form or throws.
 */
export function requireResolvedSafetyPreset(preset: SafetyPresetFields): {
  timelockDuration: number;
  spendingLimitUsd: UsdBaseUnits;
  dailySpendingCapUsd: UsdBaseUnits;
} {
  if (preset.spendingLimitUsd === null || preset.dailySpendingCapUsd === null) {
    throw new Error(
      `Safety preset has unresolved caps. The "production" preset ` +
        `intentionally leaves spendingLimitUsd and dailySpendingCapUsd ` +
        `null so the caller supplies them explicitly. Pass both to ` +
        `applySafetyPreset("production", { ... }) before using the ` +
        `result with createVault.`,
    );
  }
  return {
    timelockDuration: preset.timelockDuration,
    spendingLimitUsd: preset.spendingLimitUsd,
    dailySpendingCapUsd: preset.dailySpendingCapUsd,
  };
}
