---
"@usesigil/kit": minor
---

Production protocol-sync upgrade.

New:

- `computeVerifiedBuildHash(rpc, programId)` — hash-only helper an owner uses to
  arm the verified-build gate.
- `PolicyChanges.protocolHashes?: ReadonlyMap<Address, Uint8Array | "disarm">` —
  arms/disarms `PolicyConfig.protocol_hashes` through the shared
  `buildPolicyUpdateIx` merge path (seed-from-live whole-array replace; the same
  array feeds both the ix and the TA-19 digest, so the owner's signed digest
  matches on-chain byte-for-byte). Rejects combining `protocolHashes` with
  `approvedApps` in one update, and routes a cosign-required disarm to the
  elevated path.
- `approvePendingPolicy` / `buildApprovePendingPolicy` (+ `OwnerClient`
  methods) — completes the 2-of-2 cosign flow; the build variant surfaces the
  decoded pending policy for cosigner review.
- `promoteGraylistDestination` / `recordAgentViolation` (+ `OwnerClient`
  methods) — owner-signed graylist promotion and agent-violation recording.

Fixed:

- `findVaultsByOwner` decoded `vault_authority` at a fixed offset (644), which
  only held for a full-10-agent vault. Sub-10-agent vaults serialize the
  `agents` Borsh Vec shorter, so the field sat earlier and the fixed read
  returned zero-padding — silently dropping ownership-transfer-received vaults
  on real RPCs. Now decoded via the generated Borsh decoder.

Also in this release: the `agent_transfer` wrapper (`SigilClient.transfer` /
`buildAgentTransfer` + SAK wiring) already landed on this branch.
