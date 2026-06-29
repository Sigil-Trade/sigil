/**
 * Item 1 — verified-build gate arming (queue_policy_update protocol_hashes).
 *
 * Covers the SDK side of arming `PolicyConfig.protocol_hashes` through the
 * SHARED `buildPolicyUpdateIx` merge path (NOT a separate arm helper — that
 * would reintroduce the 6071 dual-builder drift the 2026-06-11 audit closed):
 *
 *   1. arm one protocol → the TA-19 preview digest the owner signs matches an
 *      independent recompute over (live fields + the ix's protocol_hashes arg),
 *      i.e. the SAME array feeds BOTH the ix and the digest (no 6071).
 *   2. seed-from-live preserves OTHER already-armed entries.
 *   3. reject protocolHashes + approvedApps in the same update.
 *   4. disarm (nonzero→zero) routes through the elevated path on a
 *      cosign-required vault (and is allowed on the standard path otherwise).
 *   5. computeVerifiedBuildHash == getProgramDataHash (hash-only wrapper).
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
  queuePolicyUpdate,
  queuePolicyElevated,
} from "../../src/dashboard/mutations.js";
import type { PolicyChanges } from "../../src/dashboard/types.js";
import { getQueuePolicyUpdateInstructionDataDecoder } from "../../src/generated/instructions/queuePolicyUpdate.js";
import { getPolicyConfigEncoder } from "../../src/generated/accounts/policyConfig.js";
import { getAgentVaultEncoder } from "../../src/generated/accounts/agentVault.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import { getPolicyPDA } from "../../src/resolve-accounts.js";
import { createMockVaultState } from "../../src/testing/mock-state.js";
import {
  computePolicyPreviewDigest,
  computeAgentSetHash,
} from "../../src/policy/compute-policy-preview-digest.js";
import { computeVerifiedBuildHash } from "../../src/policy/verified-build.js";
import {
  getProgramDataHash,
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  PROGRAM_DATA_HEADER_LEN,
} from "../../src/program-hash.js";
import { sha256 } from "../../src/canonical-encode.js";

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}
function hex(b: ReadonlyUint8Array): string {
  return Buffer.from(b as Uint8Array).toString("hex");
}
function isAllZero(b: ReadonlyUint8Array): boolean {
  return (b as Uint8Array).every((x) => x === 0);
}
/** Unwrap a codama/kit `Option<T>` (Some/None wrapper or bare value/null). */
function optionArray(o: unknown): ReadonlyUint8Array[] | null {
  if (o == null) return null;
  if (Array.isArray(o)) return o as ReadonlyUint8Array[];
  const opt = o as { __option?: string; value?: ReadonlyUint8Array[] };
  if (opt.__option === "Some" && opt.value) return opt.value;
  return null;
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
function splitWire(wireB64: string): {
  sigs: Uint8Array[];
  messageBytes: Uint8Array;
} {
  const bytes = new Uint8Array(getBase64Encoder().encode(wireB64));
  const numSigs = bytes[0]!;
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < numSigs; i++)
    sigs.push(bytes.slice(1 + i * 64, 1 + (i + 1) * 64));
  return { sigs, messageBytes: bytes.slice(1 + numSigs * 64) };
}
function decodeSigilIx(messageBytes: Uint8Array) {
  const m = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    staticAccounts: Address[];
    instructions: ReadonlyArray<{
      programAddressIndex: number;
      data?: Uint8Array;
    }>;
  };
  const ix = m.instructions.find(
    (i) => m.staticAccounts[i.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
  );
  if (!ix?.data) throw new Error("queue_policy_update ix not found");
  return getQueuePolicyUpdateInstructionDataDecoder().decode(
    new Uint8Array(ix.data),
  );
}

/** Map a live mock policy + vault to the canonical TA-19 digest fields. The
 *  on-chain handler recomputes the digest from exactly these live values plus
 *  the merged-effective protocol_hashes — so this is the on-chain oracle. */
