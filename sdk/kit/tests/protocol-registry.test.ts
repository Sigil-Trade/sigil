/**
 * Unit tests for `@usesigil/kit/protocol-registry`.
 *
 * The registry is the ONE source of truth for Sigil's Verified-tier
 * classification (FE↔BE contract §5c). Every downstream consumer
 * (dashboard, mobile, MCP, CLI) imports from here. These tests pin:
 *
 *   - The exact set of verified programs (change-detection test — new
 *     protocols MUST be added consciously, not accidentally).
 *   - `lookupProtocolAnnotation` happy + miss paths.
 *   - `VERIFIED_PROGRAMS` derivation correctness (every registered
 *     annotation's programId appears in the set).
 *   - Structural integrity of the annotation JSONs (no missing fields,
 *     no `verified: false` entries, no duplicate programIds).
 */
import { expect } from "chai";
import {
  PROTOCOL_ANNOTATIONS,
  VERIFIED_PROGRAMS,
  lookupProtocolAnnotation,
  type ProtocolAnnotation,
} from "../src/protocol-registry/index.js";

describe("protocol-registry — PROTOCOL_ANNOTATIONS", () => {
  it("has exactly 7 entries (change-detection guard)", () => {
    // Adding a protocol REQUIRES updating this count. Prevents silent
    // registry additions from slipping in without review.
    expect(PROTOCOL_ANNOTATIONS).to.have.lengthOf(7);
  });

  it("every entry has verified === true", () => {
    for (const a of PROTOCOL_ANNOTATIONS) {
      expect(a.verified, `${a.name} verified`).to.equal(true);
    }
  });

  it("every entry has required fields: programId, name, category", () => {
    for (const a of PROTOCOL_ANNOTATIONS) {
      expect(a.programId, `${a.name} programId`).to.be.a("string").and.not
        .empty;
      expect(a.name, `${a.name} name`).to.be.a("string").and.not.empty;
      expect(a.category, `${a.name} category`).to.be.a("string").and.not.empty;
    }
  });

  it("programIds are unique across the registry (no duplicates)", () => {
    const ids = PROTOCOL_ANNOTATIONS.map((a) => a.programId);
    const uniq = new Set(ids);
    expect(uniq.size).to.equal(ids.length);
  });

  it("named anchor programs present (Jupiter, Flash Trade, Drift, Kamino)", () => {
    const names = PROTOCOL_ANNOTATIONS.map((a) => a.name);
    expect(names).to.include.members([
      "Jupiter",
      "Flash Trade",
      "Drift",
      "Kamino",
    ]);
  });
});

describe("protocol-registry — VERIFIED_PROGRAMS", () => {
  it("is a ReadonlySet<string>", () => {
    expect(VERIFIED_PROGRAMS).to.be.instanceOf(Set);
  });

  it("contains every registered annotation's programId", () => {
    for (const a of PROTOCOL_ANNOTATIONS) {
      expect(VERIFIED_PROGRAMS.has(a.programId), `has ${a.name}`).to.equal(
        true,
      );
    }
  });

  it("size matches the annotations array length (no ghost entries)", () => {
    expect(VERIFIED_PROGRAMS.size).to.equal(PROTOCOL_ANNOTATIONS.length);
  });

  it("does not contain an unknown programId", () => {
    expect(VERIFIED_PROGRAMS.has("11111111111111111111111111111111")).to.equal(
      false,
    );
  });
});

describe("protocol-registry — lookupProtocolAnnotation()", () => {
  it("returns the Jupiter annotation for Jupiter's programId", () => {
    const jupiter = PROTOCOL_ANNOTATIONS.find((a) => a.name === "Jupiter");
    expect(jupiter, "Jupiter annotation present").to.exist;
    const found = lookupProtocolAnnotation(jupiter!.programId);
    expect(found).to.deep.equal(jupiter);
  });

  it("returns the Flash Trade annotation for Flash Trade's programId", () => {
    const flash = PROTOCOL_ANNOTATIONS.find((a) => a.name === "Flash Trade");
    expect(flash, "Flash Trade annotation present").to.exist;
    const found = lookupProtocolAnnotation(flash!.programId);
    expect(found).to.deep.equal(flash);
  });

  it("returns null for an unknown programId", () => {
    expect(
      lookupProtocolAnnotation("11111111111111111111111111111111"),
    ).to.equal(null);
  });

  it("returns null for an empty string", () => {
    expect(lookupProtocolAnnotation("")).to.equal(null);
  });

  it("is case-sensitive on programId match (Solana addresses are case-significant)", () => {
    const jupiter = PROTOCOL_ANNOTATIONS.find((a) => a.name === "Jupiter");
    const lowered = jupiter!.programId.toLowerCase();
    // base58 has no universal casing rule but Solana addresses ARE
    // case-sensitive — lowercasing changes the address identity.
    if (lowered !== jupiter!.programId) {
      expect(lookupProtocolAnnotation(lowered)).to.equal(null);
    }
  });
});

describe("protocol-registry — ProtocolAnnotation type", () => {
  it("optional `notes` field present on at least one annotation (schema coverage)", () => {
    // Asserts the optional field is represented somewhere in the registry
    // so TypeScript's structural checks exercise the `notes?: string` path.
    const withNotes = PROTOCOL_ANNOTATIONS.filter(
      (a): a is ProtocolAnnotation & { notes: string } =>
        typeof a.notes === "string" && a.notes.length > 0,
    );
    expect(
      withNotes.length,
      "at least one annotation has notes",
    ).to.be.at.least(1);
  });
});
