/**
 * Kit-native Devnet Test Helpers
 *
 * Pure @solana/kit for RPC, signers, and vault operations.
 * Uses @solana/spl-token + @solana/web3.js for stablecoin mint setup only.
 *
 * NOTE: This module imports node:fs and @solana/web3.js — do NOT re-export
 * from the barrel (index.ts) to avoid breaking browser bundlers.
 * Import directly: import { ... } from "@usesigil/kit/testing/devnet"
 */

import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "../kit-adapter.js";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { readFileSync } from "node:fs";

import { getInitializeVaultInstructionAsync } from "../generated/instructions/initializeVault.js";
import { getRegisterAgentInstructionAsync } from "../generated/instructions/registerAgent.js";
import { getQueueAgentGrantInstructionAsync } from "../generated/instructions/queueAgentGrant.js";
import { getApplyAgentGrantInstructionAsync } from "../generated/instructions/applyAgentGrant.js";
import { getDepositFundsInstructionAsync } from "../generated/instructions/depositFunds.js";
import { fetchPendingAgentGrant } from "../generated/accounts/pendingAgentGrant.js";
import { inscribe } from "../inscribe.js";
import { getAgentOverlayPDA, getTrackerPDA } from "../resolve-accounts.js";
import { computePolicyPreviewDigest } from "../policy/compute-policy-preview-digest.js";
import { sendAndConfirmTransaction, BlockhashCache } from "../rpc-helpers.js";
import {
  USDC_MINT_DEVNET,
  FULL_CAPABILITY,
  PROTOCOL_TREASURY,
} from "../types.js";

// ─── Rate Limiter (5 RPS against Helius 10 RPS limit) ──────────────────────

const RPC_MAX_RPS = 5;
const RPC_MIN_GAP_MS = Math.ceil(1000 / RPC_MAX_RPS);

// Shared state — all throttled fetch instances coordinate on one counter
const sharedLimiter = { nextSlot: 0 };

function createThrottledFetch(): typeof fetch {
  const original = globalThis.fetch.bind(globalThis);

  return async function throttledFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const now = Date.now();
    const mySlot = Math.max(now, sharedLimiter.nextSlot);
    sharedLimiter.nextSlot = mySlot + RPC_MIN_GAP_MS;

    const wait = mySlot - now;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    return original(...args);
  } as typeof fetch;
}

// ─── RPC ────────────────────────────────────────────────────────────────────

/**
 * Create a Kit-native Rpc with throttled fetch.
 */
export function createDevnetRpc(): Rpc<SolanaRpcApi> {
  const url =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  // Cast config to bypass missing 'fetch' in TS types (works at runtime)
  return createSolanaRpc(url, { fetch: createThrottledFetch() } as any);
}

// ─── Signers ────────────────────────────────────────────────────────────────

/**
 * Load the owner keypair from ANCHOR_WALLET (same file as Anchor CLI).
 */
