/**
 * Network-aware Address Lookup Table (ALT) configuration for Phalnx.
 *
 * Phalnx ALTs store non-program accounts shared across composed transactions:
 * USDC/USDT mints, protocol treasury ATAs, Instructions sysvar, Clock sysvar.
 * Program IDs are NOT stored (zero savings per Solana spec).
 *
 * EXPECTED_ALT_CONTENTS arrays are verified at runtime by verifyPhalnxAlt()
 * in alt-loader.ts. Mismatches on the Phalnx ALT throw (we control it).
 * Protocol ALTs (Jupiter, Flash Trade) rotate per-route and are NOT verified.
 */

import type { Address } from "@solana/kit";
import type { Network } from "./types.js";
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_DEVNET,
  USDT_MINT_MAINNET,
  PROTOCOL_TREASURY,
} from "./types.js";

// ─── Phalnx ALT Addresses ────────────────────────────────────────────────────

/** Devnet Phalnx ALT — deployed 2026-03-20, authority: 6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp */
export const PHALNX_ALT_DEVNET = "BtRLCMVamw9c3R8UDwgYBCFur5YVkqACmakVh9xi2aTw" as Address;

/** Mainnet Phalnx ALT — placeholder until deployed */
export const PHALNX_ALT_MAINNET = "11111111111111111111111111111111" as Address;

/** Well-known sysvar addresses stored in the Phalnx ALT */
const INSTRUCTIONS_SYSVAR =
  "Sysvar1nstructions1111111111111111111111111" as Address;
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;

/** Placeholder sentinel — System Program address indicates "not yet deployed" */
const ALT_PLACEHOLDER = "11111111111111111111111111111111" as Address;

/**
 * Get the Phalnx ALT address for a given network.
 * Throws if mainnet ALT has not been deployed yet (placeholder sentinel).
 */
export function getPhalnxAltAddress(network: Network): Address {
  if (network === "devnet") return PHALNX_ALT_DEVNET;
  if (PHALNX_ALT_MAINNET === ALT_PLACEHOLDER) {
    throw new Error(
      "Mainnet Phalnx ALT not yet deployed. Deploy the ALT and update PHALNX_ALT_MAINNET in alt-config.ts.",
    );
  }
  return PHALNX_ALT_MAINNET;
}

// ─── Verification Lists (S-5) ────────────────────────────────────────────────

/** Protocol treasury USDC ATA (devnet) — added 2026-03-24 via extend-phalnx-alt.ts */
const TREASURY_USDC_ATA_DEVNET =
  "J2SCySRvXFFQc6DdbRqnnmEz7kmtEtpM2FP37fz9R4Vt" as Address;

/** Protocol treasury USDT ATA (devnet) — added 2026-03-24 via extend-phalnx-alt.ts */
const TREASURY_USDT_ATA_DEVNET =
  "81RyRPBpxR5QK6ZBtjNDBSknid1qMHsrCcWF6w5NHKD6" as Address;

/**
 * Expected contents of the devnet Phalnx ALT (7 entries).
 * Used to verify ALT integrity after RPC fetch.
 * Updated 2026-03-24: added treasury USDC/USDT ATAs.
 */
export const EXPECTED_ALT_CONTENTS_DEVNET: Address[] = [
  USDC_MINT_DEVNET,
  USDT_MINT_DEVNET,
  PROTOCOL_TREASURY,
  INSTRUCTIONS_SYSVAR,
  CLOCK_SYSVAR,
  TREASURY_USDC_ATA_DEVNET,
  TREASURY_USDT_ATA_DEVNET,
];

/**
 * Expected contents of the mainnet Phalnx ALT.
 * Uses mainnet mints; treasury is the same across networks.
 * TODO: Add TREASURY_USDC_ATA_MAINNET and TREASURY_USDT_ATA_MAINNET
 * after deploying and extending the mainnet ALT. Derive from:
 *   getAssociatedTokenAddress(USDC_MINT_MAINNET, PROTOCOL_TREASURY, true)
 *   getAssociatedTokenAddress(USDT_MINT_MAINNET, PROTOCOL_TREASURY, true)
 */
export const EXPECTED_ALT_CONTENTS_MAINNET: Address[] = [
  USDC_MINT_MAINNET,
  USDT_MINT_MAINNET,
  PROTOCOL_TREASURY,
  INSTRUCTIONS_SYSVAR,
  CLOCK_SYSVAR,
];

/**
 * Get the expected ALT contents for a given network.
 * Used by verifyPhalnxAlt() to detect ALT corruption or staleness.
 */
export function getExpectedAltContents(network: Network): Address[] {
  return network === "devnet"
    ? EXPECTED_ALT_CONTENTS_DEVNET
    : EXPECTED_ALT_CONTENTS_MAINNET;
}