function liveDigestFields(
  state: ReturnType<typeof createMockVaultState>,
  protocolHashes: readonly ReadonlyUint8Array[],
) {
  const p = state.policy as never as Record<string, never>;
  const v = state.vault as never as Record<string, never>;
  return {
    dailySpendingCapUsd: (p as never)["dailySpendingCapUsd"],
    maxTransactionSizeUsd: (p as never)["maxTransactionSizeUsd"],
    maxSlippageBps: (p as never)["maxSlippageBps"],
    developerFeeRate: (p as never)["developerFeeRate"],
    protocolMode: (p as never)["protocolMode"],
    protocols: (p as never)["protocols"],
    destinationMode: (p as never)["destinationMode"],
    allowedDestinations: (p as never)["allowedDestinations"],
    timelockDuration: (p as never)["timelockDuration"],
    sessionExpirySeconds: (p as never)["sessionExpirySeconds"],
    observeOnly: (v as never)["observeOnly"],
    hasPostAssertions: (p as never)["hasPostAssertions"],
    createdAtSlot: (p as never)["createdAtSlot"],
    operatingHours: (p as never)["operatingHours"],
    autoPromoteGrays: (p as never)["autoPromoteGrays"],
    autoRevokeThreshold: (p as never)["autoRevokeThreshold"],
    stableBalanceFloor: (p as never)["stableBalanceFloor"],
    perRecipientDailyCapUsd: (p as never)["perRecipientDailyCapUsd"],
    cosignRequired: (p as never)["cosignRequired"],
    operatorGrantDelaySeconds: (p as never)["operatorGrantDelaySeconds"],
    hasProtocolCaps: (p as never)["hasProtocolCaps"],
    protocolCaps: (p as never)["protocolCaps"],
    agentSetHash: computeAgentSetHash((v as never)["agents"]),
    cosignSessionPubkey: (p as never)["cosignSessionPubkey"],
    protocolHashes,
  };
}

