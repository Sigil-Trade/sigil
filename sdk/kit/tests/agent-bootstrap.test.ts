/**
 * Unit tests for `@usesigil/kit/agent-bootstrap`.
 *
 * Locks the FE↔BE v2.2 C5 handoff contract:
 *   - Template shape matches the §3.4 FE-composed sample (no drift).
 *   - Substitution is complete (no `${placeholder}` leaks through).
 *   - Output is DETERMINISTIC (same input → byte-identical output).
 *   - Capability-tier → friendly-name mapping is canonical.
 *   - USD-bigint formatting handles round + fractional amounts.
 */
import { expect } from "chai";
import {
  composeAgentBootstrap,
  getHandoffPromptTemplate,
  capabilityTierToNames,
  type AgentBootstrapConfig,
} from "../src/agent-bootstrap.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SAMPLE: AgentBootstrapConfig = {
  vaultAddress: "VAULTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  agentAddress: "AGENTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ownerAddress: "OWNERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  network: "devnet",
  dailyLimitUsd: 500_000_000n, // $500
  approvedProtocols: ["Jupiter", "Flash Trade"],
  capabilityTier: 2,
};

// ─── getHandoffPromptTemplate ────────────────────────────────────────────

describe("getHandoffPromptTemplate", () => {
  it("returns a string with all 7 placeholder slots", () => {
    const tpl = getHandoffPromptTemplate();
    expect(tpl).to.be.a("string").and.not.empty;
    expect(tpl).to.include("${network}");
    expect(tpl).to.include("${agentAddress}");
    expect(tpl).to.include("${vaultAddress}");
    expect(tpl).to.include("${ownerAddress}");
    expect(tpl).to.include("${dailyLimitUsd}");
    expect(tpl).to.include("${protocolNames}");
    expect(tpl).to.include("${capabilityNames}");
  });

  it("is deterministic — two calls return identical strings", () => {
    expect(getHandoffPromptTemplate()).to.equal(getHandoffPromptTemplate());
  });

  it("mentions the MCP seal_transaction tool", () => {
    expect(getHandoffPromptTemplate()).to.include("seal_transaction");
  });

  it("mentions the request_help escape hatch", () => {
    expect(getHandoffPromptTemplate()).to.include("request_help");
  });

  it("mentions vault-will-reject design choice explicitly", () => {
    expect(getHandoffPromptTemplate()).to.include(
      "reject any tx that exceeds the rules",
    );
  });
});

// ─── capabilityTierToNames ───────────────────────────────────────────────

describe("capabilityTierToNames", () => {
  it("tier 0 (Disabled) → empty array", () => {
    expect(capabilityTierToNames(0)).to.deep.equal([]);
  });

  it("tier 1 (Observer) → ['NonSpending']", () => {
    expect(capabilityTierToNames(1)).to.deep.equal(["NonSpending"]);
  });

  it("tier 2 (Operator) → ['Spending', 'NonSpending']", () => {
    expect(capabilityTierToNames(2)).to.deep.equal(["Spending", "NonSpending"]);
  });

  it("unknown tier → empty array (defensive)", () => {
    expect(capabilityTierToNames(99)).to.deep.equal([]);
    expect(capabilityTierToNames(-1)).to.deep.equal([]);
    expect(capabilityTierToNames(3)).to.deep.equal([]);
  });
});

// ─── composeAgentBootstrap ───────────────────────────────────────────────

describe("composeAgentBootstrap — output shape", () => {
  it("returns {agentWallet, vaultPubkey, onboardingPrompt, capabilities}", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r).to.have.all.keys([
      "agentWallet",
      "vaultPubkey",
      "onboardingPrompt",
      "capabilities",
    ]);
  });

  it("mirrors the input addresses to the output slots", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.agentWallet).to.equal(SAMPLE.agentAddress);
    expect(r.vaultPubkey).to.equal(SAMPLE.vaultAddress);
  });

  it("capabilities array is derived from capabilityTier", () => {
    const r = composeAgentBootstrap({ ...SAMPLE, capabilityTier: 1 });
    expect(r.capabilities).to.deep.equal(["NonSpending"]);
  });
});

describe("composeAgentBootstrap — prompt substitution", () => {
  it("substitutes every placeholder — no ${...} remains in output", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.not.include("${");
  });

  it("substitutes network", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.include("Sigil vault on devnet");
  });

  it("substitutes agent / vault / owner addresses", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.include(SAMPLE.agentAddress);
    expect(r.onboardingPrompt).to.include(SAMPLE.vaultAddress);
    expect(r.onboardingPrompt).to.include(SAMPLE.ownerAddress);
  });

  it("substitutes daily limit with $ prefix on round amount", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.include("Daily spending limit: $500");
    expect(r.onboardingPrompt, "no trailing .00 on round").to.not.include(
      "$500.",
    );
  });

  it("substitutes daily limit with fractional cents when non-zero", () => {
    const r = composeAgentBootstrap({
      ...SAMPLE,
      dailyLimitUsd: 100_500_000n, // $100.50
    });
    expect(r.onboardingPrompt).to.include("Daily spending limit: $100.5");
  });

  it("joins approved protocols with comma-space", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.include(
      "Approved protocols: Jupiter, Flash Trade",
    );
  });

  it("joins capabilities with comma-space", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.include("Permissions: Spending, NonSpending");
  });

  it("handles empty protocol list gracefully", () => {
    const r = composeAgentBootstrap({ ...SAMPLE, approvedProtocols: [] });
    expect(r.onboardingPrompt).to.include("Approved protocols: ");
    expect(r.onboardingPrompt).to.not.include("${protocolNames}");
  });

  it("handles Disabled tier (empty capabilities) without crashing", () => {
    const r = composeAgentBootstrap({ ...SAMPLE, capabilityTier: 0 });
    expect(r.onboardingPrompt).to.include("Permissions: ");
    expect(r.capabilities).to.deep.equal([]);
  });
});

