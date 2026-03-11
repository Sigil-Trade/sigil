import { expect } from "chai";
import { createHash } from "crypto";
import {
  parsePhalnxEvents,
  filterEvents,
  getEventNames,
} from "../src/events.js";
import { EVENT_DISCRIMINATOR_MAP } from "../src/generated/event-discriminators.js";

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
    it("has 31 entries", () => {
      const entries = Object.entries(EVENT_DISCRIMINATOR_MAP);
      expect(entries).to.have.length(31);
    });

    it("all discriminators are 16-char hex", () => {
      for (const [disc] of Object.entries(EVENT_DISCRIMINATOR_MAP)) {
        expect(disc).to.match(/^[0-9a-f]{16}$/);
      }
    });

    it("no duplicate discriminators", () => {
      const discs = Object.keys(EVENT_DISCRIMINATOR_MAP);
      const unique = new Set(discs);
      expect(unique.size).to.equal(discs.length);
    });

    it("no duplicate event names", () => {
      const names = Object.values(EVENT_DISCRIMINATOR_MAP);
      const unique = new Set(names);
      expect(unique.size).to.equal(names.length);
    });

    it("each discriminator matches SHA256('event:<Name>')[0..8]", () => {
      for (const [disc, name] of Object.entries(EVENT_DISCRIMINATOR_MAP)) {
        const hash = createHash("sha256")
          .update(`event:${name}`)
          .digest();
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
});
