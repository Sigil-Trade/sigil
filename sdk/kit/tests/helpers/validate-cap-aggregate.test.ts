import { describe, it } from "mocha";
import { expect } from "chai";

import { validateAgentCapAggregate } from "../../src/helpers/validate-cap-aggregate.js";
import { SigilSdkDomainError } from "../../src/errors/sdk.js";
import { SIGIL_ERROR__SDK__CAP_EXCEEDED } from "../../src/errors/codes.js";

describe("validateAgentCapAggregate — pass cases", () => {
  it("sum == vault cap passes (boundary)", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 500_000_000n,
        existingAgentCaps: [],
        newAgentCap: 500_000_000n,
      }),
    ).not.to.throw();
  });

  it("sum < vault cap passes", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 500_000_000n,
        existingAgentCaps: [100_000_000n, 100_000_000n],
        newAgentCap: 100_000_000n,
      }),
    ).not.to.throw();
  });

  it("all zero caps pass", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 0n,
        existingAgentCaps: [0n, 0n, 0n],
        newAgentCap: 0n,
      }),
    ).not.to.throw();
  });

  it("empty existingAgentCaps + newAgentCap == vaultCap passes", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 1_000_000_000n,
        existingAgentCaps: [],
        newAgentCap: 1_000_000_000n,
      }),
    ).not.to.throw();
  });

  it("newAgentCap = 0n (Observer) always passes regardless of existing caps", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 500_000_000n,
        existingAgentCaps: [500_000_000n],
        newAgentCap: 0n,
      }),
    ).not.to.throw();
  });
});

describe("validateAgentCapAggregate — fail cases", () => {
  it("sum == vault cap + 1n throws CAP_EXCEEDED", () => {
    try {
      validateAgentCapAggregate({
        vaultDailyCap: 500_000_000n,
        existingAgentCaps: [],
        newAgentCap: 500_000_001n,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).to.be.instanceOf(SigilSdkDomainError);
      expect((err as SigilSdkDomainError).code).to.equal(
        SIGIL_ERROR__SDK__CAP_EXCEEDED,
      );
    }
  });

  it("Pentester F3 scenario: 10 × $100 caps exceed $500 vault cap", () => {
    const tenAgentCaps = Array(10).fill(100_000_000n) as bigint[];
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 500_000_000n,
        existingAgentCaps: tenAgentCaps.slice(0, 9), // 9 already registered
        newAgentCap: 100_000_000n, // 10th
      }),
    ).to.throw(SigilSdkDomainError);
  });

  it("error context includes vaultCap, sum, and agents array", () => {
    try {
      validateAgentCapAggregate({
        vaultDailyCap: 100n,
        existingAgentCaps: [60n],
        newAgentCap: 60n,
      });
      expect.fail("expected throw");
    } catch (err) {
      const ctx = (err as SigilSdkDomainError).context as {
        vaultCap?: bigint;
        sum?: bigint;
        agents?: bigint[];
      };
      expect(ctx?.vaultCap).to.equal(100n);
      expect(ctx?.sum).to.equal(120n);
      expect(ctx?.agents).to.deep.equal([60n, 60n]);
    }
  });
});

describe("validateAgentCapAggregate — input validation", () => {
  it("rejects negative vaultDailyCap", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: -1n,
        existingAgentCaps: [],
        newAgentCap: 0n,
      }),
    ).to.throw(SigilSdkDomainError);
  });

  it("rejects negative newAgentCap", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 100n,
        existingAgentCaps: [],
        newAgentCap: -1n,
      }),
    ).to.throw(SigilSdkDomainError);
  });

  it("rejects negative existingAgentCap", () => {
    expect(() =>
      validateAgentCapAggregate({
        vaultDailyCap: 100n,
        existingAgentCaps: [-50n],
        newAgentCap: 0n,
      }),
    ).to.throw(SigilSdkDomainError);
  });
});
