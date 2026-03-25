import {
  PhalnxClient,
  custodyAdapterToTransactionSigner,
  type CustodyAdapter,
} from "@phalnx/kit";
import type { TransactionSigner } from "@solana/kit";
import type { PhalnxSakConfig } from "./types.js";
import { swapAction } from "./actions/swap.js";
import { transferAction } from "./actions/transfer.js";
import { statusAction } from "./actions/status.js";

function isCustodyAdapter(
  agent: TransactionSigner | CustodyAdapter,
): agent is CustodyAdapter {
  return (
    typeof (agent as CustodyAdapter).getPublicKey === "function" &&
    typeof (agent as CustodyAdapter).sign === "function" &&
    !("address" in agent)
  );
}

export function createPhalnxPlugin(config: PhalnxSakConfig) {
  const signer = isCustodyAdapter(config.agent)
    ? custodyAdapterToTransactionSigner(config.agent)
    : config.agent;

  const client = new PhalnxClient({
    rpc: config.rpc,
    vault: config.vault,
    agent: signer,
    network: config.network,
  });

  const jupiterApi = config.jupiterApiUrl ?? "https://quote-api.jup.ag/v6";

  return {
    name: "phalnx",
    methods: {
      phalnx_swap: swapAction(client, jupiterApi),
      phalnx_transfer: transferAction(client),
      phalnx_status: statusAction(client),
    },
  };
}

export type { PhalnxSakConfig } from "./types.js";
