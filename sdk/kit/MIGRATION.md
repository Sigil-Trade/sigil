# @usesigil/kit — Migration Guide

This file collects breaking-change recipes for every major SDK transition.
Newest first.

---

## 0.15.x → 0.16.0 (Phase 9 SDK redesign)

### Removed: protocol-tier classifier + protocol-registry annotations

The `protocol-tier.ts` and `protocol-registry/` modules and their six
re-exports are gone. The dashboard already uses its own local
`@/lib/protocol-registry/` and the private `@sigil-trade/constraints`
package; nothing inside `agent-middleware/` consumed the kit copies.

```diff
- import {
-   resolveProtocolTier,
-   PROTOCOL_ANNOTATIONS,
-   VERIFIED_PROGRAMS,
-   lookupProtocolAnnotation,
-   ProtocolAnnotation,
-   ProtocolTrustTier,
- } from "@usesigil/kit";

+ // Dashboard: use the local lib + the private constraints package.
+ import { PROTOCOL_ANNOTATIONS, VERIFIED_PROGRAMS } from "@/lib/protocol-registry";
+ import { lookupProtocolAnnotation } from "@sigil-trade/constraints";
```

The unrelated `ProtocolTier` enum on `protocol-resolver.ts` (vault
allowlist tier — KNOWN / DEFAULT / NOT_ALLOWED) is preserved and used
internally by `seal.ts`.

### Renamed: `OwnerClient.resumeVault` → `OwnerClient.reactivateVault`

The original method stays as a back-compat alias; new code should call
`reactivateVault` to match the on-chain `reactivate_vault` instruction
name.

```diff
- await client.resumeVault({ address: agent, permissions: 2 });
+ await client.reactivateVault({ address: agent, permissions: 2 });
```

No semantic change; same on-chain instruction.

### Coming in v1.0: `requireMainnetConfirmation` default flip

0.16.0 introduces the `requireMainnetConfirmation` option on
`SigilClientConfig` but defaults it to `false` for back-compat. When
unset on a mainnet client, the SDK emits a `console.warn` referencing
this migration entry.

**v1.0 will flip the default to `true`** — mainnet `executeAndConfirm`
calls without an explicit `mainnetConfirmed: true` will throw error
7020 (`MAINNET_CONFIRMATION_REQUIRED`).

Prepare for the flip now:

```diff
const client = createSigilClient({
  rpc,
  vault,
  agent,
  network: "mainnet",
+ requireMainnetConfirmation: true, // adopt the v1.0 default early
});

await client.executeAndConfirm(ixs, {
  tokenMint: USDC_MAINNET,
  amount: 500_000_000n,
+ mainnetConfirmed: true, // explicit per-call opt-in
});
```

If you cannot adopt the v1.0 default yet, explicitly set
`requireMainnetConfirmation: false` to silence the warning until you
are ready.

### Added: `SealResult.intentDigest`, `network`, `isMainnet` (AL3 + AL4)

0.16.0 grows the `SealResult` interface returned by every `seal()` and
`createSigilClient().seal()` call with three new fields. All are
populated on every successful seal (Phase 9 §F-4 closure — there is no
"not set" branch in the build path; if `seal()` returns without
throwing, all three fields are present).

The fields are appended to the end of the interface so existing
destructures like `const { ok, transaction, warnings } = result` keep
working unchanged.

#### `intentDigest: Uint8Array`

The per-call AL3 SealInput digest — a 32-byte SHA-256 over the
canonical encoding of `(vault, agent, mint, amount, target_protocol,
network, instructions[])`. The encoding is fixed and append-only; see
`sdk/kit/src/seal/intent-digest.ts` for the byte layout.

**When it's set:** every successful `seal()` call. The digest is
computed AFTER `seal()` strips ComputeBudget + System program ixs and
BEFORE the agent-ATA → vault-ATA rewrites — so the bytes reflect the
intent the OWNER APPROVED, not the bytes the wallet eventually signs.

**How to use it:** show the digest hex in your preview UI when the
owner authorizes the bundle, then re-derive it at execute time with
`computeSealInputDigest(...)` and refuse the submission if the two
disagree. That closes the "compromised agent swaps recipient inside an
already-approved bundle" attack class.

```diff
+ import { computeSealInputDigest } from "@usesigil/kit";

  const result = await client.seal(ixs, {
    tokenMint: USDC_MAINNET,
    amount: 500_000_000n,
    targetProtocol: JUPITER,
  });

+ // Surface the digest in the preview UI for owner confirmation.
+ ui.showIntentHash(toHex(result.intentDigest));
+
+ // Later, at execute time, recompute over the same inputs and refuse
+ // if the agent has swapped fields mid-flow.
+ const recomputed = computeSealInputDigest({
+   vault, agent: agent.address, tokenMint, amount, targetProtocol,
+   network, instructions: ixs,
+ });
+ if (toHex(recomputed) !== toHex(result.intentDigest)) {
+   throw new Error("intent digest drift between preview and execute");
+ }
```

#### `network: SigilCaip2Chain`

The CAIP-2 chain id of the network the sealed transaction targets —
`"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"` for mainnet-beta or
`"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"` for devnet. AL4 binds the
chain id into the AL3 digest via the `network_id` byte at canonical
position 2, so a mainnet-targeted bundle cannot be replayed through a
devnet preview without producing a different `intentDigest`.

**When it's set:** every successful `seal()` call.

**How to use it:** persist alongside `intentDigest` in audit logs so a
re-execution attempt on a different cluster is visible even if the
attacker controlled the digest. Off-chain bookkeeping that aggregates
across multiple Sigil deployments uses `network` as the partitioning
key.

```diff
  const result = await client.seal(ixs, opts);

+ await auditLog.write({
+   intentDigestHex: toHex(result.intentDigest),
+   network: result.network, // CAIP-2 chain id, partitionable
+   txSizeBytes: result.txSizeBytes,
+   correlationId: opts.correlationId,
+ });
```

#### `isMainnet: boolean`

A boolean derived from `network` — `true` only when the CAIP-2 chain
id matches Solana's mainnet-beta canonical id. Convenience field for
UI code that has to render a mainnet warning banner or escalate the
confirmation chrome on real funds.

**When it's set:** every successful `seal()` call.

**How to use it:** wire to the AL2 mainnet confirmation gate above —
`isMainnet === true` is the signal that the consumer SHOULD have set
`mainnetConfirmed: true` per call. Prefer this boolean to a
string-compare on `network` because the CAIP-2 list may grow (testnet,
localnet) without changing the mainnet contract.

```diff
  const result = await client.seal(ixs, opts);

- if (config.network === "mainnet-beta") {
+ if (result.isMainnet) {
    ui.showMainnetWarning();
  }
```

The three fields are independent — code that only consumes one of them
need not touch the other two — but they are designed to be used
together for tight preview→execute intent binding.

---

## Earlier transitions

See git log + per-release `CHANGELOG.md` entries for transitions older
than 0.15.0.
