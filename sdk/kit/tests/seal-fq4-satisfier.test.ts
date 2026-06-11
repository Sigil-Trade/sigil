/**
 * F-Q4 honest-path satisfier tests.
 *
 * The on-chain F-Q4 gate (validate_and_authorize → destination_check) vets the
 * mint EXTENSIONS of any vault-owned Token-2022 token account a swap delivers
 * into the vault, and REQUIRES that mint resolvable in validate's
 * remaining_accounts (else `ErrToken2022OutputMintUnresolvable` 6106). These
 * tests cover the SDK satisfier that feeds those mints on the honest seal() path:
 *
 *  - `resolveT22OutputMintMetas` (pure): mirrors the on-chain demand exactly
 *    (T22-owned + data.len>=72 + authority[32..64]===vault) and dedups mints.
 *  - `seal()` wiring: the T22-presence perf gate (no fetch for classic bundles)
 *    and the end-to-end proof that a resolved mint reaches validate's accounts.
 */
import { expect } from "chai";
import type { Address, Instruction } from "@solana/kit";
import { AccountRole } from "@solana/kit";
import {
  seal,
  resolveT22OutputMintMetas,
  type SealParams,
} from "../src/seal.js";
import { bytesToAddress } from "../src/state-resolver.js";
import {
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  type ReadonlyUint8Array,
} from "../src/kit-adapter.js";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../src/types.js";
import {
  createMockAgent,
  createMockVaultState,
  createMockRpc,
} from "../src/testing/index.js";
import type { ResolvedVaultState } from "../src/state-resolver.js";

// ─── Deterministic test addresses (valid base58 via the address codec) ────────

const addrFromByte = (b: number): Address =>
  bytesToAddress(new Uint8Array(32).fill(b));

const VAULT = addrFromByte(2);
const AGENT_ADDR = addrFromByte(3);
const OWNER_ADDR = addrFromByte(4);
const FEE_DEST = addrFromByte(5);
const OUTPUT_T22_ATA = addrFromByte(9);
const OUTPUT_T22_ATA_2 = addrFromByte(10);
const T22_MINT = addrFromByte(7);
const T22_MINT_2 = addrFromByte(8);
const OTHER_WALLET = addrFromByte(99);
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

const enc = getAddressEncoder();

// ─── Pure-helper fixtures ─────────────────────────────────────────────────────

/** Build a fake `fetchEncodedAccounts` entry for an EXISTING account. */
function fakeAccount(opts: {
  programAddress: Address;
  mint?: Address;
  authority?: Address;
  len?: number;
}): any {
  const len = opts.len ?? 72;
  const data = new Uint8Array(len);
  if (opts.mint && len >= 32) data.set(enc.encode(opts.mint), 0);
  if (opts.authority && len >= 64) data.set(enc.encode(opts.authority), 32);
  return {
    exists: true,
    address: OUTPUT_T22_ATA,
    programAddress: opts.programAddress,
    data,
    executable: false,
    lamports: 0n,
    space: BigInt(len),
  };
}

const fakeNonexistent = (): any => ({ exists: false, address: OUTPUT_T22_ATA });

// ─── seal() fixtures ──────────────────────────────────────────────────────────

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
    rpc: {} as any,
    network: "devnet",
    tokenMint: USDC_DEVNET,
    amount: 100_000_000n,
    cachedState: makeCachedState(),
    blockhash: {
      blockhash: "GHtXQBpokCiBP6spMNfMW9qLBjfQJhmR4GWzCiQ2ATQA",
      lastValidBlockHeight: 200n,
    },
    // Disable ALT resolution so every account lands in staticAccounts (and so
    // the mock RPC is only ever exercised by the F-Q4 satisfier's fetch).
    addressLookupTables: {},
    ...overrides,
  };
}

/** A JSON-RPC account-info value as `getMultipleAccounts` returns it. */
function t22AccountInfo(mint: Address, authority: Address): unknown {
  const data = new Uint8Array(72);
  data.set(enc.encode(mint), 0);
  data.set(enc.encode(authority), 32);
  return {
    data: [Buffer.from(data).toString("base64"), "base64"],
    owner: TOKEN_2022_PROGRAM_ADDRESS,
    executable: false,
    lamports: 2_039_280n,
    rentEpoch: 0n,
    space: 72n,
  };
}

function decodeStaticAccounts(messageBytes: ReadonlyUint8Array): Address[] {
  const decoded = getCompiledTransactionMessageDecoder().decode(messageBytes);
  return (decoded as any).staticAccounts as Address[];
}

// ──────────────────────────────────────────────────────────────────────────────

