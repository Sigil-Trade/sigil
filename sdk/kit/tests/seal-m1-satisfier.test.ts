/**
 * M1 output-ownership satisfier tests (on-chain error 6112).
 *
 * The on-chain M1 gate (`finalize_session::enforce_output_ownership`) MANDATES
 * that a STABLECOIN-input acquiring swap land its output in a VAULT-OWNED account
 * whose balance strictly INCREASED, else revert 6112. These tests cover seal()'s
 * satisfier:
 *   - It FAILS LOUD when a stablecoin-input acquiring swap omits `outputSwapMint`
 *     (Sigil never infers what the agent is buying) or sets it equal to the input.
 *   - On the happy path it pins the vault's ATA for `outputSwapMint` and rewrites
 *     the swap's output destination (the agent's ATA for the acquired mint) to it,
 *     so the swap delivers into the vault and satisfies the on-chain gate.
 */
import { expect } from "chai";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { seal, type SealParams } from "../src/seal.js";
import { bytesToAddress } from "../src/state-resolver.js";
import {
  getCompiledTransactionMessageDecoder,
  type ReadonlyUint8Array,
} from "../src/kit-adapter.js";
import { deriveAta } from "../src/tokens.js";
import {
  createMockAgent,
  createMockVaultState,
  createMockRpc,
} from "../src/testing/index.js";
import { SIGIL_ERROR__SDK__INVALID_PARAMS } from "../src/errors/index.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";

const addrFromByte = (b: number): Address =>
  bytesToAddress(new Uint8Array(32).fill(b));

const VAULT = addrFromByte(2);
const AGENT_ADDR = addrFromByte(3);
const OWNER_ADDR = addrFromByte(4);
const FEE_DEST = addrFromByte(5);
const ACQUIRED_MINT = addrFromByte(20); // a non-stablecoin the agent buys
// Must match the SDK's recognized devnet stablecoin (types.ts USDC_MINT_DEVNET)
const USDC_DEVNET = "DMFEQFCRsvGrYzoL2gfwTEd9J8eVBQEjg7HjbJHd6oGH" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

function decodeStaticAccounts(messageBytes: ReadonlyUint8Array): Address[] {
  const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
  return (decoded as any).staticAccounts as Address[];
}

function makeCachedState(): ResolvedVaultState {
  return createMockVaultState({
    vault: VAULT,
    agent: AGENT_ADDR,
    owner: OWNER_ADDR,
    feeDestination: FEE_DEST,
  });
}

function baseParams(overrides?: Partial<SealParams>): SealParams {
  return {
    vault: VAULT,
    agent: createMockAgent(AGENT_ADDR),
    instructions: [],
    // getAccountInfo returns an existing account so the output-swap existence
    // check passes without a warning.
    rpc: createMockRpc({
      getAccountInfoResult: { value: { lamports: 2_039_280n } },
    }) as never,
    network: "devnet",
    tokenMint: USDC_DEVNET, // stablecoin input → triggers the M1 satisfier
    amount: 100_000_000n, // spending
    cachedState: makeCachedState(),
    blockhash: {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    },
    addressLookupTables: {}, // keep accounts in staticAccounts for decoding
    ...overrides,
  };
}

const swapIxTo = (dest: Address): Instruction => ({
  programAddress: JUPITER,
  accounts: [{ address: dest, role: AccountRole.WRITABLE }],
  data: new Uint8Array([1, 2, 3]),
});

describe("seal() M1 output-ownership satisfier (err 6112)", () => {
  it("FAILS LOUD when a stablecoin-input acquiring swap omits outputSwapMint", async () => {
    let threw: any;
    try {
      await seal(baseParams({ instructions: [swapIxTo(VAULT)] }));
    } catch (e) {
      threw = e;
    }
    expect(threw, "must throw when outputSwapMint is missing").to.exist;
    expect(threw.code ?? threw.message).to.satisfy(
      (v: string) =>
        v === SIGIL_ERROR__SDK__INVALID_PARAMS || /outputSwapMint/.test(v),
    );
  });

  it("FAILS LOUD when outputSwapMint equals the input tokenMint", async () => {
    let threw: any;
    try {
      await seal(
        baseParams({
          instructions: [swapIxTo(VAULT)],
          outputSwapMint: USDC_DEVNET,
        }),
      );
    } catch (e) {
      threw = e;
    }
    expect(threw, "must throw when outputSwapMint === tokenMint").to.exist;
    expect(threw.code ?? threw.message).to.satisfy(
      (v: string) =>
        v === SIGIL_ERROR__SDK__INVALID_PARAMS || /differ/i.test(v),
    );
  });

  it("pins the vault output ATA and rewrites the swap output to it (end-to-end)", async () => {
    const vaultSwapAta = await deriveAta(VAULT, ACQUIRED_MINT);
    const agentSwapAta = await deriveAta(AGENT_ADDR, ACQUIRED_MINT);
    // The agent built the swap to deliver the acquired mint into ITS OWN ATA —
    // seal() must rewrite that to the vault's ATA (the M1 redirection defense).
    const result = await seal(
      baseParams({
        instructions: [swapIxTo(agentSwapAta)],
        outputSwapMint: ACQUIRED_MINT,
      }),
    );
    const keys = decodeStaticAccounts(result.transaction.messageBytes);
    // RED-proof: passes ONLY because the satisfier pinned outputSwapAccount on
    // validate/finalize AND rewrote the swap output to the vault ATA. Revert the
    // seal.ts M1 block and the vault ATA is absent / the agent ATA survives.
    expect(
      keys,
      "vault output-swap ATA must be pinned into the tx",
    ).to.include(vaultSwapAta);
    expect(
      keys,
      "agent's acquired-mint ATA must be rewritten OUT of the tx",
    ).to.not.include(agentSwapAta);
  });
});
