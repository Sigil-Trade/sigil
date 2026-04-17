import { describe, it } from "mocha";
import { expect } from "chai";

import { initializeVaultAtas } from "../../src/helpers/ata.js";
import { deriveAta } from "../../src/tokens.js";
import {
  ATA_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  USDC_MINT_DEVNET,
  USDT_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "../../src/types.js";
import { AccountRole } from "../../src/kit-adapter.js";
import { SigilSdkDomainError } from "../../src/errors/sdk.js";
import { SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED } from "../../src/errors/codes.js";
import type { Address } from "../../src/kit-adapter.js";

// Deterministic test pubkeys. Using real valid-shape pubkeys (44-char
// base58 decoding to exactly 32 bytes) so @solana/kit's address codec
// accepts them. These are opaque identifiers for the purpose of these
// tests — not meant to resolve to any on-chain account.
const VAULT = "11111111111111111111111111111112" as Address; // system program + 1
const PAYER = "Sysvar1nstructions1111111111111111111111111" as Address;

describe("initializeVaultAtas — policy gate", () => {
  it("rejects a mint not present in allowedMints", async () => {
    try {
      await initializeVaultAtas({
        vault: VAULT,
        payer: PAYER,
        mints: [USDC_MINT_MAINNET],
        allowedMints: [USDC_MINT_DEVNET],
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__SPL_TOKEN_OP_BLOCKED,
      );
    }
  });

  it("rejects before any PDA derivation when the first mint is bad", async () => {
    // This verifies fail-fast: even if a later mint is valid, the first
    // invalid one short-circuits the whole call.
    try {
      await initializeVaultAtas({
        vault: VAULT,
        payer: PAYER,
        mints: [USDC_MINT_MAINNET, USDC_MINT_DEVNET],
        allowedMints: [USDC_MINT_DEVNET],
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
    }
  });

  it("error context carries the offending mint and allowedMints", async () => {
    try {
      await initializeVaultAtas({
        vault: VAULT,
        payer: PAYER,
        mints: [USDC_MINT_MAINNET],
        allowedMints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
      });
      expect.fail("expected throw");
    } catch (err) {
      const ctx = (err as SigilSdkDomainError).context as {
        mint?: string;
        allowedMints?: string[];
      };
      expect(ctx?.mint).to.equal(USDC_MINT_MAINNET);
      expect(ctx?.allowedMints).to.deep.equal([
        USDC_MINT_DEVNET,
        USDT_MINT_DEVNET,
      ]);
    }
  });
});

describe("initializeVaultAtas — instruction shape", () => {
  it("returns one createIdempotent ix per unique mint", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET, USDT_MINT_DEVNET],
    });
    expect(ixs).to.have.length(2);
  });

  it("deduplicates repeated mints in input", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET, USDC_MINT_DEVNET, USDC_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET],
    });
    expect(ixs).to.have.length(1);
  });

  it("empty mints array returns empty ix array without throw", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [],
      allowedMints: [USDC_MINT_DEVNET],
    });
    expect(ixs).to.deep.equal([]);
  });

  it("each instruction targets ATA_PROGRAM_ADDRESS", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET],
    });
    expect(ixs[0]!.programAddress).to.equal(ATA_PROGRAM_ADDRESS);
  });

  it("each instruction carries the single-byte CreateIdempotent discriminator", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET],
    });
    const data = ixs[0]!.data!;
    expect(data).to.be.instanceOf(Uint8Array);
    expect(data).to.have.length(1);
    expect(data[0]).to.equal(1); // CreateIdempotent
  });

  it("account list matches ATA program's CreateIdempotent shape", async () => {
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET],
    });
    const accounts = ixs[0]!.accounts!;
    expect(accounts).to.have.length(6);
    // [payer, ata, owner, mint, systemProgram, tokenProgram]
    expect(accounts[0]!.address).to.equal(PAYER);
    expect(accounts[0]!.role).to.equal(AccountRole.WRITABLE_SIGNER);
    // accounts[1] is the derived ATA — match it explicitly
    const expectedAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    expect(accounts[1]!.address).to.equal(expectedAta);
    expect(accounts[1]!.role).to.equal(AccountRole.WRITABLE);
    expect(accounts[2]!.address).to.equal(VAULT);
    expect(accounts[3]!.address).to.equal(USDC_MINT_DEVNET);
    expect(accounts[4]!.address).to.equal(SYSTEM_PROGRAM_ADDRESS);
    expect(accounts[5]!.address).to.equal(TOKEN_PROGRAM_ADDRESS);
  });

  it("derives canonical ATA via findAssociatedTokenPda semantics", async () => {
    // The canonical ATA derivation is [owner, TOKEN_PROGRAM, mint] under ATA_PROGRAM.
    // deriveAta implements this; we just verify the ix's second account matches.
    const ixs = await initializeVaultAtas({
      vault: VAULT,
      payer: PAYER,
      mints: [USDC_MINT_DEVNET],
      allowedMints: [USDC_MINT_DEVNET],
    });
    const expectedAta = await deriveAta(VAULT, USDC_MINT_DEVNET);
    expect(ixs[0]!.accounts![1]!.address).to.equal(expectedAta);
  });
});
