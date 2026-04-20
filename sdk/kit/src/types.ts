/**
 * Kit-native type constants + permission helpers for Sigil.
 *
 * All types use Kit's `Address` (branded string) instead of web3.js `PublicKey`,
 * and `bigint` instead of `BN`.
 */

import type { Address, Instruction } from "./kit-adapter.js";

import { SigilSdkDomainError } from "./errors/sdk.js";
import { SIGIL_ERROR__SDK__INVALID_NETWORK } from "./errors/codes.js";

// Re-export the program address from generated code
export { SIGIL_PROGRAM_ADDRESS } from "./generated/programs/sigil.js";

// Re-export generated types
/** @deprecated v6: ActionType eliminated. Use isSpending instead. */
export type ActionType = never;
export type { VaultStatus } from "./generated/types/vaultStatus.js";
export type { EscrowStatus } from "./generated/types/escrowStatus.js";
export type { AgentEntry } from "./generated/types/agentEntry.js";
export type { EpochBucket } from "./generated/types/epochBucket.js";
export type { ConstraintEntry } from "./generated/types/constraintEntry.js";
export type { DataConstraint } from "./generated/types/dataConstraint.js";
export type { AccountConstraint } from "./generated/types/accountConstraint.js";
export type { ConstraintOperator } from "./generated/types/constraintOperator.js";

// ─── Fee Constants ────────────────────────────────────────────────────────────

export const FEE_RATE_DENOMINATOR = 1_000_000;
export const PROTOCOL_FEE_RATE = 200; // 2 BPS
export const MAX_DEVELOPER_FEE_RATE = 500; // 5 BPS
export const PROTOCOL_TREASURY =
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT" as Address;

// ─── Branded Types (PR 2.B — H7-BRAND) ──────────────────────────────────────
//
// Zero-runtime-cost branded types that prevent semantic conflation.
// `addAgent(agent, FULL_CAPABILITY, DAILY_CAP)` NOW fails to compile if
// parameters are swapped — FULL_CAPABILITY is CapabilityTier, DAILY_CAP is
// UsdBaseUnits; they are not assignable to each other even though both are
// bigint at runtime.
//
// Pattern: intersection with a phantom branded property using unique symbol.
// Matches the approach used by @solana/kit's Address type (via
// @solana/nominal-types), but defined inline to avoid adding a dependency.

declare const __usdBrand: unique symbol;
declare const __capBrand: unique symbol;
declare const __slotBrand: unique symbol;

/**
 * USD amount in 6-decimal base units.
 * $500 = `usd(500_000_000n)`. $0.01 = `usd(10_000n)`.
 *
 * NOT assignable to/from plain `bigint` or `CapabilityTier` without the
 * `usd()` constructor.
 */
export type UsdBaseUnits = bigint & { readonly [__usdBrand]: never };

/**
 * Vault capability tier: 0 = Disabled, 1 = Observer, 2 = Operator.
 *
 * NOT assignable to/from plain `bigint` or `UsdBaseUnits` without the
 * `capability()` constructor.
 */
export type CapabilityTier = bigint & { readonly [__capBrand]: never };

/**
 * Solana slot number (monotonically increasing u64).
 *
 * NOT assignable to/from plain `bigint`, `UsdBaseUnits`, or `CapabilityTier`
 * without the `slot()` constructor.
 */
export type Slot = bigint & { readonly [__slotBrand]: never };

/** Construct a branded USD base-units amount. Zero runtime cost. */
export function usd(amount: bigint): UsdBaseUnits {
  return amount as UsdBaseUnits;
}

/**
 * Construct a branded capability tier. Validates range (0–2) at runtime.
 * @throws RangeError if tier is not 0n, 1n, or 2n.
 */
export function capability(tier: 0n | 1n | 2n): CapabilityTier {
  return tier as CapabilityTier;
}

/** Construct a branded slot number. Zero runtime cost. */
export function slot(s: bigint): Slot {
  return s as Slot;
}

// ─── USD Constants ────────────────────────────────────────────────────────────

export const USD_DECIMALS = 6;
/** Scaling factor for stablecoin-to-USD conversion.
 *  USDC/USDT both use 6 decimals: amount / STABLECOIN_USD_FACTOR = USD.
 *  This assumption is load-bearing — if a stablecoin with different decimals
 *  is added to isStablecoinMint(), this factor must be updated. */
export const STABLECOIN_USD_FACTOR = 10n ** BigInt(USD_DECIMALS);

// ─── Multi-agent Constants ────────────────────────────────────────────────────

