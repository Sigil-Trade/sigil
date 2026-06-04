/**
 * M3-01 stable-floor satisfier tests.
 *
 * The on-chain `stable_balance_floor` (finalize_session) sums the vault's
 * combined USDC+USDT balance and counts ONLY each stablecoin's CANONICAL ATA
 * (M3-01 pin). Sources 1+2 (named vaultTokenAccount + outputStablecoinAccount)
 * cover the session token and — sometimes — USDC, so a vault holding reserve in
 * the OTHER stablecoin would under-count and falsely revert. These tests cover
 * the SDK satisfier that feeds the missing canonical stablecoin ATA(s) into
 * finalize's remaining_accounts on the honest seal() path:
 *
 *  - `deriveStablecoinFloorCandidates` (pure): derive both canonical stablecoin
 *    ATAs, drop any already present on finalize.
 *  - `resolveStablecoinFloorMetas` (pure): existence-filter the candidates.
 *  - `seal()` wiring: gated on stable_balance_floor > 0; feeds the other
 *    stablecoin ATA into the composed tx; no fetch / no extra account when the
 *    floor is disabled (the default).
 */
import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  seal,
  deriveStablecoinFloorCandidates,
  resolveStablecoinFloorMetas,
  type SealParams,
} from "../src/seal.js";
import { deriveAta } from "../src/tokens.js";
import { bytesToAddress } from "../src/state-resolver.js";
import {
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  type ReadonlyUint8Array,
} from "../src/kit-adapter.js";
import {
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT_DEVNET,
  USDT_MINT_DEVNET,
} from "../src/types.js";
import {
  createMockAgent,
  createMockVaultState,
  createMockRpc,
} from "../src/testing/index.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";

const addrFromByte = (b: number): Address =>
  bytesToAddress(new Uint8Array(32).fill(b));

const VAULT = addrFromByte(2);
const AGENT_ADDR = addrFromByte(3);
const OWNER_ADDR = addrFromByte(4);
const FEE_DEST = addrFromByte(5);
const OTHER_WRITABLE = addrFromByte(50);
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

const enc = getAddressEncoder();

const fakeFetched = (exists: boolean): any => ({ exists, address: VAULT });

/** An SPL token-account info as `getMultipleAccounts` returns it (exists=true). */
function splAccountInfo(mint: Address, authority: Address): unknown {
  const data = new Uint8Array(165);
  data.set(enc.encode(mint), 0);
  data.set(enc.encode(authority), 32);
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    owner: TOKEN_PROGRAM_ADDRESS,
    executable: false,
    lamports: 2_039_280n,
    rentEpoch: 0n,
    space: 165n,
  };
}

function makeCachedState(stableBalanceFloor: bigint): ResolvedVaultState {
  const base = createMockVaultState({
    vault: VAULT,
    agent: AGENT_ADDR,
    owner: OWNER_ADDR,
    feeDestination: FEE_DEST,
  });
  return { ...base, policy: { ...base.policy, stableBalanceFloor } };
}

function baseParams(overrides?: Partial<SealParams>): SealParams {
  return {
    vault: VAULT,
    agent: createMockAgent(AGENT_ADDR),
    instructions: [],
    rpc: {} as any,
    network: "devnet",
    tokenMint: USDC_MINT_DEVNET,
    amount: 100_000_000n,
    cachedState: makeCachedState(0n),
    blockhash: {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    },
    addressLookupTables: {},
    ...overrides,
  };
}

function decodeStaticAccounts(messageBytes: ReadonlyUint8Array): Address[] {
  const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
  return (decoded as any).staticAccounts as Address[];
}

const classicIx: Instruction = {
  programAddress: JUPITER,
  accounts: [{ address: OTHER_WRITABLE, role: AccountRole.WRITABLE }],
  data: new Uint8Array([1, 2, 3]),
};

// ──────────────────────────────────────────────────────────────────────────────

