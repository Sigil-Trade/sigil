import {
  PublicKey,
  Connection,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Signer,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { FEE_RATE_DENOMINATOR, PROTOCOL_FEE_RATE } from "./types";
import type {
  AgentShield,
  AgentVaultAccount,
  PolicyConfigAccount,
  SpendTrackerAccount,
  PendingPolicyUpdateAccount,
  OracleRegistryAccount,
  InitializeVaultParams,
  UpdatePolicyParams,
  QueuePolicyUpdateParams,
  AgentTransferParams,
  AuthorizeParams,
  ComposeActionParams,
  InitializeOracleRegistryParams,
  UpdateOracleRegistryParams,
} from "./types";
import {
  getVaultPDA,
  getPolicyPDA,
  getTrackerPDA,
  getSessionPDA,
  getPendingPolicyPDA,
  getOracleRegistryPDA,
  fetchVault,
  fetchPolicy,
  fetchTracker,
  fetchVaultByAddress,
  fetchPolicyByAddress,
  fetchTrackerByAddress,
  fetchPendingPolicy,
  fetchOracleRegistry,
} from "./accounts";
import {
  buildInitializeOracleRegistry,
  buildUpdateOracleRegistry,
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
  createFlashTradeClient as _createFlashTradeClient,
  getPoolConfig,
  composeFlashTradeOpen,
  composeFlashTradeClose,
  composeFlashTradeIncrease,
  composeFlashTradeDecrease,
  composeFlashTradeTransaction,
  type FlashTradeConfig,
  type FlashOpenPositionParams,
  type FlashClosePositionParams,
  type FlashIncreasePositionParams,
  type FlashDecreasePositionParams,
  type FlashTradeResult,
} from "./integrations/flash-trade";
import { PerpetualsClient, PoolConfig } from "flash-sdk";
import { IDL as AgentShieldIDL } from "./idl-json";

export interface AgentShieldClientOptions {
  programId?: PublicKey;
  idl?: any;
  /** When true, createVault() throws if allowedDestinations is empty */
  requireDestinations?: boolean;
}

export class AgentShieldClient {
  readonly program: Program<AgentShield>;
  readonly provider: AnchorProvider;
  private readonly requireDestinations: boolean;

  constructor(
    connection: Connection,
    wallet: Wallet,
    programIdOrOptions?: PublicKey | AgentShieldClientOptions,
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
      const opts = programIdOrOptions as AgentShieldClientOptions;
      programId = opts.programId;
      resolvedIdl = opts.idl ?? AgentShieldIDL;
      this.requireDestinations = opts.requireDestinations ?? false;
    } else {
      programId = programIdOrOptions as PublicKey | undefined;
      resolvedIdl = idl ?? AgentShieldIDL;
      this.requireDestinations = false;
    }

    if (programId) {
      resolvedIdl.address = programId.toBase58();
    }
    this.program = new Program<AgentShield>(resolvedIdl, this.provider) as any;
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

  getOracleRegistryPDA(): [PublicKey, number] {
    return getOracleRegistryPDA(this.program.programId);
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

  async fetchOracleRegistry(): Promise<OracleRegistryAccount> {
    return fetchOracleRegistry(this.program);
  }

  // --- Oracle Registry ---

  async initializeOracleRegistry(
    params: InitializeOracleRegistryParams,
  ): Promise<string> {
    const authority = this.provider.wallet.publicKey;
    return buildInitializeOracleRegistry(this.program, authority, params).rpc();
  }

  async updateOracleRegistry(
    params: UpdateOracleRegistryParams,
  ): Promise<string> {
    const authority = this.provider.wallet.publicKey;
    return buildUpdateOracleRegistry(this.program, authority, params).rpc();
  }

  // --- Instruction Execution (sends + confirms) ---

  async createVault(params: InitializeVaultParams): Promise<string> {
    const hasDestinations =
      params.allowedDestinations && params.allowedDestinations.length > 0;

    if (!hasDestinations) {
      if (this.requireDestinations) {
        throw new Error(
          "AgentShield: allowedDestinations is empty but requireDestinations is enabled. " +
            "Pass allowedDestinations to restrict agent transfer targets.",
        );
      }
      console.warn(
        "\u26A0 AgentShield: Vault created with empty allowedDestinations \u2014 " +
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

  async registerAgent(vault: PublicKey, agent: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildRegisterAgent(this.program, owner, vault, agent).rpc();
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
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildValidateAndAuthorize(
      this.program,
      agent,
      vault,
      vaultTokenAccount,
      params,
    ).rpc();
  }

  async finalizeSession(
    vault: PublicKey,
    agent: PublicKey,
    tokenMint: PublicKey,
    success: boolean,
    vaultTokenAccount: PublicKey,
    feeDestinationTokenAccount?: PublicKey | null,
    protocolTreasuryTokenAccount?: PublicKey | null,
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
      feeDestinationTokenAccount,
      protocolTreasuryTokenAccount,
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

  async revokeAgent(vault: PublicKey): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildRevokeAgent(this.program, owner, vault).rpc();
  }

  async reactivateVault(
    vault: PublicKey,
    newAgent?: PublicKey | null,
  ): Promise<string> {
    const owner = this.provider.wallet.publicKey;
    return buildReactivateVault(this.program, owner, vault, newAgent).rpc();
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
    oracleFeedAccount?: PublicKey,
  ): Promise<string> {
    const agent = this.provider.wallet.publicKey;
    return buildAgentTransfer(
      this.program,
      agent,
      vault,
      params,
      oracleFeedAccount,
    ).rpc();
  }

  // --- Composition ---

  async composePermittedAction(
    params: ComposeActionParams,
    computeUnits?: number,
  ): Promise<TransactionInstruction[]> {
    return composePermittedAction(this.program, params, computeUnits);
  }

  async composePermittedTransaction(
    params: ComposeActionParams,
    computeUnits?: number,
  ): Promise<VersionedTransaction> {
    return composePermittedTransaction(
      this.program,
      this.provider.connection,
      params,
      computeUnits,
    );
  }

  async composePermittedSwap(
    params: Omit<ComposeActionParams, "actionType">,
    computeUnits?: number,
  ): Promise<TransactionInstruction[]> {
    return composePermittedSwap(this.program, params, computeUnits);
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
    const tx = await wrapTransaction(
      this.program,
      this.provider.connection,
      params,
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
   * Build an unsigned VersionedTransaction for a Jupiter swap through AgentShield.
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
   * Compose a Flash Trade open position through AgentShield.
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
   * Compose a Flash Trade close position through AgentShield.
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
   * Compose a Flash Trade increase position through AgentShield.
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
   * Compose a Flash Trade decrease position through AgentShield.
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
}