describe("verified-build gate arming (Item 1)", () => {
  let owner: TransactionSigner;
  let cosigner: TransactionSigner;
  let vault: Address;
  let captured: { wire: string | null };

  function buildMockRpc(
    policyB64: string,
    vaultB64: string,
    policyAddr: Address,
  ): Rpc<SolanaRpcApi> {
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
    } as unknown as Rpc<SolanaRpcApi>;
  }

  /** Build a mock state + RPC; caller may mutate the policy before encoding. */
  async function mocks(
    mutate: (state: ReturnType<typeof createMockVaultState>) => void = () => {},
    protocols: Address[] = [],
  ): Promise<{
    rpc: Rpc<SolanaRpcApi>;
    state: ReturnType<typeof createMockVaultState>;
  }> {
    const state = createMockVaultState({
      vault,
      agent: (await generateKeyPairSigner()).address,
      owner: (await generateKeyPairSigner()).address,
      feeDestination: (await generateKeyPairSigner()).address,
      protocols,
    });
    mutate(state);
    const [policyAddr] = await getPolicyPDA(vault);
    return {
      state,
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

  it("1) arm one protocol → signed digest matches the on-chain recompute", async () => {
    captured = { wire: null };
    const P = (await generateKeyPairSigner()).address;
    const HASH = new Uint8Array(32).fill(7);
    const { rpc, state } = await mocks(() => {}, [P]);

    const changes: PolicyChanges = {
      protocolHashes: new Map([[P, HASH]]),
    };
    await queuePolicyUpdate(rpc, vault, owner, "devnet", changes);
    if (!captured.wire) throw new Error("no wire captured");
    const data = decodeSigilIx(splitWire(captured.wire).messageBytes);

    // The ix arg is the seed-from-live whole array: slot0 armed, rest zero.
    const arr = optionArray(data.protocolHashes);
    if (!arr) throw new Error("protocolHashes arg must be Some(array)");
    expect(arr.length).to.equal(10);
    expect(hex(arr[0]!)).to.equal(hex(HASH));
    for (let i = 1; i < 10; i++) expect(isAllZero(arr[i]!)).to.equal(true);

    // On-chain oracle: recompute the digest from live fields + the ix arg.
    const oracle = computePolicyPreviewDigest(
      liveDigestFields(state, arr) as never,
    );
    expect(hex(data.newPolicyPreviewDigest)).to.equal(hex(oracle));
  });

  it("2) seed-from-live preserves OTHER already-armed entries", async () => {
    captured = { wire: null };
    const P0 = (await generateKeyPairSigner()).address;
    const P1 = (await generateKeyPairSigner()).address;
    const EXISTING = new Uint8Array(32).fill(0xaa);
    const NEW = new Uint8Array(32).fill(0xbb);
    const { rpc } = await mocks(
      (state) => {
        (
          state.policy as never as { protocolHashes: Uint8Array[] }
        ).protocolHashes[1] = EXISTING;
      },
      [P0, P1],
    );

    await queuePolicyUpdate(rpc, vault, owner, "devnet", {
      protocolHashes: new Map([[P0, NEW]]),
    });
    if (!captured.wire) throw new Error("no wire captured");
    const data = decodeSigilIx(splitWire(captured.wire).messageBytes);
    const arr = optionArray(data.protocolHashes);
    if (!arr) throw new Error("protocolHashes arg must be Some(array)");
    expect(hex(arr[0]!)).to.equal(hex(NEW), "slot0 armed with NEW");
    expect(hex(arr[1]!)).to.equal(hex(EXISTING), "slot1 preserved from live");
  });

  it("3) rejects protocolHashes + approvedApps in the same update", async () => {
    const P = (await generateKeyPairSigner()).address;
    const { rpc } = await mocks(() => {}, [P]);
    let threw = false;
    try {
      await queuePolicyUpdate(rpc, vault, owner, "devnet", {
        protocolHashes: new Map([[P, new Uint8Array(32).fill(1)]]),
        approvedApps: [P, (await generateKeyPairSigner()).address],
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/separate update/i);
    }
    expect(threw, "must reject the protocolHashes+approvedApps combo").to.equal(
      true,
    );
  });

  it("3b) rejects arming a protocol not in the allowlist", async () => {
    const P = (await generateKeyPairSigner()).address;
    const NOT_LISTED = (await generateKeyPairSigner()).address;
    const { rpc } = await mocks(() => {}, [P]);
    let threw = false;
    try {
      await queuePolicyUpdate(rpc, vault, owner, "devnet", {
        protocolHashes: new Map([[NOT_LISTED, new Uint8Array(32).fill(1)]]),
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/not in the vault's protocol/i);
    }
    expect(threw).to.equal(true);
  });

  it("4) disarm on a cosign-required vault is rejected on the standard path", async () => {
    const P = (await generateKeyPairSigner()).address;
    const ARMED = new Uint8Array(32).fill(0xcc);
    const { rpc } = await mocks(
      (state) => {
        (state.policy as never as { cosignRequired: boolean }).cosignRequired =
          true;
        (
          state.policy as never as { protocolHashes: Uint8Array[] }
        ).protocolHashes[0] = ARMED;
      },
      [P],
    );
    let threw = false;
    try {
      await queuePolicyUpdate(rpc, vault, owner, "devnet", {
        protocolHashes: new Map([[P, "disarm"]]),
      });
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/elevated|cosign/i);
    }
    expect(threw, "disarm on cosign vault must route elevated").to.equal(true);
  });

  it("4b) disarm via queuePolicyElevated succeeds and clears the slot", async () => {
    captured = { wire: null };
    const P = (await generateKeyPairSigner()).address;
    const ARMED = new Uint8Array(32).fill(0xcc);
    const { rpc } = await mocks(
      (state) => {
        (state.policy as never as { cosignRequired: boolean }).cosignRequired =
          true;
        (
          state.policy as never as { protocolHashes: Uint8Array[] }
        ).protocolHashes[0] = ARMED;
      },
      [P],
    );
    await queuePolicyElevated(
      rpc,
      vault,
      owner,
      "devnet",
      { protocolHashes: new Map([[P, "disarm"]]) },
      cosigner,
    );
    if (!captured.wire) throw new Error("no wire captured");
    const data = decodeSigilIx(splitWire(captured.wire).messageBytes);
    expect(data.cosignSession).to.equal(cosigner.address);
    const arr = optionArray(data.protocolHashes);
    if (!arr) throw new Error("protocolHashes arg must be Some(array)");
    expect(isAllZero(arr[0]!)).to.equal(true, "slot0 disarmed");
  });

  it("4c) disarm on a NON-cosign vault is allowed on the standard path", async () => {
    captured = { wire: null };
    const P = (await generateKeyPairSigner()).address;
    const ARMED = new Uint8Array(32).fill(0xcc);
    const { rpc } = await mocks(
      (state) => {
        (
          state.policy as never as { protocolHashes: Uint8Array[] }
        ).protocolHashes[0] = ARMED;
      },
      [P],
    );
    await queuePolicyUpdate(rpc, vault, owner, "devnet", {
      protocolHashes: new Map([[P, "disarm"]]),
    });
    if (!captured.wire) throw new Error("no wire captured (should not reject)");
    const data = decodeSigilIx(splitWire(captured.wire).messageBytes);
    const arr = optionArray(data.protocolHashes);
    if (!arr) throw new Error("protocolHashes arg must be Some(array)");
    expect(isAllZero(arr[0]!)).to.equal(true);
  });

  it("5) computeVerifiedBuildHash == getProgramDataHash (hash-only)", async () => {
    const elf = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88]);
    const data = new Uint8Array(PROGRAM_DATA_HEADER_LEN + elf.length);
    data[0] = 3;
    data.set(elf, PROGRAM_DATA_HEADER_LEN);
    const rpc = {
      getAccountInfo: () => ({
        send: async () => ({
          value: {
            owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
            data: [toBase64(data), "base64"],
          },
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const PROGRAM_ID =
      "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK" as Address;
    const viaWrapper = await computeVerifiedBuildHash(rpc, PROGRAM_ID);
    const viaDirect = await getProgramDataHash(rpc, PROGRAM_ID);
    expect(hex(viaWrapper)).to.equal(hex(viaDirect));
    expect(hex(viaWrapper)).to.equal(hex(sha256(elf)));
  });
});
