---
"@usesigil/kit": minor
---

Elevated-cosign SDK surface + TA-19 policy-preview digest fixes (security audit 2026-06-11/12).

New — elevated-cosign productization (for `cosign_required` vaults, where raising an agent's capability/limit or making an elevated policy change requires a cosigner):

- `OwnerClient.queueAgentPermissionsElevated` / `queuePolicyElevated` — single-builder dual-sign: pass the cosigner as a `TransactionSigner`; the tx is signed by `[owner, cosigner]` and sent.
- `OwnerClient.buildQueueAgentPermissionsElevated` / `buildQueuePolicyElevated` — partial-sign handoff: returns an `ElevatedCosignBundle` `{ partialTransactionBase64, cosignSession, cosignDigest }` (owner-signed; the cosigner completes + sends out-of-band — true 2-of-2).
- `computeAgentPermsCosignDigest` (+ `AgentPermsCosignDigestFields`) — mirrors the on-chain agent-perms cosign digest byte-for-byte (cross-impl pinned).
- `PolicyChanges` gains `stableBalanceFloor`, `perRecipientDailyCapUsd`, `cosignRequired`, `cosignSessionPubkey`, `operatorGrantDelaySeconds`. These are settable on either the non-elevated (`queuePolicyUpdate`) or elevated (`queuePolicyElevated`) path — elevation is direction-dependent (raising a cap is elevated, lowering isn't), not a per-field property; see the `PolicyChanges` docs for routing.

Fixes:

- The TA-19 policy-preview digest now binds the per-protocol spend caps (`has_protocol_caps` + `protocol_caps`, canonical positions 23-24), so a tampered SDK or pending-PDA mutation cannot alter caps without diverging the owner-signed preview.
- The dashboard sibling-handler and `queuePolicyUpdate` digests no longer omit `agent_set_hash` / `operator_grant_delay_seconds` / `cosign_session_pubkey`. They previously defaulted those fields, producing a `PolicyPreviewMismatch` (on-chain) on any vault with one or more registered agents — i.e. every real vault — making `createPostAssertions`, `closePostAssertions`, and `queuePolicyUpdate` unusable via the dashboard.
- Added cross-impl pins (byte-identical Rust ↔ TypeScript) for the populated `agent_set_hash`, populated `protocol_caps`, and agent-perms cosign digests.
