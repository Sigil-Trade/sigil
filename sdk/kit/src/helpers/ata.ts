/**
 * initializeVaultAtas — policy-gated ATA creation for a Sigil vault.
 *
 * Rationale: D17 closes Pentester finding F8. Before this helper, a
 * consumer could call into generic ATA-creation code with *any* SPL mint,
 * and the vault would end up with token accounts for assets that the
 * on-chain policy never approved. That breaks the mental model — the
 * vault's footprint should match its policy's protocol and destination
 * surface, not a superset of it.
 *
 * This helper enforces a hard client-side allowlist on which mints may
 * get ATAs: any mint not in `allowedMints` is rejected with
 * `SigilSdkDomainError(SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED)` before
 * any network round-trip. The allowlist is caller-supplied so this helper
 * has no dependency on RPC-backed `PolicyConfig` reads — callers that
 * already have resolved policy can pass in `policy.allowedDestinations`
 * plus known stablecoin mints; callers building a vault for the first
 * time can pass in the mints they just wrote into the policy.
 *
 * ATA instructions are built manually (following the pattern in
 * `src/x402/transfer-builder.ts`) rather than via `@solana-program/token`
 * to keep `@usesigil/kit` a zero-SPL-dep package.
 *
 * Dedup: repeated mints in the input are merged (the resulting instruction
 * list has one entry per unique mint). Empty input returns an empty list
 * without throwing — a vault that needs no ATAs is a valid configuration.
 *
 * @example
 *   const ixs = await initializeVaultAtas({
 *     vault: vaultPda,
 *     payer: ownerSigner.address,
 *     mints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
 *     allowedMints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
 *   });
 *   // → [ createIdempotent(USDC ATA), createIdempotent(USDT ATA) ]
 */

import type { Address, Instruction } from "../kit-adapter.js";
import { AccountRole } from "../kit-adapter.js";
import {
  TOKEN_PROGRAM_ADDRESS,
  ATA_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "../types.js";
import { deriveAta } from "../tokens.js";
import { SigilSdkDomainError } from "../errors/sdk.js";
import { SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED } from "../errors/codes.js";

/**
 * Associated Token Program — `CreateIdempotent` instruction discriminator.
 *
 * Layout: a single byte. No args, no additional data. Creates the ATA if
 * it doesn't exist; no-ops if it does. Source: ATA program
 * `processor.rs` variant `CreateIdempotent = 1`.
 */
const CREATE_IDEMPOTENT_DISCRIMINATOR = 1;

export interface InitializeVaultAtasParams {
  /** The vault PDA that will own the ATAs. */
  vault: Address;
  /**
   * Funding account — pays the rent for each new ATA and signs the tx.
   * Typically the owner's wallet during `createVault`, or any signer that
   * holds enough SOL to cover ATA rent.
   */
  payer: Address;
  /**
   * Mints to initialize ATAs for. Duplicates are deduplicated.
   * Empty array returns an empty instruction list.
   */
  mints: readonly Address[];
  /**
   * Client-side allowlist. Every entry in `mints` must be present in
   * `allowedMints`, or the call throws `SPL_TOKEN_OP_BLOCKED`.
   * Typically populated from `PolicyConfig.allowedDestinations` plus
   * recognized stablecoin mints the owner is wiring up.
   */
  allowedMints: readonly Address[];
}

export async function initializeVaultAtas(
  params: InitializeVaultAtasParams,
): Promise<Instruction[]> {
  const { vault, payer, mints, allowedMints } = params;

  if (mints.length === 0) return [];

  // Build the allowlist as a Set for O(1) membership test. Addresses are
  // base58 strings, which compare by value. No normalization needed.
  const allowed = new Set<string>(allowedMints);

  // Validate every mint before issuing any PDA derivation — fail-fast.
  for (const mint of mints) {
    if (!allowed.has(mint)) {
      throw new SigilSdkDomainError(
        SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
        `Mint ${mint} is not in the policy allowlist. ` +
          `initializeVaultAtas only creates ATAs for mints the vault's ` +
          `policy explicitly permits. Add this mint to the policy's ` +
          `allowedDestinations before calling, or pass a broader ` +
          `allowedMints list (e.g. [...policy.allowedDestinations, USDC_MINT_DEVNET]).`,
        { context: { mint, allowedMints: [...allowed] } as never },
      );
    }
  }

  // Deduplicate by mint — a caller passing the same mint twice should not
  // produce two identical createIdempotent instructions in the same tx.
  const uniqueMints = Array.from(new Set<string>(mints)) as Address[];

  // Derive ATAs in parallel and build one CreateIdempotent ix per mint.
  const instructions = await Promise.all(
    uniqueMints.map(async (mint) => {
      const ata = await deriveAta(vault, mint);
      return buildCreateIdempotentIx({ payer, ata, owner: vault, mint });
    }),
  );

  return instructions;
}

/**
 * Build a raw `CreateIdempotent` instruction for the ATA program.
 * Pulled into a helper to keep the main function readable.
 */
function buildCreateIdempotentIx(args: {
  payer: Address;
  ata: Address;
  owner: Address;
  mint: Address;
}): Instruction {
  return {
    programAddress: ATA_PROGRAM_ADDRESS,
    accounts: [
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: args.ata, role: AccountRole.WRITABLE },
      { address: args.owner, role: AccountRole.READONLY },
      { address: args.mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([CREATE_IDEMPOTENT_DISCRIMINATOR]),
  };
}
