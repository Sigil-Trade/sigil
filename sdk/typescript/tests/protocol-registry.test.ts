import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ProtocolRegistry } from "../src/integrations/protocol-registry";
import type {
  ProtocolHandler,
  ProtocolHandlerMetadata,
  ProtocolContext,
  ProtocolComposeResult,
} from "../src/integrations/protocol-handler";

/** Minimal stub handler for testing the registry. */
function makeStubHandler(
  protocolId: string,
  displayName: string,
  programIds: PublicKey[],
): ProtocolHandler {
  const metadata: ProtocolHandlerMetadata = {
    protocolId,
    displayName,
    programIds,
    supportedActions: new Map([
      ["deposit", { actionType: { deposit: {} }, isSpending: true }],
    ]),
  };
  return {
    metadata,
    async compose(
      _ctx: ProtocolContext,
      _action: string,
      _params: Record<string, unknown>,
    ): Promise<ProtocolComposeResult> {
      return { instructions: [] };
    },
    summarize(_action: string, _params: Record<string, unknown>): string {
      return `${displayName} action`;
    },
  };
}

describe("ProtocolRegistry", () => {
  const programA = Keypair.generate().publicKey;
  const programB = Keypair.generate().publicKey;
  const programC = Keypair.generate().publicKey;

  let registry: ProtocolRegistry;

  beforeEach(() => {
    registry = new ProtocolRegistry();
  });

  describe("register", () => {
    it("registers a handler and reports correct size", () => {
      const handler = makeStubHandler("test-proto", "Test Protocol", [
        programA,
      ]);
      registry.register(handler);
      expect(registry.size).to.equal(1);
      expect(registry.has("test-proto")).to.be.true;
    });

    it("throws on duplicate protocol ID", () => {
      const h1 = makeStubHandler("dupe", "Dupe 1", [programA]);
      const h2 = makeStubHandler("dupe", "Dupe 2", [programB]);
      registry.register(h1);
      expect(() => registry.register(h2)).to.throw(
        "Protocol handler already registered: dupe",
      );
    });

    it("indexes multiple program IDs for one handler", () => {
      const handler = makeStubHandler("multi", "Multi Programs", [
        programA,
        programB,
      ]);
      registry.register(handler);
      expect(registry.getByProgramId(programA)).to.equal(handler);
      expect(registry.getByProgramId(programB)).to.equal(handler);
    });
  });

  describe("deregister", () => {
    it("removes a registered handler", () => {
      const handler = makeStubHandler("removable", "Removable", [programA]);
      registry.register(handler);
      expect(registry.has("removable")).to.be.true;

      const removed = registry.deregister("removable");
      expect(removed).to.be.true;
      expect(registry.has("removable")).to.be.false;
      expect(registry.size).to.equal(0);
    });

    it("returns false for unknown protocol ID", () => {
      expect(registry.deregister("nonexistent")).to.be.false;
    });

    it("cleans up program ID index on deregister", () => {
      const handler = makeStubHandler("indexed", "Indexed", [
        programA,
        programB,
      ]);
      registry.register(handler);
      registry.deregister("indexed");
      expect(registry.getByProgramId(programA)).to.be.undefined;
      expect(registry.getByProgramId(programB)).to.be.undefined;
    });
  });

  describe("getByProtocolId", () => {
    it("returns handler by protocol ID", () => {
      const handler = makeStubHandler("by-id", "By ID", [programA]);
      registry.register(handler);
      expect(registry.getByProtocolId("by-id")).to.equal(handler);
    });

    it("returns undefined for unknown protocol ID", () => {
      expect(registry.getByProtocolId("unknown")).to.be.undefined;
    });
  });

  describe("getByProgramId", () => {
    it("returns handler by program ID", () => {
      const handler = makeStubHandler("by-prog", "By Program", [programA]);
      registry.register(handler);
      expect(registry.getByProgramId(programA)).to.equal(handler);
    });

    it("returns undefined for unknown program ID", () => {
      expect(registry.getByProgramId(programC)).to.be.undefined;
    });
  });

  describe("listAll", () => {
    it("returns empty array when no handlers registered", () => {
      expect(registry.listAll()).to.deep.equal([]);
    });

    it("returns metadata for all registered handlers", () => {
      registry.register(makeStubHandler("proto-a", "Proto A", [programA]));
      registry.register(makeStubHandler("proto-b", "Proto B", [programB]));
      const list = registry.listAll();
      expect(list).to.have.length(2);
      const ids = list.map((m) => m.protocolId).sort();
      expect(ids).to.deep.equal(["proto-a", "proto-b"]);
    });
  });

  describe("has", () => {
    it("returns true for registered, false for unregistered", () => {
      registry.register(makeStubHandler("exists", "Exists", [programA]));
      expect(registry.has("exists")).to.be.true;
      expect(registry.has("nope")).to.be.false;
    });
  });
});
