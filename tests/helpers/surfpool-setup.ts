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
import { Sigil } from "../../target/types/sigil";
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
import { execSync } from "child_process";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey(
  "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
);

const SURFPOOL_RPC_URL =
  process.env.SURFPOOL_RPC_URL || "http://localhost:8899";

/** Devnet USDC: DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH (test-controlled keypair) */
export const DEVNET_USDC_MINT = new PublicKey(
  "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH",
);

/** Devnet USDT: 43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze (test-controlled keypair) */
export const DEVNET_USDT_MINT = new PublicKey(
  "43cd9ma7P968BssTtAKNs5qu6zgsErupwxwdjkiuMHze",
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
      const idlPath = path.resolve(__dirname, "../../target/idl/sigil.json");
      if (fs.existsSync(idlPath)) {
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
        try {
          await surfnetRpc(connection, "surfnet_registerIdl", [idl]);
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

// ─── Local program deployment ────────────────────────────────────────────────

/**
 * Deploy the local sigil.so to Surfnet via `solana program deploy`.
 *
 * surfnet_setAccount alone does NOT update the SVM's compiled program cache.
 * The standard BPF Loader Deploy instruction is required to properly reload
 * the executable. Steps:
 *   1. Create a temporary deployer keypair and fund it
 *   2. Change the devnet-forked program's upgrade authority to our deployer
 *   3. Run `solana program deploy` which triggers a proper BPF reload
 */
async function deployLocalProgram(connection: Connection): Promise<void> {
  const soPath = path.resolve(__dirname, "../../target/deploy/sigil.so");
  if (!fs.existsSync(soPath)) {
    throw new Error(
      `Program .so not found at ${soPath}. Run 'anchor build --no-idl' first.`,
    );
  }

  // 1. Create temp deployer keypair
  const deployer = Keypair.generate();
  const deployerPath = path.resolve(__dirname, "../../.surfpool/deployer.json");
  fs.mkdirSync(path.dirname(deployerPath), { recursive: true });
  fs.writeFileSync(
    deployerPath,
    JSON.stringify(Array.from(deployer.secretKey)),
  );

  // 2. Fund deployer (need ~5 SOL for deploy buffer)
  await surfnetRpc(connection, "surfnet_setAccount", [
    deployer.publicKey.toString(),
    { lamports: 10 * LAMPORTS_PER_SOL },
  ]);

  // 3. Change program upgrade authority to our deployer
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo) {
    throw new Error("Program account not found on Surfnet");
  }
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const dataInfo = await connection.getAccountInfo(programDataAddress);
  if (!dataInfo) {
    throw new Error("Program data account not found on Surfnet");
  }

  const modifiedData = Buffer.from(dataInfo.data);
  modifiedData.writeUInt8(1, 12); // has_authority = true
  deployer.publicKey.toBuffer().copy(modifiedData, 13);

  await surfnetRpc(connection, "surfnet_setAccount", [
    programDataAddress.toString(),
    {
      data: modifiedData.toString("hex"),
      owner: dataInfo.owner.toString(),
      lamports: dataInfo.lamports,
    },
  ]);

  // 4. Deploy via solana CLI (properly updates SVM program cache)
  //    Retry up to 3 times — Surfnet can be slow after reset or on cold CI cache
  const rpcUrl = (connection as any)._rpcEndpoint || SURFPOOL_RPC_URL;
  const deployCmd =
    `solana program deploy "${soPath}" ` +
    `--program-id ${PROGRAM_ID.toString()} ` +
    `--keypair "${deployerPath}" ` +
    `--url ${rpcUrl} ` +
    `--upgrade-authority "${deployerPath}"`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync(deployCmd, { stdio: "pipe", timeout: 120_000 });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
  throw lastErr;
}

// ─── Test environment ───────────────────────────────────────────────────────

export interface SurfpoolTestEnv {
  connection: Connection;
  provider: anchor.AnchorProvider;
  program: Program<Sigil>;
  payer: Keypair;
}

/**
 * Create a full Anchor test environment connected to Surfnet.
 * The payer is a fresh keypair funded via setAccountLamports.
 * Deploys the local .so to ensure tests run against current code.
 */
export async function createSurfpoolTestEnv(): Promise<SurfpoolTestEnv> {
  const connection = await waitForReady();

  // Deploy local program (overrides devnet-forked version)
  await deployLocalProgram(connection);

  const payer = Keypair.generate();

  // Fund payer via cheatcode
  await setAccountLamports(connection, payer.publicKey, 100 * LAMPORTS_PER_SOL);

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);

  const program = new Program<Sigil>(
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../target/idl/sigil.json"),
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
 * Ensure an SPL Token mint account exists at the given address.
 * Needed for mints that don't exist on devnet (e.g., USDT).
 * Writes a valid 82-byte SPL Token mint directly via surfnet_setAccount.
 */
export async function ensureMintExists(
  connection: Connection,
  mint: PublicKey,
  decimals: number = 6,
): Promise<void> {
  const info = await connection.getAccountInfo(mint);
  if (info) return; // already exists (lazily forked from devnet)

  // SPL Token Mint layout: 82 bytes
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0); // mint_authority: None
  // supply (u64 LE) at offset 36 = 0
  data.writeUInt8(decimals, 44); // decimals
  data.writeUInt8(1, 45); // is_initialized = true
  data.writeUInt32LE(0, 46); // freeze_authority: None

  await surfnetRpc(connection, "surfnet_setAccount", [
    mint.toString(),
    {
      data: data.toString("hex"),
      owner: TOKEN_PROGRAM_ID.toString(),
      lamports: 1_000_000_000,
    },
  ]);
}

/**
 * Fund a wallet with SPL tokens via surfnet_setTokenAccount.
 * Creates/overrides the associated token account for the given mint.
 * Official API: surfnet_setTokenAccount(owner, mint, update)
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
    { amount: typeof amount === "string" ? Number(amount) : amount },
  ]);
  return ata;
}

// ─── Time travel / clock control ────────────────────────────────────────────

export interface TimeTravelOpts {
  absoluteSlot?: number;
  absoluteTimestamp?: number;
  absoluteEpoch?: number;
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
  const result = await surfnetRpc(connection, "surfnet_getTransactionProfile", [
    { signature: txSignature },
    { depth: 1 },
  ]);
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

// ─── Anchor error code → name lookup ─────────────────────────────────────────

/**
 * Sigil custom error codes (6000-6074) mapped to Anchor error names.
 * Source of truth: programs/sigil/src/errors.rs
 * Surfnet does NOT return program logs for failed TXs via getTransaction(),
 * so we must decode the numeric error code to include the name in errors.
 */
// Canonical error-code table — keep in sync with
// `sdk/kit/src/generated/errors/sigil.ts` (codama-generated from IDL).
const SIGIL_ERROR_NAMES: Record<number, string> = {
  6000: "VaultNotActive",
  6001: "UnauthorizedAgent",
  6002: "UnauthorizedOwner",
  6003: "UnsupportedToken",
  6004: "ProtocolNotAllowed",
  6005: "TransactionTooLarge",
  6006: "SpendingCapExceeded",
  6007: "SessionNotAuthorized",
  6008: "InvalidSession",
  6009: "TooManyAllowedProtocols",
  6010: "AgentAlreadyRegistered",
  6011: "NoAgentRegistered",
  6012: "VaultNotFrozen",
  6013: "VaultAlreadyClosed",
  6014: "InsufficientBalance",
  6015: "DeveloperFeeTooHigh",
  6016: "InvalidFeeDestination",
  6017: "InvalidProtocolTreasury",
  6018: "InvalidAgentKey",
  6019: "AgentIsOwner",
  6020: "Overflow",
  6021: "InvalidTokenAccount",
  6022: "TimelockNotExpired",
  6023: "NoTimelockConfigured",
  6024: "DestinationNotAllowed",
  6025: "TooManyDestinations",
  6026: "InvalidProtocolMode",
  6027: "CpiCallNotAllowed",
  6028: "MissingFinalizeInstruction",
  6029: "NonTrackedSwapMustReturnStablecoin",
  6030: "SwapSlippageExceeded",
  6031: "InvalidJupiterInstruction",
  6032: "UnauthorizedTokenTransfer",
  6033: "SlippageBpsTooHigh",
  6034: "ProtocolMismatch",
  6035: "TooManyDeFiInstructions",
  6036: "MaxAgentsReached",
  6037: "InsufficientPermissions",
  6038: "InvalidPermissions",
  6039: "EscrowNotActive",
  6040: "EscrowExpired",
  6041: "EscrowNotExpired",
  6042: "InvalidEscrowVault",
  6043: "EscrowConditionsNotMet",
  6044: "EscrowDurationExceeded",
  6045: "InvalidConstraintConfig",
  6046: "ConstraintViolated",
  6047: "InvalidConstraintsPda",
  6048: "InvalidPendingConstraintsPda",
  6049: "AgentSpendLimitExceeded",
  6050: "OverlaySlotExhausted",
  6051: "AgentSlotNotFound",
  6052: "UnauthorizedTokenApproval",
  6053: "InvalidSessionExpiry",
  6054: "UnconstrainedProgramBlocked",
  6055: "ProtocolCapExceeded",
  6056: "ProtocolCapsMismatch",
  6057: "ActiveEscrowsExist",
  6058: "ConstraintsNotClosed",
  6059: "PendingPolicyExists",
  6060: "AgentPaused",
  6061: "AgentAlreadyPaused",
  6062: "AgentNotPaused",
  6063: "UnauthorizedPostFinalizeInstruction",
  6064: "UnexpectedBalanceDecrease",
  6065: "TimelockTooShort",
  6066: "PolicyVersionMismatch",
  6067: "ActiveSessionsExist",
  6068: "PostAssertionFailed",
  6069: "InvalidPostAssertionIndex",
  6070: "UnauthorizedPreValidateInstruction",
  6071: "SnapshotNotCaptured",
  6072: "InvalidConstraintOperator",
  6073: "ConstraintsVaultMismatch",
  6074: "BlockedSplOpcode",
};

/**
 * Extract custom error code from Solana transaction error and resolve to name.
 */
function resolveErrorName(err: any): string {
  const errJson = JSON.stringify(err);
  const match = errJson.match(/"Custom":(\d+)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const name = SIGIL_ERROR_NAMES[code];
    if (name) return `${name} (${code})`;
  }
  return "";
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
 *
 * Error handling: Surfnet does not return program logs for failed TXs via
 * getTransaction(). We decode the error code from confirmation.value.err
 * and include the Anchor error name in the thrown error message.
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
    const errorName = resolveErrorName(confirmation.value.err);
    throw new Error(
      `Transaction failed: ${errorName} ${JSON.stringify(confirmation.value.err)} Logs: ${logs.join(" ")}`,
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

// ─── Overlay PDA derivation ──────────────────────────────────────────────────

/**
 * Derive the AgentSpendOverlay PDA for a vault (page index 0).
 */
export function deriveOverlayPda(
  vaultPda: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [overlayPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent_spend"), vaultPda.toBuffer(), Buffer.from([0])],
    programId,
  );
  return overlayPda;
}

// ─── Escrow PDA derivation ───────────────────────────────────────────────────

/**
 * Derive escrow PDA and its USDC ATA.
 */
export function deriveEscrowPda(
  srcVault: PublicKey,
  dstVault: PublicKey,
  escrowId: BN,
  programId: PublicKey,
): { escrowPda: PublicKey; escrowUsdcAta: PublicKey } {
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      srcVault.toBuffer(),
      dstVault.toBuffer(),
      escrowId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
  const escrowUsdcAta = getAssociatedTokenAddressSync(
    DEVNET_USDC_MINT,
    escrowPda,
    true,
  );
  return { escrowPda, escrowUsdcAta };
}

// ─── Vault setup helper ─────────────────────────────────────────────────────

export interface SetupVaultOpts {
  dailyCap?: BN;
  maxTxSize?: BN;
  vaultFunding?: number;
  agentCapability?: number;
  agentSpendingLimit?: BN;
  timelockDuration?: BN;
  allowedDestinations?: PublicKey[];
  developerFeeRate?: number;
  maxSlippageBps?: number;
  owner?: Keypair;
  protocolCaps?: any[];
  skipAgent?: boolean;
}

export interface VaultSetupResult {
  vaultId: BN;
  agent: Keypair;
  feeDestination: Keypair;
  vaultPda: PublicKey;
  policyPda: PublicKey;
  trackerPda: PublicKey;
  pendingPolicyPda: PublicKey;
  overlayPda: PublicKey;
  vaultUsdcAta: PublicKey;
  protocolTreasuryAta: PublicKey;
}

const FULL_CAPABILITY = 2;

/**
 * Create a vault with agent, fund it, and return all PDAs and keypairs.
 * Consolidates the 7-step setup pattern used in every Surfpool test suite.
 */
export async function setupVaultWithAgent(
  env: SurfpoolTestEnv,
  program: Program<any>,
  opts: SetupVaultOpts = {},
): Promise<VaultSetupResult> {
  const {
    dailyCap = new BN(500_000_000),
    maxTxSize = new BN(100_000_000),
    vaultFunding = 1_000_000_000,
    agentCapability = FULL_CAPABILITY,
    agentSpendingLimit = new BN(0),
    timelockDuration = new BN(1800), // MIN_TIMELOCK_DURATION: 30 minutes
    allowedDestinations = [],
    developerFeeRate = 0,
    maxSlippageBps = 100,
    owner = env.payer,
    protocolCaps = [],
    skipAgent = false,
  } = opts;

  const vaultId = nextVaultId();
  const agent = await createWallet(env.connection, "agent", 10);
  const feeDestination = await createWallet(env.connection, "feeDest", 2);

  const pdas = derivePDAs(owner.publicKey, vaultId, program.programId);
  const overlayPda = deriveOverlayPda(pdas.vaultPda, program.programId);

  await program.methods
    .initializeVault(
      vaultId,
      dailyCap,
      maxTxSize,
      0, // protocolMode: all
      [],
      developerFeeRate,
      maxSlippageBps,
      timelockDuration,
      allowedDestinations,
      protocolCaps,
    )
    .accounts({
      owner: owner.publicKey,
      vault: pdas.vaultPda,
      policy: pdas.policyPda,
      tracker: pdas.trackerPda,
      agentSpendOverlay: overlayPda,
      feeDestination: feeDestination.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers(owner === env.payer ? [] : [owner])
    .rpc();

  if (!skipAgent) {
    await program.methods
      .registerAgent(agent.publicKey, agentCapability, agentSpendingLimit)
      .accounts({
        owner: owner.publicKey,
        vault: pdas.vaultPda,
        agentSpendOverlay: overlayPda,
      } as any)
      .signers(owner === env.payer ? [] : [owner])
      .rpc();
  }

  const vaultUsdcAta = await fundWithTokens(
    env.connection,
    pdas.vaultPda,
    DEVNET_USDC_MINT,
    vaultFunding,
  );

  const protocolTreasuryAta = await fundWithTokens(
    env.connection,
    PROTOCOL_TREASURY,
    DEVNET_USDC_MINT,
    0,
  );

  return {
    vaultId,
    agent,
    feeDestination,
    vaultPda: pdas.vaultPda,
    policyPda: pdas.policyPda,
    trackerPda: pdas.trackerPda,
    pendingPolicyPda: pdas.pendingPolicyPda,
    overlayPda,
    vaultUsdcAta,
    protocolTreasuryAta,
  };
}

// ─── Error expectation helper ────────────────────────────────────────────────

/**
 * Send a transaction expecting it to fail with a specific error substring.
 * Re-throws AssertionErrors from expect.fail() to prevent false passes.
 */
export async function expectTxError(
  connection: Connection,
  ixs: TransactionInstruction[],
  signer: Keypair,
  errorSubstring: string,
  additionalSigners: Keypair[] = [],
): Promise<void> {
  try {
    await sendVersionedTx(connection, ixs, signer, additionalSigners);
    throw new Error(
      `Expected error containing "${errorSubstring}" but transaction succeeded`,
    );
  } catch (err: any) {
    if (err.message?.startsWith("Expected error containing")) throw err;
    const errStr = err.message || JSON.stringify(err);
    if (errStr.includes(errorSubstring)) return; // Direct string match

    // Surfpool returns numeric codes like {"Custom":6000} instead of "VaultNotActive".
    // Reverse-lookup: if errorSubstring is an error name, check if the numeric code appears.
    const codeEntry = Object.entries(SIGIL_ERROR_NAMES).find(
      ([, name]) => name === errorSubstring,
    );
    if (codeEntry) {
      const code = codeEntry[0];
      if (errStr.includes(code) || errStr.includes(`"Custom":${code}`)) return;
    }

    throw new Error(
      `Expected "${errorSubstring}" but got: ${errStr.slice(0, 200)}`,
    );
  }
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
