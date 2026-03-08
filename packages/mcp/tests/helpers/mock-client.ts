import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  AgentVaultAccount,
  AgentEntry,
  PolicyConfigAccount,
  PendingPolicyUpdateAccount,
  SpendTrackerAccount,
  VaultStatus,
  EpochBucket,
  EscrowDepositAccount,
  EscrowStatus,
  InstructionConstraintsAccount,
  PendingConstraintsUpdateAccount,
} from "@phalnx/sdk";

// Re-usable test fixtures
export const TEST_OWNER = Keypair.generate();
export const TEST_AGENT = Keypair.generate();
export const TEST_VAULT_PDA = Keypair.generate().publicKey;
export const TEST_FEE_DEST = Keypair.generate().publicKey;
export const TEST_MINT = Keypair.generate().publicKey;
export const TEST_PROTOCOL = Keypair.generate().publicKey;

/**
 * Create a mock McpConfig with a real temporary keypair file.
 * Call `cleanup()` in afterEach to remove the temp file.
 */
export function createMockConfig(): {
  walletPath: string;
  rpcUrl: string;
  cleanup: () => void;
} {
  const kp = Keypair.generate();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phalnx-test-"));
  const tmpPath = path.join(tmpDir, "keypair.json");
  fs.writeFileSync(tmpPath, JSON.stringify(Array.from(kp.secretKey)), {
    mode: 0o600,
  });
  return {
    walletPath: tmpPath,
    rpcUrl: "https://mock.rpc",
    cleanup: () => {
      try {
        fs.unlinkSync(tmpPath);
        fs.rmdirSync(tmpDir);
      } catch {}
    },
  };
}

export function makeVaultAccount(
  overrides: Partial<AgentVaultAccount> = {},
): AgentVaultAccount {
  return {
    owner: TEST_OWNER.publicKey,
    agents: [
      {
        pubkey: TEST_AGENT.publicKey,
        permissions: new BN(2097151),
        spendingLimitUsd: new BN(0),
      },
    ] as AgentEntry[],
    feeDestination: TEST_FEE_DEST,
    vaultId: new BN(1),
    status: { active: {} } as VaultStatus,
    bump: 255,
    createdAt: new BN(1700000000),
    totalTransactions: new BN(42),
    totalVolume: new BN("1000000000"),
    openPositions: 0,
    totalFeesCollected: new BN(5000),
    treasuryShard: 0,
    ...overrides,
  };
}

export function makePolicyAccount(
  overrides: Partial<PolicyConfigAccount> = {},
): PolicyConfigAccount {
  return {
    vault: TEST_VAULT_PDA,
    dailySpendingCapUsd: new BN("10000000000"),
    maxTransactionSizeUsd: new BN("1000000000"),
    protocolMode: 1,
    protocols: [TEST_PROTOCOL],
    maxLeverageBps: 30000,
    canOpenPositions: true,
    maxConcurrentPositions: 5,
    developerFeeRate: 10,
    timelockDuration: new BN(0),
    allowedDestinations: [],
    maxSlippageBps: 100,
    hasConstraints: false,
    hasProtocolCaps: false,
    protocolCaps: [],
    sessionExpirySlots: new BN(20),
    bump: 254,
    ...overrides,
  };
}

export function makeEpochBucket(
  overrides: Partial<EpochBucket> = {},
): EpochBucket {
  return {
    epochId: new BN(100),
    usdAmount: new BN("500000000"),
    ...overrides,
  };
}

export function makeTrackerAccount(
  overrides: Partial<SpendTrackerAccount> = {},
): SpendTrackerAccount {
  return {
    vault: TEST_VAULT_PDA,
    buckets: [makeEpochBucket()],
    bump: 253,
    ...overrides,
  };
}

export function makePendingPolicyAccount(
  overrides: Partial<PendingPolicyUpdateAccount> = {},
): PendingPolicyUpdateAccount {
  return {
    vault: TEST_VAULT_PDA,
    queuedAt: new BN(1700000000),
    executesAt: new BN(1700003600),
    dailySpendingCapUsd: null,
    maxTransactionAmountUsd: null,
    protocolMode: null,
    protocols: null,
    maxLeverageBps: null,
    canOpenPositions: null,
    maxConcurrentPositions: null,
    developerFeeRate: null,
    timelockDuration: null,
    allowedDestinations: null,
    bump: 252,
    ...overrides,
  };
}

export interface CallRecord {
  method: string;
  args: any[];
}

/**
 * Mock PhalnxClient that records method calls and returns canned data.
 * Cast to `any` when passing to tool handlers to bypass type checks.
 */
