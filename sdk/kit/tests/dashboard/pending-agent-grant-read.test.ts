/**
 * F-Q6 — getPendingAgentGrant read-back (dashboard subpath).
 *
 * Round-trips a PendingAgentGrant account through the SAME generated codec the
 * read consumes: encode a grant, serve it from a capturing mock RPC, and assert
 * the parsed fields + derived `executesAtUnix` + the toJSON() twin. Then assert
 * the "no grant queued" path (account absent) returns `null` — the steady state
 * after apply_agent_grant / cancel_agent_grant closes the PDA.
 *
 * Mirrors the getPendingOwnership contract; imported through the dashboard
 * barrel so the export wiring is exercised too.
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import { generateKeyPairSigner } from "@solana/kit";
import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";

import {
  getPendingAgentGrant,
  findPendingAgentGrantPda,
} from "../../src/dashboard/index.js";
import { getPendingAgentGrantEncoder } from "../../src/generated/accounts/pendingAgentGrant.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}

describe("F-Q6 getPendingAgentGrant read", () => {
  let vault: Address;
  let agent: Address;
  let pendingPda: Address;

  // A single-key queued OPERATOR grant: capability 2, 600s floor.
  const CAPABILITY = 2;
  const SPENDING_LIMIT_USD = 250_000_000n; // $250
  const QUEUED_AT = 1_700_000_000n;
  const MIN_DELAY_SECONDS = 600n;
  const QUEUED_AT_SLOT = 123_456n;

  before(async () => {
    vault = (await generateKeyPairSigner()).address;
    agent = (await generateKeyPairSigner()).address;
    pendingPda = await findPendingAgentGrantPda(vault);
  });

  function encodeGrant(): ReadonlyUint8Array {
    // The encoder auto-injects the account discriminator (transformEncoder).
    return getPendingAgentGrantEncoder().encode({
      vault,
      agent,
      capability: CAPABILITY,
      spendingLimitUsd: SPENDING_LIMIT_USD,
      queuedAt: QUEUED_AT,
      minDelaySeconds: MIN_DELAY_SECONDS,
      bump: 255,
      padding: new Uint8Array(6),
      pendingContentDigest: new Uint8Array(32),
      queuedAtSlot: QUEUED_AT_SLOT,
    });
  }

  function rpcServing(pendingB64: string | null): Rpc<SolanaRpcApi> {
    return {
      getAccountInfo: (address: Address) => ({
        send: async () =>
          pendingB64 !== null && address === pendingPda
            ? {
                value: {
                  data: [pendingB64, "base64"] as [string, "base64"],
                  executable: false,
                  lamports: 2_000_000n,
                  owner: SIGIL_PROGRAM_ADDRESS,
                  rentEpoch: 0n,
                  space: BigInt(Buffer.from(pendingB64, "base64").length),
                },
              }
            : { value: null },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  it("returns the queued grant with derived executesAtUnix + toJSON twin", async () => {
    const rpc = rpcServing(toBase64(encodeGrant()));

    const grant = await getPendingAgentGrant(rpc, vault);
    expect(grant, "grant should be present").to.not.equal(null);

    expect(grant!.vault).to.equal(vault);
    expect(grant!.agent).to.equal(agent);
    expect(grant!.capability).to.equal(CAPABILITY);
    expect(grant!.spendingLimitUsd).to.equal(SPENDING_LIMIT_USD);
    expect(grant!.queuedAt).to.equal(QUEUED_AT);
    expect(grant!.minDelaySeconds).to.equal(MIN_DELAY_SECONDS);
    // The wall-clock apply gate is queuedAt + minDelaySeconds.
    expect(grant!.executesAtUnix).to.equal(QUEUED_AT + MIN_DELAY_SECONDS);
    expect(grant!.queuedAtSlot).to.equal(QUEUED_AT_SLOT);

    // toJSON() serializes every bigint as a base-10 string (MCP-safe).
    const json = grant!.toJSON();
    expect(json.vault).to.equal(vault);
    expect(json.agent).to.equal(agent);
    expect(json.capability).to.equal(CAPABILITY);
    expect(json.spendingLimitUsd).to.equal(SPENDING_LIMIT_USD.toString());
    expect(json.queuedAt).to.equal(QUEUED_AT.toString());
    expect(json.minDelaySeconds).to.equal(MIN_DELAY_SECONDS.toString());
    expect(json.executesAtUnix).to.equal(
      (QUEUED_AT + MIN_DELAY_SECONDS).toString(),
    );
    expect(json.queuedAtSlot).to.equal(QUEUED_AT_SLOT.toString());
  });

  it("returns null when no grant is queued (post-apply steady state)", async () => {
    const rpc = rpcServing(null);
    const grant = await getPendingAgentGrant(rpc, vault);
    expect(grant).to.equal(null);
  });
});