export async function loadOwnerSigner(): Promise<{
  signer: KeyPairSigner;
  bytes: Uint8Array;
}> {
  const walletPath =
    process.env.ANCHOR_WALLET || `${process.env.HOME}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(walletPath, "utf-8")) as number[];
  const bytes = new Uint8Array(raw);
  const signer = await createKeyPairSignerFromBytes(bytes);
  return { signer, bytes };
}

/**
 * Create a funded agent keypair (transfers SOL from owner).
 * Uses a manual SystemProgram transfer instruction to avoid @solana-program/system dep.
 */
export async function createFundedAgent(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  lamports: number = 100_000_000,
): Promise<KeyPairSigner> {
  const agent = await generateKeyPairSigner();

  // Manual SystemProgram transfer (program 11111111..., instruction index 2)
  const transferIx = buildSystemTransferIx(
    owner.address,
    agent.address,
    BigInt(lamports),
  );
  await sendKitTransaction(rpc, owner, [transferIx]);

  return agent;
}

/**
 * Build a SystemProgram Transfer instruction (index=2) without @solana-program/system.
 * Layout: u32le(2) + u64le(lamports) = 12 bytes
 */
function buildSystemTransferIx(
  from: Address,
  to: Address,
  lamports: bigint,
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // Transfer instruction index
  view.setBigUint64(4, lamports, true);

  return {
    programAddress: "11111111111111111111111111111111" as Address,
    accounts: [
      { address: from, role: 3 as any }, // writable signer
      { address: to, role: 1 as any }, // writable
    ],
    data,
  };
}

// ─── Stablecoin Setup (uses @solana/spl-token — test setup only) ────────────

/**
 * Ensure the owner has stablecoin tokens for vault deposit.
 * Uses @solana/spl-token + @solana/web3.js for mint setup only.
 */
export async function ensureStablecoinBalance(
  rpcUrl: string,
  ownerSecretKey: Uint8Array,
  mintAddress: string,
  amount: number,
): Promise<void> {
  // Dynamic import to keep these as optional deps
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { getOrCreateAssociatedTokenAccount, mintTo } =
    await import("@solana/spl-token");

  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: createThrottledFetch(),
  });
  const payer = Keypair.fromSecretKey(ownerSecretKey);
  const mint = new PublicKey(mintAddress);

  // Check if the mint exists (for devnet test mints controlled by owner)
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    // This is a test-controlled mint — create it at the deterministic address
    // Only works if the mint keypair matches USDC_MINT_DEVNET
    // For real devnet USDC, the mint already exists
    throw new Error(
      `Mint ${mintAddress} does not exist on devnet. ` +
        `Use a mint that already exists or create it first.`,
    );
  }

  // Create/get owner ATA
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
  );

  // Check if we already have sufficient balance
  if (Number(ata.amount) >= amount) return;

  // Try to mint (works only if owner is mint authority — devnet test mints)
  try {
    await mintTo(connection, payer, mint, ata.address, payer.publicKey, amount);
  } catch (mintError: unknown) {
    const msg =
      mintError instanceof Error ? mintError.message : String(mintError);
    throw new Error(
      `Cannot mint tokens for ${mintAddress}: ${msg}. ` +
        `If owner is not the mint authority, fund the ATA manually.`,
    );
  }
}

// ─── Acquiring-swap fixture (M1 6112 + measurable-outcome 6115) ──────────────

export interface SwapOutputFixture {
  /** Fresh non-stablecoin output mint (random address — never USDC/USDT). */
  outputMint: Address;
  /** VAULT-OWNED ATA for outputMint — the M1 gate verifies this increased. */
  vaultOutputAta: Address;
  /** Agent-owned reserve ATA funding the swap's output leg (test-only). */
  agentReserve: Address;
  /** Agent-owned stablecoin ATA — the swap's leg-1 destination (input sink). */
  agentStablecoinAta: Address;
}

/**
 * Kit-native equivalent of the anchor `tests/helpers/devnet-setup.ts`
 * `setupSwapOutput`. Stands up an ACQUIRING-swap fixture on the LIVE cluster so a
 * stablecoin-input spending sandwich satisfies the two finalize gates that bind
 * every such spend on the deployed binary:
 *   - M1 output-ownership (ErrOutputNotVaultOwned 6112): the spend must deliver a
 *     DIFFERENT mint INTO a vault-owned account that INCREASED.
 *   - require-measurable-outcome (ErrUnmeasurableSpend 6115): a spending session
 *     (amount > 0) must produce a measurable vault delta.
 *
 * Creates a fresh non-stablecoin output mint, a VAULT-OWNED ATA to receive it
 * (the acquisition the M1 gate verifies), an agent-owned reserve funded so the
 * swap's output leg has tokens to deliver (a real swap sources output from a
 * pool — this is the test stand-in), and the agent-owned stablecoin ATA the
 * swap's leg-1 routes the pulled input into. Pair `vaultOutputAta` with the
 * `outputSwapAccount` of BOTH validate and finalize, and feed `agentStablecoinAta`
 * / `agentReserve` / `vaultOutputAta` into the mock-defi `swap_to_vault` middle
 * ix. Mirrors the verified anchor pattern (`tests/devnet-fees.ts` test 1) and the
 * mock-defi `swap_to_vault` fixture exactly — no new mechanism.
 *
 * Uses @solana/spl-token + @solana/web3.js for token setup only (same convention
 * as `ensureStablecoinBalance`). `ownerSecretKey` is the fee payer AND the output
 * mint authority.
 */
export async function setupSwapOutput(
  rpcUrl: string,
  ownerSecretKey: Uint8Array,
  vaultAddress: Address,
  agentAddress: Address,
  stablecoinMint: Address,
): Promise<SwapOutputFixture> {
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { createMint, getOrCreateAssociatedTokenAccount, mintTo } =
    await import("@solana/spl-token");

  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    fetch: createThrottledFetch(),
  });
  const payer = Keypair.fromSecretKey(ownerSecretKey);
  const vaultPk = new PublicKey(vaultAddress);
  const agentPk = new PublicKey(agentAddress);

  // Fresh non-stablecoin mint (random address → never matches USDC/USDT, so the
  // acquired output is a DIFFERENT mint from the stablecoin input). Mint
  // authority = payer.publicKey so mintTo below can sign with `payer`.
  const outputMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
  );

  // Vault-owned output ATA (allowOwnerOffCurve — the vault is a PDA).
  const vaultOutputAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    outputMint,
    vaultPk,
    true,
  );

  // Agent-owned reserve funding the swap's output leg.
  const agentReserveAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    outputMint,
    agentPk,
  );
  await mintTo(
    connection,
    payer,
    outputMint,
    agentReserveAccount.address,
    payer, // mint authority = payer.publicKey
    1_000_000_000, // healthy reserve — far exceeds any per-test outAmount
  );

  // Agent-owned stablecoin ATA — the swap's leg-1 destination (input sink).
  const agentStablecoinAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    new PublicKey(stablecoinMint),
    agentPk,
  );

  return {
    outputMint: outputMint.toString() as Address,
    vaultOutputAta: vaultOutputAccount.address.toString() as Address,
    agentReserve: agentReserveAccount.address.toString() as Address,
    agentStablecoinAta: agentStablecoinAccount.address.toString() as Address,
  };
}

// ─── Transient-RPC retry (public-devnet 429 tolerance) ──────────────────────

/**
 * Run an async RPC read with bounded exponential-backoff retry on transient
 * RPC-availability errors (429 / Too Many Requests / generic HTTP error). The
 * public devnet endpoint rate-limits read bursts the same way it does sends, so
 * raw `getSlot` / `getBlockTime` calls in the provisioning + timelock-wait
 * paths must tolerate the same flakiness as `sendKitTransaction`. Test-only.
 */
async function rpcReadWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 6,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient = errorMentions(e, [
        "429",
        "Too Many Requests",
        "HTTP error",
        "fetch failed",
        "ETIMEDOUT",
        "ECONNRESET",
      ]);
      if (!transient || attempt === maxAttempts - 1) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// ─── Operator-grant timelock (F-Q6) ─────────────────────────────────────────

/**
 * Capability tier 2 = OPERATOR (= FULL_CAPABILITY). Mirrors
 * `programs/sigil/src/state/mod.rs` `CAPABILITY_OPERATOR` and the
 * agent-middleware `tests/helpers/devnet-setup.ts` constant.
 */
export const CAPABILITY_OPERATOR = 2;

/**
 * Poll the devnet CLUSTER clock (`getBlockTime`) until it reaches
 * `deadlineUnix`, then return. On-chain timelocks gate on
 * `Clock::unix_timestamp` — the stake-weighted cluster clock, which can skew
 * from wall-time — so we poll it rather than sleeping a fixed wall duration.
 * Mirrors `tests/helpers/devnet-setup.ts waitForClusterTime`. Bounded by a
 * wall-clock cap (remaining cluster gap + 180s slack) so a stuck/null
 * getBlockTime throws an explicit diagnostic instead of spinning until the
 * mocha hook timeout.
 */
async function waitForClusterTime(
  rpc: Rpc<SolanaRpcApi>,
  deadlineUnix: number,
  label = "deadline",
): Promise<void> {
  const wallStart = Date.now();
  let firstClusterTime: number | null = null;
  let firstPass = true;
  for (;;) {
    const slot = await rpcReadWithRetry(() =>
      rpc.getSlot({ commitment: "confirmed" }).send(),
    );
    let clusterTime: number | null = null;
    try {
      clusterTime = Number(
        await rpcReadWithRetry(() => rpc.getBlockTime(slot).send()),
      );
    } catch {
      // getBlockTime can transiently fail for a just-produced slot (the slot
      // has no recorded block time yet); treat as "not ready" and re-poll.
      clusterTime = null;
    }
    if (clusterTime !== null && !Number.isNaN(clusterTime)) {
      if (firstClusterTime === null) firstClusterTime = clusterTime;
      if (clusterTime >= deadlineUnix) return;
    }
    const capMs =
      firstClusterTime !== null
        ? (deadlineUnix - firstClusterTime + 180) * 1000
        : 180_000;
    if (Date.now() - wallStart > capMs) {
      throw new Error(
        `waitForClusterTime(${label}): cluster clock never reached ` +
          `${deadlineUnix} within wall cap (${Math.round(capMs / 1000)}s) — ` +
          `getBlockTime degraded?`,
      );
    }
    const remaining =
      clusterTime === null ? 10 : Math.max(deadlineUnix - clusterTime, 1);
    // First pass sleeps the whole residual in one go; later passes verify in
    // short steps (the cluster clock can lag wall-time by a few seconds).
    await new Promise((r) =>
      setTimeout(
        r,
        (firstPass ? remaining + 2 : Math.min(remaining + 1, 10)) * 1000,
      ),
    );
    firstPass = false;
  }
}

/**
 * Seat an OPERATOR-class agent (capability >= CAPABILITY_OPERATOR) via the
 * lawful F-Q6 timelock path: `queue_agent_grant` → wait the on-chain
 * single-key timelock floor → `apply_agent_grant`.
 *
 * A fresh single-key vault can NEVER seat an OPERATOR instantly —
 * `register_agent` hard-rejects `capability >= CAPABILITY_OPERATOR` on a
 * single-factor vault with `ErrOperatorGrantRequiresTimelock` (6107). The
 * on-chain `SINGLE_KEY_OPERATOR_DELAY_FLOOR` is 600s (the missing 2nd factor);
 * we read the EXACT `queued_at` + `min_delay_seconds` back from the on-chain
 * `PendingAgentGrant` PDA (cluster truth, immune to local-clock skew) and wait
 * out that window against `getBlockTime`, then apply.
 *
 * Mirrors `tests/helpers/devnet-setup.ts`
 * `queueOperatorGrant`/`applyOperatorGrants`.
 */
async function seatOperatorAgent(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  vaultAddress: Address,
  agentAddress: Address,
  capability: number,
  spendingLimitUsd: bigint,
  overlayPDA: Address,
): Promise<void> {
  // 1. Queue. The builder auto-derives policy / pending / audit_success /
  //    slot_hashes / system_program from `vault`.
  const queueIx = await getQueueAgentGrantInstructionAsync({
    owner,
    vault: vaultAddress,
    agent: agentAddress,
    capability,
    spendingLimitUsd,
  });
  await sendKitTransaction(rpc, owner, [queueIx as Instruction]);

  // 2. Read the queue-time truth back from the on-chain pending PDA. The
  //    pending PDA address is the same one the queue builder derived; re-derive
  //    it the same way for the fetch.
  const pendingAddr = (queueIx as { accounts: { address: Address }[] })
    .accounts[3].address; // [owner, vault, policy, pending, ...]
  const pending = await rpcReadWithRetry(() =>
    fetchPendingAgentGrant(rpc, pendingAddr),
  );
  const queuedAt = Number(pending.data.queuedAt);
  const minDelaySeconds = Number(pending.data.minDelaySeconds);

  // 3. Wait out the on-chain timelock against the cluster clock. The on-chain
  //    check is `clock.unix_timestamp - queued_at >= min_delay_seconds`; add a
  //    few seconds of slack so the apply lands strictly after the boundary.
  const deadline = queuedAt + minDelaySeconds + 3;
  await waitForClusterTime(rpc, deadline, "operator-grant-timelock");

  // 4. Apply. The builder auto-derives policy / pending / audit_success /
  //    slot_hashes from `vault`; only `agentSpendOverlay` must be supplied.
  const applyIx = await getApplyAgentGrantInstructionAsync({
    owner,
    vault: vaultAddress,
    agentSpendOverlay: overlayPDA,
  });
  await sendKitTransaction(rpc, owner, [applyIx as Instruction]);
}

// ─── Vault Provisioning ─────────────────────────────────────────────────────

export interface ProvisionVaultOpts {
  dailySpendingCapUsd?: bigint;
  maxTransactionSizeUsd?: bigint;
  protocolMode?: number;
  depositAmount?: bigint;
  permissions?: bigint;
  spendingLimitUsd?: bigint;
  skipDeposit?: boolean;
  timelockDuration?: bigint;
  /** Phase 2 TA-19: provision vault in observe-only mode. */
  observeOnly?: boolean;
  /**
   * Protocol allowlist (ALLOWLIST mode). Default: empty. An ACTIVE
   * (non-observe-only) vault needs at least one allowlisted protocol or
   * destination — the on-chain F-11 guard rejects an inert vault at init
   * (6073) and the M-9 guard rejects it on reactivate
   * (ActiveVaultRequiresAllowlist). Pass at least one entry for any vault that
   * must be reactivatable or authorize spending.
   */
  protocols?: Address[];
  /**
   * Explicit vault id. When omitted, `inscribe()` auto-probes the first
   * unused id (fast path 0..4, then GPA for the next free slot). Pass an
   * explicit id when a test needs a DETERMINISTIC vault id — e.g. a LOW id
   * (< the Strategy-B probe window of 20) so `findVaultsByOwner` discovers
   * it via PDA probing even when the RPC restricts `getProgramAccounts`.
   * The caller is responsible for choosing a free slot (init fails 0x0 /
   * account-already-in-use if the PDA exists).
   */
  vaultId?: bigint;
}

export interface ProvisionVaultResult {
  vaultAddress: Address;
  policyAddress: Address;
  trackerPDA: Address;
  vaultId: bigint;
  overlayPDA: Address;
}

/**
 * Does an error mention any of the given needles anywhere in its `.cause`
 * chain? @solana/kit wraps program errors, so the on-chain code (e.g. "6071")
 * is usually NOT on the top-level `.message` — it lives down the cause chain or
 * in Kit's `.context.code`. Walk both at each level.
 */
function errorMentions(err: unknown, needles: string[]): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    const c = cur as {
      message?: unknown;
      context?: { code?: unknown };
      cause?: unknown;
    };
    const hay = `${String(c.message ?? "")} ${String(c.context?.code ?? "")} ${String(cur)}`;
    if (needles.some((n) => hay.includes(n))) return true;
    cur = c.cause;
  }
  return false;
}

/**
 * Provision a vault using Kit-native Codama builders.
 *
 * 1. Call inscribe() for PDA derivation + vault ID probing
 * 2. Build + send initializeVault IX via Codama
 * 3. Build + send registerAgent IX via Codama
 * 4. Build + send depositFunds IX via Codama (optional)
 */
export async function provisionVault(
  rpc: Rpc<SolanaRpcApi>,
  owner: KeyPairSigner,
  agent: KeyPairSigner,
  mint: Address = USDC_MINT_DEVNET,
  opts: ProvisionVaultOpts = {},
): Promise<ProvisionVaultResult> {
  const dailyCap = opts.dailySpendingCapUsd ?? 500_000_000n;
  const maxTx = opts.maxTransactionSizeUsd ?? 100_000_000n;
  // Phase 2 Option A: on-chain handler rejects protocolMode != 1 (ALLOWLIST).
  // Devnet test default is now ALLOWLIST with empty protocols (no DeFi permitted
  // by default — callers add protocols explicitly).
  const protocolMode = opts.protocolMode ?? 1;
  const protocols = opts.protocols ?? [];
  const permissions = opts.permissions ?? FULL_CAPABILITY;
  const spendingLimitUsd = opts.spendingLimitUsd ?? 0n;
  // Phase 2 TA-19: observe_only defaults to false unless caller opts in.
  const observeOnly = opts.observeOnly ?? false;

  // 1. Derive PDAs via inscribe() (auto-probes the next id unless one is given)
  const inscribeResult = await inscribe({
    rpc,
    network: "devnet",
    owner,
    agent,
    vaultId: opts.vaultId,
    unsafeSkipTeeCheck: true,
  });

  const { vaultAddress, vaultId, policyAddress } = inscribeResult;
  const [overlayPDA] = await getAgentOverlayPDA(vaultAddress, 0);

  // 2. Build and send initializeVault.
  //
  // PEN-CROSS-2: the on-chain handler captures Clock::get()?.slot at execution
  // and require!s the owner-signed digest encode that EXACT slot
  // (PolicyPreviewMismatch 6071 otherwise). The live devnet clock advances
  // between getSlot() and landing — and `confirmed` LAGS the execution slot —
  // so a single read mismatches every time. Bind to `processed + offset` and
  // retry on 6071, fanning the offset out across attempts (mirrors the
  // production SDK create-vault.ts + the agent-middleware sendInitVault).
  const timelockDuration = opts?.timelockDuration ?? 1800n;
  const seedOffsets = [2, 3, 4, 5, 6, 7, 8, 10, 12, 1, 9, 11, 14, 16, 18, 20];
  let initLanded = false;
  let lastInitErr: unknown;
  for (let attempt = 0; attempt < 40 && !initLanded; attempt++) {
    const base = await rpcReadWithRetry(() =>
      rpc.getSlot({ commitment: "processed" }).send(),
    );
    const createdAtSlot =
      base + BigInt(seedOffsets[attempt % seedOffsets.length]);
    const previewDigest = computePolicyPreviewDigest({
      dailySpendingCapUsd: dailyCap,
      maxTransactionSizeUsd: maxTx,
      maxSlippageBps: 500,
      // PEN-CROSS-6: developer_fee_rate is bound by the digest.
      developerFeeRate: 0,
      protocolMode,
      protocols,
      destinationMode: 0,
      allowedDestinations: [],
      timelockDuration,
      sessionExpirySeconds: 0n,
      observeOnly,
      hasPostAssertions: 0,
      createdAtSlot,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      // TA-12/14 (Phase 5): testing helper defaults — no floor, no per-recipient cap.
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
      // G6 (audit 2026-05-18 cosign opt-in): testing helper default = false
      // (low-friction). Tests can override via opts when exercising the
      // cosign-required path explicitly.
      cosignRequired: false,
    });

    const initIx = await getInitializeVaultInstructionAsync({
      owner,
      agentSpendOverlay: overlayPDA,
      feeDestination: PROTOCOL_TREASURY,
      vaultId,
      dailySpendingCapUsd: dailyCap,
      maxTransactionSizeUsd: maxTx,
      protocolMode,
      protocols,
      developerFeeRate: 0,
      maxSlippageBps: 500,
      timelockDuration, // MIN_TIMELOCK_DURATION (TOCTOU fix)
      allowedDestinations: [],
      protocolCaps: [],
      observeOnly,
      operatingHours: 0x00ffffff,
      autoPromoteGrays: false,
      autoRevokeThreshold: 5,
      stableBalanceFloor: 0n,
      perRecipientDailyCapUsd: 0n,
      // G6 (audit 2026-05-18 cosign opt-in): same default as the digest
      // computation above — testing helper opts out of cosign by default.
      cosignRequired: false,
      previewDigest,
    });

    try {
      // skipPreflight: the digest binds a FUTURE slot; a preflight sim at the
      // current slot would always reject it (6071) before it can land.
      await sendKitTransaction(
        rpc,
        owner,
        [
          getSetComputeUnitLimitInstruction({ units: 400_000 }),
          initIx as Instruction,
        ],
        { skipPreflight: true },
      );
      initLanded = true;
    } catch (e) {
      // @solana/kit wraps the program error: the caught error's own .message is
      // a generic preflight-failure string and the "Custom #6071" lives down the
      // .cause chain — so walk the whole chain (message + context.code).
      if (errorMentions(e, ["6071", "PolicyPreviewMismatch"])) {
        lastInitErr = e;
        continue; // slot advanced past the signed digest — re-read + retry
      }
      throw e;
    }
  }
  if (!initLanded) {
    throw new Error(
      `provisionVault: initialize_vault slot-bind failed after 40 attempts ` +
        `(PolicyPreviewMismatch 6071). Last error: ${lastInitErr}`,
    );
  }

  // 3. Seat the agent.
  //
  // F-Q6 (register_agent.rs:130-146): a single-key vault can NEVER seat an
  // OPERATOR-class grant (capability >= CAPABILITY_OPERATOR) instantly —
  // `register_agent` rejects it with `ErrOperatorGrantRequiresTimelock` (6107)
  // because the time-delay IS the missing 2nd authorization factor. The lawful
  // path is queue_agent_grant → wait the on-chain SINGLE_KEY_OPERATOR_DELAY_FLOOR
  // (600s) → apply_agent_grant. Observer (1) / Disabled (0) grants cannot move
  // funds and register instantly via the fast path.
  const capabilityTier = Number(permissions);
  if (capabilityTier >= CAPABILITY_OPERATOR) {
    await seatOperatorAgent(
      rpc,
      owner,
      vaultAddress,
      agent.address,
      capabilityTier,
      spendingLimitUsd,
      overlayPDA,
    );
  } else {
    // PEN-CROSS-5 (Phase 4 absorption): policy account required for the
    // policy_version bump on the instant register path.
    const registerIx = await getRegisterAgentInstructionAsync({
      owner,
      vault: vaultAddress,
      policy: policyAddress,
      agentSpendOverlay: overlayPDA,
      agent: agent.address,
      capability: capabilityTier,
      spendingLimitUsd,
    });
    await sendKitTransaction(rpc, owner, [registerIx as Instruction]);
  }

  // 4. Deposit funds (optional)
  if (!opts.skipDeposit) {
    const depositAmount = opts.depositAmount ?? 1_000_000_000n;
    const depositIx = await getDepositFundsInstructionAsync({
      owner,
      vault: vaultAddress,
      mint,
      amount: depositAmount,
    });

    await sendKitTransaction(rpc, owner, [depositIx as Instruction]);
  }

  const [trackerPDA] = await getTrackerPDA(vaultAddress);

  return {
    vaultAddress,
    policyAddress,
    trackerPDA,
    vaultId,
    overlayPDA,
  };
}

// ─── Transaction Helper ─────────────────────────────────────────────────────

const blockhashCache = new BlockhashCache(15_000);

/**
 * Build, sign, and send a Kit-native transaction.
 *
 * Uses pipe() + signTransactionMessageWithSigners() + sendAndConfirmTransaction().
 *
 * The public devnet RPC (`api.devnet.solana.com`) aggressively rate-limits
 * bursts and returns HTTP 429 on `sendTransaction` even under the SDK's 5-RPS
 * throttle. `sendAndConfirmTransaction` (the shared production send path) does
 * NOT retry the initial send by design — so this TEST-ONLY helper wraps the
 * full build+send in a bounded exponential-backoff retry on transient RPC
 * errors (429 / Too Many Requests / generic HTTP error). Each attempt rebuilds
 * with a fresh blockhash so a stale lifetime never leaks into a retry. This
 * keeps the hardening scoped to the devnet test harness and leaves the
 * production helper untouched.
 */
export async function sendKitTransaction(
  rpc: Rpc<SolanaRpcApi>,
  signer: KeyPairSigner,
  instructions: Instruction[],
  opts?: { skipPreflight?: boolean },
): Promise<string> {
  const MAX_ATTEMPTS = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Fresh blockhash per attempt — the cache TTL keeps this cheap while
    // guaranteeing a retry never sends with an expired lifetime.
    const blockhash = await blockhashCache.get(rpc);

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(signer.address, tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(
          blockhash as Parameters<
            typeof setTransactionMessageLifetimeUsingBlockhash
          >[0],
          tx,
        ),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    );

    // Attach fee payer signer so signTransactionMessageWithSigners can sign it
    const txWithSigners = addSignersToTransactionMessage(
      [signer],
      txMessage as any,
    );
    const signedTx = await signTransactionMessageWithSigners(
      txWithSigners as any,
    );
    const wireBase64 = getBase64EncodedWireTransaction(signedTx as any);

    try {
      return await sendAndConfirmTransaction(rpc, wireBase64, {
        timeoutMs: 60_000,
        commitment: "confirmed",
        skipPreflight: opts?.skipPreflight ?? false,
      });
    } catch (e) {
      // Retry only transient RPC-availability errors. On-chain program errors
      // (Custom #NNNN) and confirmed tx failures are deterministic — surface
      // them immediately rather than masking with retries.
      const transient = errorMentions(e, [
        "429",
        "Too Many Requests",
        "HTTP error",
        "fetch failed",
        "ETIMEDOUT",
        "ECONNRESET",
      ]);
      if (!transient || attempt === MAX_ATTEMPTS - 1) throw e;
      lastErr = e;
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s — generous because the
      // public-devnet rate-limit window is measured in seconds, not ms.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastErr;
}
