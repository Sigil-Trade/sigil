/**
 * Unit tests for the verified-build program-hash helper (Item 3, SDK side).
 *
 * These assert the helper hashes exactly the bytes the on-chain check hashes —
 * the ProgramData ELF past the 45-byte header — and fails closed on every
 * malformed input, so an owner can never silently pin a hash over a
 * non-program, a non-upgradeable account, or a truncated RPC response.
 */
import { expect } from "chai";
import type { Address } from "@solana/kit";
import {
  getProgramDataHash,
  getProgramDataAddress,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  PROGRAM_DATA_HEADER_LEN,
} from "../src/program-hash.js";
import { sha256 } from "../src/canonical-encode.js";

const PROGRAM_ID = "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK" as Address;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Build a fake ProgramData account buffer: 45-byte header + ELF payload. */
function fakeProgramData(elf: Uint8Array): Uint8Array {
  const data = new Uint8Array(PROGRAM_DATA_HEADER_LEN + elf.length);
  data[0] = 3; // UpgradeableLoaderState::ProgramData enum discriminant
  data.set(elf, PROGRAM_DATA_HEADER_LEN);
  return data;
}

function mockRpc(account: unknown) {
  return {
    getAccountInfo: () => ({ send: async () => ({ value: account }) }),
  } as never;
}

async function expectReject(
  p: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch (e) {
    threw = true;
    expect((e as Error).message).to.match(pattern);
  }
  expect(threw, "expected the call to throw").to.equal(true);
}

describe("program-hash (verified-build gate, SDK side)", () => {
  it("hashes the ELF past the 45-byte ProgramData header", async () => {
    const elf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const data = fakeProgramData(elf);
    const rpc = mockRpc({
      owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      data: [bytesToBase64(data), "base64"],
    });
    const hash = await getProgramDataHash(rpc, PROGRAM_ID);
    expect(hash.length).to.equal(32);
    expect(Array.from(hash)).to.deep.equal(Array.from(sha256(elf)));
  });

  it("is sensitive to the ELF — a different build yields a different hash", async () => {
    const a = fakeProgramData(new Uint8Array([1, 2, 3]));
    const b = fakeProgramData(new Uint8Array([1, 2, 4]));
    const hashA = await getProgramDataHash(
      mockRpc({
        owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        data: [bytesToBase64(a), "base64"],
      }),
      PROGRAM_ID,
    );
    const hashB = await getProgramDataHash(
      mockRpc({
        owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        data: [bytesToBase64(b), "base64"],
      }),
      PROGRAM_ID,
    );
    expect(Array.from(hashA)).to.not.deep.equal(Array.from(hashB));
  });

  it("ignores header bytes — a slot/authority change yields the same hash", async () => {
    const elf = new Uint8Array([9, 9, 9, 9, 9, 9]);
    const d1 = fakeProgramData(elf);
    const d2 = fakeProgramData(elf);
    d2[4] = 123; // mutate a slot byte
    d2[13] = 1; // mutate the Option<Pubkey> tag region
    d2[20] = 77; // mutate an authority byte
    const h1 = await getProgramDataHash(
      mockRpc({
        owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        data: [bytesToBase64(d1), "base64"],
      }),
      PROGRAM_ID,
    );
    const h2 = await getProgramDataHash(
      mockRpc({
        owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
        data: [bytesToBase64(d2), "base64"],
      }),
      PROGRAM_ID,
    );
    expect(Array.from(h1)).to.deep.equal(Array.from(h2));
  });

  it("throws when the ProgramData account does not exist", async () => {
    await expectReject(
      getProgramDataHash(mockRpc(null), PROGRAM_ID),
      /not found/,
    );
  });

  it("throws when the account is not owned by BPFLoaderUpgradeable", async () => {
    const data = fakeProgramData(new Uint8Array([1, 2, 3, 4, 5]));
    await expectReject(
      getProgramDataHash(
        mockRpc({ owner: PROGRAM_ID, data: [bytesToBase64(data), "base64"] }),
        PROGRAM_ID,
      ),
      /not owned by BPFLoaderUpgradeable/,
    );
  });

  it("throws when the account is too small to contain an ELF past the header", async () => {
    const headerOnly = new Uint8Array(PROGRAM_DATA_HEADER_LEN);
    await expectReject(
      getProgramDataHash(
        mockRpc({
          owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
          data: [bytesToBase64(headerOnly), "base64"],
        }),
        PROGRAM_ID,
      ),
      /too small/,
    );
  });

  it("derives the ProgramData PDA under BPFLoaderUpgradeable deterministically", async () => {
    const pda = await getProgramDataAddress(PROGRAM_ID);
    expect(typeof pda).to.equal("string");
    expect(pda.length).to.be.greaterThan(31);
    expect(await getProgramDataAddress(PROGRAM_ID)).to.equal(pda);
  });
});
