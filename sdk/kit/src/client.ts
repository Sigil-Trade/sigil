/**
 * PhalnxKitClient — Kit-native Client Facade
 *
 * Thin delegation layer:
 * - Agent-facing methods → IntentEngine
 * - Vault management → Codama-generated instruction builders
 * - Account fetching → Codama-generated decoders
 *
 * Unlike the 3,200-line monolith in the old SDK, this client delegates
 * all heavy lifting to IntentEngine and uses Codama builders directly.
 */

import type {
  Address,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import type { IntentAction, PrecheckResult, ExecuteResult } from "./intents.js";
import type { AgentError } from "./agent-errors.js";
import type { AgentVault } from "./generated/accounts/agentVault.js";
import type { PolicyConfig } from "./generated/accounts/policyConfig.js";
import type { SpendTracker } from "./generated/accounts/spendTracker.js";
import type { ResolvedToken } from "./tokens.js";
import type { Account } from "@solana/kit";

import { IntentEngine, type IntentEngineConfig, type ExplainResult, type ProtocolInfo } from "./intent-engine.js";
import { ProtocolRegistry, globalProtocolRegistry } from "./integrations/protocol-registry.js";
import { JupiterHandler } from "./integrations/jupiter-handler.js";
import { DriftHandler, FlashTradeHandler, KaminoHandler, SquadsHandler } from "./integrations/t2-handlers.js";
import { resolveToken } from "./tokens.js";
import { fetchAgentVault, fetchMaybeAgentVault } from "./generated/accounts/agentVault.js";
import { fetchPolicyConfig, fetchMaybePolicyConfig } from "./generated/accounts/policyConfig.js";
import { fetchSpendTracker, fetchMaybeSpendTracker } from "./generated/accounts/spendTracker.js";
import { getPolicyPDA, getTrackerPDA, getVaultPDA } from "./resolve-accounts.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type Network = "devnet" | "mainnet-beta";

export interface PhalnxKitClientConfig {
  rpc: Rpc<SolanaRpcApi>;
  network: Network;
  /** The agent signer */
  agent: TransactionSigner;
  /** Custom protocol registry. If omitted, uses a default registry with all built-in handlers. */
  protocolRegistry?: ProtocolRegistry;
}

// ─── Default Registry ───────────────────────────────────────────────────────

function createDefaultRegistry(): ProtocolRegistry {
  const reg = new ProtocolRegistry();
  reg.register(new JupiterHandler());
  reg.register(new DriftHandler());
  reg.register(new FlashTradeHandler());
  reg.register(new KaminoHandler());
  reg.register(new SquadsHandler());
  return reg;
}

// ─── PhalnxKitClient ────────────────────────────────────────────────────────

export class PhalnxKitClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly network: Network;
  readonly agent: TransactionSigner;
  readonly engine: IntentEngine;

  constructor(config: PhalnxKitClientConfig) {
    this.rpc = config.rpc;
    this.network = config.network;
    this.agent = config.agent;

    const registry = config.protocolRegistry ?? createDefaultRegistry();

    this.engine = new IntentEngine({
      rpc: config.rpc,
      network: config.network,
      protocolRegistry: registry,
      agent: config.agent,
    });
  }

  // ─── Agent-Facing (delegate to IntentEngine) ──────────────────────────

  /** Full workflow: validate → precheck → execute */
  async run(
    intent: IntentAction,
    vault: Address,
    options?: { skipPrecheck?: boolean },
  ): Promise<ExecuteResult | AgentError> {
    return this.engine.run(intent, vault, options);
  }

  /** Execute an intent against a vault */
  async execute(
    intent: IntentAction,
    vault: Address,
  ): Promise<ExecuteResult> {
    return this.engine.execute(intent, vault);
  }

  /** Precheck: verify permissions, caps, allowlist, slippage */
  async precheck(
    intent: IntentAction,
    vault: Address,
  ): Promise<PrecheckResult> {
    return this.engine.precheck(intent, vault);
  }

  /** Explain what a transaction would do without executing */
  async explain(
    intent: IntentAction,
    vault: Address,
  ): Promise<ExplainResult | AgentError> {
    return this.engine.explain(intent, vault);
  }

  // ─── Account Fetching ──────────────────────────────────────────────────

  /** Fetch vault account data */
  async fetchVault(vault: Address): Promise<Account<AgentVault>> {
    return fetchAgentVault(this.rpc, vault);
  }

  /** Fetch vault, returns null if not found */
  async fetchMaybeVault(vault: Address) {
    return fetchMaybeAgentVault(this.rpc, vault);
  }

  /** Fetch policy config for a vault */
  async fetchPolicy(vault: Address): Promise<Account<PolicyConfig>> {
    const [policyPda] = await getPolicyPDA(vault);
    return fetchPolicyConfig(this.rpc, policyPda);
  }

  /** Fetch spend tracker for a vault */
  async fetchTracker(vault: Address): Promise<Account<SpendTracker>> {
    const [trackerPda] = await getTrackerPDA(vault);
    return fetchSpendTracker(this.rpc, trackerPda);
  }

  /** Derive vault PDA from owner + vaultId */
  async getVaultAddress(
    owner: Address,
    vaultId: bigint,
  ): Promise<Address> {
    const [pda] = await getVaultPDA(owner, vaultId);
    return pda;
  }

  // ─── Token Resolution ──────────────────────────────────────────────────

  /** Resolve a token symbol or mint address to {mint, decimals, symbol} */
  resolveToken(tokenOrMint: string): ResolvedToken | null {
    return resolveToken(tokenOrMint, this.network);
  }

  // ─── Discovery ─────────────────────────────────────────────────────────

  /** List all registered protocols */
  listProtocols(): ProtocolInfo[] {
    return this.engine.listProtocols();
  }

  /** List supported actions for a protocol */
  listActions(protocolId: string) {
    return this.engine.listActions(protocolId);
  }
}
