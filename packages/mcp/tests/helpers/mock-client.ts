import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import type {
  AgentVaultAccount,
  PolicyConfigAccount,
  PendingPolicyUpdateAccount,
  SpendTrackerAccount,
  VaultStatus,
  EpochBucket,
} from "@agent-shield/sdk";

// Re-usable test fixtures
export const TEST_OWNER = Keypair.generate();
export const TEST_AGENT = Keypair.generate();
export const TEST_VAULT_PDA = Keypair.generate().publicKey;
export const TEST_FEE_DEST = Keypair.generate().publicKey;
export const TEST_MINT = Keypair.generate().publicKey;
export const TEST_PROTOCOL = Keypair.generate().publicKey;

export function makeVaultAccount(
  overrides: Partial<AgentVaultAccount> = {},
): AgentVaultAccount {
  return {
    owner: TEST_OWNER.publicKey,
    agent: TEST_AGENT.publicKey,
    feeDestination: TEST_FEE_DEST,
    vaultId: new BN(1),
    status: { active: {} } as VaultStatus,
    bump: 255,
    createdAt: new BN(1700000000),
    totalTransactions: new BN(42),
    totalVolume: new BN("1000000000"),
    openPositions: 0,
    totalFeesCollected: new BN(5000),
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
 * Mock AgentShieldClient that records method calls and returns canned data.
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

    async registerAgent(vault: PublicKey, agent: PublicKey) {
      calls.push({ method: "registerAgent", args: [vault, agent] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-register";
    },

    async updatePolicy(vault: PublicKey, params: any) {
      calls.push({ method: "updatePolicy", args: [vault, params] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-update";
    },

    async revokeAgent(vault: PublicKey) {
      calls.push({ method: "revokeAgent", args: [vault] });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-revoke";
    },

    async reactivateVault(vault: PublicKey, newAgent?: PublicKey) {
      calls.push({
        method: "reactivateVault",
        args: [vault, newAgent],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-reactivate";
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

    async executeFlashTrade(result: any, agent: PublicKey, signers?: any[]) {
      calls.push({
        method: "executeFlashTrade",
        args: [result, agent, signers],
      });
      if (overrides.shouldThrow) throw overrides.shouldThrow;
      return "mock-sig-flash";
    },
  };

  return mock;
}
