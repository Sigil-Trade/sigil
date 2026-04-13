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
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { readFileSync } from "node:fs";

import { getInitializeVaultInstructionAsync } from "../generated/instructions/initializeVault.js";
import { getRegisterAgentInstruction } from "../generated/instructions/registerAgent.js";
import { getDepositFundsInstructionAsync } from "../generated/instructions/depositFunds.js";
import { inscribe } from "../inscribe.js";
import { getAgentOverlayPDA, getTrackerPDA } from "../resolve-accounts.js";
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
}

export interface ProvisionVaultResult {
  vaultAddress: Address;
  policyAddress: Address;
  trackerPDA: Address;
  vaultId: bigint;
  overlayPDA: Address;
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
  const protocolMode = opts.protocolMode ?? 0; // allow all
  const permissions = opts.permissions ?? FULL_CAPABILITY;
  const spendingLimitUsd = opts.spendingLimitUsd ?? 0n;

  // 1. Derive PDAs via inscribe()
  const inscribeResult = await inscribe({
    rpc,
    network: "devnet",
    owner,
    agent,
    unsafeSkipTeeCheck: true,
  });

  const { vaultAddress, vaultId, policyAddress } = inscribeResult;
  const [overlayPDA] = await getAgentOverlayPDA(vaultAddress, 0);

  // 2. Build and send initializeVault
  const initIx = await getInitializeVaultInstructionAsync({
    owner,
    agentSpendOverlay: overlayPDA,
    feeDestination: PROTOCOL_TREASURY,
    vaultId,
    dailySpendingCapUsd: dailyCap,
    maxTransactionSizeUsd: maxTx,
    protocolMode,
    protocols: [],
    maxLeverageBps: 0,
    maxConcurrentPositions: 5,
    developerFeeRate: 0,
    maxSlippageBps: 500,
    timelockDuration: opts?.timelockDuration ?? 1800n, // MIN_TIMELOCK_DURATION (TOCTOU fix)
    allowedDestinations: [],
    protocolCaps: [],
  });

  await sendKitTransaction(rpc, owner, [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    initIx as Instruction,
  ]);

  // 3. Build and send registerAgent
  const registerIx = getRegisterAgentInstruction({
    owner,
    vault: vaultAddress,
    agentSpendOverlay: overlayPDA,
    agent: agent.address,
    capability: Number(permissions),
    spendingLimitUsd,
  });

  await sendKitTransaction(rpc, owner, [registerIx as Instruction]);

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
 */
export async function sendKitTransaction(
  rpc: Rpc<SolanaRpcApi>,
  signer: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
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

  return sendAndConfirmTransaction(rpc, wireBase64, {
    timeoutMs: 60_000,
    commitment: "confirmed",
  });
}
