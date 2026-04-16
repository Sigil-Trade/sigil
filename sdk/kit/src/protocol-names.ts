/**
 * Shared protocol name resolution — used by event-analytics and spending-analytics.
 *
 * Extracted per ANALYTICS-IMPLEMENTATION-GUIDE-PT2 Bug #6 recommendation
 * to avoid duplicate maps that drift independently.
 */

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
