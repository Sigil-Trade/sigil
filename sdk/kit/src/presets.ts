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
  PROTOCOL_MODE_ALL,
  PROTOCOL_MODE_ALLOWLIST,
  JUPITER_PROGRAM_ADDRESS,
} from "./types.js";

// ─── Protocol Addresses ──────────────────────────────────────────────────────

const FLASH_TRADE_PROGRAM =
  "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn" as Address;
const JUPITER_LEND_PROGRAM =
  "JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu" as Address;
const KAMINO_LEND_PROGRAM =
  "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;

// Preset capability is the on-chain 2-bit value (0 = Disabled, 1 = Observer,
// 2 = Operator). All presets that execute trades need `FULL_CAPABILITY` (2n).
// Every preset configures a policy that permits spending, so every preset
// needs Operator. Per-action restriction lives in `InstructionConstraints`,
// not in this capability value.

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
  /** Max slippage in basis points. */
  maxSlippageBps: number;
  /** Protocol mode: 0 = all, 1 = allowlist, 2 = denylist. */
  protocolMode: number;
  /** Allowed/denied protocol addresses (empty if mode = all). */
  protocols: Address[];
  /** Max leverage in basis points (0 = no leverage). */
  maxLeverageBps: number;
  /** Max concurrent open positions. */
  maxConcurrentPositions: number;
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
    maxLeverageBps: 0,
    maxConcurrentPositions: 0,
  },
  "perps-trader": {
    label: "Perps Trader",
    description:
      "Leveraged trading on Flash Trade and Jupiter. Operator capability with position limits.",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(5_000_000_000n), // $5,000
    maxTransactionSizeUsd: usd(1_000_000_000n), // $1,000
    maxSlippageBps: 500, // 5%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS, FLASH_TRADE_PROGRAM],
    maxLeverageBps: 10_000, // 10x
    maxConcurrentPositions: 5,
  },
  "lending-optimizer": {
    label: "Lending Optimizer",
    description:
      "Deposit and withdraw across lending protocols. Operator capability, low slippage, moderate caps.",
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
    maxLeverageBps: 0,
    maxConcurrentPositions: 0,
  },
  "full-access": {
    label: "Full Access",
    description:
      "Full capability enabled, all protocols allowed. For experienced users who need maximum flexibility.",
    capability: FULL_CAPABILITY,
    permissions: FULL_CAPABILITY,
    dailySpendingCapUsd: usd(10_000_000_000n), // $10,000
    maxTransactionSizeUsd: usd(5_000_000_000n), // $5,000
    maxSlippageBps: 500, // 5%
    protocolMode: PROTOCOL_MODE_ALL,
    protocols: [],
    maxLeverageBps: 20_000, // 20x
    maxConcurrentPositions: 10,
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
  | "maxLeverageBps"
  | "maxConcurrentPositions"
> {
  const preset = VAULT_PRESETS[name];
  return {
    permissions: preset.permissions,
    dailySpendingCapUsd: preset.dailySpendingCapUsd,
    maxTransactionSizeUsd: preset.maxTransactionSizeUsd,
    maxSlippageBps: preset.maxSlippageBps,
    protocolMode: preset.protocolMode,
    protocols: [...preset.protocols],
    maxLeverageBps: preset.maxLeverageBps,
    maxConcurrentPositions: preset.maxConcurrentPositions,
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