describe("composeAgentBootstrap — determinism", () => {
  it("same input → byte-identical output across calls", () => {
    const a = composeAgentBootstrap(SAMPLE);
    const b = composeAgentBootstrap(SAMPLE);
    expect(a.onboardingPrompt).to.equal(b.onboardingPrompt);
    expect(a.capabilities).to.deep.equal(b.capabilities);
  });

  it("no stray \\n\\n\\n sequences (render-stable whitespace)", () => {
    const r = composeAgentBootstrap(SAMPLE);
    expect(r.onboardingPrompt).to.not.include("\n\n\n");
  });

  it("no trailing whitespace on lines", () => {
    const r = composeAgentBootstrap(SAMPLE);
    const lines = r.onboardingPrompt.split("\n");
    for (const line of lines) {
      expect(line, `line "${line}" has no trailing whitespace`).to.equal(
        line.replace(/[ \t]+$/, ""),
      );
    }
  });
});

describe("composeAgentBootstrap — network variants", () => {
  it("mainnet-beta surfaces as 'mainnet-beta' in prompt", () => {
    const r = composeAgentBootstrap({
      ...SAMPLE,
      network: "mainnet-beta",
    });
    expect(r.onboardingPrompt).to.include("Sigil vault on mainnet-beta");
  });
});

describe("composeAgentBootstrap — injection + input validation (review fixes)", () => {
  // Adversarial code-review caught that sequential String.prototype.replace
  // exposes dollar-sign special sequences ($&, $', $`, $1…$9) in the
  // REPLACEMENT strings. `approvedProtocols` is untrusted (MCP / partner
  // input), so a protocol name containing `$1` or `$&` would be reinterpreted
  // by the NEXT replacement call. The fix uses callback-form replaceAll
  // which bypasses dollar-sign interpretation entirely.

  it("protocol name containing '$&' renders literally (no back-reference substitution)", () => {
    const r = composeAgentBootstrap({
      ...SAMPLE,
      approvedProtocols: ["Evil$&protocol"],
    });
    expect(r.onboardingPrompt).to.include("Evil$&protocol");
    expect(r.onboardingPrompt).to.not.include("${protocolNames}");
  });

  it("protocol name containing '${capabilityNames}' does NOT get substituted", () => {
    // The attack: a protocol name that looks like a later placeholder
    // would, under naive sequential replace, get re-substituted by the
    // `capabilityNames` pass. replaceAll-callback form blocks it.
    const r = composeAgentBootstrap({
      ...SAMPLE,
      approvedProtocols: ["LegitProto", "${capabilityNames} pwned"],
    });
    expect(r.onboardingPrompt).to.include(
      "LegitProto, ${capabilityNames} pwned",
    );
    // The ACTUAL capability slot should ALSO be filled correctly —
    // proves the template didn't get over-substituted.
    expect(r.onboardingPrompt).to.include("Permissions: Spending, NonSpending");
  });

  it("address containing a $ sign renders literally", () => {
    // Solana base58 can't contain `$` — but defensive anyway since the
    // kit's type is `string` not a branded Address.
    const r = composeAgentBootstrap({
      ...SAMPLE,
      ownerAddress: "$0wn3r$pubkey",
    });
    expect(r.onboardingPrompt).to.include("$0wn3r$pubkey");
  });

  it("throws RangeError on negative dailyLimitUsd", () => {
    expect(() =>
      composeAgentBootstrap({
        ...SAMPLE,
        dailyLimitUsd: -100_000_000n,
      }),
    ).to.throw(RangeError, /dailyLimitUsd must be >= 0/);
  });

  it("throws RangeError on dailyLimitUsd = -1n (boundary)", () => {
    expect(() =>
      composeAgentBootstrap({
        ...SAMPLE,
        dailyLimitUsd: -1n,
      }),
    ).to.throw(RangeError);
  });

  it("accepts 0n dailyLimitUsd (zero is a valid config — observer-like)", () => {
    const r = composeAgentBootstrap({
      ...SAMPLE,
      dailyLimitUsd: 0n,
    });
    expect(r.onboardingPrompt).to.include("Daily spending limit: $0");
  });
});
