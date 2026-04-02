/**
 * Jupiter V6 Swap via Sigil — Complete Integration Example
 *
 * Demonstrates the #1 integration path: wrapping a Jupiter swap with
 * Sigil on-chain spending limits and permission policies.
 *
 * Prerequisites:
 *   - A deployed Sigil vault on devnet (owner-created)
 *   - The vault funded with USDC
 *   - An agent keypair registered in the vault
 *
 * To run: change VAULT_ADDRESS, RPC_URL, and loadAgentSigner() below.
 *
 * Node.js >= 18 required.
 */

import {
  SigilClient,
  ActionType,
  toAgentError,
  formatUsd,
  formatPercent,
  USDC_MINT_DEVNET,
} from "@usesigil/kit";
import {
  address,
  createSolanaRpc,
  AccountRole,
} from "@solana/kit";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";

// ─── Configuration (change these three) ──────────────────────────────────────

const VAULT_ADDRESS = address("YOUR_VAULT_ADDRESS");
const RPC_URL = "https://api.devnet.solana.com";

/** $10 USDC in base units (6 decimals). 10 * 10^6 = 10_000_000. */
const SWAP_AMOUNT = 10_000_000n;

const INPUT_MINT = USDC_MINT_DEVNET;
const OUTPUT_MINT = address("So11111111111111111111111111111111111111112"); // SOL

// ─── Agent Signer ────────────────────────────────────────────────────────────

/**
 * Load your agent's TransactionSigner.
 *
 * Replace this stub with your actual key loading:
 *   - Turnkey:  use @usesigil/custody/turnkey
 *   - Local:    use createKeyPairSignerFromBytes() from @solana/kit
 *   - Privy:    use @usesigil/custody/privy
 */
function loadAgentSigner(): TransactionSigner {
  throw new Error(
    "Replace loadAgentSigner() with your agent key. " +
      "See @usesigil/custody/turnkey for production use.",
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = createSolanaRpc(RPC_URL);
  const agent = loadAgentSigner();

  // Step 1: Get Jupiter quote
  const quoteRes = await fetch(
    `https://quote-api.jup.ag/v6/quote?` +
      `inputMint=${INPUT_MINT}&outputMint=${OUTPUT_MINT}` +
      `&amount=${SWAP_AMOUNT}&slippageBps=50`,
  );
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
  const quoteResponse = await quoteRes.json();

  // Step 2: Get swap instructions
  //
  // CRITICAL: Use /swap-instructions, NOT /swap.
  //   /swap returns a single serialized transaction — unusable with seal().
  //   /swap-instructions returns individual instructions we can compose
  //   into a Sigil-wrapped atomic transaction.
  const swapIxRes = await fetch("https://quote-api.jup.ag/v6/swap-instructions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: agent.address,
      // wrapAndUnwrapSol defaults to true — Jupiter handles SOL wrapping.
      // Sigil will rewrite ATAs to point at the vault's token accounts.
    }),
  });
  if (!swapIxRes.ok) throw new Error(`Jupiter swap-instructions failed: ${swapIxRes.status}`);
  const swapData = (await swapIxRes.json()) as JupiterSwapInstructionsResponse;

  // Step 3: Parse Jupiter response into Kit Instruction[]
  //
  // Jupiter returns 6 fields. We collect setup + swap + cleanup + other
  // (excluding computeBudget — seal() adds its own compute budget).
  const jupiterInstructions = parseJupiterResponse(swapData);
  if (jupiterInstructions.length === 0) {
    throw new Error("Jupiter returned zero instructions");
  }

  // Step 4: Extract ALT addresses
  //
  // Jupiter routes use address lookup tables that rotate per-route.
  // Always pass fresh values from each response — never cache these.
  const protocolAltAddresses: Address[] = (
    swapData.addressLookupTableAddresses ?? []
  ).map((a) => address(a));

  // Step 5: Wrap and execute
  //
  // SigilClient holds vault/agent/network context and manages caches.
  // executeAndConfirm() does: seal() → sign → send → confirm in one call.
  const client = new SigilClient({
    rpc,
    vault: VAULT_ADDRESS,
    agent,
    network: "devnet",
  });

  try {
    const { signature, wrapResult } = await client.executeAndConfirm(
      jupiterInstructions,
      {
        tokenMint: INPUT_MINT,
        amount: SWAP_AMOUNT,
        actionType: ActionType.Swap,
        protocolAltAddresses,
      },
    );

    // Step 6: Display results
    console.log(`Swap executed: ${signature}`);

    if (wrapResult.warnings.length > 0) {
      console.warn("Warnings:");
      for (const w of wrapResult.warnings) console.warn(`  ${w}`);
    }

    const pnl = await client.getPnL();
    console.log(`Vault P&L: ${formatUsd(pnl.pnl)} (${formatPercent(pnl.pnlPercent)})`);
  } catch (err) {
    // Structured error for AI agent consumption.
    // toAgentError() converts on-chain error codes (6000-6070) AND SDK errors
    // into a structured format with category, retryable flag, and recovery actions.
    const agentError = toAgentError(err);
    console.error(`[${agentError.category}] ${agentError.message}`);
    console.error(`Retryable: ${agentError.retryable}`);
    for (const action of agentError.recovery_actions) {
      console.error(`  Recovery: ${action.description}`);
    }
  }
}

main().catch(console.error);

// ─── Jupiter Types & Helpers ─────────────────────────────────────────────────
//
// These mirror the production implementation in @usesigil/plugins/sak.
// For production code, use the plugin's parseJupiterSwapResponse() instead
// of these standalone helpers.

interface JupiterSwapInstructionsResponse {
  computeBudgetInstructions?: JupiterIx[];
  setupInstructions?: JupiterIx[];
  swapInstruction?: JupiterIx;
  cleanupInstruction?: JupiterIx;
  otherInstructions?: JupiterIx[];
  addressLookupTableAddresses?: string[];
}

interface JupiterIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64-encoded instruction data
}

/**
 * Collect Jupiter DeFi instructions in execution order.
 * Excludes computeBudgetInstructions — seal() adds its own.
 */
function parseJupiterResponse(res: JupiterSwapInstructionsResponse): Instruction[] {
  const all = [
    ...(res.setupInstructions ?? []),
    res.swapInstruction,
    ...(res.cleanupInstruction ? [res.cleanupInstruction] : []),
    ...(res.otherInstructions ?? []),
  ].filter(Boolean) as JupiterIx[];

  return all.map(toKitInstruction);
}

/**
 * Convert a single Jupiter API instruction to a Kit Instruction.
 *
 * Maps Jupiter's { pubkey, isSigner, isWritable } account format
 * to Kit's { address, role: AccountRole } format.
 */
function toKitInstruction(ix: JupiterIx): Instruction {
  return {
    programAddress: ix.programId as Address,
    accounts: (ix.accounts ?? []).map(
      (a: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
        address: a.pubkey as Address,
        role: a.isSigner
          ? a.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : a.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      }),
    ),
    data: new Uint8Array(Buffer.from(ix.data, "base64")),
  };
}