describe("resolveT22OutputMintMetas (F-Q4 pure resolver)", () => {
  it("returns the mint (READONLY) for a vault-owned Token-2022 token account", () => {
    const metas = resolveT22OutputMintMetas(
      [
        fakeAccount({
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
          mint: T22_MINT,
          authority: VAULT,
        }),
      ],
      VAULT,
      new Set(),
    );
    expect(metas).to.have.length(1);
    expect(metas[0].address).to.equal(T22_MINT);
    expect(metas[0].role).to.equal(AccountRole.READONLY);
  });

  it("skips a classic SPL-Token account (programAddress not Token-2022)", () => {
    const metas = resolveT22OutputMintMetas(
      [
        fakeAccount({
          programAddress: TOKEN_PROGRAM_ADDRESS,
          mint: T22_MINT,
          authority: VAULT,
        }),
      ],
      VAULT,
      new Set(),
    );
    expect(metas).to.have.length(0);
  });

  it("skips a Token-2022 account NOT owned by the vault", () => {
    const metas = resolveT22OutputMintMetas(
      [
        fakeAccount({
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
          mint: T22_MINT,
          authority: OTHER_WALLET,
        }),
      ],
      VAULT,
      new Set(),
    );
    expect(metas).to.have.length(0);
  });

  it("skips an account shorter than 72 bytes (mirrors on-chain length guard)", () => {
    const metas = resolveT22OutputMintMetas(
      [
        fakeAccount({
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
          mint: T22_MINT,
          authority: VAULT,
          len: 71,
        }),
      ],
      VAULT,
      new Set(),
    );
    expect(metas).to.have.length(0);
  });

  it("skips a non-existent account (stale/lagging RPC view)", () => {
    const metas = resolveT22OutputMintMetas(
      [fakeNonexistent()],
      VAULT,
      new Set(),
    );
    expect(metas).to.have.length(0);
  });

  it("dedups the same mint across two vault-owned T22 accounts (one meta)", () => {
    const a = fakeAccount({
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      mint: T22_MINT,
      authority: VAULT,
    });
    const b = {
      ...fakeAccount({
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        mint: T22_MINT,
        authority: VAULT,
      }),
      address: OUTPUT_T22_ATA_2,
    };
    const metas = resolveT22OutputMintMetas([a, b], VAULT, new Set());
    expect(metas).to.have.length(1);
    expect(metas[0].address).to.equal(T22_MINT);
  });

  it("returns distinct metas for two different vault-owned T22 mints", () => {
    const a = fakeAccount({
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      mint: T22_MINT,
      authority: VAULT,
    });
    const b = {
      ...fakeAccount({
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        mint: T22_MINT_2,
        authority: VAULT,
      }),
      address: OUTPUT_T22_ATA_2,
    };
    const metas = resolveT22OutputMintMetas([a, b], VAULT, new Set());
    const mints = metas.map((m) => m.address);
    expect(mints).to.have.members([T22_MINT, T22_MINT_2]);
    expect(metas).to.have.length(2);
  });

  it("does not re-add a mint already present in the writable set (alreadySeen)", () => {
    const metas = resolveT22OutputMintMetas(
      [
        fakeAccount({
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
          mint: T22_MINT,
          authority: VAULT,
        }),
      ],
      VAULT,
      new Set([T22_MINT]),
    );
    expect(metas).to.have.length(0);
  });
});

describe("seal() F-Q4 satisfier wiring", () => {
  it("does NOT fetch (getMultipleAccounts) for a classic bundle with no Token-2022 program", async () => {
    let gmaCalls = 0;
    const base = createMockRpc();
    const rpc = {
      ...base,
      getMultipleAccounts: () => {
        gmaCalls++;
        return {
          send: async () => {
            throw new Error("F-Q4 gate should have skipped the fetch");
          },
        };
      },
    } as any;
    const classicIx: Instruction = {
      programAddress: JUPITER,
      accounts: [{ address: VAULT, role: AccountRole.WRITABLE }],
      data: new Uint8Array([1, 2, 3]),
    };
    const result = await seal(baseParams({ instructions: [classicIx], rpc }));
    expect(result.transaction).to.exist;
    expect(
      gmaCalls,
      "no T22 program in bundle → gate must skip the fetch",
    ).to.equal(0);
  });

  it("fetches and feeds the vault-owned T22 output mint into the composed tx (end-to-end)", async () => {
    let gmaCalls = 0;
    const base = createMockRpc({
      getMultipleAccountsByAddress: {
        [OUTPUT_T22_ATA]: t22AccountInfo(T22_MINT, VAULT),
      },
    });
    const rpc = {
      ...base,
      getMultipleAccounts: (addrs: readonly Address[]) => {
        gmaCalls++;
        return base.getMultipleAccounts(addrs);
      },
    } as any;
    const t22SwapIx: Instruction = {
      programAddress: JUPITER,
      accounts: [
        { address: OUTPUT_T22_ATA, role: AccountRole.WRITABLE },
        { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1, 2, 3]),
    };
    const result = await seal(baseParams({ instructions: [t22SwapIx], rpc }));

    expect(
      gmaCalls,
      "T22 in bundle → gate must fetch the writable set",
    ).to.equal(1);
    const keys = decodeStaticAccounts(result.transaction.messageBytes);
    // RED-proof anchor: this passes ONLY because the satisfier appended the mint
    // to validate's remaining_accounts. Revert the `...t22OutputMintReadonlyMetas`
    // spread in seal.ts and this assertion fails (the mint is absent).
    expect(
      keys,
      "resolved vault-owned T22 output mint must reach the tx",
    ).to.include(T22_MINT);
  });

  it("fails CLOSED with a contextual error when the F-Q4 fetch RPC throws", async () => {
    const base = createMockRpc();
    const rpc = {
      ...base,
      getMultipleAccounts: () => ({
        send: async () => {
          throw new Error("simulated RPC outage");
        },
      }),
    } as any;
    const t22SwapIx: Instruction = {
      programAddress: JUPITER,
      accounts: [
        { address: OUTPUT_T22_ATA, role: AccountRole.WRITABLE },
        { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([1, 2, 3]),
    };
    let threw = false;
    try {
      await seal(baseParams({ instructions: [t22SwapIx], rpc }));
    } catch (e: any) {
      threw = true;
      // The error must name the F-Q4 step (not a raw opaque RPC error).
      expect(e.message).to.include("F-Q4 output-mint resolution failed");
    }
    expect(
      threw,
      "seal() must reject (fail-closed) when the F-Q4 fetch RPC throws",
    ).to.equal(true);
  });
});