export const MAX_AGENTS_PER_VAULT = 10;
/** Mirror of on-chain MAX_ALLOWED_PROTOCOLS — bounds PolicyConfig.protocols vec. */
export const MAX_ALLOWED_PROTOCOLS = 10;
/**
 * Capability tier: Operator (2) — "can spend" + "can hold positions".
 * Replaces the legacy 21-bit ActionType permission bitmask.
 * On-chain v6 uses a 2-bit capability model instead of per-action permissions.
 *
 * PR 2.B: now typed as `CapabilityTier` — NOT assignable to `UsdBaseUnits`
 * or plain `bigint` without the `capability()` constructor.
 */
export const FULL_CAPABILITY: CapabilityTier = capability(2n);
/** @deprecated Use FULL_CAPABILITY instead. Kept for backward compatibility. */
export const FULL_PERMISSIONS: CapabilityTier = FULL_CAPABILITY;
// Legacy 21-bit permission bitmasks (SWAP_ONLY, PERPS_ONLY, TRANSFER_ONLY,
// ESCROW_ONLY, PERPS_FULL) were removed in the A11 cleanup — they encoded a
// pre-v6 permission model the on-chain program no longer supports. Use
// FULL_CAPABILITY (2n) for operator agents and put granular per-action
// restrictions in InstructionConstraints.

// ─── Escrow Constants ─────────────────────────────────────────────────────────

export const MAX_ESCROW_DURATION = 2_592_000; // 30 days in seconds

// ─── u64 Boundary ────────────────────────────────────────────────────────────

/** Maximum u64 value — used for BigInt clamping to match on-chain Rust math. */
export const U64_MAX = BigInt("18446744073709551615");

// ─── Slippage Constants ───────────────────────────────────────────────────────

export const MAX_SLIPPAGE_BPS = 5_000; // 50%

// ─── SpendTracker Constants ───────────────────────────────────────────────────

export const EPOCH_DURATION = 600; // 10 minutes in seconds
export const NUM_EPOCHS = 144; // 144 × 10 min = 24h

// ─── AgentSpendOverlay Constants ─────────────────────────────────────────────

export const OVERLAY_EPOCH_DURATION = 3600; // 1 hour in seconds
export const OVERLAY_NUM_EPOCHS = 24; // 24 × 1h = 24h
export const ROLLING_WINDOW_SECONDS = 86_400; // 24 hours in seconds

// ─── Protocol Mode ────────────────────────────────────────────────────────────

export const PROTOCOL_MODE_ALL = 0;
export const PROTOCOL_MODE_ALLOWLIST = 1;
export const PROTOCOL_MODE_DENYLIST = 2;

// ─── Stablecoin Mints ─────────────────────────────────────────────────────────

// Devnet mints: test-controlled keypairs matching on-chain state/mod.rs
// (we own the mint authority for devnet testing)
export const USDC_MINT_DEVNET =
  "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH" as Address;
export const USDC_MINT_MAINNET =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
export const USDT_MINT_DEVNET =
  "43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze" as Address;
export const USDT_MINT_MAINNET =
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;

// ─── Well-Known Program Addresses (PR 3.B — F036 constant dedup) ────────────
// Single source of truth. Previously duplicated across 4+ files.

export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

export const TOKEN_2022_PROGRAM_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

export const ATA_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111" as Address;

export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

export const JUPITER_PROGRAM_ADDRESS =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

// ─── Supported Protocol Registry (PR 3.B — F042 single source of truth) ─────
//
// Previously duplicated across 3 files (types.ts, protocol-names.ts,
// priority-fees.ts) with divergent entries. Now a single registry.

export interface ProtocolMeta {
  /** Human-readable protocol name. */
  name: string;
  /** Whether this protocol is instruction-count-limited by on-chain
   * validate_and_authorize.rs:325-329. Only programs in this set
   * are counted for the "exactly 1 DeFi instruction" enforcement. */
  instructionCountLimited: boolean;
  /** Default CU estimate for composed transactions with this protocol. */
  defaultCU: number;
}

/**
 * Single source of truth for all supported DeFi protocols.
 *
 * Unifies RECOGNIZED_DEFI_PROGRAMS (instruction count enforcement),
 * PROTOCOL_NAMES (analytics display), and priority-fees constants.
 * Adding a new protocol requires ONE entry here.
 */
export const SUPPORTED_PROTOCOLS: Record<string, ProtocolMeta> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    name: "Jupiter",
    instructionCountLimited: true,
    defaultCU: 600_000,
  },
  FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn: {
    name: "Flash Trade",
    instructionCountLimited: true,
    defaultCU: 800_000,
  },
  JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu: {
    name: "Jupiter Lend",
    instructionCountLimited: true,
    defaultCU: 400_000,
  },
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: {
    name: "Jupiter Earn",
    instructionCountLimited: true,
    defaultCU: 400_000,
  },
  jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi: {
    name: "Jupiter Borrow",
    instructionCountLimited: true,
    defaultCU: 400_000,
  },
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: {
    name: "Drift",
    instructionCountLimited: false,
    defaultCU: 800_000,
  },
  KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM: {
    name: "Kamino",
    instructionCountLimited: false,
    defaultCU: 400_000,
  },
};

