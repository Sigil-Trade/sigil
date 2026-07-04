/**
 * Shared protocol name resolution — used by event-analytics and spending-analytics.
 *
 * Extracted per ANALYTICS-IMPLEMENTATION-GUIDE-PT2 Bug #6 recommendation
 * to avoid duplicate maps that drift independently.
 */

import type { Address } from "./kit-adapter.js";
import { formatAddress } from "./formatting.js";
import { SUPPORTED_PROTOCOLS } from "./types.js";

// PR 3.B F042: derived from the canonical SUPPORTED_PROTOCOLS registry.
// No longer a standalone map — adding a protocol to types.ts automatically
// makes it resolvable here.
export const PROTOCOL_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SUPPORTED_PROTOCOLS).map(([addr, meta]) => [addr, meta.name]),
);

export function resolveProtocolName(protocol: string): string {
  return PROTOCOL_NAMES[protocol] ?? formatAddress(protocol);
}

/**
 * A Sigil-recognized DeFi protocol: on-chain program address + a
 * human-readable name for UI labeling.
 *
 * "Recognized" is NOT "verified". Recognition is a curated
 * display/allowlist convenience derived from {@link SUPPORTED_PROTOCOLS};
 * the "verified-build" (hash-armed) control is a distinct, owner-armed
 * on-chain gate (`PolicyConfig.protocol_hashes`) unrelated to this list.
 */
export interface RecognizedProtocol {
  id: Address;
  name: string;
}

/**
 * Ordered list of Sigil-recognized DeFi protocols (id + name), for UI
 * labeling and the Full Access preset's allowlist. Derived from the
 * canonical {@link SUPPORTED_PROTOCOLS} registry — adding a protocol there
 * surfaces it here automatically.
 *
 * Recognition is not a restriction: owners may allowlist arbitrary program
 * IDs beyond this set when creating a vault (`createVault` accepts any
 * `protocols`). This list only labels the ones Sigil ships names for.
 */
export const RECOGNIZED_PROTOCOLS: readonly RecognizedProtocol[] =
  Object.entries(SUPPORTED_PROTOCOLS).map(([id, meta]) => ({
    id: id as Address,
    name: meta.name,
  }));
