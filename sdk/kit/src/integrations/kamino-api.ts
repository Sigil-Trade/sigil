/**
 * Kamino API Foundation Layer — Kit-native
 *
 * Pure HTTP client for api.kamino.finance with retry, timeout, and HTTPS enforcement.
 * Mirrors the Jupiter API pattern (jupiter-api.ts).
 *
 * 7 actions: deposit, withdraw, borrow, repay, vaultDeposit, vaultWithdraw, multiply.
 */

import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import type { ProtocolComposeResult, ProtocolContext } from "./protocol-handler.js";
import {
  COMPOSE_ERROR_CODES,
  KaminoComposeError,
  createSafeBigInt,
  createRequireField,
} from "./compose-errors.js";
import { KAMINO_LENDING_PROGRAM } from "./config/kamino-markets.js";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface KaminoApiConfig {
  baseUrl?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  maxDelayMs?: number;
  env?: string;
}

export class KaminoApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`Kamino API error (${statusCode}): ${body}`);
    this.name = "KaminoApiError";
  }
}

const DEFAULT_CONFIG: Required<KaminoApiConfig> = {
  baseUrl: "https://api.kamino.finance",
  maxRetries: 3,
  retryDelayMs: 1000,
  timeoutMs: 30_000,
  maxDelayMs: 30_000,
  env: "mainnet-beta",
};

let currentConfig: Readonly<Required<KaminoApiConfig>> = Object.freeze({ ...DEFAULT_CONFIG });

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

export function configureKaminoApi(config: KaminoApiConfig): void {
  const normalizedUrl = (config.baseUrl ?? DEFAULT_CONFIG.baseUrl).replace(/\/$/, "");
  if (normalizedUrl) {
    try {
      const parsed = new URL(normalizedUrl);
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !isLocalhost) {
        throw new Error(
          `Kamino API base URL must use HTTPS (got: ${normalizedUrl}). ` +
          "Use http://localhost only for local development/testing."
        );
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error(`Invalid Kamino API base URL: ${normalizedUrl}`);
      }
      throw e;
    }
  }
  currentConfig = Object.freeze({
    baseUrl: normalizedUrl,
    maxRetries: config.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    retryDelayMs: config.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs,
    timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
    env: config.env ?? DEFAULT_CONFIG.env,
  });
}

export function getKaminoApiConfig(): Readonly<Required<KaminoApiConfig>> {
  return currentConfig;
}

export function resetKaminoApiConfig(): void {
  currentConfig = Object.freeze({ ...DEFAULT_CONFIG });
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// ─── Core Fetch ──────────────────────────────────────────────────────────────

export interface KaminoFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
}

export async function kaminoFetch<T>(
  path: string,
  options?: KaminoFetchOptions,
): Promise<T> {
  // Circuit breaker check
  if (Date.now() < circuitOpenUntil) {
    throw new KaminoApiError(
      503,
      "Kamino API temporarily unavailable (circuit breaker open). Try again in 60 seconds.",
    );
  }

  const config = currentConfig;
  const url = `${config.baseUrl}${path}`;
  const method = options?.method ?? "GET";
  const timeout = options?.timeoutMs ?? config.timeoutMs;

  const headers: Record<string, string> = { ...options?.headers };

  if (options?.body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  const body: string | undefined =
    options?.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : (options?.body as string | undefined);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });

      if (response.ok) {
        consecutiveFailures = 0;
        return (await response.json()) as T;
      }

      const responseBody = await response.text();

      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < config.maxRetries
      ) {
        const retryAfter = response.headers.get("Retry-After");
        const parsedRetry = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const delay =
          !isNaN(parsedRetry) && parsedRetry > 0
            ? Math.min(parsedRetry * 1000, config.maxDelayMs)
            : Math.min(
                config.retryDelayMs * Math.pow(2, attempt) +
                  Math.random() * config.retryDelayMs,
                config.maxDelayMs,
              );

        await sleep(delay);
        lastError = new KaminoApiError(response.status, responseBody);
        continue;
      }

      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      }

      throw new KaminoApiError(response.status, responseBody);
    } catch (error) {
      if (error instanceof KaminoApiError) {
        throw error;
      }

      if (attempt < config.maxRetries) {
        const delay = Math.min(
          config.retryDelayMs * Math.pow(2, attempt) +
            Math.random() * config.retryDelayMs,
          config.maxDelayMs,
        );
        await sleep(delay);
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      consecutiveFailures++;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      }

      throw error;
    }
  }

  throw lastError ?? new Error("Kamino API request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KaminoSerializedInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64
}

