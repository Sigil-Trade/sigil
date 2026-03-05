import {
  PublicKey,
  Connection,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Signer,
  Keypair,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { FEE_RATE_DENOMINATOR, PROTOCOL_FEE_RATE } from "./types";
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
}

export class PhalnxClient {
  readonly program: Program<Phalnx>;
  readonly provider: AnchorProvider;
  private readonly requireDestinations: boolean;
  private readonly priorityFeeConfig:
    | import("./priority-fees").PriorityFeeConfig
    | false;

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
      if (opts.jupiterApiConfig) {
        configureJupiterApi(opts.jupiterApiConfig);
      }
    } else {
      programId = programIdOrOptions as PublicKey | undefined;
      resolvedIdl = idl ?? PhalnxIDL;
      this.requireDestinations = false;
      this.priorityFeeConfig = {};
    }

    if (programId) {
      resolvedIdl.address = programId.toBase58();
    }
    this.program = new Program<Phalnx>(resolvedIdl, this.provider) as any;
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
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildRegisterAgent(
      this.program,
      owner,
      vault,
      agent,
      permissions,
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

  async updateAgentPermissions(
    vault: PublicKey,
    agent: PublicKey,
    newPermissions: BN,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildUpdateAgentPermissions(
      this.program,
      owner,
      vault,
      agent,
      newPermissions,
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
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);

    if (signers && signers.length > 0) {
      tx.sign(signers);
    }

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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return sig;
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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return sig;
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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return sig;
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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return sig;
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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    const result = await this.provider.connection.getLatestBlockhash();
    await this.provider.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
      },
      "confirmed",
    );
    return sig;
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
    const sig = await this.provider.connection.sendRawTransaction(
      signed.serialize(),
    );
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash();
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return sig;
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
}
