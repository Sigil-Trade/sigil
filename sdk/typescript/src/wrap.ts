import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  Connection,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { BN, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { AgentShield, ActionType } from "./types";
import { getVaultPDA, getPolicyPDA } from "./accounts";
import {
  buildValidateAndAuthorize,
  buildFinalizeSession,
} from "./instructions";
import { rewriteVaultAuthority } from "./rewriter";

/** Default compute budget for wrapped transactions (1.4M CU) */
const DEFAULT_COMPUTE_UNITS = 1_400_000;

export interface WrapTransactionParams {
  /** Vault PDA */
  vault: PublicKey;
  /** Vault owner pubkey */
  owner: PublicKey;
  /** Vault ID */
  vaultId: BN;
  /** Agent signer pubkey */
  agent: PublicKey;
  /** Raw DeFi instruction(s) — will be authority-rewritten */
  defiInstructions: TransactionInstruction[];
  /** Token mint being spent */
  tokenMint: PublicKey;
  /** Amount in base units */
  amount: BN;
  /** Target DeFi protocol program ID */
  targetProtocol: PublicKey;
  /** Action type (swap, openPosition, etc.) */
  actionType: ActionType;
  /** Leverage in basis points (for perp actions) */
  leverageBps?: number | null;
  /** Address lookup tables for compact transaction encoding */
  addressLookupTables?: AddressLookupTableAccount[];
  /** Compute unit budget override */
  computeUnits?: number;
  /** Fee destination token account (optional) */
  feeDestinationTokenAccount?: PublicKey | null;
  /** Protocol treasury token account (optional) */
  protocolTreasuryTokenAccount?: PublicKey | null;
  /** Oracle feed account for oracle-priced tokens (Pyth or Switchboard) */
  oracleFeedAccount?: PublicKey;
}

/**
 * Wrap arbitrary DeFi instructions into a complete AgentShield transaction.
 *
 * This is the protocol-agnostic entry point. It:
 * 1. Resolves the vault's token account
 * 2. Rewrites authority in DeFi instructions (vault PDA → agent)
 * 3. Builds: [ComputeBudget, ValidateAndAuthorize, ...defi, FinalizeSession]
 * 4. Returns an unsigned VersionedTransaction
 */
export async function wrapTransaction(
  program: Program<AgentShield>,
  connection: Connection,
  params: WrapTransactionParams,
): Promise<VersionedTransaction> {
  const instructions = await wrapInstructions(program, params);

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: params.agent,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(params.addressLookupTables);

  return new VersionedTransaction(messageV0);
}

/**
 * Build the instruction array for a wrapped transaction without
 * creating the VersionedTransaction. Useful when the caller needs
 * to compose further or use a different signing flow.
 */
export async function wrapInstructions(
  program: Program<AgentShield>,
  params: WrapTransactionParams,
): Promise<TransactionInstruction[]> {
  const computeUnits = params.computeUnits ?? DEFAULT_COMPUTE_UNITS;

  // Derive vault token account
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    params.tokenMint,
    params.vault,
    true,
  );

  // Rewrite authority in DeFi instructions
  const rewrittenDefi = rewriteVaultAuthority(
    params.defiInstructions,
    params.vault,
    params.agent,
  );

  // Compute budget
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: computeUnits,
  });

  // Validate and authorize (includes token delegation CPI)
  const validateIx = await buildValidateAndAuthorize(
    program,
    params.agent,
    params.vault,
    vaultTokenAccount,
    {
      actionType: params.actionType,
      tokenMint: params.tokenMint,
      amount: params.amount,
      targetProtocol: params.targetProtocol,
      leverageBps: params.leverageBps,
    },
    params.oracleFeedAccount,
  ).instruction();

  // Finalize session (revokes delegation, collects fees)
  const finalizeIx = await buildFinalizeSession(
    program,
    params.agent,
    params.vault,
    params.agent,
    params.tokenMint,
    true,
    vaultTokenAccount,
    params.feeDestinationTokenAccount,
    params.protocolTreasuryTokenAccount,
  ).instruction();

  return [computeIx, validateIx, ...rewrittenDefi, finalizeIx];
}