export interface KaminoTxResponse {
  instructions: KaminoSerializedInstruction[];
  addressLookupTableAddresses?: string[];
}

export interface KaminoMarketInfo {
  lendingMarket: string;
  name: string;
  isPrimary: boolean;
  isCurated: boolean;
  lookupTable?: string;
}

export interface KaminoReserveMetrics {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  maxLtv: number;
  borrowApy: number;
  supplyApy: number;
  totalSupply: string;
  totalBorrow: string;
  totalBorrowUsd: number;
  totalSupplyUsd: number;
}

export interface KaminoLeverageMetrics {
  tvl: number;
  avgLeverage: number;
  totalBorrowed: number;
  totalDeposited: number;
  depositReserve: string;
  borrowReserve: string;
  tag: string;
}

export interface KaminoObligation {
  obligationAddress: string;
  lendingMarket: string;
  deposits: { reserve: string; amount: string; valueUsd: number }[];
  borrows: { reserve: string; amount: string; valueUsd: number }[];
  healthFactor: number;
  ltv: number;
  maxLtv: number;
}

export interface KaminoLoanInfo {
  obligation: string;
  netApy: number;
  interestEarned: number;
  interestPaid: number;
  liquidationThreshold: number;
}

export interface KaminoPnl {
  obligation: string;
  totalPnl: number;
  unrealizedPnl: number;
}

export interface StakingYield {
  token: string;
  apy: number;
  mint: string;
}

export interface KaminoRewards {
  lending: { pending: number; tokens: string[] };
  vault: { pending: number; tokens: string[] };
}

// ─── Instruction Deserialization ─────────────────────────────────────────────

export function deserializeKaminoInstruction(
  ix: KaminoSerializedInstruction,
): Instruction {
  return {
    programAddress: ix.programId as Address,
    accounts: ix.accounts.map((acc) => ({
      address: acc.pubkey as Address,
      role: acc.isSigner && acc.isWritable
        ? AccountRole.WRITABLE_SIGNER
        : acc.isSigner
          ? AccountRole.READONLY_SIGNER
          : acc.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
    })),
    data: base64ToUint8Array(ix.data),
  };
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Transaction Building ────────────────────────────────────────────────────

export async function fetchKlendDepositInstructions(
  wallet: string,
  market: string,
  reserve: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/klend/deposit-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, market, reserve, amount } },
  );
}

export async function fetchKlendWithdrawInstructions(
  wallet: string,
  market: string,
  reserve: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/klend/withdraw-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, market, reserve, amount } },
  );
}

export async function fetchKlendBorrowInstructions(
  wallet: string,
  market: string,
  reserve: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/klend/borrow-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, market, reserve, amount } },
  );
}

export async function fetchKlendRepayInstructions(
  wallet: string,
  market: string,
  reserve: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/klend/repay-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, market, reserve, amount } },
  );
}

export async function fetchKvaultDepositInstructions(
  wallet: string,
  kvault: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/kvault/deposit-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, kvault, amount } },
  );
}

export async function fetchKvaultWithdrawInstructions(
  wallet: string,
  kvault: string,
  amount: string,
  env?: string,
): Promise<KaminoTxResponse> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoTxResponse>(
    `/ktx/kvault/withdraw-instructions?env=${envParam}`,
    { method: "POST", body: { wallet, kvault, amount } },
  );
}

// ─── Data Queries (Agent Context) ────────────────────────────────────────────

export async function fetchKaminoMarkets(env?: string): Promise<KaminoMarketInfo[]> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoMarketInfo[]>(`/kamino-market/all?env=${envParam}`);
}

export async function fetchReserveMetrics(market: string, env?: string): Promise<KaminoReserveMetrics[]> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoReserveMetrics[]>(`/kamino-market/${market}/reserves?env=${envParam}`);
}

export async function fetchLeverageMetrics(market: string, env?: string): Promise<KaminoLeverageMetrics[]> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoLeverageMetrics[]>(`/kamino-market/${market}/leverage?env=${envParam}`);
}

export async function fetchObligations(market: string, wallet: string, env?: string): Promise<KaminoObligation[]> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoObligation[]>(`/kamino-market/${market}/obligations?wallet=${wallet}&env=${envParam}`);
}

