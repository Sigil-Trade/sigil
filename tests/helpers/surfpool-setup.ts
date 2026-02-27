/**
 * Surfpool test infrastructure — real RPC with cheatcode extensions.
 *
 * Parallel to litesvm-setup.ts but uses a live Surfnet (local LiteSVM-backed
 * validator with lazy devnet forking). Requires `surfpool start --network devnet`
 * running in the background.
 *
 * Cheatcodes are accessed via connection._rpcRequest("surfnet_*", [...]).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentShield } from "../../target/types/agent_shield";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
);

const SURFPOOL_RPC_URL =
  process.env.SURFPOOL_RPC_URL || "http://localhost:8899";

/** Devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU */
export const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

/** Devnet USDT: EJwZgeZrdC8TXTQbQBoL6bfuAnFUQS5S4iC5A2ciQtCK */
export const DEVNET_USDT_MINT = new PublicKey(
  "EJwZgeZrdC8TXTQbQBoL6bfuAnFUQS5S4iC5A2ciQtCK",
);

/** Protocol treasury (must match on-chain constant) */
export const PROTOCOL_TREASURY = new PublicKey(
  "ASHie1dFTnDSnrHMPGmniJhMgfJVGPm3rAaEPnrtWDiT",
);

export const PROTOCOL_FEE_RATE = 200;
export const FEE_RATE_DENOMINATOR = 1_000_000;
export const SESSION_EXPIRY_SLOTS = 20;
export const ROLLING_WINDOW_SECONDS = 86_400;

// ─── Surfnet RPC cheatcode caller ───────────────────────────────────────────

/**
 * Low-level cheatcode caller via connection._rpcRequest.
 * Surfnet exposes custom RPC methods prefixed with "surfnet_".
 */
export async function surfnetRpc(
  connection: Connection,
  method: string,
  params: any[] = [],
): Promise<any> {
  const result = await (connection as any)._rpcRequest(method, params);
  if (result.error) {
    throw new Error(
      `Surfnet RPC error (${method}): ${JSON.stringify(result.error)}`,
    );
  }
  return result.result;
}

// ─── Readiness check ────────────────────────────────────────────────────────

/**
 * Poll until Surfnet is responsive, then register the IDL for Studio parsing.
 */
