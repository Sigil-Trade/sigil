/**
 * Elevated policy cosign surface (audit 2026-06-12, Phase 2 — policy path).
 *
 * queuePolicyElevated / buildQueuePolicyElevated mirror the agent-perms pair for
 * policy changes, sharing buildPolicyUpdateIx with queuePolicyUpdate. The
 * dual-sign / partial-sign mechanics themselves are proven in
 * elevated-agent-perms.test.ts; these tests cover the policy-specific wiring:
 * the queue ix's cosign_session arg, the cosigner as a required signer, and the
 * policy cosign digest (computeCosignDigest over the raw queued args).
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
} from "@solana/kit";
import type {
  Address,
  ReadonlyUint8Array,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from "@solana/kit";

import {
  queuePolicyElevated,
  buildQueuePolicyElevated,
} from "../../src/dashboard/mutations.js";
import type { PolicyElevatedChanges } from "../../src/dashboard/types.js";
import { getQueuePolicyUpdateInstructionDataDecoder } from "../../src/generated/instructions/queuePolicyUpdate.js";
import { getPolicyConfigEncoder } from "../../src/generated/accounts/policyConfig.js";
import { getAgentVaultEncoder } from "../../src/generated/accounts/agentVault.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import { getPolicyPDA } from "../../src/resolve-accounts.js";
import { createMockVaultState } from "../../src/testing/mock-state.js";
import { computeCosignDigest } from "../../src/policy/compute-cosign-digest.js";

// Raising the daily cap is an elevated change AND a cosign-digest field.
const RAISE: PolicyElevatedChanges = { dailyCap: 800_000_000n };

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}
function accountInfo(dataB64: string) {
  return {
    value: {
      data: [dataB64, "base64"] as [string, "base64"],
      executable: false,
      lamports: 10_000_000n,
      owner: SIGIL_PROGRAM_ADDRESS,
      rentEpoch: 0n,
      space: BigInt(Buffer.from(dataB64, "base64").length),
    },
  };
}

function isAllZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}
function splitWire(wireB64: string): { sigs: Uint8Array[]; messageBytes: Uint8Array } {
  const bytes = new Uint8Array(getBase64Encoder().encode(wireB64));
  const numSigs = bytes[0]!;
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < numSigs; i++)
    sigs.push(bytes.slice(1 + i * 64, 1 + (i + 1) * 64));
  return { sigs, messageBytes: bytes.slice(1 + numSigs * 64) };
}
function decodeMessage(messageBytes: Uint8Array) {
  const m = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: Address[];
    instructions: ReadonlyArray<{ programAddressIndex: number; data?: Uint8Array }>;
  };
  const ix = m.instructions.find(
    (i) => m.staticAccounts[i.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
  );
  if (!ix?.data) throw new Error("queue_policy_update ix not found");
  return {
    staticAccounts: m.staticAccounts,
    numSigners: m.header.numSignerAccounts,
    sigilIxData: new Uint8Array(ix.data),
  };
}

describe("elevated policy cosign wrappers (audit 2026-06-12 Phase 2)", () => {
  let owner: TransactionSigner;
  let cosigner: TransactionSigner;
  let vault: Address;
  let captured: { wire: string | null };

  function buildMockRpc(policyB64: string, vaultB64: string, policyAddr: Address): Rpc<SolanaRpcApi> {
    return {
      getAccountInfo: (address: Address) => ({
        send: async () => {
          if (address === policyAddr) return accountInfo(policyB64);
          if (address === vault) return accountInfo(vaultB64);
          return { value: null };
        },
      }),
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
        send: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
      }),
      getSlot: () => ({ send: async () => 100n }),
      getMinimumBalanceForRentExemption: (size: bigint) => ({
        send: async () => (size + 128n) * 6_960n,
      }),
    } as unknown as Rpc<SolanaRpcApi>;
  }

  async function mocks(): Promise<{ rpc: Rpc<SolanaRpcApi> }> {
    const state = createMockVaultState({
      vault,
      agent: (await generateKeyPairSigner()).address,
      owner: (await generateKeyPairSigner()).address,
      feeDestination: (await generateKeyPairSigner()).address,
    });
    const [policyAddr] = await getPolicyPDA(vault);
    return {
      rpc: buildMockRpc(
        toBase64(getPolicyConfigEncoder().encode(state.policy as never)),
        toBase64(getAgentVaultEncoder().encode(state.vault as never)),
        policyAddr,
      ),
    };
  }

  before(async () => {
    owner = await generateKeyPairSigner();
    cosigner = await generateKeyPairSigner();
    vault = (await generateKeyPairSigner()).address;
  });

  it("dual-sign: binds the cosigner as cosign_session AND a required signer, dual-signed", async () => {
    captured = { wire: null };
    const { rpc } = await mocks();
    await queuePolicyElevated(rpc, vault, owner, "devnet", RAISE, cosigner);
    if (!captured.wire) throw new Error("no wire captured");
    const { sigs, messageBytes } = splitWire(captured.wire);
    const { staticAccounts, numSigners, sigilIxData } = decodeMessage(messageBytes);

    const data = getQueuePolicyUpdateInstructionDataDecoder().decode(sigilIxData);
    expect(data.cosignSession).to.equal(cosigner.address);

    const signers = staticAccounts.slice(0, numSigners);
    expect(signers).to.include(cosigner.address);
    expect(signers).to.include(owner.address);
    expect(sigs.length).to.equal(2);
    expect(sigs.every((s) => !isAllZero(s))).to.equal(true);
  });

  it("partial-sign: cosign digest matches computeCosignDigest(raw args) + owner-signed/cosigner-unsigned", async () => {
    captured = { wire: null };
    const { rpc } = await mocks();
    const bundle = await buildQueuePolicyElevated(
      rpc,
      vault,
      owner,
      RAISE,
      cosigner.address,
    );
    const oracle = computeCosignDigest({
      cosignSession: cosigner.address,
      dailySpendingCapUsd: 800_000_000n,
      maxTransactionAmountUsd: null,
      allowedDestinations: null,
      protocols: null,
      stableBalanceFloor: null,
      perRecipientDailyCapUsd: null,
      hasProtocolCaps: null,
      protocolCaps: null,
      cosignRequired: null,
    });
    expect(Buffer.from(bundle.cosignDigest).toString("hex")).to.equal(
      Buffer.from(oracle).toString("hex"),
    );

    const { sigs, messageBytes } = splitWire(bundle.partialTransactionBase64);
    const { staticAccounts } = decodeMessage(messageBytes);
    const ownerIdx = staticAccounts.indexOf(owner.address);
    const cosignerIdx = staticAccounts.indexOf(cosigner.address);
    expect(isAllZero(sigs[ownerIdx]!)).to.equal(false, "owner signed");
    expect(isAllZero(sigs[cosignerIdx]!)).to.equal(true, "cosigner slot empty");
  });
});
