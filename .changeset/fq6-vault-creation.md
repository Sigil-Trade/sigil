---
"@usesigil/kit": minor
---

F-Q6: make `createVault` produce a non-reverting first-OPERATOR seating on single-key vaults.

A freshly-created vault is always single-key (EOA owner, cosign off), and on
such a vault the program rejects an instant OPERATOR grant with error 6107
(`ErrOperatorGrantRequiresTimelock`). `createVault` previously emitted the
instant `[initialize_vault, register_agent(OPERATOR)]` composition for the
default (OPERATOR) capability, so the create transaction reverted.

`createVault` now seats a first OPERATOR agent through the timelocked
queued-grant path instead:

- New `firstOperatorSeating?: "queued-grant" | "immediate"` option (default
  `"queued-grant"`). The default emits `[initialize_vault, queue_agent_grant]`,
  which lands, and returns an `operatorGrant` descriptor
  (`{ queued: true, agent, capability: 2, delaySeconds, appliesAfterUnix? }`)
  so the caller can surface the activation countdown. The agent becomes an
  OPERATOR after `apply_agent_grant` once the single-key 600s floor elapses.
  `"immediate"` fails fast with `INVALID_PARAMS` rather than building a
  transaction the program is guaranteed to reject.
- `CreateVaultResult.registerAgentIx` is now optional — it is emitted only for
  OBSERVER/DISABLED first agents; the OPERATOR path populates
  `queueAgentGrantIx` instead. Use the new `instructions` array (the ordered
  composition) rather than hand-assembling `[initializeVaultIx, registerAgentIx]`.

Also in this release:

- `@usesigil/kit/dashboard` exports `getPendingAgentGrant(rpc, vault)` — a
  standalone read mirroring `getPendingOwnership` that returns the queued
  OPERATOR grant (with `executesAtUnix`) or `null` once it is applied/cancelled.
  The apply path is the existing `OwnerClient.applyAgentGrant`.
- The `full-access` preset now allow-lists every Sigil-recognized protocol (up
  to the on-chain max of 10) instead of using allow-all mode with an empty
  allowlist, which the active-vault guard rejected. New `RECOGNIZED_PROTOCOLS`
  export (`{ id, name }[]`) is the source of that set.
- Preset descriptions corrected to match on-chain reality (capability tiers +
  caps); `maxSlippageBps` is documented as advisory (enforced off-chain by the
  SDK, not by the program).
- The 6107 error hint now points at the `createVault` queued-grant flow.
