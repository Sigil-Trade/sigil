/**
 * phalnx_advise — Agent reasoning support.
 *
 * Returns structured JSON guidance, NOT prose. Agents parse the output
 * to decide which tool to call next, whether to retry, or what went wrong.
 */

import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { lookupError } from "../errors";
import {
  loadShieldConfig,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";
import { toPublicKey, formatBN, permissionsToActions } from "../utils";

export const phalnxAdviseSchema = z.object({
  question: z
    .enum([
      "whatCanIDo",
      "bestRouteFor",
      "whyDidThisFail",
      "shouldIRetry",
      "protocolComparison",
    ])
    .describe(
      "The type of guidance needed. " +
        "whatCanIDo: list available actions for this agent. " +
        "bestRouteFor: recommend protocol for a token pair. " +
        "whyDidThisFail: explain error + recovery steps. " +
        "shouldIRetry: decide whether to retry a failed tx. " +
        "protocolComparison: compare two protocols for an action.",
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Additional context. For whyDidThisFail: { errorCode: number }. " +
        "For bestRouteFor: { inputToken, outputToken }. " +
        "For shouldIRetry: { errorCode: number, attemptCount: number }. " +
        "For protocolComparison: { action, protocols: string[] }. " +
        "For whatCanIDo: { vault: string }.",
    ),
});

export type PhalnxAdviseInput = z.infer<typeof phalnxAdviseSchema>;

export async function phalnxAdvise(
  client: PhalnxClient | null,
  _config: McpConfig | null,
  input: PhalnxAdviseInput,
  _custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  const ctx = input.context ?? {};

  switch (input.question) {
    case "whatCanIDo":
      return handleWhatCanIDo(client, ctx);
    case "bestRouteFor":
      return handleBestRouteFor(ctx);
    case "whyDidThisFail":
      return handleWhyDidThisFail(ctx);
    case "shouldIRetry":
      return handleShouldIRetry(ctx);
    case "protocolComparison":
      return handleProtocolComparison(ctx);
    default:
      return JSON.stringify({ error: "Unknown question type" });
  }
}

async function handleWhatCanIDo(
  client: PhalnxClient | null,
  ctx: Record<string, unknown>,
): Promise<string> {
  const vaultAddr =
    (ctx.vault as string) ??
    loadShieldConfig()?.layers?.vault?.address ??
    undefined;

  if (!client || !vaultAddr) {
    return JSON.stringify({
      question: "whatCanIDo",
      available: false,
      reason: !client
        ? "Not configured — run phalnx_setup first"
        : "No vault address provided",
      suggestedTool: "phalnx_setup",
      suggestedAction: "status",
    });
  }

  try {
    const vault = toPublicKey(vaultAddr);
    const vaultAccount = await client.fetchVaultByAddress(vault);
    const policy = await client.fetchPolicy(vault);

    const agentPubkey = client.provider.wallet.publicKey.toBase58();
    const agent = vaultAccount.agents.find(
      (a) => a.pubkey.toBase58() === agentPubkey,
    );

    if (!agent) {
      return JSON.stringify({
        question: "whatCanIDo",
        available: false,
        reason: "Agent not registered on this vault",
        suggestedTool: "phalnx_manage",
        suggestedAction: "registerAgent",
      });
    }

    const actions = permissionsToActions(agent.permissions.toString());
    const vaultStatus = Object.keys(vaultAccount.status)[0] ?? "unknown";

    return JSON.stringify({
      question: "whatCanIDo",
      available: vaultStatus === "active",
      vaultStatus,
      agentPaused: !!(agent as any).paused,
      allowedActions: actions,
      spendingLimitUsd: formatBN(agent.spendingLimitUsd),
      dailyCapUsd: formatBN(policy.dailySpendingCapUsd),
      maxSlippageBps: policy.maxSlippageBps,
      maxLeverageBps: policy.maxLeverageBps,
      protocolMode:
        ["all", "allowlist", "denylist"][policy.protocolMode] ?? "unknown",
      protocolCount: policy.protocols.length,
      suggestedTool: actions.includes("swap")
        ? "phalnx_execute"
        : "phalnx_query",
      suggestedAction: actions.includes("swap") ? "swap" : "vault",
    });
  } catch (err) {
    return JSON.stringify({
      question: "whatCanIDo",
      available: false,
      reason: err instanceof Error ? err.message : "Vault fetch failed",
      suggestedTool: "phalnx_query",
      suggestedAction: "vault",
    });
  }
}

function handleBestRouteFor(ctx: Record<string, unknown>): string {
  const input = (ctx.inputToken as string) ?? "";
  const output = (ctx.outputToken as string) ?? "";

  if (!input || !output) {
    return JSON.stringify({
      question: "bestRouteFor",
      error: "Provide inputToken and outputToken in context",
      suggestedTool: "phalnx_query",
      suggestedAction: "searchTokens",
    });
  }

  // Jupiter is the universal best route for swaps (aggregates all DEXs)
  return JSON.stringify({
    question: "bestRouteFor",
    inputToken: input,
    outputToken: output,
    recommendedProtocol: "jupiter",
    reason: "Jupiter aggregates 30+ DEXs for best price across all token pairs",
    suggestedTool: "phalnx_execute",
    suggestedAction: "swap",
    suggestedParams: {
      action: "swap",
      params: { inputToken: input, outputToken: output },
    },
    alternatives: [
      {
        protocol: "drift",
        useWhen: "Perpetual futures or spot margin trading",
        actions: ["driftPerpOrder", "driftSpotOrder", "driftDeposit"],
      },
      {
        protocol: "flash-trade",
        useWhen: "Leveraged perps up to 100x, pool-to-peer model",
        actions: ["openPosition", "increasePosition", "addCollateral"],
      },
    ],
  });
}

function handleWhyDidThisFail(ctx: Record<string, unknown>): string {
  const rawCode = ctx.errorCode;
  const errorCode =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/.test(rawCode)
        ? Number(rawCode)
        : undefined;

  if (errorCode === undefined) {
    return JSON.stringify({
      question: "whyDidThisFail",
      error: "Provide errorCode in context (e.g., 6004)",
      suggestedTool: "phalnx_advise",
      suggestedAction: "whyDidThisFail",
    });
  }

  const info = lookupError(errorCode);
  const category = categorizeError(errorCode);

  return JSON.stringify({
    question: "whyDidThisFail",
    errorCode: info.code,
    errorName: info.name,
    errorMessage: info.message,
    category,
    recoverySteps: getRecoverySteps(category),
    suggestedTool: getRecoveryTool(category),
    suggestedAction: getRecoveryAction(category),
  });
}

function handleShouldIRetry(ctx: Record<string, unknown>): string {
  const rawCode = ctx.errorCode;
  const errorCode =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/.test(rawCode)
        ? Number(rawCode)
        : undefined;
  const rawAttempt = ctx.attemptCount;
  const attemptCount =
    typeof rawAttempt === "number" && rawAttempt >= 0
      ? rawAttempt
      : typeof rawAttempt === "string" && /^\d+$/.test(rawAttempt)
        ? Number(rawAttempt)
        : 1;

  if (errorCode === undefined) {
    return JSON.stringify({
      question: "shouldIRetry",
      shouldRetry: false,
      reason: "No errorCode provided — cannot determine retryability",
    });
  }

  const category = categorizeError(errorCode);
  const retryable = category === "TRANSIENT" || category === "RATE_LIMIT";
  const maxAttempts = category === "RATE_LIMIT" ? 3 : 2;
  const shouldRetry = retryable && attemptCount < maxAttempts;

  return JSON.stringify({
    question: "shouldIRetry",
    shouldRetry,
    reason: shouldRetry
      ? `Error is ${category} — retry ${attemptCount + 1}/${maxAttempts}`
      : retryable
        ? `Max retries exceeded (${attemptCount}/${maxAttempts})`
        : `Error category ${category} is not retryable`,
    delayMs: shouldRetry
      ? Math.min(1000 * Math.pow(2, attemptCount - 1), 10000)
      : null,
    suggestedTool: shouldRetry ? "phalnx_execute" : getRecoveryTool(category),
    suggestedAction: shouldRetry ? null : getRecoveryAction(category),
  });
}

function handleProtocolComparison(ctx: Record<string, unknown>): string {
  const action = typeof ctx.action === "string" ? ctx.action : "";
  const protocols = Array.isArray(ctx.protocols)
    ? ctx.protocols.filter((p): p is string => typeof p === "string")
    : [];

  const protocolInfo: Record<
    string,
    {
      tier: string;
      bestFor: string;
      actions: string[];
      tradeoffs: string;
    }
  > = {
    jupiter: {
      tier: "T1_API",
      bestFor: "Token swaps, best price aggregation across 30+ DEXs",
      actions: ["swap"],
      tradeoffs: "Swap-only — no perps, no lending",
    },
    "flash-trade": {
      tier: "T2_SDK",
      bestFor: "Leveraged perpetual futures (up to 100x), pool-to-peer",
      actions: [
        "openPosition",
        "closePosition",
        "increasePosition",
        "decreasePosition",
        "addCollateral",
        "removeCollateral",
        "placeTriggerOrder",
        "placeLimitOrder",
      ],
      tradeoffs: "Limited token pairs (SOL, BTC, ETH + stablecoins)",
    },
    drift: {
      tier: "T2_SDK",
      bestFor: "Perps + spot margin trading, deepest liquidity for BTC/ETH/SOL",
      actions: [
        "driftDeposit",
        "driftWithdraw",
        "driftPerpOrder",
        "driftSpotOrder",
      ],
      tradeoffs: "More complex account setup, requires insurance fund",
    },
    kamino: {
      tier: "T2_SDK",
      bestFor: "Lending and borrowing, yield optimization",
      actions: [
        "kaminoDeposit",
        "kaminoBorrow",
        "kaminoRepay",
        "kaminoWithdraw",
      ],
      tradeoffs: "Lending-only — no trading, no perps",
    },
  };

  const requested =
    protocols.length > 0 ? protocols : Object.keys(protocolInfo);

  const comparison = requested.map((p) => {
    const info = protocolInfo[p];
    if (!info) return { protocol: p, available: false };
    return {
      protocol: p,
      available: true,
      ...info,
      supportsAction: action ? info.actions.includes(action) : null,
    };
  });

  return JSON.stringify({
    question: "protocolComparison",
    action: action || null,
    protocols: comparison,
    recommendation: action
      ? (comparison.find((c) => c.available && (c as any).supportsAction)
          ?.protocol ?? null)
      : null,
  });
}

// --- Helper functions ---

function categorizeError(code: number): string {
  if (code >= 6000 && code <= 6002) return "PERMISSION";
  if (code === 6003 || code === 6004 || code === 6005)
    return "INPUT_VALIDATION";
  if (code >= 6006 && code <= 6011) return "SPENDING_CAP";
  if (code === 6012 || code === 6013) return "RATE_LIMIT";
  if (code >= 6014 && code <= 6020) return "POLICY_VIOLATION";
  if (code >= 6043 && code <= 6045) return "PERMISSION";
  if (code >= 6067 && code <= 6069) return "PERMISSION";
  return "TRANSIENT";
}

function getRecoverySteps(category: string): string[] {
  switch (category) {
    case "PERMISSION":
      return [
        "Check agent permissions with phalnx_query type='vault'",
        "Verify agent is registered and not paused",
        "Contact vault owner if permissions need updating",
      ];
    case "SPENDING_CAP":
      return [
        "Check remaining cap with phalnx_query type='spending'",
        "Wait for 24h rolling window to reset",
        "Retry with a smaller amount",
      ];
    case "INPUT_VALIDATION":
      return [
        "Check error message for which parameter is invalid",
        "Use phalnx_query type='searchTokens' to verify token addresses",
        "Retry with corrected parameters",
      ];
    case "RATE_LIMIT":
      return [
        "Wait 2-5 seconds before retrying",
        "Check if session has expired",
      ];
    case "POLICY_VIOLATION":
      return [
        "Check vault policy with phalnx_query type='policy'",
        "Verify protocol is in allowlist",
        "Check slippage and leverage limits",
      ];
    default:
      return ["Retry the transaction", "Check network status"];
  }
}

function getRecoveryTool(category: string): string {
  switch (category) {
    case "PERMISSION":
      return "phalnx_query";
    case "SPENDING_CAP":
      return "phalnx_query";
    case "INPUT_VALIDATION":
      return "phalnx_advise";
    case "RATE_LIMIT":
      return "phalnx_execute";
    case "POLICY_VIOLATION":
      return "phalnx_query";
    default:
      return "phalnx_execute";
  }
}

function getRecoveryAction(category: string): string {
  switch (category) {
    case "PERMISSION":
      return "vault";
    case "SPENDING_CAP":
      return "spending";
    case "INPUT_VALIDATION":
      return "whyDidThisFail";
    case "RATE_LIMIT":
      return "retry";
    case "POLICY_VIOLATION":
      return "policy";
    default:
      return "retry";
  }
}