export async function fetchLoanInfo(market: string, obligation: string, env?: string): Promise<KaminoLoanInfo> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoLoanInfo>(`/kamino-market/${market}/loan/${obligation}?env=${envParam}`);
}

export async function fetchObligationPnl(market: string, obligation: string, env?: string): Promise<KaminoPnl> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoPnl>(`/kamino-market/${market}/obligation/${obligation}/pnl?env=${envParam}`);
}

export async function fetchStakingYields(env?: string): Promise<StakingYield[]> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<StakingYield[]>(`/staking/yields?env=${envParam}`);
}

export async function fetchUserRewards(wallet: string, env?: string): Promise<KaminoRewards> {
  const config = currentConfig;
  const envParam = env ?? config.env;
  return kaminoFetch<KaminoRewards>(`/rewards/${wallet}?env=${envParam}`);
}

// ─── Compose Dispatcher (backward compat with t2-handlers) ───────────────────

const requireField = createRequireField(
  (field) => new KaminoComposeError(COMPOSE_ERROR_CODES.MISSING_PARAM, `Missing required parameter: ${field}`),
);

const safeBigInt = createSafeBigInt(
  (field, value) => new KaminoComposeError(COMPOSE_ERROR_CODES.INVALID_BIGINT, `Invalid numeric value for ${field}: ${String(value)}`),
);

/**
 * Dispatch a Kamino action to the correct API-backed compose function.
 * Called by KaminoHandler.compose() in t2-handlers.ts.
 */
export async function dispatchKaminoCompose(
  ctx: ProtocolContext,
  action: string,
  params: Record<string, unknown>,
): Promise<ProtocolComposeResult> {
  const env = ctx.network === "devnet" ? "devnet" : "mainnet-beta";

  switch (action) {
    case "deposit":
      return composeKlend(ctx, "deposit", params, env);
    case "withdraw":
      return composeKlend(ctx, "withdraw", params, env);
    case "borrow":
      return composeKlend(ctx, "borrow", params, env);
    case "repay":
      return composeKlend(ctx, "repay", params, env);
    case "vaultDeposit":
      return composeKvault(ctx, "deposit", params, env);
    case "vaultWithdraw":
      return composeKvault(ctx, "withdraw", params, env);
    case "multiply":
      return composeMultiply(ctx, params, env);
    default:
      throw new KaminoComposeError(
        COMPOSE_ERROR_CODES.UNSUPPORTED_ACTION,
        `Unsupported action: ${action}. Supported: deposit, withdraw, borrow, repay, vaultDeposit, vaultWithdraw, multiply`,
      );
  }
}

// ─── Internal Compose Functions ──────────────────────────────────────────────

