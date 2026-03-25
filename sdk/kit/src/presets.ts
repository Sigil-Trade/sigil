/**
 * Vault creation presets — safe defaults for common use cases.
 *
 * Presets provide the policy/permission fields for CreateVaultOptions.
 * Runtime fields (rpc, network, owner, agent, feeDestination, vaultId)
 * are NOT included — the caller supplies those.
 *
 * Dashboard "Create Vault" wizard uses these as "Quick Setup" cards
 * before the custom configuration step.
 */

import type { Address } from "@solana/kit";
import type { CreateVaultOptions } from "./create-vault.js";
import {
  FULL_PERMISSIONS,
  SWAP_ONLY,
  PERPS_FULL,
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

// ─── Permission Helpers ──────────────────────────────────────────────────────

/** Swap (0) + Deposit (5) + Withdraw (6) — lending use case */
const LENDING_PERMISSIONS = SWAP_ONLY | (1n << 5n) | (1n << 6n);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Policy fields from CreateVaultOptions that a preset configures. */
export interface VaultPreset {
  /** Human-readable label for UI display. */
  label: string;
  /** One-sentence description for the wizard card. */
  description: string;
  /** Agent permission bitmask (21 bits). */
  permissions: bigint;
  /** Rolling 24h spending cap in USD base units (6 decimals). */
  dailySpendingCapUsd: bigint;
  /** Max single transaction size in USD base units. */
  maxTransactionSizeUsd: bigint;
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
      "Simple swap bot using Jupiter. Swap permission only, conservative caps.",
    permissions: SWAP_ONLY,
    dailySpendingCapUsd: 500_000_000n, // $500
    maxTransactionSizeUsd: 100_000_000n, // $100
    maxSlippageBps: 200, // 2%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS],
    maxLeverageBps: 0,
    maxConcurrentPositions: 0,
  },
  "perps-trader": {
    label: "Perps Trader",
    description:
      "Leveraged trading on Flash Trade and Jupiter. Full order management with position limits.",
    permissions: PERPS_FULL | SWAP_ONLY,
    dailySpendingCapUsd: 5_000_000_000n, // $5,000
    maxTransactionSizeUsd: 1_000_000_000n, // $1,000
    maxSlippageBps: 500, // 5%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS, FLASH_TRADE_PROGRAM],
    maxLeverageBps: 10_000, // 10x
    maxConcurrentPositions: 5,
  },
  "lending-optimizer": {
    label: "Lending Optimizer",
    description:
      "Deposit and withdraw across lending protocols. Low slippage, moderate caps.",
    permissions: LENDING_PERMISSIONS,
    dailySpendingCapUsd: 2_000_000_000n, // $2,000
    maxTransactionSizeUsd: 500_000_000n, // $500
    maxSlippageBps: 100, // 1%
    protocolMode: PROTOCOL_MODE_ALLOWLIST,
    protocols: [JUPITER_PROGRAM_ADDRESS, JUPITER_LEND_PROGRAM, KAMINO_LEND_PROGRAM],
    maxLeverageBps: 0,
    maxConcurrentPositions: 0,
  },
  "full-access": {
    label: "Full Access",
    description:
      "All permissions enabled, all protocols allowed. For experienced users who need maximum flexibility.",
    permissions: FULL_PERMISSIONS,
    dailySpendingCapUsd: 10_000_000_000n, // $10,000
    maxTransactionSizeUsd: 5_000_000_000n, // $5,000
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
  if (!Object.prototype.hasOwnProperty.call(VAULT_PRESETS, name)) return undefined;
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
