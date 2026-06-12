/**
 * Elevated agent-permissions cosign surface (audit 2026-06-12, Phase 2).
 *
 * The on-chain queue_agent_permissions_update handler treats raising an agent's
 * capability/limit (or setting a cooldown) on a cosign_required vault as
 * elevated: it requires a non-default `cosign_session` that is distinct from the
 * owner and present as a signer in remaining_accounts. These tests verify the
 * two SDK wrappers build exactly that transaction:
 *   - queueAgentPermissionsElevated   → dual-signed [owner, cosigner], cosigner
 *     bound as the cosign_session arg AND as a required signer.
 *   - buildQueueAgentPermissionsElevated → owner-partial-signed (cosigner slot
 *     empty) + the correct cosign digest for handoff.
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
} from "@solana/kit";
import type { Address, Rpc, SolanaRpcApi, TransactionSigner } from "@solana/kit";

import {
  queueAgentPermissionsElevated,
  buildQueueAgentPermissionsElevated,
} from "../../src/dashboard/mutations.js";
import { getQueueAgentPermissionsUpdateInstructionDataDecoder } from "../../src/generated/instructions/queueAgentPermissionsUpdate.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import { computeAgentPermsCosignDigest } from "../../src/policy/compute-agent-perms-cosign-digest.js";
import { capability, usd } from "../../src/types.js";

const OPERATOR = capability(2n); // CapabilityTier.Operator
const LIMIT = usd(250_000_000n);
const COOLDOWN = 3600n;

function buildMockRpc(captured: { wire: string | null }): Rpc<SolanaRpcApi> {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
          lastValidBlockHeight: 1000n,
        },
      }),
    }),
    simulateTransaction: () => ({
      send: async () => ({ value: { err: null, logs: [], unitsConsumed: 1 } }),
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        captured.wire = wire;
        return "5wHu1qwD7y5B7TFDx5UKo2KRDwfJpJdHnnRr8KeUQBJGG2ZxVjktjDqfUzE6jR2Kv8Zj";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ confirmationStatus: "confirmed", err: null }],
      }),
    }),
    getSlot: () => ({ send: async () => 100n }),
    getMinimumBalanceForRentExemption: (size: bigint) => ({
      send: async () => (size + 128n) * 6_960n,
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

/** Split a base64 wire tx into its signature slots (64 bytes each) + message. */
function splitWire(wireB64: string): { sigs: Uint8Array[]; messageBytes: Uint8Array } {
  const bytes = new Uint8Array(getBase64Encoder().encode(wireB64));
  const numSigs = bytes[0]!; // compact-u16; <128 ⇒ 1 byte
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < numSigs; i++) {
    sigs.push(bytes.slice(1 + i * 64, 1 + (i + 1) * 64));
  }
  return { sigs, messageBytes: bytes.slice(1 + numSigs * 64) };
}

function isAllZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

function decodeMessage(messageBytes: Uint8Array): {
  staticAccounts: Address[];
  numSigners: number;
  sigilIxData: Uint8Array;
} {
  const m = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: Address[];
    instructions: ReadonlyArray<{
      programAddressIndex: number;
      data?: Uint8Array;
    }>;
  };
  const ix = m.instructions.find(
    (i) => m.staticAccounts[i.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
  );
  if (!ix?.data) throw new Error("queue_agent_permissions ix not found");
  return {
    staticAccounts: m.staticAccounts,
    numSigners: m.header.numSignerAccounts,
    sigilIxData: new Uint8Array(ix.data),
  };
}

describe("elevated agent-permissions cosign wrappers (audit 2026-06-12 Phase 2)", () => {
  let owner: TransactionSigner;
  let cosigner: TransactionSigner;
  let vault: Address;
  let agent: Address;
  before(async () => {
    owner = await generateKeyPairSigner();
    cosigner = await generateKeyPairSigner();
    vault = (await generateKeyPairSigner()).address;
    agent = (await generateKeyPairSigner()).address;
  });

  it("dual-sign: binds the cosigner as cosign_session AND as a required signer, with two real signatures", async () => {
    const captured = { wire: null as string | null };
    const rpc = buildMockRpc(captured);
    await queueAgentPermissionsElevated(
      rpc,
      vault,
      owner,
      "devnet",
      agent,
      OPERATOR,
      LIMIT,
      COOLDOWN,
      cosigner,
    );
    if (!captured.wire) throw new Error("no wire captured");
    const { sigs, messageBytes } = splitWire(captured.wire);
    const { staticAccounts, numSigners, sigilIxData } =
      decodeMessage(messageBytes);

    // cosign_session arg == cosigner pubkey
    const data = getQueueAgentPermissionsUpdateInstructionDataDecoder().decode(
      sigilIxData,
    );
    expect(data.cosignSession).to.equal(cosigner.address);

    // cosigner is a REQUIRED signer (in the signer section of staticAccounts)
    const signerSection = staticAccounts.slice(0, numSigners);
    expect(signerSection).to.include(
      cosigner.address,
      "cosigner must be a required signer",
    );
    expect(signerSection).to.include(owner.address);

    // both signatures present + non-empty (owner + cosigner actually signed)
    expect(sigs.length).to.equal(2);
    expect(sigs.every((s) => !isAllZero(s))).to.equal(
      true,
      "both owner and cosigner signatures must be present",
    );
  });

  it("partial-sign: returns the correct cosign digest + an owner-signed / cosigner-unsigned tx", async () => {
    const rpc = buildMockRpc({ wire: null });
    const bundle = await buildQueueAgentPermissionsElevated(
      rpc,
      vault,
      owner,
      agent,
      OPERATOR,
      LIMIT,
      COOLDOWN,
      cosigner.address,
    );

    // digest matches the canonical builder (what the cosigner attests)
    const oracle = computeAgentPermsCosignDigest({
      cosignSession: cosigner.address,
      agent,
      newCapability: Number(OPERATOR),
      spendingLimitUsd: LIMIT,
      cooldownSeconds: COOLDOWN,
    });
    expect(Buffer.from(bundle.cosignDigest).toString("hex")).to.equal(
      Buffer.from(oracle).toString("hex"),
    );
    expect(bundle.cosignSession).to.equal(cosigner.address);

    // owner signed, cosigner slot still empty (awaiting handoff)
    const { sigs, messageBytes } = splitWire(bundle.partialTransactionBase64);
    const { staticAccounts, numSigners } = decodeMessage(messageBytes);
    expect(sigs.length).to.equal(2);
    const ownerIdx = staticAccounts.indexOf(owner.address);
    const cosignerIdx = staticAccounts.indexOf(cosigner.address);
    expect(ownerIdx).to.equal(0, "fee-payer/owner is signer 0");
    expect(cosignerIdx).to.be.greaterThan(0).and.lessThan(numSigners);
    expect(isAllZero(sigs[ownerIdx]!)).to.equal(false, "owner must be signed");
    expect(isAllZero(sigs[cosignerIdx]!)).to.equal(
      true,
      "cosigner slot must be empty for handoff",
    );
  });

  it("rejects a cosigner equal to the owner", async () => {
    const rpc = buildMockRpc({ wire: null });
    let threw = false;
    try {
      await queueAgentPermissionsElevated(
        rpc,
        vault,
        owner,
        "devnet",
        agent,
        OPERATOR,
        LIMIT,
        COOLDOWN,
        owner, // cosigner == owner
      );
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true, "owner-as-cosigner must be rejected");
  });
});