export function createMockClient(
  overrides: {
    vault?: Partial<AgentVaultAccount>;
    policy?: Partial<PolicyConfigAccount>;
    tracker?: Partial<SpendTrackerAccount>;
    pendingPolicy?: PendingPolicyUpdateAccount | null;
    shouldThrow?: Error;
  } = {},
) {
  const calls: CallRecord[] = [];
  const vaultData = makeVaultAccount(overrides.vault);
  const policyData = makePolicyAccount(overrides.policy);
  const trackerData = makeTrackerAccount(overrides.tracker);

  const mock = {
    calls,

    provider: {
      wallet: {
        publicKey: TEST_OWNER.publicKey,
      },
    },

    getVaultPDA(owner: PublicKey, vaultId: BN): [PublicKey, number] {
      calls.push({ method: "getVaultPDA", args: [owner, vaultId] });
      return [TEST_VAULT_PDA, 255];
    },

    getPolicyPDA(vault: PublicKey): [PublicKey, number] {
      calls.push({ method: "getPolicyPDA", args: [vault] });
      return [Keypair.generate().publicKey, 254];
    },

    getTrackerPDA(vault: PublicKey): [PublicKey, number] {
      calls.push({ method: "getTrackerPDA", args: [vault] });
      return [Keypair.generate().publicKey, 253];
    },

    getSessionPDA(
      vault: PublicKey,
      agent: PublicKey,
      tokenMint: PublicKey,
    ): [PublicKey, number] {
      calls.push({ method: "getSessionPDA", args: [vault, agent, tokenMint] });
      return [Keypair.generate().publicKey, 252];
    },

    async fetchVault(owner: PublicKey, vaultId: BN) {
      calls.push({ method: "fetchVault", args: [owner, vaultId] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return vaultData;
    },

    async fetchVaultByAddress(address: PublicKey) {
      calls.push({ method: "fetchVaultByAddress", args: [address] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return vaultData;
    },

    async fetchPolicy(vault: PublicKey) {
      calls.push({ method: "fetchPolicy", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return policyData;
    },

    async fetchPolicyByAddress(address: PublicKey) {
      calls.push({ method: "fetchPolicyByAddress", args: [address] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return policyData;
    },

    async fetchTracker(vault: PublicKey) {
      calls.push({ method: "fetchTracker", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return trackerData;
    },

    async fetchTrackerByAddress(address: PublicKey) {
      calls.push({ method: "fetchTrackerByAddress", args: [address] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return trackerData;
    },

    async createVault(params: any) {
      calls.push({ method: "createVault", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-create";
    },

    async deposit(vault: PublicKey, mint: PublicKey, amount: BN) {
      calls.push({ method: "deposit", args: [vault, mint, amount] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-deposit";
    },

    async withdraw(vault: PublicKey, mint: PublicKey, amount: BN) {
      calls.push({ method: "withdraw", args: [vault, mint, amount] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-withdraw";
    },

    async registerAgent(
      vault: PublicKey,
      agent: PublicKey,
      permissions: BN,
      spendingLimitUsd: BN = new BN(0),
    ) {
      calls.push({
        method: "registerAgent",
        args: [vault, agent, permissions, spendingLimitUsd],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-register";
    },

    async updatePolicy(vault: PublicKey, params: any) {
      calls.push({ method: "updatePolicy", args: [vault, params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-update";
    },

    async revokeAgent(vault: PublicKey, agentToRemove: PublicKey) {
      calls.push({ method: "revokeAgent", args: [vault, agentToRemove] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-revoke";
    },

    async reactivateVault(
      vault: PublicKey,
      newAgent?: PublicKey,
      newAgentPermissions?: BN,
    ) {
      calls.push({
        method: "reactivateVault",
        args: [vault, newAgent, newAgentPermissions],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-reactivate";
    },

    async updateAgentPermissions(
      vault: PublicKey,
      agent: PublicKey,
      newPermissions: BN,
    ) {
      calls.push({
        method: "updateAgentPermissions",
        args: [vault, agent, newPermissions],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-update-perms";
    },

    async authorizeAction(vault: PublicKey, params: any) {
      calls.push({ method: "authorizeAction", args: [vault, params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-authorize";
    },

    async finalizeSession(
      vault: PublicKey,
      agent: PublicKey,
      success: boolean,
      ...rest: any[]
    ) {
      calls.push({
        method: "finalizeSession",
        args: [vault, agent, success, ...rest],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-finalize";
    },

    async closeVault(vault: PublicKey) {
      calls.push({ method: "closeVault", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-close";
    },

    async fetchPendingPolicy(vault: PublicKey) {
      calls.push({ method: "fetchPendingPolicy", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return overrides.pendingPolicy ?? null;
    },

    async queuePolicyUpdate(vault: PublicKey, params: any) {
      calls.push({ method: "queuePolicyUpdate", args: [vault, params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-queue";
    },

    async applyPendingPolicy(vault: PublicKey) {
      calls.push({ method: "applyPendingPolicy", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-apply";
    },

    async cancelPendingPolicy(vault: PublicKey) {
      calls.push({ method: "cancelPendingPolicy", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-cancel";
    },

    async agentTransfer(
      vault: PublicKey,
      params: any,
      oracleFeedAccount?: PublicKey,
    ) {
      calls.push({
        method: "agentTransfer",
        args: [vault, params, oracleFeedAccount],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-transfer";
    },

    async composePermittedAction(params: any, computeUnits?: number) {
      calls.push({
        method: "composePermittedAction",
        args: [params, computeUnits],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [];
    },

    async composePermittedTransaction(params: any, computeUnits?: number) {
      calls.push({
        method: "composePermittedTransaction",
        args: [params, computeUnits],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {} as any;
    },

    async composePermittedSwap(params: any, computeUnits?: number) {
      calls.push({
        method: "composePermittedSwap",
        args: [params, computeUnits],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [];
    },

    async composeAndSend(params: any, signers?: any[], computeUnits?: number) {
      calls.push({
        method: "composeAndSend",
        args: [params, signers, computeUnits],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-compose-send";
    },

    async getJupiterQuote(params: any) {
      calls.push({ method: "getJupiterQuote", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        inputMint: params.inputMint.toBase58(),
        outputMint: params.outputMint.toBase58(),
        inAmount: params.amount.toString(),
        outAmount: "99000000",
        otherAmountThreshold: "98000000",
        swapMode: "ExactIn",
        slippageBps: params.slippageBps,
        routePlan: [],
      };
    },

    async jupiterSwap(params: any) {
      calls.push({ method: "jupiterSwap", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {} as any;
    },

    async executeJupiterSwap(params: any, signers?: any[]) {
      calls.push({
        method: "executeJupiterSwap",
        args: [params, signers],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-swap";
    },

    async flashTradeOpen(params: any) {
      calls.push({ method: "flashTradeOpen", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        instructions: [],
        additionalSigners: [],
      };
    },

    async flashTradeClose(params: any) {
      calls.push({ method: "flashTradeClose", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        instructions: [],
        additionalSigners: [],
      };
    },

    createFlashTradeClient(config?: any) {
      calls.push({ method: "createFlashTradeClient", args: [config] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {} as any;
    },

    getFlashPoolConfig(poolName?: string, cluster?: string) {
      calls.push({
        method: "getFlashPoolConfig",
        args: [poolName, cluster],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {} as any;
    },

    async flashTradeIncrease(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeIncrease",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeDecrease(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeDecrease",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeAddCollateral(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeAddCollateral",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeRemoveCollateral(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeRemoveCollateral",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradePlaceTriggerOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradePlaceTriggerOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeEditTriggerOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeEditTriggerOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeCancelTriggerOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeCancelTriggerOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradePlaceLimitOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradePlaceLimitOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeEditLimitOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeEditLimitOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeCancelLimitOrder(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeCancelLimitOrder",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeSwapAndOpen(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeSwapAndOpen",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async flashTradeCloseAndSwap(params: any, poolConfig?: any) {
      calls.push({
        method: "flashTradeCloseAndSwap",
        args: [params, poolConfig],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { instructions: [], additionalSigners: [] };
    },

    async syncPositions(
      owner: PublicKey,
      vault: PublicKey,
      poolCustodyPairs: any[],
      flashProgramId: PublicKey,
    ) {
      calls.push({
        method: "syncPositions",
        args: [owner, vault, poolCustodyPairs, flashProgramId],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-sync";
    },

    async executeFlashTrade(result: any, agent: PublicKey, signers?: any[]) {
      calls.push({
        method: "executeFlashTrade",
        args: [result, agent, signers],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-flash";
    },

    // --- Jupiter Price API ---

    async getTokenPrices(mints: string[]) {
      calls.push({ method: "getTokenPrices", args: [mints] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      const data: Record<string, any> = {};
      for (const mint of mints) {
        data[mint] = { id: mint, type: "derivedPrice", price: "1.50" };
      }
      return { data, timeTaken: 42 };
    },

    async getTokenPriceUsd(mint: string) {
      calls.push({ method: "getTokenPriceUsd", args: [mint] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return 1.5;
    },

    // --- Jupiter Token API ---

    async searchTokens(query: string, limit?: number) {
      calls.push({ method: "searchTokens", args: [query, limit] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [
        {
          address: "So11111111111111111111111111111111111111112",
          name: "Wrapped SOL",
          symbol: "SOL",
          decimals: 9,
          dailyVolume: 500000000,
          isSus: false,
        },
      ];
    },

    async getTrendingTokens(interval?: string) {
      calls.push({ method: "getTrendingTokens", args: [interval] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [
        {
          address: "So11111111111111111111111111111111111111112",
          name: "Wrapped SOL",
          symbol: "SOL",
          decimals: 9,
          dailyVolume: 500000000,
        },
      ];
    },

    // --- Jupiter Lend/Earn ---

    async getJupiterLendTokens() {
      calls.push({ method: "getJupiterLendTokens", args: [] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [
        {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
          apy: 0.085,
          totalDeposited: "15000000000000",
          totalBorrowed: "8000000000000",
          utilizationRate: 0.533,
        },
      ];
    },

    async getJupiterEarnPositions(user: string, positions: string[]) {
      calls.push({
        method: "getJupiterEarnPositions",
        args: [user, positions],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [];
    },

    async jupiterLendDeposit(params: any) {
      calls.push({ method: "jupiterLendDeposit", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-lend-deposit";
    },

    async jupiterLendWithdraw(params: any) {
      calls.push({ method: "jupiterLendWithdraw", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-lend-withdraw";
    },

    // --- Jupiter Trigger Orders ---

    async createJupiterTriggerOrder(params: any) {
      calls.push({ method: "createJupiterTriggerOrder", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { serializedTransaction: "mock-serialized-trigger-create-tx" };
    },

    async getJupiterTriggerOrders(authority: string, state?: string) {
      calls.push({
        method: "getJupiterTriggerOrders",
        args: [authority, state],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [
        {
          orderId: "mock-order-1",
          maker: authority,
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          makingAmount: "100000000",
          takingAmount: "5000000000",
          remainingMakingAmount: "100000000",
          remainingTakingAmount: "5000000000",
          state: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
    },

    async cancelJupiterTriggerOrder(
      orderId: string,
      feePayer: string,
      signer: string,
    ) {
      calls.push({
        method: "cancelJupiterTriggerOrder",
        args: [orderId, feePayer, signer],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { serializedTransaction: "mock-serialized-trigger-cancel-tx" };
    },

    // --- Jupiter Recurring/DCA ---

    async createJupiterRecurringOrder(params: any) {
      calls.push({ method: "createJupiterRecurringOrder", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { transaction: "mock-serialized-recurring-create-tx" };
    },

    async getJupiterRecurringOrders(user: string) {
      calls.push({ method: "getJupiterRecurringOrders", args: [user] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return [
        {
          orderId: "mock-recurring-1",
          maker: user,
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          inAmount: "1000000000",
          inDeposited: "500000000",
          inWithdrawn: "0",
          outWithdrawn: "2500000000",
          numberOfOrders: 10,
          numberOfOrdersFilled: 5,
          intervalSeconds: 86400,
          state: "active",
          createdAt: "2026-01-01T00:00:00Z",
          nextExecutionAt: "2026-01-06T00:00:00Z",
        },
      ];
    },

    async cancelJupiterRecurringOrder(
      orderId: string,
      feePayer: string,
      signer: string,
    ) {
      calls.push({
        method: "cancelJupiterRecurringOrder",
        args: [orderId, feePayer, signer],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return { transaction: "mock-serialized-recurring-cancel-tx" };
    },

    // --- Jupiter Portfolio ---

    async getJupiterPortfolio(wallet: string) {
      calls.push({ method: "getJupiterPortfolio", args: [wallet] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        wallet,
        totalValue: 12500.5,
        positions: [
          {
            platform: "jupiter-lend",
            platformName: "Jupiter Lend",
            elementType: "borrowlend",
            value: 5000,
            tokens: [
              {
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                symbol: "USDC",
                amount: 5000,
                value: 5000,
              },
            ],
          },
        ],
      };
    },

    // --- Squads V4 Multisig Governance ---

    async squadsCreateMultisig(_member: any, params: any) {
      calls.push({ method: "squadsCreateMultisig", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        signature: "mock-sig-squads-create",
        multisigPda: Keypair.generate().publicKey,
        vaultPda: Keypair.generate().publicKey,
      };
    },

    async squadsProposeVaultAction(_member: any, params: any) {
      calls.push({ method: "squadsProposeVaultAction", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        signature: "mock-sig-squads-propose",
        transactionIndex: 1n,
      };
    },

    async squadsApproveProposal(_member: any, params: any) {
      calls.push({ method: "squadsApproveProposal", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-squads-approve";
    },

    async squadsRejectProposal(_member: any, params: any) {
      calls.push({ method: "squadsRejectProposal", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-squads-reject";
    },

    async squadsExecuteTransaction(_member: any, params: any) {
      calls.push({ method: "squadsExecuteTransaction", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-squads-execute";
    },

    async squadsFetchMultisigInfo(multisigPda: any) {
      calls.push({ method: "squadsFetchMultisigInfo", args: [multisigPda] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        address: multisigPda,
        threshold: 2,
        memberCount: 3,
        members: [
          {
            key: TEST_OWNER.publicKey,
            permissions: { initiate: true, vote: true, execute: true },
          },
          {
            key: TEST_AGENT.publicKey,
            permissions: { initiate: false, vote: true, execute: false },
          },
          {
            key: Keypair.generate().publicKey,
            permissions: { initiate: true, vote: true, execute: true },
          },
        ],
        transactionIndex: 5n,
        timeLock: 0,
        vaultPda: Keypair.generate().publicKey,
      };
    },

    async squadsFetchProposalInfo(multisigPda: any, transactionIndex: any) {
      calls.push({
        method: "squadsFetchProposalInfo",
        args: [multisigPda, transactionIndex],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        address: Keypair.generate().publicKey,
        multisig: multisigPda,
        transactionIndex: BigInt(transactionIndex?.toString?.() ?? "1"),
        status: "Active",
        statusTimestamp: 1700000000n,
        approvals: [TEST_OWNER.publicKey],
        rejections: [],
        cancellations: [],
      };
    },

    async squadsProposeAction(_member: any, params: any) {
      calls.push({ method: "squadsProposeAction", args: [params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        signature: "mock-sig-squads-propose-action",
        transactionIndex: 1n,
      };
    },

    // --- Escrow Operations ---

    async createEscrow(...args: any[]) {
      calls.push({ method: "createEscrow", args });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-create-escrow";
    },

    async settleEscrow(...args: any[]) {
      calls.push({ method: "settleEscrow", args });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-settle-escrow";
    },

    async refundEscrow(...args: any[]) {
      calls.push({ method: "refundEscrow", args });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-refund-escrow";
    },

    async closeSettledEscrow(...args: any[]) {
      calls.push({ method: "closeSettledEscrow", args });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-close-escrow";
    },

    async fetchEscrow(
      sourceVault: PublicKey,
      destinationVault: PublicKey,
      escrowId: BN,
    ) {
      calls.push({
        method: "fetchEscrow",
        args: [sourceVault, destinationVault, escrowId],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return {
        sourceVault,
        destinationVault,
        escrowId,
        amount: new BN(1000000),
        tokenMint: TEST_MINT,
        createdAt: new BN(1700000000),
        expiresAt: new BN(1700086400),
        status: { active: {} } as EscrowStatus,
        conditionHash: new Array(32).fill(0),
        bump: 251,
      } as EscrowDepositAccount;
    },

    // --- Instruction Constraints ---

    async createInstructionConstraints(vault: PublicKey, entries: any[]) {
      calls.push({
        method: "createInstructionConstraints",
        args: [vault, entries],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-create-constraints";
    },

    async closeInstructionConstraints(vault: PublicKey) {
      calls.push({ method: "closeInstructionConstraints", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-close-constraints";
    },

    async updateInstructionConstraints(vault: PublicKey, entries: any[]) {
      calls.push({
        method: "updateInstructionConstraints",
        args: [vault, entries],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-update-constraints";
    },

    async queueConstraintsUpdate(vault: PublicKey, entries: any[]) {
      calls.push({
        method: "queueConstraintsUpdate",
        args: [vault, entries],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-queue-constraints";
    },

    async applyConstraintsUpdate(vault: PublicKey) {
      calls.push({ method: "applyConstraintsUpdate", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-apply-constraints";
    },

    async cancelConstraintsUpdate(vault: PublicKey) {
      calls.push({ method: "cancelConstraintsUpdate", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-cancel-constraints";
    },

    async fetchConstraints(vault: PublicKey) {
      calls.push({ method: "fetchConstraints", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return null as InstructionConstraintsAccount | null;
    },

    async fetchPendingConstraints(vault: PublicKey) {
      calls.push({ method: "fetchPendingConstraints", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return null as PendingConstraintsUpdateAccount | null;
    },
  };

  return mock;
}
