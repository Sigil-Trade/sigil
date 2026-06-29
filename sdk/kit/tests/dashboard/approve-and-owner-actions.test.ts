/**
 * Item 3 (approve_pending_policy) + Item 4 (promote_graylist_destination,
 * record_agent_violation) mutation wrappers.
 *
 * Drives the REAL exported mutations through a capturing mock RPC, then decodes
 * the wire transaction to assert the instruction shape (accounts + args +
 * signer), and exercises the buildApprovePendingPolicy review/handoff path.
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
  approvePendingPolicy,
  buildApprovePendingPolicy,
  promoteGraylistDestination,
  recordAgentViolation,
} from "../../src/dashboard/mutations.js";
import { getPromoteGraylistDestinationInstructionDataDecoder } from "../../src/generated/instructions/promoteGraylistDestination.js";
import { getRecordAgentViolationInstructionDataDecoder } from "../../src/generated/instructions/recordAgentViolation.js";
import { getPendingPolicyUpdateEncoder } from "../../src/generated/accounts/pendingPolicyUpdate.js";
import { SIGIL_PROGRAM_ADDRESS } from "../../src/generated/programs/sigil.js";
import {
  getPolicyPDA,
  getPendingPolicyPDA,
} from "../../src/resolve-accounts.js";

function toBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes as Uint8Array).toString("base64");
}
function isAllZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
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
function decode(messageBytes: Uint8Array) {
  const m = getCompiledTransactionMessageDecoder().decode(
    messageBytes,
  ) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: Address[];
    instructions: ReadonlyArray<{
      programAddressIndex: number;
      accountIndices?: number[];
      data?: Uint8Array;
    }>;
  };
  const ix = m.instructions.find(
    (i) => m.staticAccounts[i.programAddressIndex] === SIGIL_PROGRAM_ADDRESS,
  );
  if (!ix?.data) throw new Error("sigil ix not found");
  return {
    staticAccounts: m.staticAccounts,
    numSigners: m.header.numSignerAccounts,
    accounts: (ix.accountIndices ?? []).map((i) => m.staticAccounts[i]!),
    data: new Uint8Array(ix.data),
  };
}

describe("Item 3/4 owner & cosigner action wrappers", () => {
  let owner: TransactionSigner;
  let cosigner: TransactionSigner;
  let vault: Address;
  let captured: { wire: string | null };

  function buildMockRpc(pendingB64?: string): Rpc<SolanaRpcApi> {
    return {
      getAccountInfo: async () => ({}),
      // fetchPendingPolicyUpdate uses getAccountInfo via the generated fetch;
      // intercept it below in mocksWithPending.
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
      // unused in the execute paths; pendingB64 wired in via the dedicated
      // builder mock below.
      _pendingB64: pendingB64,
    } as unknown as Rpc<SolanaRpcApi>;
  }

  before(async () => {
    owner = await generateKeyPairSigner();
    cosigner = await generateKeyPairSigner();
    vault = (await generateKeyPairSigner()).address;
  });

  it("Item 3: approvePendingPolicy — cosigner is fee-payer + sole signer, accounts [cosigner,vault,policy,pendingPolicy]", async () => {
    captured = { wire: null };
    const rpc = buildMockRpc();
    await approvePendingPolicy(rpc, vault, cosigner, "devnet");
    if (!captured.wire) throw new Error("no wire captured");
    const wire = splitWire(captured.wire);
    const sigs = wire.sigs;
    const { accounts, staticAccounts, numSigners } = decode(wire.messageBytes);
    const [policyPda] = await getPolicyPDA(vault);
    const [pendingPda] = await getPendingPolicyPDA(vault);

    expect(accounts[0]).to.equal(cosigner.address, "cosigner first");
    expect(accounts[1]).to.equal(vault, "vault second");
    expect(accounts[2]).to.equal(policyPda, "policy third");
    expect(accounts[3]).to.equal(pendingPda, "pendingPolicy fourth");

    // Cosigner is the fee payer (staticAccounts[0]) + a signer; owner is absent.
    expect(staticAccounts[0]).to.equal(cosigner.address);
    expect(staticAccounts.slice(0, numSigners)).to.not.include(owner.address);
    expect(sigs.length).to.equal(1);
    expect(isAllZero(sigs[0]!)).to.equal(false, "cosigner signed");
  });

  it("Item 3: buildApprovePendingPolicy — returns decoded pending policy + unsigned cosigner-fee-payer tx", async () => {
    const [pendingPda] = await getPendingPolicyPDA(vault);
    const pendingArgs = {
      vault,
      queuedAt: 100n,
      executesAt: 2000n,
      queuedAtSlot: 50n,
      dailySpendingCapUsd: 999_000_000n,
      maxTransactionAmountUsd: null,
      protocolMode: null,
      protocols: null,
      developerFeeRate: null,
      maxSlippageBps: null,
      timelockDuration: null,
      allowedDestinations: null,
      sessionExpirySeconds: null,
      hasProtocolCaps: null,
      protocolCaps: null,
      destinationMode: null,
      bump: 254,
      operatingHours: null,
      cosignDigest: new Uint8Array(32),
      cosignSession: cosigner.address,
      newPolicyPreviewDigest: new Uint8Array(32).fill(9),
      stableBalanceFloor: null,
      perRecipientDailyCapUsd: null,
      cosignRequired: null,
      cosignSessionPubkey: null,
      operatorGrantDelaySeconds: null,
      cosignApproved: false,
      approvedAtSlot: 0n,
      queuedPolicyVersion: 1n,
      protocolHashes: null,
    };
    const pendingData = getPendingPolicyUpdateEncoder().encode(
      pendingArgs as never,
    );
    const rpc = {
      getAccountInfo: (address: Address) => ({
        send: async () =>
          address === pendingPda
            ? {
                value: {
                  data: [toBase64(pendingData), "base64"] as [string, "base64"],
                  executable: false,
                  lamports: 10_000_000n,
                  owner: SIGIL_PROGRAM_ADDRESS,
                  rentEpoch: 0n,
                  space: BigInt(pendingData.length),
                },
              }
            : { value: null },
      }),
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: "4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaJ4",
            lastValidBlockHeight: 1000n,
          },
        }),
      }),
    } as unknown as Rpc<SolanaRpcApi>;

    const review = await buildApprovePendingPolicy(
      rpc,
      vault,
      cosigner.address,
    );
    expect(review.pendingPolicyPda).to.equal(pendingPda);
    expect(review.pendingPolicy.vault).to.equal(vault);
    expect(review.pendingPolicy.dailySpendingCapUsd).to.not.equal(null);

    const { sigs, messageBytes } = splitWire(review.unsignedTransactionBase64);
    const { staticAccounts, accounts } = decode(messageBytes);
    expect(staticAccounts[0]).to.equal(cosigner.address, "cosigner fee payer");
    expect(accounts[0]).to.equal(cosigner.address);
    expect(accounts[1]).to.equal(vault);
    // Noop signer → empty signature slot (wallet completes it).
    expect(isAllZero(sigs[0]!)).to.equal(true, "unsigned");
  });

  it("Item 3: buildApprovePendingPolicy throws when no pending policy exists", async () => {
    const rpc = {
      getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    } as unknown as Rpc<SolanaRpcApi>;
    let threw = false;
    try {
      await buildApprovePendingPolicy(rpc, vault, cosigner.address);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/No pending policy/i);
    }
    expect(threw).to.equal(true);
  });

  it("Item 4: promoteGraylistDestination — owner-signed, destination arg + [owner,vault,policy]", async () => {
    captured = { wire: null };
    const rpc = buildMockRpc();
    const destination = (await generateKeyPairSigner()).address;
    await promoteGraylistDestination(rpc, vault, owner, "devnet", destination);
    if (!captured.wire) throw new Error("no wire captured");
    const wire = splitWire(captured.wire);
    const sigs = wire.sigs;
    const { accounts, staticAccounts } = decode(wire.messageBytes);
    const [policyPda] = await getPolicyPDA(vault);
    const data = getPromoteGraylistDestinationInstructionDataDecoder().decode(
      accountsData(captured.wire),
    );
    expect(data.destination).to.equal(destination);
    expect(accounts[0]).to.equal(owner.address);
    expect(accounts[1]).to.equal(vault);
    expect(accounts[2]).to.equal(policyPda);
    expect(staticAccounts[0]).to.equal(owner.address);
    expect(isAllZero(sigs[0]!)).to.equal(false);
  });

  it("Item 4: recordAgentViolation — owner-signed, agent+errorCode args", async () => {
    captured = { wire: null };
    const rpc = buildMockRpc();
    const agent = (await generateKeyPairSigner()).address;
    await recordAgentViolation(rpc, vault, owner, "devnet", agent, 6075);
    if (!captured.wire) throw new Error("no wire captured");
    const { accounts, staticAccounts } = decode(
      splitWire(captured.wire).messageBytes,
    );
    const data = getRecordAgentViolationInstructionDataDecoder().decode(
      accountsData(captured.wire),
    );
    expect(data.agent).to.equal(agent);
    expect(data.errorCode).to.equal(6075);
    expect(accounts[0]).to.equal(owner.address);
    expect(accounts[1]).to.equal(vault);
    // owner, vault, policy, auditLogSuccess, slotHashesSysvar
    expect(accounts.length).to.equal(5);
    expect(staticAccounts[0]).to.equal(owner.address);
  });

  it("Item 4: recordAgentViolation rejects a non-u32 errorCode before sending", async () => {
    captured = { wire: null };
    const rpc = buildMockRpc();
    const agent = (await generateKeyPairSigner()).address;
    let threw = false;
    try {
      await recordAgentViolation(rpc, vault, owner, "devnet", agent, -1);
    } catch {
      threw = true;
    }
    expect(threw, "must reject a negative errorCode").to.equal(true);
    expect(captured.wire, "must fail before broadcasting").to.equal(null);
  });
});

/** Re-extract the sigil instruction data bytes from a captured wire tx. */
function accountsData(wireB64: string): Uint8Array {
  const bytes = new Uint8Array(getBase64Encoder().encode(wireB64));
  const numSigs = bytes[0]!;
  const messageBytes = bytes.slice(1 + numSigs * 64);
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
  if (!ix?.data) throw new Error("sigil ix not found");
  return new Uint8Array(ix.data);
}