export async function waitForReady(
  rpcUrl: string = SURFPOOL_RPC_URL,
  maxRetries: number = 30,
): Promise<Connection> {
  const connection = new Connection(rpcUrl, "confirmed");

  for (let i = 0; i < maxRetries; i++) {
    try {
      await connection.getSlot();
      // Register IDL for account parsing in Studio
      const idlPath = path.resolve(
        __dirname,
        "../../target/idl/agent_shield.json",
      );
      if (fs.existsSync(idlPath)) {
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
        try {
          await surfnetRpc(connection, "surfnet_registerIdl", [
            {
              programId: PROGRAM_ID.toString(),
              idl: JSON.stringify(idl),
            },
          ]);
        } catch {
          // IDL registration is best-effort — tests work without it
        }
      }
      return connection;
    } catch {
      if (i === maxRetries - 1) {
        throw new Error(
          `Surfnet not ready after ${maxRetries} attempts at ${rpcUrl}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("unreachable");
}

// ─── Test environment ───────────────────────────────────────────────────────

export interface SurfpoolTestEnv {
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: Program<AgentShield>;
  payer: Keypair;
}

/**
 * Create a full Anchor test environment connected to Surfnet.
 * The payer is a fresh keypair funded via setAccountLamports.
 */
export async function createSurfpoolTestEnv(): Promise<SurfpoolTestEnv> {
  const connection = await waitForReady();
  const payer = Keypair.generate();

  // Fund payer via cheatcode
  await setAccountLamports(connection, payer.publicKey, 100 * LAMPORTS_PER_SOL);

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);

  const program = new Program<AgentShield>(
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../target/idl/agent_shield.json"),
        "utf-8",
      ),
    ),
    provider,
  );

  return { connection, provider, program, payer };
}

// ─── Account / balance manipulation ─────────────────────────────────────────

/**
 * Set an account's lamports directly via surfnet_setAccount.
 * Official API: surfnet_setAccount(pubkey, update)
 */
export async function setAccountLamports(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number,
): Promise<void> {
  await surfnetRpc(connection, "surfnet_setAccount", [
    pubkey.toString(),
    { lamports },
  ]);
}

/**
 * Create a funded wallet keypair.
 */
export async function createWallet(
  connection: Connection,
  _name: string,
  solAmount: number = 10,
): Promise<Keypair> {
  const kp = Keypair.generate();
  await setAccountLamports(
    connection,
    kp.publicKey,
    solAmount * LAMPORTS_PER_SOL,
  );
  return kp;
}

/**
 * Fund a wallet with SPL tokens via surfnet_setTokenAccount.
 * Creates/overrides the associated token account for the given mint.
 * Official API: surfnet_setTokenAccount(owner, mint, tokenProgram?, update)
 */
export async function fundWithTokens(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  amount: string | number,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  await surfnetRpc(connection, "surfnet_setTokenAccount", [
    owner.toString(),
    mint.toString(),
    TOKEN_PROGRAM_ID.toString(),
    { amount: amount.toString() },
  ]);
  return ata;
}

// ─── Time travel / clock control ────────────────────────────────────────────

export interface TimeTravelOpts {
  absoluteSlot?: number;
  timestamp?: number;
  epoch?: number;
}

/**
 * Jump Surfnet to a future slot, timestamp, or epoch.
 */
export async function timeTravel(
  connection: Connection,
  opts: TimeTravelOpts,
): Promise<void> {
  await surfnetRpc(connection, "surfnet_timeTravel", [opts]);
}

/**
 * Pause Surfnet block production.
 */
export async function pauseClock(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_pauseClock", []);
}

/**
 * Resume Surfnet block production.
 */
export async function resumeClock(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_resumeClock", []);
}

/**
 * Get current Surfnet clock info.
 */
export async function getClock(
  connection: Connection,
): Promise<{ slot: number; timestamp: number; epoch: number }> {
  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  const epochInfo = await connection.getEpochInfo();
  return {
    slot,
    timestamp: blockTime ?? 0,
    epoch: epochInfo.epoch,
  };
}

/**
 * Poll until Surfnet reaches a specific slot.
 */
export async function waitForSlot(
  connection: Connection,
  targetSlot: number,
  maxWaitMs: number = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const current = await connection.getSlot();
    if (current >= targetSlot) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for slot ${targetSlot} after ${maxWaitMs}ms`,
  );
}

// ─── Network reset ──────────────────────────────────────────────────────────

/**
 * Reset Surfnet to initial state — clears all accounts and transactions.
 */
export async function resetNetwork(connection: Connection): Promise<void> {
  await surfnetRpc(connection, "surfnet_resetNetwork", []);
}

// ─── Transaction profiling ──────────────────────────────────────────────────

export interface ProfileResult {
  computeUnits: number;
  accounts: any[];
  logs: string[];
  tag?: string;
}

/**
 * Profile a transaction for CU usage and account changes.
 * Official API: surfnet_getTransactionProfile(signatureOrUuid, config?)
 */
export async function profileTransaction(
  connection: Connection,
  txSignature: string,
  tag?: string,
): Promise<ProfileResult> {
  // Use getTransactionProfile with the signature
  const result = await surfnetRpc(
    connection,
    "surfnet_getTransactionProfile",
    [{ signature: txSignature }, { depth: 1 }],
  );
  if (tag) result.tag = tag;
  return result;
}

/**
 * Get all profiling results for a specific tag.
 * Official API: surfnet_getProfileResultsByTag(tag, config?)
 */
export async function getProfilesByTag(
  connection: Connection,
  tag: string,
): Promise<ProfileResult[]> {
  return await surfnetRpc(connection, "surfnet_getProfileResultsByTag", [
    tag,
    { depth: 1 },
  ]);
}

// ─── Composed transaction helper ────────────────────────────────────────────

export interface VersionedTxResult {
  signature: string;
  slot: number;
  logs: string[];
}

/**
 * Build, sign, and send a versioned transaction — mirrors litesvm-setup API.
 * Returns the signature and logs.
 */
export async function sendVersionedTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  signers: Keypair[] = [],
): Promise<VersionedTxResult> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer, ...signers]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  if (confirmation.value.err) {
    const txDetails = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = txDetails?.meta?.logMessages ?? [];
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)} Logs: ${logs.join(" ")}`,
    );
  }

  const txDetails = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  return {
    signature,
    slot: txDetails?.slot ?? 0,
    logs: txDetails?.meta?.logMessages ?? [],
  };
}

// ─── PDA derivation (reused from devnet-setup pattern) ──────────────────────

export function derivePDAs(
  owner: PublicKey,
  vaultId: BN,
  programId: PublicKey,
) {
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      owner.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), vaultPda.toBuffer()],
    programId,
  );
  const [trackerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tracker"), vaultPda.toBuffer()],
    programId,
  );
  const [pendingPolicyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pending_policy"), vaultPda.toBuffer()],
    programId,
  );
  return { vaultPda, policyPda, trackerPda, pendingPolicyPda };
}

export function deriveSessionPda(
  vaultPda: PublicKey,
  agent: PublicKey,
  tokenMint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [sessionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("session"),
      vaultPda.toBuffer(),
      agent.toBuffer(),
      tokenMint.toBuffer(),
    ],
    programId,
  );
  return sessionPda;
}

// ─── Collision-free vault ID generator (prefix 50_xxx) ──────────────────────

let vaultIdCounter = 0;

/**
 * Returns a unique vault ID in the 50_xxx_xxx range to avoid collisions
 * with LiteSVM tests (1-300) and devnet tests (1-8 prefixes).
 */
export function nextVaultId(): BN {
  return new BN(50_000_000 + (Date.now() % 1_000_000) + vaultIdCounter++);
}
