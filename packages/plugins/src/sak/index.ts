import {
  createSigilClient,
  custodyAdapterToTransactionSigner,
  type CustodyAdapter,
} from "@usesigil/kit";
import type { TransactionSigner } from "@solana/kit";
import type { SigilSakConfig } from "./types.js";
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

export function createSigilPlugin(config: SigilSakConfig) {
  const signer = isCustodyAdapter(config.agent)
    ? custodyAdapterToTransactionSigner(config.agent)
    : config.agent;

  // Sprint 2 (v0.11.0) privatized the sync `new SigilClient(...)` constructor.
  // `createSigilClient()` is the lightweight factory that skips the async
  // genesis-hash assertion — suitable here because `createSigilPlugin()` is
  // a sync factory and SAK callers typically run their own network checks.
  // Callers who want the genesis assertion can use `SigilClient.create()`
  // directly and wire it into a different plugin shape.
  const client = createSigilClient({
    rpc: config.rpc,
    vault: config.vault,
    agent: signer,
    network: config.network,
  });

  const jupiterApi = config.jupiterApiUrl ?? "https://quote-api.jup.ag/v6";

  return {
    name: "sigil",
    methods: {
      sigil_swap: swapAction(client, jupiterApi),
      sigil_transfer: transferAction(client),
      sigil_status: statusAction(client),
    },
  };
}

export type { SigilSakConfig } from "./types.js";
