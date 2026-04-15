/**
 * SigilError base class — behavior tests.
 *
 * Covers: constructor field assignment, message formatting (viem-style
 * shortMessage + footer), cause chaining, instanceof relationships, version
 * stamping. The walk() method has its own dedicated test file.
 */

import { expect } from "chai";
import {
  SigilError,
  SigilShieldError,
  SigilTeeError,
  SigilX402Error,
  SigilComposeError,
  SigilSdkDomainError,
  SigilRpcError,
  SIGIL_KIT_VERSION,
  SIGIL_ERROR__SHIELD__POLICY_DENIED,
  SIGIL_ERROR__TEE__ATTESTATION_FAILED,
  SIGIL_ERROR__X402__HEADER_MALFORMED,
  SIGIL_ERROR__SDK__INVALID_PARAMS,
  SIGIL_ERROR__RPC__TX_FAILED,
} from "../../src/errors/index.js";

describe("SigilError — base class", () => {
  describe("constructor + field assignment", () => {
    it("stores code, shortMessage, and version", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "bad input");
      expect(err.code).to.equal(SIGIL_ERROR__SDK__INVALID_PARAMS);
      expect(err.shortMessage).to.equal("bad input");
      expect(err.version).to.equal(SIGIL_KIT_VERSION);
    });

    it("default name is 'SigilError'", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "x");
      expect(err.name).to.equal("SigilError");
    });

    it("stores cause when provided", () => {
      const cause = new Error("upstream");
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "wrapper", {
        cause,
      });
      expect(err.cause).to.equal(cause);
    });

    it("stores context payload typed by code", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "bad", {
        context: { field: "amount", received: -1 },
      });
      expect(err.context).to.deep.equal({ field: "amount", received: -1 });
    });

    it("metaMessages and docsPath are stored verbatim", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "x", {
        metaMessages: ["one", "two"],
        docsPath: "/errors/sdk-invalid-params",
      });
      expect(err.metaMessages).to.deep.equal(["one", "two"]);
      expect(err.docsPath).to.equal("/errors/sdk-invalid-params");
    });
  });

  describe("message formatting", () => {
    it("appends Version footer to message (viem pattern)", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "short");
      expect(err.message).to.include("short");
      expect(err.message).to.include(
        `Version: @usesigil/kit@${SIGIL_KIT_VERSION}`,
      );
    });

    it(".shortMessage preserves the original verbatim (no footer)", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "short");
      expect(err.shortMessage).to.equal("short");
    });

    it("includes metaMessages between shortMessage and footer", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "main", {
        metaMessages: ["meta1", "meta2"],
      });
      expect(err.message).to.include("main");
      expect(err.message).to.include("meta1");
      expect(err.message).to.include("meta2");
      const mainIdx = err.message.indexOf("main");
      const metaIdx = err.message.indexOf("meta1");
      const versionIdx = err.message.indexOf("Version:");
      expect(mainIdx).to.be.lessThan(metaIdx);
      expect(metaIdx).to.be.lessThan(versionIdx);
    });

    it("includes docsPath as a docs URL when provided", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "x", {
        docsPath: "/errors/test",
      });
      expect(err.message).to.include("https://docs.sigil.trade/errors/test");
    });

    it("includes details from a SigilError cause", () => {
      const inner = new SigilError(SIGIL_ERROR__RPC__TX_FAILED, "rpc broke");
      const wrapper = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "wrap", {
        cause: inner,
      });
      // The wrapper's details inherit from the cause's shortMessage when
      // the cause has no .details of its own.
      expect(wrapper.details).to.equal("rpc broke");
    });

    it("includes details from a plain Error cause (truncated to 500 chars)", () => {
      const long = "x".repeat(600);
      const cause = new Error(long);
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "wrap", {
        cause,
      });
      expect(err.details.length).to.be.at.most(501); // 500 chars + horizontal ellipsis
      expect(err.details.startsWith("xxx")).to.equal(true);
    });
  });

  describe("instanceof hierarchy", () => {
    it("is an instance of Error", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "x");
      expect(err).to.be.instanceOf(Error);
    });

    it("domain class instances are SigilError instances", () => {
      const shield = new SigilShieldError(
        SIGIL_ERROR__SHIELD__POLICY_DENIED,
        "x",
        { context: { violations: [] } as never },
      );
      const tee = new SigilTeeError(SIGIL_ERROR__TEE__ATTESTATION_FAILED, "x");
      const x402 = new SigilX402Error(
        SIGIL_ERROR__X402__HEADER_MALFORMED,
        "x",
        {
          context: { legacyNumericCode: 7024 } as never,
        },
      );
      const sdk = new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
        "x",
      );
      const rpc = new SigilRpcError(SIGIL_ERROR__RPC__TX_FAILED, "x");

      for (const e of [shield, tee, x402, sdk, rpc]) {
        expect(e).to.be.instanceOf(SigilError);
        expect(e).to.be.instanceOf(Error);
      }
    });

    it("domain class .name strings are correct", () => {
      const shield = new SigilShieldError(
        SIGIL_ERROR__SHIELD__POLICY_DENIED,
        "x",
        { context: { violations: [] } as never },
      );
      const tee = new SigilTeeError(SIGIL_ERROR__TEE__ATTESTATION_FAILED, "x");
      const x402 = new SigilX402Error(
        SIGIL_ERROR__X402__HEADER_MALFORMED,
        "x",
        {
          context: { legacyNumericCode: 7024 } as never,
        },
      );
      const compose = new SigilComposeError(
        "SIGIL_ERROR__COMPOSE__MISSING_PARAM" as never,
        "x",
        { context: { protocol: "test", fieldName: "f" } as never },
      );
      const sdk = new SigilSdkDomainError(
        SIGIL_ERROR__SDK__INVALID_PARAMS,
        "x",
      );
      const rpc = new SigilRpcError(SIGIL_ERROR__RPC__TX_FAILED, "x");

      expect(shield.name).to.equal("SigilShieldError");
      expect(tee.name).to.equal("SigilTeeError");
      expect(x402.name).to.equal("SigilX402Error");
      expect(compose.name).to.equal("SigilComposeError");
      expect(sdk.name).to.equal("SigilSdkDomainError");
      expect(rpc.name).to.equal("SigilRpcError");
    });
  });

  describe("frozen instances (defensive)", () => {
    it("Object.freeze on a SigilError does not break field reads", () => {
      const err = new SigilError(SIGIL_ERROR__SDK__INVALID_PARAMS, "x", {
        context: { field: "f" },
      });
      Object.freeze(err);
      expect(() => err.code).to.not.throw();
      expect(() => err.shortMessage).to.not.throw();
      expect(() => err.message).to.not.throw();
      expect(() => err.context).to.not.throw();
      expect(err.code).to.equal(SIGIL_ERROR__SDK__INVALID_PARAMS);
    });
  });
});