describe("deriveStablecoinFloorCandidates (M3-01 pure derivation)", () => {
  it("derives both canonical stablecoin ATAs when none are present", async () => {
    const usdcAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const candidates = await deriveStablecoinFloorCandidates(
      VAULT,
      USDC_MINT_DEVNET,
      USDT_MINT_DEVNET,
      new Set(),
    );
    expect(candidates).to.have.members([usdcAta, usdtAta]);
    expect(candidates).to.have.length(2);
  });

  it("drops the USDC ATA when it is already present (USDC session)", async () => {
    const usdcAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const candidates = await deriveStablecoinFloorCandidates(
      VAULT,
      USDC_MINT_DEVNET,
      USDT_MINT_DEVNET,
      new Set([usdcAta]),
    );
    expect(candidates).to.deep.equal([usdtAta]);
  });

  it("drops the USDT ATA when it is already present (USDT session)", async () => {
    const usdcAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const candidates = await deriveStablecoinFloorCandidates(
      VAULT,
      USDC_MINT_DEVNET,
      USDT_MINT_DEVNET,
      new Set([usdtAta]),
    );
    expect(candidates).to.deep.equal([usdcAta]);
  });

  it("returns empty when both stablecoin ATAs are already present", async () => {
    const usdcAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const candidates = await deriveStablecoinFloorCandidates(
      VAULT,
      USDC_MINT_DEVNET,
      USDT_MINT_DEVNET,
      new Set([usdcAta, usdtAta]),
    );
    expect(candidates).to.have.length(0);
  });
});

describe("resolveStablecoinFloorMetas (M3-01 pure existence filter)", () => {
  it("returns a READONLY meta for an existing candidate", () => {
    const cand = [VAULT];
    const metas = resolveStablecoinFloorMetas([fakeFetched(true)], cand);
    expect(metas).to.have.length(1);
    expect(metas[0].address).to.equal(VAULT);
    expect(metas[0].role).to.equal(AccountRole.READONLY);
  });

  it("skips a non-existent candidate", () => {
    const metas = resolveStablecoinFloorMetas([fakeFetched(false)], [VAULT]);
    expect(metas).to.have.length(0);
  });

  it("keeps only the existing candidates (mixed)", () => {
    const a = addrFromByte(40);
    const b = addrFromByte(41);
    const metas = resolveStablecoinFloorMetas(
      [fakeFetched(true), fakeFetched(false)],
      [a, b],
    );
    expect(metas.map((m) => m.address)).to.deep.equal([a]);
  });
});

describe("seal() M3-01 stable-floor satisfier wiring", () => {
  it("does NOT fetch / add a stablecoin ATA when the floor is disabled (0)", async () => {
    let gmaCalls = 0;
    const base = createMockRpc();
    const rpc = {
      ...base,
      getMultipleAccounts: (addrs: readonly Address[]) => {
        gmaCalls++;
        return base.getMultipleAccounts(addrs);
      },
    } as any;
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    const result = await seal(
      baseParams({
        instructions: [classicIx],
        rpc,
        cachedState: makeCachedState(0n),
      }),
    );
    expect(gmaCalls, "floor disabled → no floor fetch").to.equal(0);
    const keys = decodeStaticAccounts(result.transaction.messageBytes);
    expect(keys, "floor disabled → other stablecoin ATA absent").to.not.include(
      usdtAta,
    );
  });

  it("feeds the vault's USDT ATA into finalize when the floor is set (USDC session)", async () => {
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    let gmaCalls = 0;
    const base = createMockRpc({
      getMultipleAccountsByAddress: {
        [usdtAta]: splAccountInfo(USDT_MINT_DEVNET, VAULT),
      },
    });
    const rpc = {
      ...base,
      getMultipleAccounts: (addrs: readonly Address[]) => {
        gmaCalls++;
        return base.getMultipleAccounts(addrs);
      },
    } as any;
    const result = await seal(
      baseParams({
        instructions: [classicIx],
        rpc,
        cachedState: makeCachedState(100_000_000n),
      }),
    );
    expect(gmaCalls, "floor set → one floor fetch").to.equal(1);
    const keys = decodeStaticAccounts(result.transaction.messageBytes);
    // RED-proof anchor: passes ONLY because the satisfier appended the USDT ATA
    // to finalize's remaining_accounts. Revert the `...stablecoinFloorMetas`
    // spread in seal.ts and this assertion fails (the ATA is absent).
    expect(
      keys,
      "the vault's other-stablecoin ATA must reach the composed tx",
    ).to.include(usdtAta);
  });

  it("does NOT feed a non-existent USDT ATA (existence-gated)", async () => {
    const usdtAta = await deriveAta(VAULT, USDT_MINT_DEVNET);
    // Floor set, but the USDT ATA is NOT mocked → fetchEncodedAccounts → !exists.
    const result = await seal(
      baseParams({
        instructions: [classicIx],
        rpc: createMockRpc(),
        cachedState: makeCachedState(100_000_000n),
      }),
    );
    const keys = decodeStaticAccounts(result.transaction.messageBytes);
    expect(
      keys,
      "a non-existent other-stablecoin ATA is omitted, not fed",
    ).to.not.include(usdtAta);
  });
});
