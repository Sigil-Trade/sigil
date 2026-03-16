import { z } from "zod";

// ── Shared schemas for constraint builder tools ──────────────

export const actionRuleSchema = z.object({
  actions: z.array(z.string()).describe("Instruction names this rule applies to"),
  type: z.string().describe("Rule type (e.g., 'allowAll', 'maxPositionSize', 'allowedMarkets')"),
  params: z.record(z.string(), z.unknown()).describe("Rule-specific params (empty {} for allowAll)"),
});

export const protocolConfigSchema = z.object({
  protocolId: z.string().describe("Protocol ID (e.g., 'flash-trade', 'kamino')"),
  actionRules: z.array(actionRuleSchema).describe("Rules for this protocol"),
  strictMode: z.boolean().optional().describe("If true, reject actions without any rule"),
});

// ── Shared kit loader + descriptor map ───────────────────────

let kitCache: typeof import("@phalnx/kit") | null = null;

export async function loadKit() {
  if (!kitCache) {
    kitCache = await import("@phalnx/kit");
  }
  return kitCache;
}

export async function getDescriptors(): Promise<Record<string, any>> {
  const kit = await loadKit();
  return {
    "flash-trade": kit.FlashTradeDescriptor,
    "kamino": kit.KaminoDescriptor,
  };
}
