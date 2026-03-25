/**
 * Shared protocol name resolution — used by event-analytics and spending-analytics.
 *
 * Extracted per ANALYTICS-IMPLEMENTATION-GUIDE-PT2 Bug #6 recommendation
 * to avoid duplicate maps that drift independently.
 */

import { formatAddress } from "./formatting.js";

export const PROTOCOL_NAMES: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn: "Flash Trade",
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: "Drift",
  KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM: "Kamino",
  JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu: "Jupiter Lend",
};

export function resolveProtocolName(protocol: string): string {
  return PROTOCOL_NAMES[protocol] ?? formatAddress(protocol);
}