/** Reserve metrics cache — avoids repeated API calls for token resolution */
let reserveMetricsCache: { market: string; data: KaminoReserveMetrics[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function resolveReserveBySymbol(
  tokenSymbol: string,
  market: string,
  env: string,
): Promise<string> {
  // Check cache
  if (reserveMetricsCache && reserveMetricsCache.market === market && Date.now() < reserveMetricsCache.expiresAt) {
    const match = reserveMetricsCache.data.find(
      (r) => r.liquidityToken.toUpperCase() === tokenSymbol.toUpperCase(),
    );
    if (match) return match.reserve;
  }

  // Fetch fresh
  const metrics = await fetchReserveMetrics(market, env);
  reserveMetricsCache = { market, data: metrics, expiresAt: Date.now() + CACHE_TTL_MS };

  const match = metrics.find(
    (r) => r.liquidityToken.toUpperCase() === tokenSymbol.toUpperCase(),
  );
  if (!match) {
    const available = metrics.map((r) => r.liquidityToken).join(", ");
    throw new KaminoComposeError(
      COMPOSE_ERROR_CODES.INVALID_PARAM,
      `Unknown Kamino token: ${tokenSymbol}. Available: ${available}`,
    );
  }
  return match.reserve;
}

async function resolvePrimaryMarket(env: string): Promise<string> {
  const markets = await fetchKaminoMarkets(env);
  const primary = markets.find((m) => m.isPrimary);
  if (!primary) {
    throw new KaminoComposeError(
      COMPOSE_ERROR_CODES.INVALID_PARAM,
      "No primary market found on Kamino API",
    );
  }
  return primary.lendingMarket;
}

async function composeKlend(
  ctx: ProtocolContext,
  action: string,
  params: Record<string, unknown>,
  env: string,
): Promise<ProtocolComposeResult> {
  const tokenMint = requireField<string>(params, "tokenMint");
  const amount = String(safeBigInt(requireField(params, "amount"), "amount"));
  const market = (params.market as string) ?? await resolvePrimaryMarket(env);
  const reserve = await resolveReserveBySymbol(tokenMint, market, env);

  let response: KaminoTxResponse;
  switch (action) {
    case "deposit":
      response = await fetchKlendDepositInstructions(ctx.vault, market, reserve, amount, env);
      break;
    case "withdraw":
      response = await fetchKlendWithdrawInstructions(ctx.vault, market, reserve, amount, env);
      break;
    case "borrow":
      response = await fetchKlendBorrowInstructions(ctx.vault, market, reserve, amount, env);
      break;
    case "repay":
      response = await fetchKlendRepayInstructions(ctx.vault, market, reserve, amount, env);
      break;
    default:
      throw new KaminoComposeError(COMPOSE_ERROR_CODES.UNSUPPORTED_ACTION, `Unknown klend action: ${action}`);
  }

  const instructions = response.instructions.map(deserializeKaminoInstruction);
  const addressLookupTables = (response.addressLookupTableAddresses ?? []) as Address[];

  return { instructions, addressLookupTables };
}

async function composeKvault(
  ctx: ProtocolContext,
  action: string,
  params: Record<string, unknown>,
  env: string,
): Promise<ProtocolComposeResult> {
  const kvault = requireField<string>(params, "kvault");
  const amount = String(safeBigInt(requireField(params, "amount"), "amount"));

  let response: KaminoTxResponse;
  if (action === "deposit") {
    response = await fetchKvaultDepositInstructions(ctx.vault, kvault, amount, env);
  } else {
    response = await fetchKvaultWithdrawInstructions(ctx.vault, kvault, amount, env);
  }

  const instructions = response.instructions.map(deserializeKaminoInstruction);
  const addressLookupTables = (response.addressLookupTableAddresses ?? []) as Address[];

  return { instructions, addressLookupTables };
}

async function composeMultiply(
  ctx: ProtocolContext,
  params: Record<string, unknown>,
  env: string,
): Promise<ProtocolComposeResult> {
  const depositToken = requireField<string>(params, "depositToken");
  const borrowToken = requireField<string>(params, "borrowToken");
  const initialAmount = String(safeBigInt(requireField(params, "amount"), "amount"));
  const targetLeverage = (params.targetLeverage as number) ?? 2;
  const maxLoops = Math.min((params.maxLoops as number) ?? 3, 5);
  const market = (params.market as string) ?? await resolvePrimaryMarket(env);

  const allInstructions: Instruction[] = [];
  const allAlts: Address[] = [];

  // Initial deposit
  const depositResult = await composeKlend(
    ctx,
    "deposit",
    { tokenMint: depositToken, amount: initialAmount, market },
    env,
  );
  allInstructions.push(...depositResult.instructions);
  if (depositResult.addressLookupTables) {
    allAlts.push(...depositResult.addressLookupTables);
  }

  // Leverage loops: borrow → deposit
  let remainingLeverage = targetLeverage - 1;
  let currentAmount = BigInt(initialAmount);

  for (let i = 0; i < maxLoops && remainingLeverage > 0.1; i++) {
    const borrowRatio = Math.min(remainingLeverage, 1);
    const borrowAmount = String(BigInt(Math.floor(Number(currentAmount) * borrowRatio * 0.95)));

    const borrowResult = await composeKlend(
      ctx,
      "borrow",
      { tokenMint: borrowToken, amount: borrowAmount, market },
      env,
    );
    allInstructions.push(...borrowResult.instructions);
    if (borrowResult.addressLookupTables) {
      allAlts.push(...borrowResult.addressLookupTables);
    }

    const reDepositResult = await composeKlend(
      ctx,
      "deposit",
      { tokenMint: depositToken, amount: borrowAmount, market },
      env,
    );
    allInstructions.push(...reDepositResult.instructions);
    if (reDepositResult.addressLookupTables) {
      allAlts.push(...reDepositResult.addressLookupTables);
    }

    currentAmount = BigInt(borrowAmount);
    remainingLeverage -= borrowRatio;
  }

  // Deduplicate ALTs
  const uniqueAlts = [...new Set(allAlts)];

  return { instructions: allInstructions, addressLookupTables: uniqueAlts };
}
