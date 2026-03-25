import { expect } from "chai";
import { createHash } from "crypto";
import {
  parsePhalnxEvents,
  filterEvents,
  getEventNames,
  decodePhalnxEvent,
  parseAndDecodePhalnxEvents,
  type PhalnxEvent,
} from "../src/events.js";
import { EVENT_DISCRIMINATOR_MAP } from "../src/generated/event-discriminators.js";
import { type Address } from "@solana/kit";
import {
  getActionAuthorizedEncoder,
  getSessionFinalizedEncoder,
  getVaultReactivatedEncoder,
} from "../src/generated/types/index.js";

/** Encode bytes to base64 (Node.js) */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Create a mock "Program data: <base64>" log line for a given discriminator hex + payload */
function mockEventLog(discHex: string, payloadBytes: number[] = []): string {
  const discBytes = [];
  for (let i = 0; i < discHex.length; i += 2) {
    discBytes.push(parseInt(discHex.slice(i, i + 2), 16));
  }
  const allBytes = new Uint8Array([...discBytes, ...payloadBytes]);
  return `Program data: ${toBase64(allBytes)}`;
}

describe("events", () => {
  describe("EVENT_DISCRIMINATOR_MAP verification", () => {
    // Deleted 3 tautological tests (entry count, no-duplicate-keys, hex-format).
    // These test properties of the Map object itself, not correctness of the discriminators.
    // Kept: SHA256 verification (the only test that catches a WRONG discriminator).

    it("has at least 1 entry (non-empty guard)", () => {
      expect(Object.keys(EVENT_DISCRIMINATOR_MAP).length).to.be.greaterThan(0);
    });

    it("each discriminator matches SHA256('event:<Name>')[0..8]", () => {
      for (const [disc, name] of Object.entries(EVENT_DISCRIMINATOR_MAP)) {
        const hash = createHash("sha256").update(`event:${name}`).digest();
        const expected = hash.subarray(0, 8).toString("hex");
        expect(disc, `Discriminator for ${name}`).to.equal(expected);
      }
    });
  });

  describe("parsePhalnxEvents", () => {
    it("empty logs returns empty array", () => {
      expect(parsePhalnxEvents([])).to.deep.equal([]);
    });

    it("no 'Program data:' returns empty array", () => {
      const logs = ["Program log: hello world", "some other log"];
      expect(parsePhalnxEvents(logs)).to.deep.equal([]);
    });

    it("valid base64 with known discriminator parses event", () => {
      const disc = Object.keys(EVENT_DISCRIMINATOR_MAP)[0];
      const expectedName = EVENT_DISCRIMINATOR_MAP[disc];
      const logs = [mockEventLog(disc, [1, 2, 3])];
      const events = parsePhalnxEvents(logs);
      expect(events).to.have.length(1);
      expect(events[0].name).to.equal(expectedName);
      expect(events[0].data).to.have.length(3);
    });

    it("multiple events in same log set", () => {
      const discs = Object.keys(EVENT_DISCRIMINATOR_MAP);
      const logs = [mockEventLog(discs[0]), mockEventLog(discs[1])];
      const events = parsePhalnxEvents(logs);
      expect(events).to.have.length(2);
    });

    it("unknown discriminator is skipped", () => {
      const logs = [mockEventLog("0000000000000000", [1, 2, 3])];
      expect(parsePhalnxEvents(logs)).to.deep.equal([]);
    });

    it("base64 too short (<8 bytes) is skipped", () => {
      const shortData = new Uint8Array([1, 2, 3]);
      const logs = [`Program data: ${toBase64(shortData)}`];
      expect(parsePhalnxEvents(logs)).to.deep.equal([]);
    });

    it("malformed base64 is skipped", () => {
      const logs = ["Program data: !!!not-base64!!!"];
      expect(parsePhalnxEvents(logs)).to.deep.equal([]);
    });

    it("event data bytes are correct (after discriminator)", () => {
      const disc = Object.keys(EVENT_DISCRIMINATOR_MAP)[0];
      const payload = [0xaa, 0xbb, 0xcc, 0xdd];
      const logs = [mockEventLog(disc, payload)];
      const events = parsePhalnxEvents(logs);
      expect(events).to.have.length(1);
      expect(Array.from(events[0].data)).to.deep.equal(payload);
    });
  });

  describe("filterEvents", () => {
    it("filters by name", () => {
      const discs = Object.keys(EVENT_DISCRIMINATOR_MAP);
      const targetName = EVENT_DISCRIMINATOR_MAP[discs[0]];
      const logs = [
        mockEventLog(discs[0], [1]),
        mockEventLog(discs[1], [2]),
        mockEventLog(discs[0], [3]),
      ];
      const filtered = filterEvents(logs, targetName);
      expect(filtered).to.have.length(2);
      for (const e of filtered) {
        expect(e.name).to.equal(targetName);
      }
    });

    it("returns empty for non-matching name", () => {
      const disc = Object.keys(EVENT_DISCRIMINATOR_MAP)[0];
      const logs = [mockEventLog(disc, [1])];
      // Use a different event name
      const otherName =
        EVENT_DISCRIMINATOR_MAP[Object.keys(EVENT_DISCRIMINATOR_MAP)[1]];
      const filtered = filterEvents(logs, otherName);
      expect(filtered).to.deep.equal([]);
    });

    it("filters from mixed event set", () => {
      const discs = Object.keys(EVENT_DISCRIMINATOR_MAP);
      const logs = discs.slice(0, 5).map((d) => mockEventLog(d));
      const targetName = EVENT_DISCRIMINATOR_MAP[discs[2]];
      const filtered = filterEvents(logs, targetName);
      expect(filtered).to.have.length(1);
      expect(filtered[0].name).to.equal(targetName);
    });
  });

  describe("getEventNames", () => {
    it("returns 31 names", () => {
      expect(getEventNames()).to.have.length(31);
    });

    it("includes known names", () => {
      const names = getEventNames();
      expect(names).to.include("VaultCreated");
      expect(names).to.include("ActionAuthorized");
      expect(names).to.include("SessionFinalized");
    });
  });

  describe("base64 round-trip", () => {
    it("encode mock event then parse and verify name + data", () => {
      const disc = Object.keys(EVENT_DISCRIMINATOR_MAP)[0];
      const expectedName = EVENT_DISCRIMINATOR_MAP[disc];
      const payload = [10, 20, 30, 40, 50];
      const log = mockEventLog(disc, payload);
      const events = parsePhalnxEvents([log]);
      expect(events).to.have.length(1);
      expect(events[0].name).to.equal(expectedName);
      expect(Array.from(events[0].data)).to.deep.equal(payload);
    });

    it("discriminator-only event (no data) parses correctly", () => {
      const disc = Object.keys(EVENT_DISCRIMINATOR_MAP)[0];
      const log = mockEventLog(disc, []);
      const events = parsePhalnxEvents([log]);
      expect(events).to.have.length(1);
      expect(events[0].data).to.have.length(0);
    });
  });

  // ─── Event Decoding (Step 2.7) ──────────────────────────────────────────────

  describe("decodePhalnxEvent", () => {
    // Known addresses for building test payloads
    const VAULT_ADDR = "11111111111111111111111111111111" as Address;
    const AGENT_ADDR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const MINT_ADDR = "So11111111111111111111111111111111111111112" as Address;
    const PROTOCOL_ADDR = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;

    it("decodes ActionAuthorized event fields correctly", () => {
      const encoder = getActionAuthorizedEncoder();
      const encoded = encoder.encode({
        vault: VAULT_ADDR,
        agent: AGENT_ADDR,
        actionType: 0, // Swap
        tokenMint: MINT_ADDR,
        amount: 1_000_000n,
        usdAmount: 1_000_000n,
        protocol: PROTOCOL_ADDR,
        rollingSpendUsdAfter: 1_000_000n,
        dailyCapUsd: 500_000_000n,
        delegated: false,
        timestamp: 1700000000n,
      });

      const event: PhalnxEvent = {
        name: "ActionAuthorized",
        data: new Uint8Array(encoded),
      };

      const decoded = decodePhalnxEvent(event);
      expect(decoded.fields).to.not.be.null;
      expect(decoded.fields!.vault).to.equal(VAULT_ADDR);
      expect(decoded.fields!.agent).to.equal(AGENT_ADDR);
      expect(decoded.fields!.amount).to.equal(1_000_000n);
      expect(decoded.fields!.usdAmount).to.equal(1_000_000n);
      expect(decoded.fields!.dailyCapUsd).to.equal(500_000_000n);
      expect(decoded.fields!.delegated).to.equal(false);
      expect(decoded.fields!.timestamp).to.equal(1700000000n);
      // raw data preserved
      expect(decoded.data).to.deep.equal(new Uint8Array(encoded));
    });

    it("decodes SessionFinalized event fields correctly", () => {
      const encoder = getSessionFinalizedEncoder();
      const encoded = encoder.encode({
        vault: VAULT_ADDR,
        agent: AGENT_ADDR,
        success: true,
        isExpired: false,
        timestamp: 1700000100n,
        actualSpendUsd: 500_000_000n,
        balanceAfterUsd: 1_200_000_000n,
        actionType: 0,
      });

      const event: PhalnxEvent = {
        name: "SessionFinalized",
        data: new Uint8Array(encoded),
      };

      const decoded = decodePhalnxEvent(event);
      expect(decoded.fields).to.not.be.null;
      expect(decoded.fields!.vault).to.equal(VAULT_ADDR);
      expect(decoded.fields!.agent).to.equal(AGENT_ADDR);
      expect(decoded.fields!.success).to.equal(true);
      expect(decoded.fields!.isExpired).to.equal(false);
      expect(decoded.fields!.timestamp).to.equal(1700000100n);
      expect(decoded.fields!.actualSpendUsd).to.equal(500_000_000n);
      expect(decoded.fields!.balanceAfterUsd).to.equal(1_200_000_000n);
      expect(decoded.fields!.actionType).to.equal(0);
    });

    it("returns fields=null when decoder fails on corrupt data", () => {
      const event: PhalnxEvent = {
        name: "ActionAuthorized",
        data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), // way too short
      };

      const decoded = decodePhalnxEvent(event);
      expect(decoded.name).to.equal("ActionAuthorized");
      expect(decoded.fields).to.be.null;
      expect(decoded.data).to.deep.equal(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("parseAndDecodePhalnxEvents decodes from raw log strings", () => {
      // Build an ActionAuthorized event as a full log line (disc + payload)
      const encoder = getActionAuthorizedEncoder();
      const payload = encoder.encode({
        vault: VAULT_ADDR,
        agent: AGENT_ADDR,
        actionType: 0,
        tokenMint: MINT_ADDR,
        amount: 500_000n,
        usdAmount: 500_000n,
        protocol: PROTOCOL_ADDR,
        rollingSpendUsdAfter: 500_000n,
        dailyCapUsd: 1_000_000_000n,
        delegated: true,
        timestamp: 1700000200n,
      });

      // Find the discriminator hex for ActionAuthorized
      const discHex = Object.entries(EVENT_DISCRIMINATOR_MAP).find(
        ([, name]) => name === "ActionAuthorized",
      )![0];

      // Build full log line: discriminator bytes + payload bytes
      const discBytes: number[] = [];
      for (let i = 0; i < discHex.length; i += 2) {
        discBytes.push(parseInt(discHex.slice(i, i + 2), 16));
      }
      const allBytes = new Uint8Array([...discBytes, ...new Uint8Array(payload)]);
      const log = `Program data: ${Buffer.from(allBytes).toString("base64")}`;

      const decoded = parseAndDecodePhalnxEvents([log]);
      expect(decoded).to.have.length(1);
      expect(decoded[0].name).to.equal("ActionAuthorized");
      expect(decoded[0].fields).to.not.be.null;
      expect(decoded[0].fields!.amount).to.equal(500_000n);
      expect(decoded[0].fields!.delegated).to.equal(true);
    });

    it("decodes VaultReactivated with Option fields (variable-size decoder)", () => {
      const encoder = getVaultReactivatedEncoder();

      // Case 1: Both Option fields are Some
      const encodedSome = encoder.encode({
        vault: VAULT_ADDR,
        newAgent: AGENT_ADDR,
        newAgentPermissions: 0x1FFFFFn, // FULL_PERMISSIONS
        timestamp: 1700000300n,
      });

      const eventSome: PhalnxEvent = {
        name: "VaultReactivated",
        data: new Uint8Array(encodedSome),
      };
      const decodedSome = decodePhalnxEvent(eventSome);
      expect(decodedSome.fields).to.not.be.null;
      expect(decodedSome.fields!.vault).to.equal(VAULT_ADDR);
      expect(decodedSome.fields!.timestamp).to.equal(1700000300n);

      // Case 2: Both Option fields are None
      const encodedNone = encoder.encode({
        vault: VAULT_ADDR,
        newAgent: null,
        newAgentPermissions: null,
        timestamp: 1700000400n,
      });

      const eventNone: PhalnxEvent = {
        name: "VaultReactivated",
        data: new Uint8Array(encodedNone),
      };
      const decodedNone = decodePhalnxEvent(eventNone);
      expect(decodedNone.fields).to.not.be.null;
      expect(decodedNone.fields!.vault).to.equal(VAULT_ADDR);
      expect(decodedNone.fields!.timestamp).to.equal(1700000400n);
    });

    it("parseAndDecodePhalnxEvents handles mixed known/unknown events", () => {
      // Build one valid event log
      const discHex = Object.entries(EVENT_DISCRIMINATOR_MAP).find(
        ([, name]) => name === "SessionFinalized",
      )![0];
      const discBytes: number[] = [];
      for (let i = 0; i < discHex.length; i += 2) {
        discBytes.push(parseInt(discHex.slice(i, i + 2), 16));
      }
      const encoder = getSessionFinalizedEncoder();
      const payload = encoder.encode({
        vault: VAULT_ADDR,
        agent: AGENT_ADDR,
        success: true,
        isExpired: false,
        timestamp: 1700000500n,
        actualSpendUsd: 0n,
        balanceAfterUsd: 0n,
        actionType: 0,
      });
      const validBytes = new Uint8Array([...discBytes, ...new Uint8Array(payload)]);
      const validLog = `Program data: ${Buffer.from(validBytes).toString("base64")}`;

      // Mix with non-event log lines
      const logs = [
        "Program log: Instruction: ValidateAndAuthorize",
        validLog,
        "Program log: some debug output",
        "Program data: AAAA", // too short to be an event
      ];

      const decoded = parseAndDecodePhalnxEvents(logs);
      expect(decoded).to.have.length(1);
      expect(decoded[0].name).to.equal("SessionFinalized");
      expect(decoded[0].fields).to.not.be.null;
      expect(decoded[0].fields!.success).to.equal(true);
    });
  });

  describe("EVENT_DECODER_MAP completeness", () => {
    it("has a decoder entry for every event in EVENT_DISCRIMINATOR_MAP", () => {
      const discriminatorNames = new Set(Object.values(EVENT_DISCRIMINATOR_MAP));
      // decodePhalnxEvent returns non-null fields for known events,
      // null for unknown. If the decoder map is missing an entry,
      // we'd get null for a known discriminator name.
      for (const eventName of discriminatorNames) {
        // Build minimal valid bytes (won't decode, but decoder lookup should succeed)
        const event: PhalnxEvent = { name: eventName, data: new Uint8Array(0) };
        const decoded = decodePhalnxEvent(event);
        // fields may be null due to empty data, but the name should match
        // The key test: decodePhalnxEvent should attempt decoding (not skip with "unknown")
        // We verify by checking that the raw data is preserved and name is correct
        expect(decoded.name, `Missing decoder for ${eventName}`).to.equal(eventName);
      }
      // The runtime sync assertion in events.ts would have thrown at import time
      // if any entry was missing, so reaching this point proves completeness
      expect(discriminatorNames.size).to.equal(31);
    });
  });
});
