/**
 * initializeVaultAtas — build ATA `CreateIdempotent` instructions for a
 * Sigil vault with a caller-asserted allowlist check.
 *
 * **This is not a security gate.** The real security surface is the
 * on-chain program: Sigil's `validate_and_authorize` path checks the
 * vault-policy allowlist against every mint touched by the DeFi
 * instructions that actually execute. `initializeVaultAtas` is a
 * thin authoring helper — it builds correct ATA-program instructions
 * AND performs a client-side sanity check that each `mint` is in the
 * `allowedMints` list the caller already decided is valid.
 *
 * The allowlist is **caller-supplied** on purpose: this helper has no
 * RPC dependency, so it can be used inside `createVault` pipelines
 * where the policy object is in memory but not yet on-chain. Callers
 * who already have a resolved `PolicyConfig` should pass
 * `allowedMints: policy.allowedDestinations` (plus any stablecoin mints
 * the owner is wiring up). Callers who pass `allowedMints: mints`
 * (tautological) get no safety value from this helper — they're only
 * using it for the manual instruction-building.
 *
 * The historical naming tied this helper to "F8 closure"; that framing
 * was misleading. F8 is closed by the on-chain protocol, not by this
 * function. Keep the name for API stability; the docstring is the
 * contract.
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
 *   // Typical usage: allowedMints derived from the vault's policy.
 *   const ixs = await initializeVaultAtas({
 *     vault: vaultPda,
 *     payer: ownerSigner.address,
 *     mints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
 *     allowedMints: [
 *       ...policy.allowedDestinations,
 *       USDC_MINT_DEVNET,
 *       USDT_MINT_DEVNET,
 *     ],
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
