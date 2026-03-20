/**
 * IntentEngine — Kit-native 12-step Execute Pipeline
 *
 * Connects all Phase 1 + Phase 2 pieces into a single E2E flow:
 * validate → resolve protocol → resolve token → precheck →
 * compose → verify → resolve PDAs → build sandwich →
 * simulate → sign → send → parse events.
 *
 * For the Kit SDK, IntentEngine is self-contained rather than
 * delegating to a PhalnxClient monolith.
 */

import type {
  Address,
  Instruction,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";
import type {
  IntentAction,
  IntentActionType,
  PrecheckResult,
  ExecuteResult,
} from "./intents.js";
import type { AgentError } from "./agent-errors.js";
import type {
  ProtocolHandlerMetadata,
  ProtocolActionDescriptor,
} from "./integrations/protocol-handler.js";
import type { ProtocolRegistry } from "./integrations/protocol-registry.js";
import type { ResolvedToken } from "./tokens.js";

import {
  validateIntentInput,
  type ValidationResult,
} from "./intent-validator.js";
import type { TransactionExecutor } from "./transaction-executor.js";
import { toAgentError, protocolEscalationError } from "./agent-errors.js";
import { getPhalnxAltAddress } from "./alt-config.js";
import { mergeAltAddresses } from "./alt-loader.js";
import {
  resolveProtocol,
  isProtocolAllowed,
  ProtocolTier,
} from "./protocol-resolver.js";
import {
  ACTION_TYPE_MAP,
  summarizeAction,
  resolveProtocolActionType,
} from "./intents.js";
import { resolveToken } from "./tokens.js";
import {
  hasPermission,
  isSpendingAction,
  getPositionEffect,
  isStablecoinMint,
  type Network,
} from "./types.js";
import {
  resolveVaultState,
  type ResolvedVaultState,
} from "./state-resolver.js";
import { VaultStatus } from "./generated/types/vaultStatus.js";
import { resolveAccounts } from "./resolve-accounts.js";
import {
  verifyAdapterOutput,
  type VerifiableInstruction,
} from "./integrations/adapter-verifier.js";
import { fetchAgentVault } from "./generated/accounts/agentVault.js";
import { fetchPolicyConfig } from "./generated/accounts/policyConfig.js";
import {
  getPolicyPDA,
  getTrackerPDA,
  getAgentOverlayPDA,
} from "./resolve-accounts.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Escrow actions use standalone instructions, not the composition flow */
const ESCROW_ACTIONS = new Set([
  "createEscrow",
  "settleEscrow",
  "refundEscrow",
]);

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of IntentEngine.explain() — transaction plan without execution */
export interface ExplainResult {
  /** Human-readable summary of what the transaction will do */
  summary: string;
  /** The intent action type */
  actionType: IntentActionType;
  /** Whether this action counts against spending cap */
  isSpending: boolean;
  /** Precheck result (spending capacity, permissions, etc.) */
  precheck: PrecheckResult;
}

/** Protocol info for discovery */
export interface ProtocolInfo {
  protocolId: string;
  displayName: string;
  programIds: string[];
  actionCount: number;
}

/** Action info for protocol exploration */
export interface ActionInfo {
  name: string;
  isSpending: boolean;
}

/** Configuration for IntentEngine */
export interface IntentEngineConfig {
  rpc: Rpc<SolanaRpcApi>;
  network: Network;
  protocolRegistry: ProtocolRegistry;
  /** The agent signer that will sign transactions */
  agent: TransactionSigner;
  /** Optional TransactionExecutor for steps 9-12. When absent, execute() throws. */
  executor?: TransactionExecutor;
  /** @internal Override state resolver for testing */
  _stateResolver?: typeof resolveVaultState;
}

// ─── IntentEngine ───────────────────────────────────────────────────────────

export class IntentEngine {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly network: Network;
  readonly registry: ProtocolRegistry;
  readonly agent: TransactionSigner;
  readonly executor: TransactionExecutor | null;
  private readonly _stateResolver: typeof resolveVaultState;

  constructor(config: IntentEngineConfig) {
    this.rpc = config.rpc;
    this.network = config.network;
    this.registry = config.protocolRegistry;
    this.agent = config.agent;
    this.executor = config.executor ?? null;
    this._stateResolver = config._stateResolver ?? resolveVaultState;

    // H-5: Warn if protocol registry is not frozen
    if (!config.protocolRegistry.isFrozen) {
      console.warn(
        "[IntentEngine] Protocol registry is not frozen. " +
          "Call registry.freeze() after registering all handlers to prevent runtime mutation.",
      );
    }
  }

  // ─── Core Agent Workflow ─────────────────────────────────────────────

  /**
   * Full agent workflow: validate → precheck → execute.
   *
   * Returns ExecuteResult on success or AgentError on failure at any stage.
   * This is the primary method agents should call.
   */
  async run(
    intent: IntentAction,
    vault: Address,
    options?: { skipPrecheck?: boolean },
  ): Promise<ExecuteResult | AgentError> {
    // 1. Validate inputs (offline)
    const validation = this.validate(intent);
    if (!validation.valid) {
      return validation.errors[0];
    }

    // 2. Protocol resolution for protocol/passthrough intents
    if (intent.type === "protocol" || intent.type === "passthrough") {
      try {
        const resolution = await this._resolveProtocolTier(intent, vault);
        if (
          resolution &&
          resolution.tier === ProtocolTier.NOT_SUPPORTED &&
          resolution.escalation
        ) {
          return protocolEscalationError(resolution.escalation);
        }
      } catch (err) {
        return toAgentError(err, { phase: "protocol_resolution" });
      }
    }

    // 3. Precheck (unless skipped)
    let precheck: PrecheckResult | undefined;
    if (!options?.skipPrecheck) {
      try {
        precheck = await this.precheck(intent, vault);
        if (!precheck.allowed) {
          return toAgentError(
            new Error(
              `Precheck failed: ${precheck.reason ?? precheck.summary}`,
            ),
            {
              precheck_details: JSON.stringify(precheck.details),
              risk_flags: precheck.riskFlags.join(","),
            },
          );
        }
      } catch (err) {
        return toAgentError(err, { phase: "precheck" });
      }
    }

    // 4. Execute (compose → verify → build sandwich → simulate → sign → send)
    try {
      return await this.execute(intent, vault, precheck);
    } catch (err) {
      return toAgentError(err, { phase: "execute", intent_type: intent.type });
    }
  }

  // ─── Individual Steps ────────────────────────────────────────────────

  /**
   * Step 1: Validate intent parameters without hitting RPC.
   * Catches hallucinated inputs (negative amounts, invalid addresses, etc.).
   */
  validate(intent: IntentAction): ValidationResult {
    return validateIntentInput(intent);
  }

  /**
   * Steps 2-4: Precheck — verify permissions, caps, allowlist, slippage.
   * Hits RPC to fetch vault + policy state.
   */
  async precheck(
    intent: IntentAction,
    vault: Address,
  ): Promise<PrecheckResult> {
    try {
      // Single batched RPC call fetches vault + policy + tracker + overlay + constraints.
      const state = await this._stateResolver(
        this.rpc,
        vault,
        this.agent.address,
      );
      const vaultData = state.vault;
      const policyData = state.policy;
      const riskFlags: string[] = [];

      // Find the agent entry in vault
      const agentAddress = this.agent.address;
      const agentEntry = vaultData.agents.find(
        (a) => a.pubkey === agentAddress,
      );

      // Resolve base action type string
      const baseActionType = this._getBaseActionType(intent);

      // Permission check
      const permissionPassed = agentEntry
        ? hasPermission(agentEntry.permissions, baseActionType)
        : false;

      if (!agentEntry) {
        return this._failedPrecheck(
          "Agent not registered in vault",
          `Agent ${agentAddress} is not registered in vault ${vault}`,
          {
            permission: {
              passed: false,
              requiredBit: baseActionType,
              agentHas: false,
            },
            protocol: { passed: true, inAllowlist: true },
          },
        );
      }

      if (agentEntry.paused) {
        return this._failedPrecheck(
          "Agent is paused",
          `Agent ${agentAddress} is paused in vault ${vault}`,
          {
            permission: {
              passed: false,
              requiredBit: baseActionType,
              agentHas: false,
            },
            protocol: { passed: true, inAllowlist: true },
          },
        );
      }

      // Check vault is active
      if (vaultData.status !== VaultStatus.Active) {
        return this._failedPrecheck(
          `Vault is ${VaultStatus[vaultData.status] ?? "unknown"}`,
          `Vault ${vault} is not active`,
          {
            permission: {
              passed: false,
              requiredBit: baseActionType,
              agentHas: false,
            },
            protocol: { passed: true, inAllowlist: true },
          },
        );
      }

      if (!permissionPassed) {
        return this._failedPrecheck(
          `Missing permission for ${baseActionType}`,
          `Agent lacks permission bit for ${baseActionType}`,
          {
            permission: {
              passed: false,
              requiredBit: baseActionType,
              agentHas: false,
            },
            protocol: { passed: true, inAllowlist: true },
          },
        );
      }

      // Escrow actions use standalone instructions, not the composition flow (on-chain line 178)
      if (ESCROW_ACTIONS.has(baseActionType)) {
        return this._failedPrecheck(
          "Escrow actions use standalone instructions, not the composition flow",
          "InvalidSession",
          {
            permission: {
              passed: true,
              requiredBit: baseActionType,
              agentHas: true,
            },
            protocol: { passed: true, inAllowlist: true },
          },
          6011,
        );
      }

      // Protocol allowlist check
      let protocolPassed = true;
      let protocolInAllowlist = true;
      if (intent.type === "protocol") {
        const protocolId = (intent.params as Record<string, unknown>)
          .protocolId as string | undefined;
        if (protocolId) {
          const handler = this.registry.getByProtocolId(protocolId);
          if (handler?.metadata.programIds[0]) {
            protocolInAllowlist = isProtocolAllowed(
              handler.metadata.programIds[0] as Address,
              {
                protocolMode: policyData.protocolMode,
                protocols: policyData.protocols,
              },
            );
            protocolPassed = protocolInAllowlist;
          }
        }
      }

      if (!protocolPassed) {
        return this._failedPrecheck(
          "Protocol not in allowlist",
          "Protocol not allowed by vault policy",
          {
            permission: {
              passed: true,
              requiredBit: baseActionType,
              agentHas: true,
            },
            protocol: { passed: false, inAllowlist: false },
          },
        );
      }

      // Slippage check (swaps only)
      let slippageDetails: PrecheckResult["details"]["slippage"];
      if (intent.type === "swap" && intent.params.slippageBps !== undefined) {
        const slippagePassed =
          intent.params.slippageBps <= policyData.maxSlippageBps;
        slippageDetails = {
          passed: slippagePassed,
          intentBps: intent.params.slippageBps,
          vaultMaxBps: policyData.maxSlippageBps,
        };
        if (!slippagePassed) {
          return this._failedPrecheck(
            `Slippage ${intent.params.slippageBps} BPS > max ${policyData.maxSlippageBps} BPS`,
            "Intent slippage exceeds vault max",
            {
              permission: {
                passed: true,
                requiredBit: baseActionType,
                agentHas: true,
              },
              protocol: { passed: true, inAllowlist: true },
              slippage: slippageDetails,
            },
          );
        }
      }

      // Spending check — 4 ordered checks matching on-chain validate_and_authorize
      let spendingDetails: PrecheckResult["details"]["spendingCap"];
      if (isSpendingAction(baseActionType)) {
        const token = this._resolveIntentToken(intent);
        const amountStr = token ? this._getIntentAmount(intent) : null;

        // Unresolvable token or amount — can't verify spending, flag as risk
        if (!token || !amountStr) {
          spendingDetails = {
            passed: true,
            spent24h: 0n,
            cap: state.globalBudget.cap,
            remaining: state.globalBudget.remaining,
            deferred: true,
          };
          riskFlags.push("SPENDING_UNVERIFIED");
        } else {
          const amountUsd = this._estimateUsd(amountStr, token);

          if (amountUsd === 0n) {
            // Non-stablecoin input: cap check deferred to finalize_session
            spendingDetails = {
              passed: true,
              spent24h: state.globalBudget.spent24h,
              cap: state.globalBudget.cap,
              remaining: state.globalBudget.remaining,
              deferred: true,
            };
          } else {
            // Stablecoin input: 4 ordered checks matching on-chain

            // Check 1: Transaction size (on-chain line 206, error 6005)
            if (amountUsd > state.maxTransactionUsd) {
              return this._failedPrecheck(
                `Transaction $${amountUsd} exceeds max $${state.maxTransactionUsd}`,
                "TRANSACTION_TOO_LARGE",
                {
                  permission: {
                    passed: true,
                    requiredBit: baseActionType,
                    agentHas: true,
                  },
                  protocol: { passed: true, inAllowlist: protocolInAllowlist },
                  transactionSize: {
                    passed: false,
                    maxUsd: state.maxTransactionUsd,
                    intentUsd: amountUsd,
                  },
                },
                6005,
              );
            }

            // Check 2: Rolling 24h vault cap (on-chain line 218, error 6006)
            const newGlobalTotal = state.globalBudget.spent24h + amountUsd;
            if (newGlobalTotal > state.globalBudget.cap) {
              return this._failedPrecheck(
                `Daily cap exceeded: ${newGlobalTotal} > ${state.globalBudget.cap}`,
                "DAILY_CAP_EXCEEDED",
                {
                  permission: {
                    passed: true,
                    requiredBit: baseActionType,
                    agentHas: true,
                  },
                  spendingCap: {
                    passed: false,
                    spent24h: state.globalBudget.spent24h,
                    cap: state.globalBudget.cap,
                    remaining: state.globalBudget.remaining,
                    intentAmount: amountUsd,
                  },
                  protocol: { passed: true, inAllowlist: protocolInAllowlist },
                },
                6006,
              );
            }

            // Check 3: Per-agent cap (on-chain line 235, error 6056)
            if (state.agentBudget) {
              const newAgentTotal = state.agentBudget.spent24h + amountUsd;
              if (newAgentTotal > state.agentBudget.cap) {
                return this._failedPrecheck(
                  `Agent spend limit exceeded: ${newAgentTotal} > ${state.agentBudget.cap}`,
                  "AGENT_SPEND_LIMIT_EXCEEDED",
                  {
                    permission: {
                      passed: true,
                      requiredBit: baseActionType,
                      agentHas: true,
                    },
                    spendingCap: {
                      passed: false,
                      spent24h: state.agentBudget.spent24h,
                      cap: state.agentBudget.cap,
                      remaining: state.agentBudget.remaining,
                      intentAmount: amountUsd,
                    },
                    protocol: {
                      passed: true,
                      inAllowlist: protocolInAllowlist,
                    },
                  },
                  6056,
                );
              }
            }

            // Check 4: Per-protocol cap (on-chain line 261, error 6062)
            const protocolAddr = this._resolveProtocolAddress(intent);
            if (protocolAddr) {
              const protocolBudget = state.protocolBudgets.find(
                (p) => p.protocol === protocolAddr,
              );
              if (protocolBudget) {
                const newProtoTotal = protocolBudget.spent24h + amountUsd;
                if (newProtoTotal > protocolBudget.cap) {
                  return this._failedPrecheck(
                    `Protocol cap exceeded: ${newProtoTotal} > ${protocolBudget.cap}`,
                    "PROTOCOL_CAP_EXCEEDED",
                    {
                      permission: {
                        passed: true,
                        requiredBit: baseActionType,
                        agentHas: true,
                      },
                      spendingCap: {
                        passed: false,
                        spent24h: protocolBudget.spent24h,
                        cap: protocolBudget.cap,
                        remaining: protocolBudget.remaining,
                        intentAmount: amountUsd,
                      },
                      protocol: {
                        passed: true,
                        inAllowlist: protocolInAllowlist,
                      },
                    },
                    6062,
                  );
                }
              }
            } else if (intent.type === "passthrough") {
              riskFlags.push("PASSTHROUGH_PROTOCOL_UNVERIFIED");
            }

            // All spending checks passed
            spendingDetails = {
              passed: true,
              spent24h: state.globalBudget.spent24h,
              cap: state.globalBudget.cap,
              remaining: state.globalBudget.remaining,
              intentAmount: amountUsd,
            };
          }
        }
      }

      // Leverage check (on-chain line 515, error 6007)
      const intentLeverageBps = this._getLeverageBps(intent);
      if (intentLeverageBps !== null && policyData.maxLeverageBps > 0) {
        if (intentLeverageBps > policyData.maxLeverageBps) {
          return this._failedPrecheck(
            `Leverage ${intentLeverageBps} BPS > max ${policyData.maxLeverageBps} BPS`,
            "LEVERAGE_TOO_HIGH",
            {
              permission: {
                passed: true,
                requiredBit: baseActionType,
                agentHas: true,
              },
              protocol: { passed: true, inAllowlist: protocolInAllowlist },
              leverage: {
                passed: false,
                maxBps: policyData.maxLeverageBps,
                intentBps: intentLeverageBps,
              },
            },
            6007,
          );
        }
      }

      // Position check
      const posEffect = getPositionEffect(baseActionType);

      if (posEffect === "increment") {
        if (!policyData.canOpenPositions) {
          return this._failedPrecheck(
            "Vault does not allow opening positions",
            "POSITION_OPENING_DISALLOWED",
            {
              permission: {
                passed: true,
                requiredBit: baseActionType,
                agentHas: true,
              },
              protocol: { passed: true, inAllowlist: protocolInAllowlist },
              positions: {
                passed: false,
                max: policyData.maxConcurrentPositions,
                current: vaultData.openPositions,
                canOpen: false,
              },
            },
            6009,
          );
        }
        if (vaultData.openPositions >= policyData.maxConcurrentPositions) {
          return this._failedPrecheck(
            `Positions at max: ${vaultData.openPositions} >= ${policyData.maxConcurrentPositions}`,
            "TOO_MANY_POSITIONS",
            {
              permission: {
                passed: true,
                requiredBit: baseActionType,
                agentHas: true,
              },
              protocol: { passed: true, inAllowlist: protocolInAllowlist },
              positions: {
                passed: false,
                max: policyData.maxConcurrentPositions,
                current: vaultData.openPositions,
                canOpen: true,
              },
            },
            6008,
          );
        }
      } else if (posEffect === "decrement") {
        if (vaultData.openPositions === 0) {
          return this._failedPrecheck(
            "No positions to close",
            "NO_POSITIONS_TO_CLOSE",
            {
              permission: {
                passed: true,
                requiredBit: baseActionType,
                agentHas: true,
              },
              protocol: { passed: true, inAllowlist: protocolInAllowlist },
              positions: {
                passed: false,
                max: policyData.maxConcurrentPositions,
                current: 0,
                canOpen: policyData.canOpenPositions,
              },
            },
            6033,
          );
        }
      }

      return {
        allowed: true,
        summary: `Precheck passed for ${intent.type}`,
        details: {
          permission: {
            passed: true,
            requiredBit: baseActionType,
            agentHas: true,
          },
          spendingCap: spendingDetails,
          protocol: { passed: true, inAllowlist: protocolInAllowlist },
          slippage: slippageDetails,
        },
        budget: {
          global: {
            spent24h: state.globalBudget.spent24h,
            cap: state.globalBudget.cap,
            remaining: state.globalBudget.remaining,
          },
          agent: state.agentBudget
            ? {
                spent24h: state.agentBudget.spent24h,
                cap: state.agentBudget.cap,
                remaining: state.agentBudget.remaining,
              }
            : null,
          protocols: state.protocolBudgets.map((p) => ({
            protocol: p.protocol as string,
            spent24h: p.spent24h,
            cap: p.cap,
            remaining: p.remaining,
          })),
          maxTransactionUsd: state.maxTransactionUsd,
          resolvedAt: state.resolvedAtTimestamp,
        },
        riskFlags,
      };
    } catch (err) {
      return this._failedPrecheck(
        "Precheck failed",
        err instanceof Error ? err.message : String(err),
        {
          permission: {
            passed: false,
            requiredBit: intent.type,
            agentHas: false,
          },
          protocol: { passed: false, inAllowlist: false },
        },
      );
    }
  }

  /**
   * Steps 5-12: Execute the intent — compose, verify, build, simulate, sign, send.
   *
   * Steps 9-12 (compose transaction, simulate, sign, send) are stubbed — they
   * require RPC blockhash + wallet signing infrastructure. The structure is
   * laid out for each pipeline step.
   */
  async execute(
    intent: IntentAction,
    vault: Address,
    _cachedPrecheck?: PrecheckResult,
  ): Promise<ExecuteResult> {
    // Step 1: Validate
    const validation = this.validate(intent);
    if (!validation.valid) {
      throw validation.errors[0];
    }

    // Step 2: Resolve protocol
    const baseActionType = this._getBaseActionType(intent);
    const handler = this._resolveHandler(intent);

    // Step 3: Resolve token
    const token = this._resolveIntentToken(intent);

    // Step 4: Precheck (reuse cached result from run() if available)
    const precheck = _cachedPrecheck ?? (await this.precheck(intent, vault));
    if (!precheck.allowed) {
      throw new Error(
        `Precheck failed: ${precheck.reason ?? precheck.summary}`,
      );
    }

    // Step 5: handler.compose()
    if (!handler) {
      throw new Error(
        `No protocol handler found for intent type: ${intent.type}`,
      );
    }

    const [policyPda] = await getPolicyPDA(vault);
    const policyAccount = await fetchPolicyConfig(this.rpc, policyPda);
    const vaultAccount = await fetchAgentVault(this.rpc, vault);

    const composeCtx = {
      rpc: this.rpc,
      network: this.network,
      vault,
      owner: vaultAccount.data.owner,
      vaultId: vaultAccount.data.vaultId,
      agent: this.agent.address,
    };

    let composeResult;
    try {
      const composeAction = this._getComposeAction(intent);
      composeResult = await handler.compose(
        composeCtx,
        composeAction,
        intent.params as Record<string, unknown>,
      );
    } catch (err) {
      throw toAgentError(err, {
        phase: "compose",
        protocol: handler.metadata.protocolId,
      });
    }

    // Step 6: Verify adapter output
    const verification = verifyAdapterOutput(
      composeResult.instructions as VerifiableInstruction[],
      handler.metadata.programIds.map((p) => p as Address),
      vault,
    );
    if (!verification.valid) {
      throw new Error(
        `Adapter verification failed: ${verification.violations.join("; ")}`,
      );
    }

    // Step 7: Resolve all PDAs
    const tokenMint =
      token?.mint ?? ("11111111111111111111111111111111" as Address);
    let accounts;
    try {
      accounts = await resolveAccounts({
        vault,
        agent: this.agent.address,
        tokenMint,
        hasConstraints: policyAccount.data.hasConstraints,
      });
    } catch (err) {
      throw toAgentError(err, { phase: "resolve_accounts" });
    }

    // Step 8: Build sandwich instructions (validate + DeFi + finalize)
    const { getValidateAndAuthorizeInstructionAsync } =
      await import("./generated/instructions/validateAndAuthorize.js");
    const { getFinalizeSessionInstructionAsync } =
      await import("./generated/instructions/finalizeSession.js");

    const agentOverlayPda =
      accounts.agentOverlayPda ?? (await getAgentOverlayPDA(vault))[0];
    const [trackerPda] = await getTrackerPDA(vault);

    const mapping =
      ACTION_TYPE_MAP[baseActionType as keyof typeof ACTION_TYPE_MAP];
    if (!mapping) {
      throw new Error(`Unknown action type: ${baseActionType}`);
    }

    const targetProtocol = handler.metadata.programIds[0] as Address;

    const _validateIx = await getValidateAndAuthorizeInstructionAsync({
      agent: this.agent,
      vault,
      policy: accounts.policyPda,
      tracker: trackerPda,
      agentSpendOverlay: agentOverlayPda,
      session: accounts.sessionPda,
      vaultTokenAccount: tokenMint, // placeholder — real ATA derived at runtime
      tokenMintAccount: tokenMint,
      actionType: mapping.actionType,
      tokenMint: tokenMint,
      amount: BigInt(this._getIntentAmount(intent) ?? "0"),
      targetProtocol,
      leverageBps: this._getLeverageBps(intent),
    });

    const _finalizeIx = await getFinalizeSessionInstructionAsync({
      payer: this.agent,
      vault,
      session: accounts.sessionPda,
      sessionRentRecipient: this.agent.address,
      policy: accounts.policyPda,
      tracker: trackerPda,
      agentSpendOverlay: agentOverlayPda,
      success: true,
    });

    // Steps 9-12: Compose transaction, simulate, sign + send, parse events
    if (!this.executor) {
      throw new Error(
        "IntentEngine.execute() steps 9-12 require a TransactionExecutor. " +
          "Pass executor in IntentEngineConfig, or use composePhalnxTransaction() directly.",
      );
    }

    // Collect ALTs: Phalnx ALT + protocol-returned ALTs (e.g. Jupiter route ALTs)
    const mergedAltAddresses = mergeAltAddresses(
      getPhalnxAltAddress(this.network),
      composeResult.addressLookupTables,
    );

    // Resolve via cached RPC fetch (graceful degradation on failure)
    const resolvedAlts = await this.executor.resolveAlts(
      this.rpc,
      mergedAltAddresses,
    );

    const txResult = await this.executor.executeTransaction({
      feePayer: this.agent.address,
      validateIx: _validateIx,
      defiInstructions: composeResult.instructions,
      finalizeIx: _finalizeIx,
      skipSimulation: false,
      addressLookupTables: resolvedAlts,
    });

    return {
      signature: txResult.signature,
      intent,
      precheck,
      summary: summarizeAction(intent),
    };
  }

  // ─── Transaction Plan Inspection ─────────────────────────────────────

  /**
   * Explain what a transaction would do without executing it.
   * Like SQL EXPLAIN — shows the plan, not the result.
   */
  async explain(
    intent: IntentAction,
    vault: Address,
  ): Promise<ExplainResult | AgentError> {
    const validation = this.validate(intent);
    if (!validation.valid) {
      return validation.errors[0];
    }

    try {
      const precheckResult = await this.precheck(intent, vault);
      const mapping = ACTION_TYPE_MAP[intent.type];

      return {
        summary: summarizeAction(intent),
        actionType: intent.type,
        isSpending: mapping?.isSpending ?? false,
        precheck: precheckResult,
      };
    } catch (err) {
      return toAgentError(err, { phase: "explain" });
    }
  }

  // ─── Discovery ──────────────────────────────────────────────────────

  /** List all registered protocols and their capabilities. */
  listProtocols(): ProtocolInfo[] {
    return this.registry.listAll().map((meta: ProtocolHandlerMetadata) => ({
      protocolId: meta.protocolId,
      displayName: meta.displayName,
      programIds: meta.programIds.map((p) => String(p)),
      actionCount: meta.supportedActions.size,
    }));
  }

  /** List supported actions for a specific protocol. */
  listActions(protocolId: string): ActionInfo[] {
    const handler = this.registry.getByProtocolId(protocolId);
    if (!handler) return [];

    const actions: ActionInfo[] = [];
    handler.metadata.supportedActions.forEach(
      (descriptor: ProtocolActionDescriptor, name: string) => {
        actions.push({ name, isSpending: descriptor.isSpending });
      },
    );
    return actions;
  }

  // ─── Internal Helpers ────────────────────────────────────────────────

  private _failedPrecheck(
    summary: string,
    reason: string,
    details: PrecheckResult["details"],
    errorCode?: number,
    riskFlags: string[] = [],
  ): PrecheckResult {
    return { allowed: false, summary, reason, details, errorCode, riskFlags };
  }

  /**
   * Get the base action type string from an intent.
   * For protocol intents, uses resolveProtocolActionType with the registry.
   * For ALL other intent types, resolves through the handler's action type
   * metadata to ensure protocol-specific mappings are always applied (M-2).
   */
  private _getBaseActionType(intent: IntentAction): string {
    // For "protocol" intents, use explicit protocolId + action
    if (intent.type === "protocol") {
      const params = intent.params as Record<string, unknown>;
      const protocolId = params.protocolId as string | undefined;
      const action = params.action as string | undefined;
      if (protocolId && action) {
        const resolved = resolveProtocolActionType(
          this.registry,
          protocolId,
          action,
        );
        // Return the ActionType key name for permission checking
        // e.g. ActionType.Swap -> "swap"
        const typeStr = Object.entries(ACTION_TYPE_MAP).find(
          ([, v]) => v.actionType === resolved.actionType,
        );
        return typeStr?.[0] ?? intent.type;
      }
    }

    // M-2: For ALL other intent types, resolve through the handler's action type.
    // This ensures protocol-specific action type mappings are always applied
    // instead of relying on the raw intent type string.
    const handler = this._resolveHandler(intent);
    if (handler) {
      const composeAction = this._getComposeAction(intent);
      const descriptor = handler.metadata.supportedActions.get(composeAction);
      if (descriptor) {
        const typeStr = Object.entries(ACTION_TYPE_MAP).find(
          ([, v]) => v.actionType === descriptor.actionType,
        );
        if (typeStr) return typeStr[0];
      }
    }

    return intent.type;
  }

  /**
   * Get the compose-layer action string from an intent.
   * Strips protocol prefixes so the compose dispatcher gets the base verb.
   * e.g. "kaminoDeposit" → "deposit", "swap" → "swap"
   */
  private _getComposeAction(intent: IntentAction): string {
    if (intent.type.startsWith("kamino")) {
      const stripped = intent.type.slice(6);
      return stripped.charAt(0).toLowerCase() + stripped.slice(1);
    }
    return intent.type;
  }

  private async _resolveProtocolTier(intent: IntentAction, vault: Address) {
    let programAddress: Address | null = null;

    if (intent.type === "protocol") {
      const protocolId = (intent.params as Record<string, unknown>)
        .protocolId as string | undefined;
      if (protocolId) {
        const handler = this.registry.getByProtocolId(protocolId);
        if (handler?.metadata.programIds[0]) {
          programAddress = handler.metadata.programIds[0] as Address;
        }
      }
    } else if (intent.type === "passthrough") {
      const pid = (intent.params as Record<string, unknown>).programId as
        | string
        | undefined;
      if (pid) {
        programAddress = pid as Address;
      }
    }

    if (!programAddress) return null;

    const [policyPda] = await getPolicyPDA(vault);
    const policyAccount = await fetchPolicyConfig(this.rpc, policyPda);

    return resolveProtocol(
      programAddress,
      this.registry,
      {
        protocolMode: policyAccount.data.protocolMode,
        protocols: policyAccount.data.protocols,
      },
      policyAccount.data.hasConstraints,
    );
  }

  private _resolveProtocolAddress(intent: IntentAction): Address | null {
    const handler = this._resolveHandler(intent);
    if (handler?.metadata.programIds[0])
      return handler.metadata.programIds[0] as Address;
    if (intent.type === "passthrough") {
      // Advisory only — on-chain validates actual instruction program IDs
      return (
        ((intent.params as Record<string, unknown>).programId as
          | Address
          | undefined) ?? null
      );
    }
    return null;
  }

  private _resolveHandler(intent: IntentAction) {
    if (intent.type === "swap") {
      return this.registry.getByProtocolId("jupiter");
    }
    if (
      intent.type === "openPosition" ||
      intent.type === "closePosition" ||
      intent.type === "increasePosition" ||
      intent.type === "decreasePosition"
    ) {
      return this.registry.getByProtocolId("flash-trade");
    }
    if (intent.type === "deposit" || intent.type === "withdraw") {
      const params = intent.params as Record<string, unknown>;
      if (params.protocol === "drift") {
        return this.registry.getByProtocolId("drift");
      }
      return this.registry.getByProtocolId("kamino-lending");
    }
    if (
      intent.type === "kaminoDeposit" ||
      intent.type === "kaminoBorrow" ||
      intent.type === "kaminoRepay" ||
      intent.type === "kaminoWithdraw" ||
      intent.type === "kaminoVaultDeposit" ||
      intent.type === "kaminoVaultWithdraw" ||
      intent.type === "kaminoMultiply"
    ) {
      return this.registry.getByProtocolId("kamino-lending");
    }
    if (intent.type === "protocol") {
      const protocolId = (intent.params as Record<string, unknown>)
        .protocolId as string | undefined;
      if (protocolId) {
        return this.registry.getByProtocolId(protocolId);
      }
    }
    return null;
  }

  private _resolveIntentToken(intent: IntentAction): ResolvedToken | null {
    const params = intent.params as Record<string, unknown>;
    const tokenField =
      (params.inputMint as string) ??
      (params.mint as string) ??
      (params.tokenMint as string) ??
      (params.collateral as string);
    if (!tokenField) return null;
    return resolveToken(tokenField, this.network);
  }

  private _getIntentAmount(intent: IntentAction): string | null {
    const params = intent.params as Record<string, unknown>;
    return (
      (params.amount as string) ??
      (params.collateral as string) ??
      (params.sizeDelta as string) ??
      (params.collateralAmount as string) ??
      null
    );
  }

  private _estimateUsd(amountStr: string, token: ResolvedToken): bigint {
    if (isStablecoinMint(token.mint, this.network)) {
      return BigInt(amountStr);
    }
    // Non-stablecoins bypass cap check by design (no oracle)
    return 0n;
  }

  private _getLeverageBps(intent: IntentAction): number | null {
    const params = intent.params as Record<string, unknown>;
    const leverage = params.leverage as number | undefined;
    const leverageBps = params.leverageBps as number | undefined;
    if (leverageBps !== undefined) return leverageBps;
    if (leverage !== undefined) return Math.round(leverage * 100);
    return null;
  }
}
