/**
 * Cross-impl parity for the agent-permissions cosign digest (elevated
 * agent-perms SDK surface). The SDK `computeAgentPermsCosignDigest` must be
 * byte-identical to the on-chain `compute_agent_perms_cosign_digest`
 * (programs/sigil/src/utils/cosign_digest.rs::agent_perms_cosign_digest_cross_impl_pin),
 * else an elevated agent-perms queue would revert with a cosign mismatch.
 *
 * PK_n is derived from raw bytes [n;32] so it matches the Rust test's
 * pk(n) = Pubkey::new_from_array([n;32]) exactly.
 */

import { describe, it } from "mocha";
import { expect } from "chai";
import { getBase58Decoder } from "@solana/kit";
import type { Address } from "@solana/kit";
import { computeAgentPermsCosignDigest } from "../../src/policy/compute-agent-perms-cosign-digest.js";

function addr(fill: number): Address {
  return getBase58Decoder().decode(new Uint8Array(32).fill(fill)) as Address;
}
function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

const PK_1 = addr(1);
const PK_2 = addr(2);
const PK_3 = addr(3);

describe("computeAgentPermsCosignDigest — cross-impl parity (elevated agent-perms cosign)", () => {
  it("matches the Rust agent_perms_cosign_digest_cross_impl_pin", () => {
    const d = computeAgentPermsCosignDigest({
      cosignSession: PK_1,
      agent: PK_2,
      newCapability: 2,
      spendingLimitUsd: 250_000_000n,
      cooldownSeconds: 3600n,
    });
    expect(toHex(d)).to.equal(
      "56ecf828e2e7e5e0ee5d979e8894a588dad3f26485147749fd6563bcfedbff31",
    );
  });

  it("binds the agent (agent flip changes the digest)", () => {
    const base = {
      cosignSession: PK_1,
      agent: PK_2,
      newCapability: 2,
      spendingLimitUsd: 250_000_000n,
      cooldownSeconds: 0n,
    };
    expect(toHex(computeAgentPermsCosignDigest(base))).to.not.equal(
      toHex(computeAgentPermsCosignDigest({ ...base, agent: PK_3 })),
    );
  });

  it("binds the elevation fields (capability / limit / cooldown)", () => {
    const base = {
      cosignSession: PK_1,
      agent: PK_2,
      newCapability: 1,
      spendingLimitUsd: 0n,
      cooldownSeconds: 0n,
    };
    const d = toHex(computeAgentPermsCosignDigest(base));
    expect(d).to.not.equal(
      toHex(computeAgentPermsCosignDigest({ ...base, newCapability: 2 })),
    );
    expect(d).to.not.equal(
      toHex(computeAgentPermsCosignDigest({ ...base, spendingLimitUsd: 50_000_000n })),
    );
    expect(d).to.not.equal(
      toHex(computeAgentPermsCosignDigest({ ...base, cooldownSeconds: 3600n })),
    );
  });
});
