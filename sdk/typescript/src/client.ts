import {
  PublicKey,
  Connection,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Signer,
  Keypair,
  AddressLookupTableAccount,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  FEE_RATE_DENOMINATOR,
  PROTOCOL_FEE_RATE,
  EPOCH_DURATION,
  NUM_EPOCHS,
  hasPermission,
  isStablecoinMint,
} from "./types";
import type {
  Phalnx,
  AgentVaultAccount,
  PolicyConfigAccount,
  SpendTrackerAccount,
  PendingPolicyUpdateAccount,
  EscrowDepositAccount,
  InstructionConstraintsAccount,
  PendingConstraintsUpdateAccount,
  ConstraintEntry,
  InitializeVaultParams,
  UpdatePolicyParams,
  QueuePolicyUpdateParams,
  AgentTransferParams,
  AuthorizeParams,
  ComposeActionParams,
} from "./types";
import {
  ACTION_TYPE_MAP,
  summarizeAction,
  type PrecheckResult,
  type ExecuteResult,
  type IntentAction,
} from "./intents";
import { resolveToken, toBaseUnits } from "./tokens";
import { PhalnxSDKError, precheckError, parseOnChainError } from "./errors";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getEscrowPDA,
  getConstraintsPDA,
  getPendingConstraintsPDA,
  fetchVault,
  fetchPolicy,
  fetchTracker,
  fetchVaultByAddress,
  fetchPolicyByAddress,
  fetchTrackerByAddress,
  fetchPendingPolicy,
  fetchEscrow,
  fetchEscrowByAddress,
  fetchConstraints,
  fetchPendingConstraints,
} from "./accounts";
import {
  buildInitializeVault,
  buildDepositFunds,
  buildRegisterAgent,
  buildUpdatePolicy,
  buildValidateAndAuthorize,
  buildFinalizeSession,
  buildRevokeAgent,
  buildReactivateVault,
  buildFreezeVault,
  buildPauseAgent,
  buildUnpauseAgent,
  buildWithdrawFunds,
  buildCloseVault,
  buildQueuePolicyUpdate,
  buildApplyPendingPolicy,
  buildCancelPendingPolicy,
  buildAgentTransfer,
  buildUpdateAgentPermissions,
  buildCreateEscrow,
  buildSettleEscrow,
  buildRefundEscrow,
  buildCloseSettledEscrow,
  buildCreateInstructionConstraints,
  buildCloseInstructionConstraints,
  buildUpdateInstructionConstraints,
  buildQueueConstraintsUpdate,
  buildApplyConstraintsUpdate,
  buildCancelConstraintsUpdate,
} from "./instructions";
import {
  composePermittedAction,
  composePermittedTransaction,
  composePermittedSwap,
} from "./composer";
import { wrapTransaction, type WrapTransactionParams } from "./wrap";
import {
  fetchJupiterQuote,
  composeJupiterSwap,
  composeJupiterSwapTransaction,
  type JupiterQuoteParams,
  type JupiterQuoteResponse,
  type JupiterSwapParams,
} from "./integrations/jupiter";
import {
  getJupiterPrices,
  getTokenPriceUsd,
  type JupiterPriceResponse,
} from "./integrations/jupiter-price";
import {
  searchJupiterTokens,
  getTrendingTokens,
  type JupiterTokenInfo,
  type TrendingInterval,
} from "./integrations/jupiter-tokens";
import {
  getJupiterLendTokens,
  getJupiterEarnPositions,
  composeJupiterLendDeposit,
  composeJupiterLendWithdraw,
  type JupiterLendTokenInfo,
  type JupiterEarnPosition,
  type JupiterLendDepositParams,
  type JupiterLendWithdrawParams,
} from "./integrations/jupiter-lend";
import {
  createJupiterTriggerOrder,
  cancelJupiterTriggerOrder,
  getJupiterTriggerOrders,
  type JupiterTriggerOrderParams,
  type JupiterTriggerOrder,
} from "./integrations/jupiter-trigger";
import {
  createJupiterRecurringOrder,
  getJupiterRecurringOrders,
  cancelJupiterRecurringOrder,
  type JupiterRecurringOrderParams,
  type JupiterRecurringOrder,
} from "./integrations/jupiter-recurring";
import {
  getJupiterPortfolio,
  type JupiterPortfolioSummary,
} from "./integrations/jupiter-portfolio";
import {
  createFlashTradeClient as _createFlashTradeClient,
  getPoolConfig,
  composeFlashTradeOpen,
  composeFlashTradeClose,
  composeFlashTradeIncrease,
  composeFlashTradeDecrease,
  composeFlashTradeAddCollateral,
  composeFlashTradeRemoveCollateral,
  composeFlashTradePlaceTriggerOrder,
  composeFlashTradeEditTriggerOrder,
  composeFlashTradeCancelTriggerOrder,
  composeFlashTradePlaceLimitOrder,
  composeFlashTradeEditLimitOrder,
  composeFlashTradeCancelLimitOrder,
  composeFlashTradeSwapAndOpen,
  composeFlashTradeCloseAndSwap,
  composeFlashTradeTransaction,
  type FlashTradeConfig,
  type FlashOpenPositionParams,
  type FlashClosePositionParams,
  type FlashIncreasePositionParams,
  type FlashDecreasePositionParams,
  type FlashAddCollateralParams,
  type FlashRemoveCollateralParams,
  type FlashTriggerOrderParams,
  type FlashEditTriggerOrderParams,
  type FlashCancelTriggerOrderParams,
  type FlashLimitOrderParams,
  type FlashEditLimitOrderParams,
  type FlashCancelLimitOrderParams,
  type FlashSwapAndOpenParams,
  type FlashCloseAndSwapParams,
  type FlashTradeResult,
} from "./integrations/flash-trade";
import {
  reconcilePositions,
  countFlashTradePositions,
} from "./integrations/flash-trade-reconcile";
import { buildSyncPositions } from "./instructions";
import { PerpetualsClient, PoolConfig } from "flash-sdk";
import { IDL as PhalnxIDL } from "./idl-json";
import {
  configureJupiterApi,
  type JupiterApiConfig,
} from "./integrations/jupiter-api";
import {
  simulateTransaction,
  type SimulationResult,
  type SimulateOptions,
} from "./simulation";
import { TransactionSimulationError } from "./wrapper/errors";
import {
  createIntent,
  MemoryIntentStorage,
  type IntentStorage,
  type TransactionIntent,
} from "./intents";
import {
  composeDriftDeposit,
  composeDriftWithdraw,
  composeDriftPlacePerpOrder,
  composeDriftPlaceSpotOrder,
  composeDriftCancelOrder,
  composeDriftModifyOrder,
  composeDriftSettlePnl,
  type DriftDepositParams,
  type DriftWithdrawParams,
  type DriftPlacePerpOrderParams,
  type DriftPlaceSpotOrderParams,
  type DriftCancelOrderParams,
  type DriftModifyOrderParams,
  type DriftSettlePnlParams,
  type DriftComposeResult,
} from "./integrations/drift";
import {
  composeKaminoDeposit,
  composeKaminoBorrow,
  composeKaminoRepay,
  composeKaminoWithdraw,
  type KaminoDepositParams,
  type KaminoBorrowParams,
  type KaminoRepayParams,
  type KaminoWithdrawParams,
  type KaminoComposeResult,
} from "./integrations/kamino";
import { globalProtocolRegistry } from "./integrations/protocol-registry";
import type { ProtocolRegistry } from "./integrations/protocol-registry";
import {
  createSquadsMultisig,
  proposeVaultAction,
  approveProposal,
  rejectProposal,
  executeVaultTransaction,
  fetchMultisigInfo,
  fetchProposalInfo,
  getSquadsVaultPda,
  proposeUpdatePolicy as _proposeUpdatePolicy,
  proposeQueuePolicyUpdate as _proposeQueuePolicyUpdate,
  proposeApplyPendingPolicy as _proposeApplyPendingPolicy,
  proposeSyncPositions as _proposeSyncPositions,
  proposeInitializeVault as _proposeInitializeVault,
  type CreateSquadsMultisigParams,
  type ProposeVaultActionParams,
  type ApproveProposalParams,
  type RejectProposalParams,
  type ExecuteVaultTransactionParams,
  type MultisigInfo,
  type ProposalInfo,
} from "./integrations/squads";

