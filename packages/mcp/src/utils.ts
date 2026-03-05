import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type { VaultStatus, ActionType } from "@phalnx/sdk";

export function toPublicKey(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid public key: "${value}"`);
  }
}

export function toBN(value: string): BN {
  try {
    return new BN(value);
  } catch {
    throw new Error(
      `Invalid numeric value: "${value}". Provide a decimal integer string.`,
    );
  }
}

export function formatVaultStatus(status: VaultStatus): string {
  if ("active" in status) return "Active";
  if ("frozen" in status) return "Frozen";
  if ("closed" in status) return "Closed";
  return "Unknown";
}

export function formatActionType(action: ActionType): string {
  if ("swap" in action) return "Swap";
  if ("openPosition" in action) return "Open Position";
  if ("closePosition" in action) return "Close Position";
  if ("increasePosition" in action) return "Increase Position";
  if ("decreasePosition" in action) return "Decrease Position";
  if ("deposit" in action) return "Deposit";
  if ("withdraw" in action) return "Withdraw";
  return "Unknown";
}

export function formatBN(value: BN): string {
  return value.toString();
}

export function formatTimestamp(ts: BN): string {
  const ms = ts.toNumber() * 1000;
  return new Date(ms).toISOString();
}

export function formatLamports(lamports: BN, decimals: number = 9): string {
  const str = lamports.toString().padStart(decimals + 1, "0");
  const whole = str.slice(0, str.length - decimals) || "0";
  const frac = str.slice(str.length - decimals);
  // Trim trailing zeros
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}
