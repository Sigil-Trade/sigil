/**
 * Template definitions for vault provisioning.
 *
 * IMPORTANT: This module must NOT import heavy dependencies at the top level
 * (@solana/web3.js, @coral-xyz/anchor, @phalnx/sdk) to keep serverless
 * cold starts fast. Heavy deps are loaded dynamically in buildParamsFromTemplate.
 */

export type TemplateName = "conservative" | "moderate" | "aggressive";

export interface TemplateConfig {
  label: string;
  description: string;
  dailyCapUsd: number;
  maxTxUsd: number;
  /** Base58-encoded protocol program IDs */
  protocols: string[];
  maxLeverageBps: number;
  maxConcurrentPositions: number;
}

/** Known protocol program IDs (base58 strings — no @solana/web3.js import) */
const PROTOCOL_IDS = {
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  orca: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  meteora: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  flashTrade: "F1aShdFvR4FHMqAjMbBiGWCHKYaUqR6sFg1MG2pPVfkz",
};

/** USDC mint on Solana */
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const TEMPLATES: Record<TemplateName, TemplateConfig> = {
  conservative: {
    label: "Conservative",
    description: "$500/day, Jupiter only, no leverage",
    dailyCapUsd: 500,
    maxTxUsd: 250,
    protocols: [PROTOCOL_IDS.jupiter],
    maxLeverageBps: 0,
    maxConcurrentPositions: 0,
  },
  moderate: {
    label: "Moderate",
    description: "$2,000/day, Jupiter + Orca + Raydium + Meteora, 2x leverage",
    dailyCapUsd: 2000,
    maxTxUsd: 1000,
    protocols: [
      PROTOCOL_IDS.jupiter,
      PROTOCOL_IDS.orca,
      PROTOCOL_IDS.raydium,
      PROTOCOL_IDS.meteora,
    ],
    maxLeverageBps: 20000,
    maxConcurrentPositions: 3,
  },
  aggressive: {
    label: "Aggressive",
    description: "$10,000/day, all protocols, 5x leverage",
    dailyCapUsd: 10000,
    maxTxUsd: 5000,
    protocols: [
      PROTOCOL_IDS.jupiter,
      PROTOCOL_IDS.orca,
      PROTOCOL_IDS.raydium,
      PROTOCOL_IDS.meteora,
      PROTOCOL_IDS.flashTrade,
    ],
    maxLeverageBps: 50000,
    maxConcurrentPositions: 10,
  },
};

/**
 * Build InitializeVaultParams from a template name and optional overrides.
 * Heavy deps (@solana/web3.js, @coral-xyz/anchor) are loaded dynamically.
 */
export async function buildParamsFromTemplate(
  template: TemplateName,
  vaultId: any,
  feeDestination: any,
  overrides?: { dailyCap?: number },
) {
  const { PublicKey } = await import("@solana/web3.js");
  const { BN } = await import("@coral-xyz/anchor");

  const config = TEMPLATES[template];
  const dailyCap = overrides?.dailyCap ?? config.dailyCapUsd;
  const maxTx = overrides?.dailyCap
    ? Math.floor(overrides.dailyCap / 2)
    : config.maxTxUsd;

  function usd(dollars: number) {
    return new BN(dollars * 1_000_000);
  }

  return {
    vaultId,
    dailySpendingCapUsd: usd(dailyCap),
    maxTransactionSizeUsd: usd(maxTx),
    protocolMode: 1, // allowlist
    protocols: config.protocols.map((p) => new PublicKey(p)),
    maxLeverageBps: config.maxLeverageBps,
    maxConcurrentPositions: config.maxConcurrentPositions,
    feeDestination,
    developerFeeRate: 0,
    timelockDuration: new BN(0),
    allowedDestinations: [],
  };
}