export interface PhalnxClientOptions {
  programId?: PublicKey;
  idl?: any;
  /** When true, createVault() throws if allowedDestinations is empty */
  requireDestinations?: boolean;
  /** Priority fee configuration. Enabled by default with "auto" strategy. */
  priorityFees?: import("./priority-fees").PriorityFeeConfig | false;
  /** Jupiter API configuration (API key, base URL, retry, timeout). */
  jupiterApiConfig?: JupiterApiConfig;
  /** When true, simulate transactions before sending. Default: false. */
  simulateBeforeSend?: boolean;
  /** Custom intent storage. Default: MemoryIntentStorage (lazy-initialized). */
  intentStorage?: IntentStorage;
  /** Custom protocol registry. Default: globalProtocolRegistry. */
  protocolRegistry?: ProtocolRegistry;
}

export class PhalnxClient {
  readonly program: Program<Phalnx>;
  readonly provider: AnchorProvider;
  private readonly requireDestinations: boolean;
  private readonly priorityFeeConfig:
    | import("./priority-fees").PriorityFeeConfig
    | false;
  private readonly _simulateBeforeSend: boolean;
  private _intentStorage: IntentStorage | undefined;
  private readonly _protocolRegistry: ProtocolRegistry;
  private _intentsEngine: import("./intent-engine").IntentEngine | undefined;

