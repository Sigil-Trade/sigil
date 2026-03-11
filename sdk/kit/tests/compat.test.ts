import { expect } from "chai";
import { AccountRole } from "@solana/kit";
import {
  toKitInstruction,
  toKitAddress,
  toBigInt,
  fromKitAddress,
} from "../src/compat.js";
import type { Address } from "@solana/kit";

/** Mock a web3.js-like PublicKey */
function mockPubkey(base58: string) {
  return { toBase58: () => base58 };
}

/** Mock a web3.js-like TransactionInstruction */
function mockInstruction(
  programId: string,
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>,
  data: number[] = [],
) {
  return {
    programId: mockPubkey(programId),
    keys: keys.map((k) => ({
      pubkey: mockPubkey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(data),
  };
}

describe("compat", () => {
  describe("toKitInstruction", () => {
    it("converts programId.toBase58() to programAddress", () => {
      const ix = mockInstruction(
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        [],
      );
      const kitIx = toKitInstruction(ix);
      expect(kitIx.programAddress).to.equal(
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      );
    });

    it("maps keys to accounts with correct AccountRole", () => {
      const ix = mockInstruction(
        "11111111111111111111111111111111",
        [
          {
            pubkey: "22222222222222222222222222222222",
            isSigner: true,
            isWritable: true,
          },
          {
            pubkey: "33333333333333333333333333333333",
            isSigner: true,
            isWritable: false,
          },
          {
            pubkey: "44444444444444444444444444444444",
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: "55555555555555555555555555555555",
            isSigner: false,
            isWritable: false,
          },
        ],
      );
      const kitIx = toKitInstruction(ix);
      expect(kitIx.accounts).to.have.length(4);
      expect(kitIx.accounts![0].role).to.equal(AccountRole.WRITABLE_SIGNER);
      expect(kitIx.accounts![1].role).to.equal(AccountRole.READONLY_SIGNER);
      expect(kitIx.accounts![2].role).to.equal(AccountRole.WRITABLE);
      expect(kitIx.accounts![3].role).to.equal(AccountRole.READONLY);
    });

    it("data converted to Uint8Array", () => {
      const ix = mockInstruction(
        "11111111111111111111111111111111",
        [],
        [0xaa, 0xbb, 0xcc],
      );
      const kitIx = toKitInstruction(ix);
      expect(kitIx.data).to.be.instanceOf(Uint8Array);
      expect(Array.from(kitIx.data as Uint8Array)).to.deep.equal([0xaa, 0xbb, 0xcc]);
    });
  });

  describe("toKitAddress", () => {
    it("converts pubkey.toBase58() to Address", () => {
      const addr = toKitAddress(
        mockPubkey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      );
      expect(addr).to.equal("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(typeof addr).to.equal("string");
    });

    it("returns string", () => {
      const addr = toKitAddress(
        mockPubkey("11111111111111111111111111111111"),
      );
      expect(addr).to.be.a("string");
    });
  });

  describe("toBigInt", () => {
    it("converts bn.toString() to bigint", () => {
      const bn = { toString: (base?: number) => "1000000" };
      expect(toBigInt(bn)).to.equal(1_000_000n);
    });

    it("handles large values", () => {
      const large = "18446744073709551615"; // u64::MAX
      const bn = { toString: () => large };
      expect(toBigInt(bn)).to.equal(18_446_744_073_709_551_615n);
    });
  });

  describe("fromKitAddress", () => {
    it("returns Address as string (identity)", () => {
      const address =
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
      const result = fromKitAddress(address);
      expect(result).to.equal("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(typeof result).to.equal("string");
    });
  });
});
