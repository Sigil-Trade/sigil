/**
 * phalnx_query — Read-only queries for vault state, spending, prices, etc.
 */

import { z } from "zod";
import type { PhalnxClient } from "@phalnx/sdk";
import { getJupiterPrices, searchJupiterTokens } from "@phalnx/sdk";
import { formatError } from "../errors";
import {
  loadShieldConfig,
  type McpConfig,
  type CustodyWalletLike,
} from "../config";
import { toPublicKey, toBN } from "../utils";

export const phalnxQuerySchema = z.object({
  query: z
    .enum([
      "vault",
      "spending",
      "policy",
      "pendingPolicy",
      "escrow",
      "constraints",
      "prices",
      "searchTokens",
      "trendingTokens",
      "lendTokens",
      "triggerOrders",
      "recurringOrders",
      "portfolio",
      "positions",
      "protocols",
      "actions",
      "squadsStatus",
      "kaminoMarkets",
      "kaminoPositionHealth",
      "kaminoYields",
    ])
    .describe("The query type"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Query-specific parameters"),
});

export type PhalnxQueryInput = z.infer<typeof phalnxQuerySchema>;

export async function phalnxQuery(
  client: PhalnxClient,
  _config: McpConfig,
  input: PhalnxQueryInput,
  _custodyWallet?: CustodyWalletLike | null,
): Promise<string> {
  try {
    const params = input.params ?? {};
    const vault =
      (params.vault as string) ??
      loadShieldConfig()?.layers.vault.address ??
      undefined;

    switch (input.query) {
      case "vault": {
        if (!vault) return "No vault specified";
        const vaultAccount = await client.fetchVaultByAddress(
          toPublicKey(vault),
        );
        return JSON.stringify(
          {
            owner: vaultAccount.owner.toBase58(),
            agents: vaultAccount.agents.map((a) => ({
              pubkey: a.pubkey.toBase58(),
              permissions: a.permissions.toString(),
              paused: a.paused,
            })),
            status: vaultAccount.status,
            totalTransactions: vaultAccount.totalTransactions.toString(),
            totalVolume: vaultAccount.totalVolume.toString(),
            openPositions: vaultAccount.openPositions,
          },
          null,
          2,
        );
      }

      case "spending": {
        if (!vault) return "No vault specified";
        const tracker = await client.fetchTracker(toPublicKey(vault));
        const now = Math.floor(Date.now() / 1000);
        let spent24h = 0;
        for (const bucket of tracker.buckets) {
          const epochTime = bucket.epochId.toNumber() * 600;
          if (epochTime >= now - 86400) {
            spent24h += bucket.usdAmount.toNumber();
          }
        }
        return JSON.stringify(
          {
            spent24hUsd: (spent24h / 1_000_000).toFixed(2),
            totalBuckets: tracker.buckets.length,
          },
          null,
          2,
        );
      }

      case "policy": {
        if (!vault) return "No vault specified";
        const policy = await client.fetchPolicy(toPublicKey(vault));
        return JSON.stringify(
          {
            dailySpendingCapUsd: (
              policy.dailySpendingCapUsd.toNumber() / 1_000_000
            ).toFixed(2),
            protocolMode: policy.protocolMode,
            protocols: policy.protocols.map((p) => p.toBase58()),
            maxLeverageBps: policy.maxLeverageBps,
            maxSlippageBps: policy.maxSlippageBps,
            canOpenPositions: policy.canOpenPositions,
            maxConcurrentPositions: policy.maxConcurrentPositions,
            hasConstraints: policy.hasConstraints,
          },
          null,
          2,
        );
      }

      case "protocols": {
        const protocols = client.intents.listProtocols();
        return JSON.stringify(protocols, null, 2);
      }

      case "actions": {
        const protocolId = params.protocolId as string;
        if (!protocolId) return "protocolId parameter required";
        const actions = client.intents.listActions(protocolId);
        return JSON.stringify(actions, null, 2);
      }

      case "prices": {
        const mints = params.mints as string[];
        if (!mints || !Array.isArray(mints))
          return "mints parameter required (string array)";
        const response = await getJupiterPrices({ ids: mints });
        return JSON.stringify(response.data, null, 2);
      }

      case "searchTokens": {
        const query = params.query as string;
        if (!query) return "query parameter required";
        const tokens = await searchJupiterTokens({ query });
        return JSON.stringify(tokens.slice(0, 10), null, 2);
      }

      case "trendingTokens": {
        const interval = (params.interval as string) ?? "1h";
        const tokens = await client.getTrendingTokens(
          interval as "1h" | "6h" | "24h",
        );
        return JSON.stringify(tokens.slice(0, 10), null, 2);
      }

      case "lendTokens": {
        const tokens = await client.getJupiterLendTokens();
        return JSON.stringify(tokens.slice(0, 10), null, 2);
      }

      case "portfolio": {
        const walletAddr =
          (params.wallet as string) ??
          client.provider.wallet.publicKey.toBase58();
        const portfolio = await client.getJupiterPortfolio(walletAddr);
        return JSON.stringify(portfolio, null, 2);
      }

      case "triggerOrders": {
        const walletAddr =
          (params.wallet as string) ??
          client.provider.wallet.publicKey.toBase58();
        const orders = await client.getJupiterTriggerOrders(walletAddr);
        return JSON.stringify(orders, null, 2);
      }

      case "recurringOrders": {
        const walletAddr =
          (params.wallet as string) ??
          client.provider.wallet.publicKey.toBase58();
        const orders = await client.getJupiterRecurringOrders(walletAddr);
        return JSON.stringify(orders, null, 2);
      }

      case "pendingPolicy": {
        if (!vault) return "No vault specified";
        try {
          const pending = await client.fetchPendingPolicy(toPublicKey(vault));
          if (!pending) {
            return JSON.stringify({ exists: false }, null, 2);
          }
          return JSON.stringify(
            {
              exists: true,
              executesAt: pending.executesAt.toString(),
              dailySpendingCapUsd: pending.dailySpendingCapUsd
                ? (pending.dailySpendingCapUsd.toNumber() / 1_000_000).toFixed(
                    2,
                  )
                : null,
            },
            null,
            2,
          );
        } catch {
          return JSON.stringify({ exists: false }, null, 2);
        }
      }

      case "escrow": {
        const sourceVault = (params.sourceVault as string) ?? vault;
        const destinationVault = params.destinationVault as string;
        const escrowId = params.escrowId as string;
        if (!sourceVault || !destinationVault || !escrowId) {
          return "sourceVault, destinationVault, and escrowId parameters required";
        }
        const escrow = await client.fetchEscrow(
          toPublicKey(sourceVault),
          toPublicKey(destinationVault),
          toBN(escrowId),
        );
        return JSON.stringify(
          {
            status: escrow.status,
            amount: escrow.amount.toString(),
            expiresAt: escrow.expiresAt.toString(),
            tokenMint: escrow.tokenMint.toBase58(),
          },
          null,
          2,
        );
      }

      case "constraints": {
        if (!vault) return "No vault specified";
        try {
          const constraints = await client.fetchConstraints(toPublicKey(vault));
          if (!constraints) {
            return JSON.stringify({ exists: false }, null, 2);
          }
          return JSON.stringify(
            {
              exists: true,
              entries: constraints.entries.length,
              strictMode: constraints.strictMode,
            },
            null,
            2,
          );
        } catch {
          return JSON.stringify({ exists: false }, null, 2);
        }
      }

      case "positions": {
        return "Use query 'portfolio' to view positions";
      }

      case "kaminoMarkets": {
        const { getKaminoMarketsResource } = await import("../resources/kamino-markets");
        return getKaminoMarketsResource();
      }

      case "kaminoYields": {
        const { getKaminoYieldsResource } = await import("../resources/kamino-yields");
        return getKaminoYieldsResource();
      }

      case "kaminoPositionHealth": {
        const walletAddr =
          (params.wallet as string) ??
          client.provider.wallet.publicKey.toBase58();
        const { getKaminoPositionsResource } = await import("../resources/kamino-positions");
        return getKaminoPositionsResource(walletAddr);
      }

      case "squadsStatus": {
        const multisig = params.multisig as string;
        if (!multisig) return "multisig parameter required";
        const info = await client.squadsFetchMultisigInfo(
          toPublicKey(multisig),
        );
        return JSON.stringify(
          {
            threshold: info.threshold,
            memberCount: info.memberCount,
            transactionIndex: info.transactionIndex,
            vaultPda: info.vaultPda.toBase58(),
            members: info.members.map((m) => ({
              key: m.key.toBase58(),
              permissions: m.permissions,
            })),
          },
          null,
          2,
        );
      }

      default:
        return `Unknown query type: ${input.query}`;
    }
  } catch (error) {
    return formatError(error);
  }
}
