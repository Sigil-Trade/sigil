import { z } from "zod";
import type { SigilClient } from "@usesigil/kit";
import { ActionType, resolveToken, toAgentError, toBaseUnits } from "@usesigil/kit";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { toResolvedNetwork } from "../types.js";

const schema = z.object({
  inputMint: z
    .string()
    .describe(
      "Input token mint address or symbol (e.g. 'USDC' or full address)",
    ),
  outputMint: z
    .string()
    .describe("Output token mint address or symbol"),
  amount: z
    .number()
    .positive()
    .describe("Amount in human-readable units (e.g. 500 for $500 USDC)"),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe("Slippage tolerance in BPS (default 50 = 0.5%)"),
});

export function swapAction(client: SigilClient, jupiterApiUrl: string) {
  return {
    description:
      "Execute a Sigil-secured token swap via Jupiter. Enforces vault spending caps and permissions.",
    schema,
    handler: async (_agent: unknown, input: z.infer<typeof schema>) => {
      try {
        const net = toResolvedNetwork(client.network);

        const inputToken = resolveToken(input.inputMint, net);
        const outputToken = resolveToken(input.outputMint, net);
        const inputMint = (inputToken?.mint ?? input.inputMint) as Address;
        const outputMint = (outputToken?.mint ?? input.outputMint) as Address;
        const decimals = inputToken?.decimals ?? 6;
        const baseAmount = toBaseUnits(input.amount, decimals);

        const quoteUrl =
          `${jupiterApiUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
          `&amount=${baseAmount}&slippageBps=${input.slippageBps ?? 50}`;
        const quoteRes = await fetch(quoteUrl);
        if (!quoteRes.ok)
          throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
        const quote = await quoteRes.json();

        const ixRes = await fetch(`${jupiterApiUrl}/swap-instructions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: client.agent.address,
            wrapAndUnwrapSol: true,
          }),
        });
        if (!ixRes.ok)
          throw new Error(`Jupiter swap-instructions failed: ${ixRes.status}`);
        const ixData = await ixRes.json();

        const parsed = parseJupiterSwapResponse(ixData);
        if (parsed.instructions.length === 0) {
          throw new Error(
            "Jupiter returned no swap instructions. The quote may be invalid or the route unavailable.",
          );
        }

        const execResult = await client.executeAndConfirm(parsed.instructions, {
          tokenMint: inputMint,
          amount: baseAmount,
          actionType: ActionType.Swap,
          protocolAltAddresses: parsed.addressLookupTableAddresses,
        });

        return {
          success: true,
          signature: execResult.signature,
          inputMint,
          outputMint,
          amount: input.amount,
        };
      } catch (err) {
        const agentErr = toAgentError(err);
        return {
          success: false,
          error: agentErr.message,
          recovery: agentErr.recovery_actions,
        };
      }
    },
  };
}

// ─── Jupiter Response Parsing ───────────────────────────────────────────────

interface JupiterSwapResponse {
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
  data: string;
}

interface ParsedJupiterSwap {
  instructions: Instruction[];
  addressLookupTableAddresses: Address[];
}

/**
 * Parse Jupiter swap-instructions response into Kit types.
 *
 * Jupiter returns 6 fields:
 * - computeBudgetInstructions: stripped by wrap() — excluded
 * - setupInstructions: ATA creation, etc. — included
 * - swapInstruction: the swap itself — included
 * - cleanupInstruction: SOL unwrap (nullable) — included
 * - otherInstructions: Jito tips, etc. — included
 * - addressLookupTableAddresses: ALTs for tx compression — returned separately
 */
function parseJupiterSwapResponse(ixData: Record<string, unknown>): ParsedJupiterSwap {
  const raw = ixData as JupiterSwapResponse;

  // Collect all DeFi instructions in execution order.
  // ComputeBudget instructions are excluded — wrap() adds its own.
  const all = [
    ...(raw.setupInstructions ?? []),
    raw.swapInstruction,
    ...(raw.cleanupInstruction ? [raw.cleanupInstruction] : []),
    ...(raw.otherInstructions ?? []),
  ].filter(Boolean) as JupiterIx[];

  const instructions = all.map(toKitInstruction);

  const addressLookupTableAddresses = (raw.addressLookupTableAddresses ?? []) as Address[];

  return { instructions, addressLookupTableAddresses };
}

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