/** The programs that are instruction-count-limited (derived from registry). */
export const RECOGNIZED_DEFI_PROGRAMS: ReadonlySet<string> = new Set(
  Object.entries(SUPPORTED_PROTOCOLS)
    .filter(([, meta]) => meta.instructionCountLimited)
    .map(([addr]) => addr),
);

export type Network = "devnet" | "mainnet-beta";

/** Validate that a string is a recognized Network value. */
export function validateNetwork(network: string): asserts network is Network {
  const normalized = network === "mainnet" ? "mainnet-beta" : network;
  if (normalized !== "devnet" && normalized !== "mainnet-beta") {
    throw new SigilSdkDomainError(
      SIGIL_ERROR__SDK__INVALID_NETWORK,
      `Invalid network: "${network}". Must be "devnet", "mainnet", or "mainnet-beta".`,
      {
        context: {
          received: network,
          valid: ["devnet", "mainnet", "mainnet-beta"],
        },
      },
    );
  }
}

/** Short-form network accepted by public APIs. Normalized internally. */
export type NetworkInput = "devnet" | "mainnet" | "mainnet-beta";

/** Convert short-form network to canonical Network type.
 *  "mainnet" → "mainnet-beta", all others pass through. */
export function normalizeNetwork(network: NetworkInput): Network {
  return network === "mainnet" ? "mainnet-beta" : (network as Network);
}

/** Type-safe instruction conversion from Codama builders. */
export function toInstruction(ix: {
  programAddress: Address;
  accounts?: readonly unknown[];
  data?: unknown;
}): Instruction {
  return ix as Instruction;
}

/** Check if a mint address is a recognized stablecoin (network-aware). */
export function isStablecoinMint(mint: Address, network: Network): boolean {
  if (network === "devnet") {
    return mint === USDC_MINT_DEVNET || mint === USDT_MINT_DEVNET;
  }
  return mint === USDC_MINT_MAINNET || mint === USDT_MINT_MAINNET;
}

// ─── ActionType Parsing ──────────────────────────────────────────────────────
//
// The v6 on-chain program eliminated per-action permission bits in favor of a
// 2-bit capability enum. `parseActionType` is preserved because
// `event-analytics.ts` still reads numeric ActionType values from on-chain
// events and needs the string label for UI display. It does NOT grant or
// check any permission — the v6 program enforces capability (0/1/2), not
// ActionType.

/**
 * Canonical action-type names indexed by the v6 on-chain ActionType enum
 * variant. Index 0 = `Swap`, index 20 = `RefundEscrow`. This is the ONLY
 * permission-related state still in this file post-A11 — it powers
 * `parseActionType` for event decoding and nothing else.
 */
const ACTION_TYPE_NAMES_BY_INDEX = [
  "swap", // 0
  "openPosition", // 1
  "closePosition", // 2
  "increasePosition", // 3
  "decreasePosition", // 4
  "deposit", // 5
  "withdraw", // 6
  "transfer", // 7
  "addCollateral", // 8
  "removeCollateral", // 9
  "placeTriggerOrder", // 10
  "editTriggerOrder", // 11
  "cancelTriggerOrder", // 12
  "placeLimitOrder", // 13
  "editLimitOrder", // 14
  "cancelLimitOrder", // 15
  "swapAndOpenPosition", // 16
  "closeAndSwapPosition", // 17
  "createEscrow", // 18
  "settleEscrow", // 19
  "refundEscrow", // 20
] as const;

/**
 * Parse an action type to its string key.
 * Accepts either a numeric ActionType enum value (0-20) or an
 * Anchor-style `{ Swap: {} }` object. Returns `undefined` for
 * out-of-range numeric values or empty objects.
 */
export function parseActionType(
  actionType: number | Record<string, unknown>,
): string | undefined {
  if (typeof actionType === "number") {
    return ACTION_TYPE_NAMES_BY_INDEX[actionType];
  }
  return Object.keys(actionType)[0];
}

// ─── Spending Classification ─────────────────────────────────────────────────

// PositionEffect type + getPositionEffect helper REMOVED — position counter
// system deleted wholesale per council decision (9-1 vote, 2026-04-19).
// Spending classification is authoritative via session.is_spending (set from
// amount > 0 in validate_and_authorize) — not derived from position semantics.

export function isSpendingAction(actionType: string): boolean {
  return [
    "swap",
    "openPosition",
    "increasePosition",
    "deposit",
    "transfer",
    "addCollateral",
    "placeLimitOrder",
    "swapAndOpenPosition",
    "createEscrow",
  ].includes(actionType);
}