  constructor(
    connection: Connection,
    wallet: Wallet,
    programIdOrOptions?: PublicKey | PhalnxClientOptions,
    idl?: any,
  ) {
    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });

    let programId: PublicKey | undefined;
    let resolvedIdl: any;

    if (
      programIdOrOptions &&
      !(programIdOrOptions instanceof PublicKey) &&
      typeof programIdOrOptions === "object"
    ) {
      const opts = programIdOrOptions as PhalnxClientOptions;
      programId = opts.programId;
      resolvedIdl = opts.idl ?? PhalnxIDL;
      this.requireDestinations = opts.requireDestinations ?? false;
      this.priorityFeeConfig = opts.priorityFees ?? {};
      this._simulateBeforeSend = opts.simulateBeforeSend ?? false;
      this._intentStorage = opts.intentStorage;
      this._protocolRegistry = opts.protocolRegistry ?? globalProtocolRegistry;
      if (opts.jupiterApiConfig) {
        configureJupiterApi(opts.jupiterApiConfig);
      }
    } else {
      programId = programIdOrOptions as PublicKey | undefined;
      resolvedIdl = idl ?? PhalnxIDL;
      this.requireDestinations = false;
      this.priorityFeeConfig = {};
      this._simulateBeforeSend = false;
      this._protocolRegistry = globalProtocolRegistry;
    }

    if (programId) {
      resolvedIdl.address = programId.toBase58();
    }
    this.program = new Program<Phalnx>(resolvedIdl, this.provider) as any;
  }

  // --- Simulation & Send Helpers ---

  private async sendWithOptionalSimulation(
    signed: VersionedTransaction,
    blockhash?: string,
    lastValidBlockHeight?: number,
  ): Promise<string> {
    if (this._simulateBeforeSend) {
      const simResult = await simulateTransaction(
        this.provider.connection,
        signed,
        { replaceRecentBlockhash: false },
      );
      if (!simResult.success) {
        throw new TransactionSimulationError(simResult);
      }
    }

    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );

    if (!blockhash || lastValidBlockHeight === undefined) {
      const latest = await this.provider.connection.getLatestBlockhash();
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;
    }

    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }

  async simulate(
    tx: VersionedTransaction,
    options?: SimulateOptions,
  ): Promise<SimulationResult> {
    return simulateTransaction(this.provider.connection, tx, options);
  }

  // --- PDA Helpers ---

  getVaultPDA(owner: PublicKey, vaultId: BN): [PublicKey, number] {
    return getVaultPDA(owner, vaultId, this.program.programId);
  }

  getPolicyPDA(vault: PublicKey): [PublicKey, number] {
    return getPolicyPDA(vault, this.program.programId);
  }

  getTrackerPDA(vault: PublicKey): [PublicKey, number] {
    return getTrackerPDA(vault, this.program.programId);
  }

  getSessionPDA(
    vault: PublicKey,
    agent: PublicKey,
    tokenMint: PublicKey,
  ): [PublicKey, number] {
    return getSessionPDA(vault, agent, tokenMint, this.program.programId);
  }

  getPendingPolicyPDA(vault: PublicKey): [PublicKey, number] {
    return getPendingPolicyPDA(vault, this.program.programId);
  }

  // --- Account Fetching ---

  async fetchVault(owner: PublicKey, vaultId: BN): Promise<AgentVaultAccount> {
    return fetchVault(this.program, owner, vaultId);
  }

  async fetchVaultByAddress(address: PublicKey): Promise<AgentVaultAccount> {
    return fetchVaultByAddress(this.program, address);
  }

  async fetchPolicy(vault: PublicKey): Promise<PolicyConfigAccount> {
    return fetchPolicy(this.program, vault);
  }

  async fetchPolicyByAddress(address: PublicKey): Promise<PolicyConfigAccount> {
    return fetchPolicyByAddress(this.program, address);
  }

  async fetchTracker(vault: PublicKey): Promise<SpendTrackerAccount> {
    return fetchTracker(this.program, vault);
  }

  async fetchTrackerByAddress(
    address: PublicKey,
  ): Promise<SpendTrackerAccount> {
    return fetchTrackerByAddress(this.program, address);
  }

  async fetchPendingPolicy(
    vault: PublicKey,
  ): Promise<PendingPolicyUpdateAccount | null> {
    return fetchPendingPolicy(this.program, vault);
  }

  // --- Instruction Execution (sends + confirms) ---

  async createVault(params: InitializeVaultParams): Promise<string> {
    const hasDestinations =
      params.allowedDestinations && params.allowedDestinations.length > 0;

    if (!hasDestinations) {
      if (this.requireDestinations) {
        throw new Error(
          "Phalnx: allowedDestinations is empty but requireDestinations is enabled. " +
            "Pass allowedDestinations to restrict agent transfer targets.",
        );
      }
      console.warn(
        "\u26A0 Phalnx: Vault created with empty allowedDestinations \u2014 " +
          "agent can transfer to ANY address. Pass allowedDestinations to restrict.",
      );
    }

    const owner = this.provider.wallet.publicKey;
    return buildInitializeVault(this.program, owner, params).rpc();
  }

  async deposit(
    vault: PublicKey,
    mint: PublicKey,
    amount: BN,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildDepositFunds(this.program, owner, vault, mint, amount).rpc();
  }

  async registerAgent(
    vault: PublicKey,
    agent: PublicKey,
    permissions: BN,
    spendingLimitUsd: BN = new BN(0),
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildRegisterAgent(
      this.program,
      owner,
      vault,
      agent,
      permissions,
      spendingLimitUsd,
    ).rpc();
  }

  async updatePolicy(
    vault: PublicKey,
    params: UpdatePolicyParams,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildUpdatePolicy(this.program, owner, vault, params).rpc();
  }

  async authorizeAction(
    vault: PublicKey,
    vaultTokenAccount: PublicKey,
    params: AuthorizeParams,
    protocolTreasuryTokenAccount?: PublicKey | null,
    feeDestinationTokenAccount?: PublicKey | null,
    outputStablecoinAccount?: PublicKey,
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildValidateAndAuthorize(
      this.program,
      agent,
      vault,
      vaultTokenAccount,
      params,
      protocolTreasuryTokenAccount,
      feeDestinationTokenAccount,
      outputStablecoinAccount,
    ).rpc();
  }

  async finalizeSession(
    vault: PublicKey,
    agent: PublicKey,
    tokenMint: PublicKey,
    success: boolean,
    vaultTokenAccount: PublicKey,
    outputStablecoinAccount?: PublicKey,
  ): Promise<string> {
    const payer = this.provider.wallet.publicKey;
    return buildFinalizeSession(
      this.program,
      payer,
      vault,
      agent,
      tokenMint,
      success,
      vaultTokenAccount,
      outputStablecoinAccount,
    ).rpc();
  }

  /**
   * Calculate protocol and developer fees for a given amount.
   */
  static calculateFees(
    amount: BN,
    developerFeeRate: number,
  ): { protocolFee: BN; developerFee: BN; totalFee: BN } {
    const protocolFee = amount
      .mul(new BN(PROTOCOL_FEE_RATE))
      .div(new BN(FEE_RATE_DENOMINATOR));
    const developerFee = amount
      .mul(new BN(developerFeeRate))
      .div(new BN(FEE_RATE_DENOMINATOR));
    return {
      protocolFee,
      developerFee,
      totalFee: protocolFee.add(developerFee),
    };
  }

  async revokeAgent(
    vault: PublicKey,
    agentToRemove: PublicKey,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildRevokeAgent(this.program, owner, vault, agentToRemove).rpc();
  }

  async reactivateVault(
    vault: PublicKey,
    newAgent?: PublicKey | null,
    newAgentPermissions?: BN | null,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildReactivateVault(
      this.program,
      owner,
      vault,
      newAgent,
      newAgentPermissions,
    ).rpc();
  }

  async freezeVault(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildFreezeVault(this.program, owner, vault).rpc();
  }

  async pauseAgent(vault: PublicKey, agent: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildPauseAgent(this.program, owner, vault, agent).rpc();
  }

  async unpauseAgent(vault: PublicKey, agent: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildUnpauseAgent(this.program, owner, vault, agent).rpc();
  }

  async updateAgentPermissions(
    vault: PublicKey,
    agent: PublicKey,
    newPermissions: BN,
    spendingLimitUsd: BN = new BN(0),
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildUpdateAgentPermissions(
      this.program,
      owner,
      vault,
      agent,
      newPermissions,
      spendingLimitUsd,
    ).rpc();
  }

  async withdraw(
    vault: PublicKey,
    mint: PublicKey,
    amount: BN,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildWithdrawFunds(this.program, owner, vault, mint, amount).rpc();
  }

  async closeVault(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildCloseVault(this.program, owner, vault).rpc();
  }

  async queuePolicyUpdate(
    vault: PublicKey,
    params: QueuePolicyUpdateParams,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildQueuePolicyUpdate(this.program, owner, vault, params).rpc();
  }

  async applyPendingPolicy(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildApplyPendingPolicy(this.program, owner, vault).rpc();
  }

  async cancelPendingPolicy(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildCancelPendingPolicy(this.program, owner, vault).rpc();
  }

  async agentTransfer(
    vault: PublicKey,
    params: AgentTransferParams,
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildAgentTransfer(this.program, agent, vault, params).rpc();
  }

  // --- Composition ---

  async composePermittedAction(
    params: ComposeActionParams,
    computeUnits?: number,
  ): Promise<TransactionInstruction[]> {
    const conn =
      this.priorityFeeConfig !== false ? this.provider.connection : undefined;
    const feeConfig =
      this.priorityFeeConfig !== false ? this.priorityFeeConfig : undefined;
    return composePermittedAction(
      this.program,
      params,
      computeUnits,
      conn,
      feeConfig || undefined,
    );
  }

  async composePermittedTransaction(
    params: ComposeActionParams,
    computeUnits?: number,
  ): Promise<VersionedTransaction> {
    const feeConfig =
      this.priorityFeeConfig !== false ? this.priorityFeeConfig : undefined;
    return composePermittedTransaction(
      this.program,
      this.provider.connection,
      params,
      computeUnits,
      feeConfig || undefined,
    );
  }

  async composePermittedSwap(
    params: Omit<ComposeActionParams, "actionType">,
    computeUnits?: number,
  ): Promise<TransactionInstruction[]> {
    const conn =
      this.priorityFeeConfig !== false ? this.provider.connection : undefined;
    const feeConfig =
      this.priorityFeeConfig !== false ? this.priorityFeeConfig : undefined;
    return composePermittedSwap(
      this.program,
      params,
      computeUnits,
      conn,
      feeConfig || undefined,
    );
  }

  /**
   * Compose a permitted action, sign, and send in one call.
   * Returns the transaction signature.
   */
  async composeAndSend(
    params: ComposeActionParams,
    signers?: Signer[],
    computeUnits?: number,
  ): Promise<string> {
    const instructions = await this.composePermittedAction(
      params,
      computeUnits,
    );
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: params.agent,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(params.addressLookupTables);

    const tx = new VersionedTransaction(messageV0);

    if (signers && signers.length > 0) {
      tx.sign(signers);
    }

    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(
      signed,
      blockhash,
      lastValidBlockHeight,
    );
  }

  /**
   * Protocol-agnostic: wrap DeFi instructions, sign, send, and confirm.
   * Handles authority rewriting, delegation, and fee collection automatically.
   */
  async wrapAndSend(
    params: WrapTransactionParams,
    signers?: Signer[],
  ): Promise<string> {
    const feeConfig =
      this.priorityFeeConfig !== false ? this.priorityFeeConfig : undefined;
    const paramsWithFees: WrapTransactionParams = {
      ...params,
      priorityFeeConfig: params.priorityFeeConfig ?? (feeConfig || undefined),
    };
    const tx = await wrapTransaction(
      this.program,
      this.provider.connection,
      paramsWithFees,
    );

    if (signers && signers.length > 0) {
      tx.sign(signers);
    }

    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(signed);
  }

  // --- Jupiter Integration ---

  /**
   * Fetch a swap quote from Jupiter V6 API.
   */
  async getJupiterQuote(
    params: JupiterQuoteParams,
  ): Promise<JupiterQuoteResponse> {
    return fetchJupiterQuote(params);
  }

  /**
   * Build an unsigned VersionedTransaction for a Jupiter swap through Phalnx.
   *
   * Composes: [ComputeBudget, ValidateAndAuthorize, ...JupiterIxs, FinalizeSession]
   */
  async jupiterSwap(params: JupiterSwapParams): Promise<VersionedTransaction> {
    return composeJupiterSwapTransaction(
      this.program,
      this.provider.connection,
      params,
    );
  }

  /**
   * Compose a Jupiter swap, sign, send, and confirm in one call.
   * Returns the transaction signature.
   */
  async executeJupiterSwap(
    params: JupiterSwapParams,
    signers?: Signer[],
  ): Promise<string> {
    const { instructions, addressLookupTables } = await composeJupiterSwap(
      this.program,
      this.provider.connection,
      params,
    );

    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: params.agent,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTables);

    const tx = new VersionedTransaction(messageV0);

    if (signers && signers.length > 0) {
      tx.sign(signers);
    }

    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(
      signed,
      blockhash,
      lastValidBlockHeight,
    );
  }

  // --- Jupiter Price API ---

  async getTokenPrices(mints: string[]): Promise<JupiterPriceResponse> {
    return getJupiterPrices({ ids: mints });
  }

  async getTokenPriceUsd(mint: string): Promise<number | null> {
    return getTokenPriceUsd(mint);
  }

  // --- Jupiter Token API ---

  async searchTokens(
    query: string,
    limit?: number,
  ): Promise<JupiterTokenInfo[]> {
    return searchJupiterTokens({ query, limit });
  }

  async getTrendingTokens(
    interval?: TrendingInterval,
  ): Promise<JupiterTokenInfo[]> {
    return getTrendingTokens(interval);
  }

  // --- Jupiter Lend/Earn Integration ---

  async getJupiterLendTokens(): Promise<JupiterLendTokenInfo[]> {
    return getJupiterLendTokens();
  }

  async getJupiterEarnPositions(
    user: string,
    positions: string[],
  ): Promise<JupiterEarnPosition[]> {
    return getJupiterEarnPositions(user, positions);
  }

  async jupiterLendDeposit(params: JupiterLendDepositParams): Promise<string> {
    const { instructions } = await composeJupiterLendDeposit(
      this.program,
      this.provider.connection,
      params,
    );

    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: params.agent,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(
      signed,
      blockhash,
      lastValidBlockHeight,
    );
  }

  async jupiterLendWithdraw(
    params: JupiterLendWithdrawParams,
  ): Promise<string> {
    const { instructions } = await composeJupiterLendWithdraw(
      this.program,
      this.provider.connection,
      params,
    );

    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: params.agent,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(
      signed,
      blockhash,
      lastValidBlockHeight,
    );
  }

  // --- Jupiter Trigger Orders ---

  async createJupiterTriggerOrder(
    params: JupiterTriggerOrderParams,
  ): Promise<{ serializedTransaction: string }> {
    return createJupiterTriggerOrder(params);
  }

  async getJupiterTriggerOrders(
    authority: string,
    state?: "active" | "completed" | "cancelled",
  ): Promise<JupiterTriggerOrder[]> {
    return getJupiterTriggerOrders(authority, state);
  }

  async cancelJupiterTriggerOrder(
    orderId: string,
    feePayer: string,
    signer: string,
  ): Promise<{ serializedTransaction: string }> {
    return cancelJupiterTriggerOrder(orderId, feePayer, signer);
  }

  // --- Jupiter Recurring/DCA ---

  async createJupiterRecurringOrder(
    params: JupiterRecurringOrderParams,
  ): Promise<{ transaction: string }> {
    return createJupiterRecurringOrder(params);
  }

  async getJupiterRecurringOrders(
    user: string,
  ): Promise<JupiterRecurringOrder[]> {
    return getJupiterRecurringOrders(user);
  }

  async cancelJupiterRecurringOrder(
    orderId: string,
    feePayer: string,
    signer: string,
  ): Promise<{ transaction: string }> {
    return cancelJupiterRecurringOrder(orderId, feePayer, signer);
  }

  // --- Jupiter Portfolio ---

  async getJupiterPortfolio(wallet: string): Promise<JupiterPortfolioSummary> {
    return getJupiterPortfolio(wallet);
  }

  // --- Flash Trade Integration ---

  private _perpClient: PerpetualsClient | null = null;
  private _poolConfig: PoolConfig | null = null;

  /**
   * Create (or return cached) Flash Trade PerpetualsClient.
   */
  createFlashTradeClient(config?: Partial<FlashTradeConfig>): PerpetualsClient {
    if (!this._perpClient) {
      this._perpClient = _createFlashTradeClient(this.provider, config);
    }
    return this._perpClient;
  }

  /**
   * Get (or return cached) Flash Trade PoolConfig.
   */
  getFlashPoolConfig(
    poolName: string = "Crypto.1",
    cluster: "mainnet-beta" | "devnet" = "mainnet-beta",
  ): PoolConfig {
    if (!this._poolConfig) {
      this._poolConfig = getPoolConfig(poolName, cluster);
    }
    return this._poolConfig;
  }

  /**
   * Compose a Flash Trade open position through Phalnx.
   */
  async flashTradeOpen(
    params: FlashOpenPositionParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeOpen(this.program, perpClient, config, params);
  }

  /**
   * Compose a Flash Trade close position through Phalnx.
   */
  async flashTradeClose(
    params: FlashClosePositionParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeClose(this.program, perpClient, config, params);
  }

  /**
   * Compose a Flash Trade increase position through Phalnx.
   */
  async flashTradeIncrease(
    params: FlashIncreasePositionParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeIncrease(this.program, perpClient, config, params);
  }

  /**
   * Compose a Flash Trade decrease position through Phalnx.
   */
  async flashTradeDecrease(
    params: FlashDecreasePositionParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeDecrease(this.program, perpClient, config, params);
  }

  /**
   * Add collateral to an existing Flash Trade position.
   */
  async flashTradeAddCollateral(
    params: FlashAddCollateralParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeAddCollateral(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Remove collateral from an existing Flash Trade position.
   */
  async flashTradeRemoveCollateral(
    params: FlashRemoveCollateralParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeRemoveCollateral(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Place a trigger order (TP/SL) on an existing Flash Trade position.
   */
  async flashTradePlaceTriggerOrder(
    params: FlashTriggerOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradePlaceTriggerOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Edit an existing trigger order on a Flash Trade position.
   */
  async flashTradeEditTriggerOrder(
    params: FlashEditTriggerOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeEditTriggerOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Cancel a trigger order on a Flash Trade position.
   */
  async flashTradeCancelTriggerOrder(
    params: FlashCancelTriggerOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeCancelTriggerOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Place a limit order via Flash Trade through Phalnx.
   */
  async flashTradePlaceLimitOrder(
    params: FlashLimitOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradePlaceLimitOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Edit an existing limit order on Flash Trade.
   */
  async flashTradeEditLimitOrder(
    params: FlashEditLimitOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeEditLimitOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Cancel a limit order on Flash Trade.
   */
  async flashTradeCancelLimitOrder(
    params: FlashCancelLimitOrderParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeCancelLimitOrder(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Swap tokens then open a Flash Trade position in one transaction.
   */
  async flashTradeSwapAndOpen(
    params: FlashSwapAndOpenParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeSwapAndOpen(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Close a Flash Trade position and swap the output in one transaction.
   */
  async flashTradeCloseAndSwap(
    params: FlashCloseAndSwapParams,
    poolConfig?: PoolConfig,
  ): Promise<FlashTradeResult> {
    const perpClient = this.createFlashTradeClient();
    const config = poolConfig ?? this.getFlashPoolConfig();
    return composeFlashTradeCloseAndSwap(
      this.program,
      perpClient,
      config,
      params,
    );
  }

  /**
   * Sync the vault's open position counter with actual Flash Trade state.
   * Owner-only. Returns the transaction signature, or null if already in sync.
   */
  async syncPositions(
    owner: PublicKey,
    vault: PublicKey,
    poolCustodyPairs: [PublicKey, PublicKey][],
    flashProgramId: PublicKey,
  ): Promise<string | null> {
    const ix = await reconcilePositions(
      this.program,
      this.provider.connection,
      owner,
      vault,
      poolCustodyPairs,
      flashProgramId,
    );
    if (!ix) return null;

    const { blockhash } = await this.provider.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: this.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(signed);
  }

  /**
   * Compose a Flash Trade action, sign, send, and confirm in one call.
   */
  async executeFlashTrade(
    result: FlashTradeResult,
    agent: PublicKey,
    signers?: Signer[],
  ): Promise<string> {
    const tx = await composeFlashTradeTransaction(
      this.provider.connection,
      agent,
      result,
    );

    const allSigners = [
      ...(result.additionalSigners || []),
      ...(signers || []),
    ];
    if (allSigners.length > 0) {
      tx.sign(allSigners);
    }

    const signed = await this.provider.wallet.signTransaction(tx);
    return this.sendWithOptionalSimulation(signed);
  }

  // --- Escrow Operations ---

  async createEscrow(
    sourceVault: PublicKey,
    destinationVault: PublicKey,
    escrowId: BN,
    amount: BN,
    expiresAt: BN,
    conditionHash: number[],
    tokenMint: PublicKey,
    sourceVaultAta: PublicKey,
    protocolTreasuryAta?: PublicKey | null,
    feeDestinationAta?: PublicKey | null,
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildCreateEscrow(
      this.program,
      agent,
      sourceVault,
      destinationVault,
      escrowId,
      amount,
      expiresAt,
      conditionHash,
      tokenMint,
      sourceVaultAta,
      protocolTreasuryAta,
      feeDestinationAta,
    ).rpc();
  }

  async settleEscrow(
    destinationVault: PublicKey,
    sourceVault: PublicKey,
    escrow: PublicKey,
    escrowAta: PublicKey,
    destinationVaultAta: PublicKey,
    tokenMint: PublicKey,
    proof: Buffer,
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildSettleEscrow(
      this.program,
      agent,
      destinationVault,
      sourceVault,
      escrow,
      escrowAta,
      destinationVaultAta,
      tokenMint,
      proof,
    ).rpc();
  }

  async refundEscrow(
    sourceVault: PublicKey,
    escrow: PublicKey,
    escrowAta: PublicKey,
    sourceVaultAta: PublicKey,
    tokenMint: PublicKey,
  ): Promise<string> {
    const signer = this.provider.wallet.publicKey;
    return buildRefundEscrow(
      this.program,
      signer,
      sourceVault,
      escrow,
      escrowAta,
      sourceVaultAta,
      tokenMint,
    ).rpc();
  }

  async closeSettledEscrow(
    sourceVault: PublicKey,
    destinationVaultKey: PublicKey,
    escrow: PublicKey,
    escrowId: BN,
  ): Promise<string> {
    const signer = this.provider.wallet.publicKey;
    return buildCloseSettledEscrow(
      this.program,
      signer,
      sourceVault,
      destinationVaultKey,
      escrow,
      escrowId,
    ).rpc();
  }

  async fetchEscrow(
    sourceVault: PublicKey,
    destinationVault: PublicKey,
    escrowId: BN,
  ): Promise<EscrowDepositAccount> {
    return fetchEscrow(this.program, sourceVault, destinationVault, escrowId);
  }

  // --- Instruction Constraints ---

  async createInstructionConstraints(
    vault: PublicKey,
    entries: ConstraintEntry[],
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildCreateInstructionConstraints(
      this.program,
      owner,
      vault,
      entries,
    ).rpc();
  }

  async closeInstructionConstraints(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildCloseInstructionConstraints(this.program, owner, vault).rpc();
  }

  async updateInstructionConstraints(
    vault: PublicKey,
    entries: ConstraintEntry[],
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildUpdateInstructionConstraints(
      this.program,
      owner,
      vault,
      entries,
    ).rpc();
  }

  async queueConstraintsUpdate(
    vault: PublicKey,
    entries: ConstraintEntry[],
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildQueueConstraintsUpdate(
      this.program,
      owner,
      vault,
      entries,
    ).rpc();
  }

  async applyConstraintsUpdate(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildApplyConstraintsUpdate(this.program, owner, vault).rpc();
  }

  async cancelConstraintsUpdate(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildCancelConstraintsUpdate(this.program, owner, vault).rpc();
  }

  async fetchConstraints(
    vault: PublicKey,
  ): Promise<InstructionConstraintsAccount | null> {
    return fetchConstraints(this.program, vault);
  }

  async fetchPendingConstraints(
    vault: PublicKey,
  ): Promise<PendingConstraintsUpdateAccount | null> {
    return fetchPendingConstraints(this.program, vault);
  }

  // --- Squads V4 Multisig Governance ---

  /**
   * Create a new Squads V4 multisig for governing an Phalnx vault.
   * Returns the multisig PDA and default vault PDA (index 0).
   */
  async squadsCreateMultisig(
    member: Keypair,
    params: CreateSquadsMultisigParams,
  ): Promise<{
    signature: string;
    multisigPda: PublicKey;
    vaultPda: PublicKey;
  }> {
    return createSquadsMultisig(this.provider.connection, member, params);
  }

  /**
   * Wrap Phalnx instruction(s) in a Squads vault transaction + proposal.
   * The member must have the Initiate permission.
   */
  async squadsProposeVaultAction(
    member: Keypair,
    params: ProposeVaultActionParams,
  ): Promise<{ signature: string; transactionIndex: bigint }> {
    return proposeVaultAction(this.provider.connection, member, params);
  }

  /**
   * Cast an approval vote on a Squads proposal.
   */
  async squadsApproveProposal(
    member: Keypair,
    params: ApproveProposalParams,
  ): Promise<string> {
    return approveProposal(this.provider.connection, member, params);
  }

  /**
   * Cast a rejection vote on a Squads proposal.
   */
  async squadsRejectProposal(
    member: Keypair,
    params: RejectProposalParams,
  ): Promise<string> {
    return rejectProposal(this.provider.connection, member, params);
  }

  /**
   * Execute an approved Squads vault transaction.
   * The member must have the Execute permission.
   */
  async squadsExecuteTransaction(
    member: Keypair,
    params: ExecuteVaultTransactionParams,
  ): Promise<string> {
    return executeVaultTransaction(this.provider.connection, member, params);
  }

  /**
   * Fetch and normalize a Squads multisig account.
   */
  async squadsFetchMultisigInfo(multisigPda: PublicKey): Promise<MultisigInfo> {
    return fetchMultisigInfo(this.provider.connection, multisigPda);
  }

  /**
   * Fetch and normalize a Squads proposal account.
   */
  async squadsFetchProposalInfo(
    multisigPda: PublicKey,
    transactionIndex: bigint,
  ): Promise<ProposalInfo> {
    return fetchProposalInfo(
      this.provider.connection,
      multisigPda,
      transactionIndex,
    );
  }

  /**
   * Build an Phalnx admin instruction and wrap it in a Squads proposal.
   * Supported actions: update_policy, queue_policy_update, apply_pending_policy,
   * sync_positions, initialize_vault.
   */
  async squadsProposeAction(
    member: Keypair,
    params: {
      multisigPda: PublicKey;
      vaultIndex?: number;
      action: string;
      phalnxVault?: PublicKey;
      actionParams?: any;
      memo?: string;
    },
  ): Promise<{ signature: string; transactionIndex: bigint }> {
    const conn = this.provider.connection;
    const base = {
      multisigPda: params.multisigPda,
      vaultIndex: params.vaultIndex,
      memo: params.memo,
    };

    switch (params.action) {
      case "update_policy":
        return _proposeUpdatePolicy(this.program, conn, member, {
          ...base,
          phalnxVault: params.phalnxVault!,
          policyUpdate: params.actionParams,
        });

      case "queue_policy_update":
        return _proposeQueuePolicyUpdate(this.program, conn, member, {
          ...base,
          phalnxVault: params.phalnxVault!,
          policyUpdate: params.actionParams,
        });

      case "apply_pending_policy":
        return _proposeApplyPendingPolicy(this.program, conn, member, {
          ...base,
          phalnxVault: params.phalnxVault!,
        });

      case "sync_positions":
        return _proposeSyncPositions(this.program, conn, member, {
          ...base,
          phalnxVault: params.phalnxVault!,
          actualPositions: params.actionParams?.actualPositions ?? 0,
        });

      case "initialize_vault":
        return _proposeInitializeVault(this.program, conn, member, {
          ...base,
          initParams: params.actionParams,
        });

      default:
        throw new Error(`Unknown Squads action: ${params.action}`);
    }
  }

  // --- Drift Protocol Methods ---

  async driftDeposit(params: DriftDepositParams): Promise<DriftComposeResult> {
    return composeDriftDeposit(this.program, this.provider.connection, params);
  }

  async driftWithdraw(
    params: DriftWithdrawParams,
  ): Promise<DriftComposeResult> {
    return composeDriftWithdraw(this.program, this.provider.connection, params);
  }

  async driftPlacePerpOrder(
    params: DriftPlacePerpOrderParams,
  ): Promise<DriftComposeResult> {
    return composeDriftPlacePerpOrder(
      this.program,
      this.provider.connection,
      params,
    );
  }

  async driftPlaceSpotOrder(
    params: DriftPlaceSpotOrderParams,
  ): Promise<DriftComposeResult> {
    return composeDriftPlaceSpotOrder(
      this.program,
      this.provider.connection,
      params,
    );
  }

  async driftCancelOrder(
    params: DriftCancelOrderParams,
  ): Promise<DriftComposeResult> {
    return composeDriftCancelOrder(
      this.program,
      this.provider.connection,
      params,
    );
  }

  async driftModifyOrder(
    params: DriftModifyOrderParams,
  ): Promise<DriftComposeResult> {
    return composeDriftModifyOrder(
      this.program,
      this.provider.connection,
      params,
    );
  }

  async driftSettlePnl(
    params: DriftSettlePnlParams,
  ): Promise<DriftComposeResult> {
    return composeDriftSettlePnl(
      this.program,
      this.provider.connection,
      params,
    );
  }

  /** Execute a composed Drift transaction (same pattern as executeFlashTrade). */
  async executeDrift(
    result: DriftComposeResult,
    agent: PublicKey,
    signers?: Signer[],
  ): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: agent,
      recentBlockhash: blockhash,
      instructions: result.instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    const allSigners = [
      ...(result.additionalSigners || []),
      ...(signers || []),
    ];
    if (allSigners.length > 0) {
      tx.sign(allSigners);
    }
    return this.provider.sendAndConfirm(tx, allSigners, {
      skipPreflight: false,
    });
  }

  // --- Kamino Lending Methods ---

  async kaminoDeposit(
    params: KaminoDepositParams,
  ): Promise<KaminoComposeResult> {
    return composeKaminoDeposit(this.program, this.provider.connection, params);
  }

  async kaminoBorrow(params: KaminoBorrowParams): Promise<KaminoComposeResult> {
    return composeKaminoBorrow(this.program, this.provider.connection, params);
  }

  async kaminoRepay(params: KaminoRepayParams): Promise<KaminoComposeResult> {
    return composeKaminoRepay(this.program, this.provider.connection, params);
  }

  async kaminoWithdraw(
    params: KaminoWithdrawParams,
  ): Promise<KaminoComposeResult> {
    return composeKaminoWithdraw(
      this.program,
      this.provider.connection,
      params,
    );
  }

  async executeKamino(
    result: KaminoComposeResult,
    agent: PublicKey,
    signers?: Signer[],
  ): Promise<string> {
    const { blockhash } = await this.provider.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: agent,
      recentBlockhash: blockhash,
      instructions: result.instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    const allSigners = [
      ...(result.additionalSigners || []),
      ...(signers || []),
    ];
    if (allSigners.length > 0) {
      tx.sign(allSigners);
    }
    return this.provider.sendAndConfirm(tx, allSigners, {
      skipPreflight: false,
    });
  }

  // --- Dynamic Protocol Execution ---

  /**
   * Execute an action via a registered protocol handler.
   * Dispatches to the handler identified by protocolId in the registry.
   */
  async executeProtocol(
    protocolId: string,
    action: string,
    params: Record<string, unknown>,
    vault: PublicKey,
  ): Promise<string> {
    const handler = this._protocolRegistry.getByProtocolId(protocolId);
    if (!handler) {
      throw new PhalnxSDKError({
        code: -1,
        name: "UnknownProtocol",
        message: `No protocol handler registered for "${protocolId}"`,
      });
    }

    const vaultAccount = await this.fetchVaultByAddress(vault);
    const ctx = {
      program: this.program,
      connection: this.provider.connection,
      vault,
      owner: vaultAccount.owner,
      vaultId: vaultAccount.vaultId,
      agent: this.provider.wallet.publicKey,
    };

    if (handler.initialize) {
      await handler.initialize(this.provider.connection);
    }

    const result = await handler.compose(ctx, action, params);
    const allSigners = result.additionalSigners ?? [];
    const { blockhash } = await this.provider.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: this.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: result.instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    if (allSigners.length > 0) {
      tx.sign(allSigners);
    }
    return this.provider.sendAndConfirm(tx, allSigners, {
      skipPreflight: false,
    });
  }

  // --- Intent Execution (Direct agent path) ---

  /**
   * Estimate USD amount for a spending intent.
   * Returns the amount in USD (human units), or null if amount cannot be estimated
   * (e.g., non-stablecoin swap input — on-chain doesn't cap-check these either).
   */
  private getIntentAmountUsd(intent: IntentAction): number | null {
    const p = intent.params as Record<string, unknown>;
    switch (intent.type) {
      // Stablecoin-denominated amount fields
      case "transfer":
      case "deposit":
      case "createEscrow":
      case "driftDeposit":
      case "kaminoDeposit":
      case "kaminoRepay": {
        const mint = p.mint as string | undefined;
        if (!mint) return null;
        const token = resolveToken(mint);
        if (!token) return null;
        if (!isStablecoinMint(token.mint)) return null;
        const amount = parseFloat(p.amount as string);
        return Number.isFinite(amount) && amount >= 0 ? amount : null;
      }

      // Swap: only estimate if input is stablecoin
      case "swap":
      case "swapAndOpenPosition":
      case "driftSpotOrder": {
        const inputMint = (p.inputMint ?? p.tokenMint) as string | undefined;
        if (!inputMint) return null;
        const token = resolveToken(inputMint);
        if (!token) return null;
        if (!isStablecoinMint(token.mint)) return null;
        const amount = parseFloat(p.amount as string);
        return Number.isFinite(amount) && amount >= 0 ? amount : null;
      }

      // Perps: collateral is USD-denominated
      case "openPosition": {
        const collateral = parseFloat(p.collateral as string);
        return Number.isFinite(collateral) && collateral >= 0
          ? collateral
          : null;
      }
      case "increasePosition":
      case "addCollateral": {
        const collateralAmount = parseFloat(p.collateralAmount as string);
        return Number.isFinite(collateralAmount) && collateralAmount >= 0
          ? collateralAmount
          : null;
      }

      // Limit orders: reserve amount is USD-denominated
      case "placeLimitOrder": {
        const reserveAmount = parseFloat(p.reserveAmount as string);
        return Number.isFinite(reserveAmount) && reserveAmount >= 0
          ? reserveAmount
          : null;
      }

      // Drift perp orders: amount is notional, not directly USD — skip
      case "driftPerpOrder":
      default:
        return null;
    }
  }

  /**
   * Pre-flight policy check: validates an intent against on-chain vault state
   * before submitting a transaction.
   */
  async precheck(
    intent: IntentAction,
    vault: PublicKey,
  ): Promise<PrecheckResult> {
    const agent = this.provider.wallet.publicKey;
    const mapping = ACTION_TYPE_MAP[intent.type];
    if (!mapping) {
      throw new PhalnxSDKError({
        code: -1,
        name: "UnknownActionType",
        message: `Unknown intent action type: ${intent.type}`,
        suggestion: `Supported types: ${Object.keys(ACTION_TYPE_MAP).join(", ")}`,
      });
    }

    // Fetch vault, policy, tracker in parallel
    const [vaultAccount, policyAccount, trackerAccount] = await Promise.all([
      this.fetchVaultByAddress(vault),
      this.fetchPolicy(vault),
      this.fetchTracker(vault),
    ]);

    const riskFlags: string[] = [];

    // Check agent permission
    const agentEntry = vaultAccount.agents.find(
      (a) => a.pubkey.toBase58() === agent.toBase58(),
    );
    const agentPermissions = agentEntry
      ? BigInt(agentEntry.permissions.toString())
      : 0n;
    const baseActionKey = Object.keys(mapping.actionType)[0];
    const permPassed = hasPermission(agentPermissions, baseActionKey);

    // Check spending cap (for spending actions only)
    let capDetails: PrecheckResult["details"]["spendingCap"] | undefined;
    if (mapping.isSpending) {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - NUM_EPOCHS * EPOCH_DURATION;
      let spent24h = 0;
      for (const bucket of trackerAccount.buckets) {
        const epochTime = bucket.epochId.toNumber() * EPOCH_DURATION;
        if (epochTime >= windowStart) {
          spent24h += bucket.usdAmount.toNumber();
        }
      }
      // Convert from micro-USD to USD
      const spent24hUsd = spent24h / 1_000_000;
      const capUsd = policyAccount.dailySpendingCapUsd.toNumber() / 1_000_000;
      const remaining = Math.max(0, capUsd - spent24hUsd);

      const intentAmountUsd = this.getIntentAmountUsd(intent);
      capDetails = {
        passed:
          intentAmountUsd !== null
            ? intentAmountUsd <= remaining
            : remaining > 0,
        spent24h: spent24hUsd,
        cap: capUsd,
        remaining,
        intentAmount: intentAmountUsd ?? undefined,
      };

      if (capUsd > 0) {
        const usagePct = (spent24hUsd / capUsd) * 100;
        if (usagePct > 70) {
          riskFlags.push(`${Math.round(usagePct)}% of daily cap consumed`);
        }
      }
    }

    // Check protocol (simplified — actual protocol depends on routing)
    const protocolPassed =
      policyAccount.protocolMode === 0 || policyAccount.protocols.length > 0;

    // Check slippage (if applicable)
    let slippageDetails: PrecheckResult["details"]["slippage"] | undefined;
    if (
      "slippageBps" in intent.params &&
      intent.params.slippageBps !== undefined
    ) {
      const intentBps = intent.params.slippageBps as number;
      const vaultMaxBps = policyAccount.maxSlippageBps;
      const slipPassed = intentBps <= vaultMaxBps;
      slippageDetails = {
        passed: slipPassed,
        intentBps,
        vaultMaxBps,
      };
      if (intentBps > 200) {
        riskFlags.push(`High slippage tolerance: ${intentBps} BPS`);
      }
    }

    const allPassed =
      permPassed &&
      (capDetails?.passed ?? true) &&
      protocolPassed &&
      (slippageDetails?.passed ?? true);

    const reason = !permPassed
      ? "Agent lacks permission for this action"
      : capDetails && !capDetails.passed
        ? "Spending cap would be exceeded"
        : !protocolPassed
          ? "Protocol not in allowlist"
          : slippageDetails && !slippageDetails.passed
            ? "Slippage exceeds vault maximum"
            : undefined;

    return {
      allowed: allPassed,
      reason,
      details: {
        permission: {
          passed: permPassed,
          requiredBit: baseActionKey,
          agentHas: !!agentEntry,
        },
        spendingCap: capDetails,
        protocol: { passed: protocolPassed, inAllowlist: protocolPassed },
        slippage: slippageDetails,
      },
      summary: summarizeAction(intent),
      riskFlags,
    };
  }

  /**
   * Direct execution path: intent -> precheck -> build -> sign -> send.
   * No propose/approve cycle required.
   */
  async execute(
    intent: IntentAction,
    vault: PublicKey,
    options?: {
      skipPrecheck?: boolean;
      signers?: Signer[];
    },
  ): Promise<ExecuteResult> {
    // 1. Run precheck unless skipped
    let precheckResult: PrecheckResult | undefined;
    if (!options?.skipPrecheck) {
      precheckResult = await this.precheck(intent, vault);
      if (!precheckResult.allowed) {
        throw precheckError({
          check: precheckResult.reason ?? "policy",
          expected: "allowed",
          actual: precheckResult.reason ?? "denied",
          suggestion: precheckResult.reason ?? "Check vault policy",
        });
      }
    }

    // 2. Execute the action
    try {
      const signature = await this._executeAction(
        intent,
        vault,
        options?.signers,
      );
      return {
        signature,
        intent,
        precheck: precheckResult,
        summary: summarizeAction(intent),
      };
    } catch (err) {
      const sdkError = parseOnChainError(err);
      if (sdkError) throw sdkError;
      throw err;
    }
  }

  /**
   * Route an intent action to the correct SDK method.
   * Shared by execute() and executeIntent().
   */
  private async _executeAction(
    intent: IntentAction,
    vault: PublicKey,
    signers?: Signer[],
  ): Promise<string> {
    const vaultAccount = await this.fetchVaultByAddress(vault);
    const agent = this.provider.wallet.publicKey;
    const owner = vaultAccount.owner;
    const vaultId = vaultAccount.vaultId;

    const toSide = (
      s: "long" | "short",
    ): { long: Record<string, never> } | { short: Record<string, never> } =>
      s === "long" ? { long: {} } : { short: {} };

    switch (intent.type) {
      case "swap": {
        const p = intent.params;
        const inputMint =
          resolveToken(p.inputMint)?.mint ?? new PublicKey(p.inputMint);
        const outputMint =
          resolveToken(p.outputMint)?.mint ?? new PublicKey(p.outputMint);
        const inputToken = resolveToken(p.inputMint);
        const amount = inputToken
          ? toBaseUnits(p.amount, inputToken.decimals)
          : new BN(p.amount);
        return this.executeJupiterSwap(
          {
            owner,
            vaultId,
            agent,
            inputMint,
            outputMint,
            amount,
            slippageBps: p.slippageBps ?? 50,
          },
          signers,
        );
      }

      case "transfer": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const { getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");
        const dest = new PublicKey(p.destination);
        const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
        const destAta = getAssociatedTokenAddressSync(mint, dest, true);
        return this.agentTransfer(vault, {
          amount,
          vaultTokenAccount: vaultAta,
          tokenMintAccount: mint,
          destinationTokenAccount: destAta,
        });
      }

      case "deposit": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        return this.jupiterLendDeposit({
          owner,
          vaultId,
          agent,
          tokenMint: mint,
          amount,
        });
      }

      case "withdraw": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        return this.jupiterLendWithdraw({
          owner,
          vaultId,
          agent,
          tokenMint: mint,
          amount,
        });
      }

      case "openPosition": {
        const p = intent.params;
        const result = await this.flashTradeOpen({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          collateralAmount: new BN(p.collateral),
          sizeAmount: new BN(p.collateral),
          side: toSide(p.side),
          priceWithSlippage: { price: new BN("0"), exponent: 0 },
          leverageBps: p.leverage * 10000,
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "closePosition": {
        const p = intent.params;
        const result = await this.flashTradeClose({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          collateralAmount: new BN(0),
          side: { long: {} },
          priceWithSlippage: { price: new BN("0"), exponent: 0 },
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "increasePosition": {
        const p = intent.params;
        throw new Error(
          "increasePosition via intent requires positionPubKey. Use client.flashTradeIncrease() directly.",
        );
      }

      case "decreasePosition": {
        const p = intent.params;
        throw new Error(
          "decreasePosition via intent requires positionPubKey. Use client.flashTradeDecrease() directly.",
        );
      }

      case "addCollateral": {
        const p = intent.params;
        throw new Error(
          "addCollateral via intent requires positionPubKey. Use client.flashTradeAddCollateral() directly.",
        );
      }

      case "removeCollateral": {
        const p = intent.params;
        throw new Error(
          "removeCollateral via intent requires positionPubKey. Use client.flashTradeRemoveCollateral() directly.",
        );
      }

      case "placeTriggerOrder": {
        const p = intent.params;
        const result = await this.flashTradePlaceTriggerOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          receiveSymbol: "USDC",
          side: toSide(p.side),
          triggerPrice: { price: new BN(p.triggerPrice), exponent: 0 },
          deltaSizeAmount: new BN(p.deltaSizeAmount),
          isStopLoss: p.isStopLoss,
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "editTriggerOrder": {
        const p = intent.params;
        const result = await this.flashTradeEditTriggerOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          receiveSymbol: "USDC",
          side: toSide(p.side),
          orderId: parseInt(p.orderId, 10),
          triggerPrice: { price: new BN(p.triggerPrice), exponent: 0 },
          deltaSizeAmount: new BN(p.deltaSizeAmount),
          isStopLoss: p.isStopLoss,
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "cancelTriggerOrder": {
        const p = intent.params;
        const result = await this.flashTradeCancelTriggerOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          side: toSide(p.side),
          orderId: parseInt(p.orderId, 10),
          isStopLoss: p.isStopLoss,
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "placeLimitOrder": {
        const p = intent.params;
        const result = await this.flashTradePlaceLimitOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          reserveSymbol: "USDC",
          receiveSymbol: p.market,
          reserveAmount: new BN(p.reserveAmount),
          sizeAmount: new BN(p.sizeAmount),
          side: toSide(p.side),
          limitPrice: { price: new BN(p.limitPrice), exponent: 0 },
          stopLossPrice: {
            price: new BN(p.stopLossPrice ?? "0"),
            exponent: 0,
          },
          takeProfitPrice: {
            price: new BN(p.takeProfitPrice ?? "0"),
            exponent: 0,
          },
          leverageBps: p.leverageBps ?? 10000,
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "editLimitOrder": {
        const p = intent.params;
        const result = await this.flashTradeEditLimitOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          reserveSymbol: "USDC",
          receiveSymbol: p.market,
          side: toSide(p.side),
          orderId: parseInt(p.orderId, 10),
          limitPrice: { price: new BN(p.limitPrice), exponent: 0 },
          sizeAmount: new BN(p.sizeAmount),
          stopLossPrice: {
            price: new BN(p.stopLossPrice ?? "0"),
            exponent: 0,
          },
          takeProfitPrice: {
            price: new BN(p.takeProfitPrice ?? "0"),
            exponent: 0,
          },
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "cancelLimitOrder": {
        const p = intent.params;
        const result = await this.flashTradeCancelLimitOrder({
          owner,
          vaultId,
          agent,
          targetSymbol: p.market,
          collateralSymbol: p.market,
          orderId: parseInt(p.orderId, 10),
          reserveSymbol: "USDC",
          receiveSymbol: p.market,
          side: toSide(p.side),
        });
        return this.executeFlashTrade(result, agent, signers);
      }

      case "swapAndOpenPosition": {
        throw new Error(
          "swapAndOpenPosition via intent requires pre-built swap instructions. Use client.flashTradeSwapAndOpen() directly.",
        );
      }

      case "closeAndSwapPosition": {
        throw new Error(
          "closeAndSwapPosition via intent requires pre-built swap instructions. Use client.flashTradeCloseAndSwap() directly.",
        );
      }

      case "createEscrow": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = new BN(now + p.expiresInSeconds);
        const conditionHash = p.conditionHash
          ? Array.from(Buffer.from(p.conditionHash, "hex"))
          : Array(32).fill(0);
        const destVault = new PublicKey(p.destinationVault);
        const { getAssociatedTokenAddressSync } =
          await import("@solana/spl-token");
        const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
        const escrowId = new BN(Date.now());

        return this.createEscrow(
          vault,
          destVault,
          escrowId,
          amount,
          expiresAt,
          conditionHash,
          mint,
          vaultAta,
        );
      }

      case "settleEscrow": {
        throw new Error(
          "settleEscrow via intent requires on-chain account addresses. Use client.settleEscrow() directly.",
        );
      }

      case "refundEscrow": {
        throw new Error(
          "refundEscrow via intent requires on-chain account addresses. Use client.refundEscrow() directly.",
        );
      }

      // ─── Drift Protocol ──────────────────────────────────────────────

      case "driftDeposit": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.driftDeposit({
          owner,
          vaultId,
          agent,
          amount,
          marketIndex: p.marketIndex,
          tokenMint: mint,
          subAccountId: p.subAccountId,
        });
        return this.executeDrift(result, agent, signers);
      }

      case "driftWithdraw": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.driftWithdraw({
          owner,
          vaultId,
          agent,
          amount,
          marketIndex: p.marketIndex,
          tokenMint: mint,
          subAccountId: p.subAccountId,
        });
        return this.executeDrift(result, agent, signers);
      }

      case "driftPerpOrder": {
        const p = intent.params;
        const usdcMint =
          resolveToken("USDC")?.mint ??
          new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const result = await this.driftPlacePerpOrder({
          owner,
          vaultId,
          agent,
          marketIndex: p.marketIndex,
          side: p.side,
          amount: new BN(p.amount),
          price: p.price ? new BN(p.price) : undefined,
          orderType: p.orderType,
          tokenMint: usdcMint,
          subAccountId: p.subAccountId,
        });
        return this.executeDrift(result, agent, signers);
      }

      case "driftSpotOrder": {
        const p = intent.params;
        const usdcMint =
          resolveToken("USDC")?.mint ??
          new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const result = await this.driftPlaceSpotOrder({
          owner,
          vaultId,
          agent,
          marketIndex: p.marketIndex,
          side: p.side,
          amount: new BN(p.amount),
          price: p.price ? new BN(p.price) : undefined,
          orderType: p.orderType,
          tokenMint: usdcMint,
        });
        return this.executeDrift(result, agent, signers);
      }

      case "driftCancelOrder": {
        const p = intent.params;
        const usdcMint =
          resolveToken("USDC")?.mint ??
          new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const result = await this.driftCancelOrder({
          owner,
          vaultId,
          agent,
          orderId: p.orderId,
          tokenMint: usdcMint,
          subAccountId: p.subAccountId,
        });
        return this.executeDrift(result, agent, signers);
      }

      // ─── Kamino Lending ──────────────────────────────────────────────

      case "kaminoDeposit": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.kaminoDeposit({
          owner,
          vaultId,
          agent,
          amount,
          tokenMint: mint,
          market: p.market ? new PublicKey(p.market) : undefined,
        });
        return this.executeKamino(result, agent, signers);
      }

      case "kaminoBorrow": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.kaminoBorrow({
          owner,
          vaultId,
          agent,
          amount,
          tokenMint: mint,
          market: p.market ? new PublicKey(p.market) : undefined,
        });
        return this.executeKamino(result, agent, signers);
      }

      case "kaminoRepay": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.kaminoRepay({
          owner,
          vaultId,
          agent,
          amount,
          tokenMint: mint,
          market: p.market ? new PublicKey(p.market) : undefined,
        });
        return this.executeKamino(result, agent, signers);
      }

      case "kaminoWithdraw": {
        const p = intent.params;
        const mint = resolveToken(p.mint)?.mint ?? new PublicKey(p.mint);
        const token = resolveToken(p.mint);
        const amount = token
          ? toBaseUnits(p.amount, token.decimals)
          : new BN(p.amount);
        const result = await this.kaminoWithdraw({
          owner,
          vaultId,
          agent,
          amount,
          tokenMint: mint,
          market: p.market ? new PublicKey(p.market) : undefined,
        });
        return this.executeKamino(result, agent, signers);
      }

      // ─── Generic Protocol (registry-based dispatch) ──────────────────

      case "protocol": {
        const p = intent.params;
        return this.executeProtocol(p.protocolId, p.action, p, vault);
      }

      default: {
        const _exhaustive: never = intent;
        throw new Error(
          `Unhandled intent type: ${(intent as IntentAction).type}`,
        );
      }
    }
  }

  // --- IntentEngine (Agent-first facade) ---

  /**
   * Lazy-initialized IntentEngine for agent-first workflows.
   * Provides validate → precheck → execute pipeline with structured errors.
   */
  get intents(): import("./intent-engine").IntentEngine {
    if (!this._intentsEngine) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { IntentEngine } =
        require("./intent-engine") as typeof import("./intent-engine");
      this._intentsEngine = new IntentEngine(this);
    }
    return this._intentsEngine;
  }

  // --- Intents (Human-in-the-loop proposal flow) ---

  getIntentStorage(): IntentStorage {
    if (!this._intentStorage) {
      this._intentStorage = new MemoryIntentStorage();
    }
    return this._intentStorage;
  }

  async proposeSwap(params: {
    vault: PublicKey;
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
  }): Promise<TransactionIntent> {
    const agent = this.provider.wallet.publicKey;
    const intent = createIntent(
      {
        type: "swap",
        params: {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          amount: params.amount,
          slippageBps: params.slippageBps,
        },
      },
      params.vault,
      agent,
    );
    await this.getIntentStorage().save(intent);
    return intent;
  }

  async proposeOpenPosition(params: {
    vault: PublicKey;
    market: string;
    side: "long" | "short";
    collateral: string;
    leverage: number;
  }): Promise<TransactionIntent> {
    const agent = this.provider.wallet.publicKey;
    const intent = createIntent(
      {
        type: "openPosition",
        params: {
          market: params.market,
          side: params.side,
          collateral: params.collateral,
          leverage: params.leverage,
        },
      },
      params.vault,
      agent,
    );
    await this.getIntentStorage().save(intent);
    return intent;
  }

  async proposeTransfer(params: {
    vault: PublicKey;
    destination: string;
    mint: string;
    amount: string;
  }): Promise<TransactionIntent> {
    const agent = this.provider.wallet.publicKey;
    const intent = createIntent(
      {
        type: "transfer",
        params: {
          destination: params.destination,
          mint: params.mint,
          amount: params.amount,
        },
      },
      params.vault,
      agent,
    );
    await this.getIntentStorage().save(intent);
    return intent;
  }

  async proposeDeposit(params: {
    vault: PublicKey;
    mint: string;
    amount: string;
  }): Promise<TransactionIntent> {
    const agent = this.provider.wallet.publicKey;
    const intent = createIntent(
      { type: "deposit", params: { mint: params.mint, amount: params.amount } },
      params.vault,
      agent,
    );
    await this.getIntentStorage().save(intent);
    return intent;
  }

  async approveIntent(intentId: string): Promise<void> {
    const storage = this.getIntentStorage();
    await storage.update(intentId, {
      status: "approved",
      updatedAt: Date.now(),
    });
  }

  async rejectIntent(intentId: string): Promise<void> {
    const storage = this.getIntentStorage();
    await storage.update(intentId, {
      status: "rejected",
      updatedAt: Date.now(),
    });
  }

  async executeIntent(_intentId: string): Promise<string> {
    const storage = this.getIntentStorage();
    const intent = await storage.get(_intentId);
    if (!intent) throw new Error(`Intent not found: ${_intentId}`);
    if (intent.status !== "approved") {
      throw new Error(
        `Intent must be approved before execution. Current status: ${intent.status}`,
      );
    }

    await storage.update(_intentId, {
      status: "executed",
      updatedAt: Date.now(),
    });

    try {
      return await this._executeAction(intent.action, intent.vault);
    } catch (err: any) {
      await storage.update(_intentId, {
        status: "failed",
        updatedAt: Date.now(),
        error: err.message ?? String(err),
      });
      throw err;
    }
  }

  async listIntents(filter?: {
    status?: import("./intents").IntentStatus;
    vault?: PublicKey;
  }): Promise<TransactionIntent[]> {
    return this.getIntentStorage().list(filter);
  }

  async getIntent(id: string): Promise<TransactionIntent | null> {
    return this.getIntentStorage().get(id);
  }

  // --- Fee Management Helpers ---

  /** Check an agent's SOL balance (for monitoring/top-up decisions) */
  async getAgentBalance(agent: PublicKey): Promise<number> {
    return this.provider.connection.getBalance(agent);
  }

  /** Fund an agent with SOL from the current wallet (owner) */
  async fundAgent(agent: PublicKey, lamports: number): Promise<string> {
    const ix = SystemProgram.transfer({
      fromPubkey: this.provider.wallet.publicKey,
      toPubkey: agent,
      lamports,
    });
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: this.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = await this.provider.wallet.signTransaction(tx);
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }

  /** Fund a vault PDA with SOL (for fee refund reserves) */
  async fundVaultSol(vault: PublicKey, lamports: number): Promise<string> {
    const ix = SystemProgram.transfer({
      fromPubkey: this.provider.wallet.publicKey,
      toPubkey: vault,
      lamports,
    });
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: this.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const signed = await this.provider.wallet.signTransaction(tx);
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return sig;
  }
}
