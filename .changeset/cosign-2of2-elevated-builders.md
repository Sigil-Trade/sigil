---
"@usesigil/kit": minor
---

Cosign 2-of-2 hardening — SDK lockstep with the on-chain program:

- Add six partial-sign elevated owner-op builders for vaults with `cosign_required`: `buildCancelAgentGrantElevated`, `buildCancelAgentPermissionsElevated`, `buildCancelPendingPolicyElevated`, `buildApplyAgentPermissionsElevated`, `buildApplyPendingPolicyElevated`, and `buildCloseVaultElevated` (plus the matching `OwnerClient` methods). Each returns a `CosignedActionBundle` — the owner-partial-signed wire transaction with the bound cosigner appended as a required signer, for a genuine 2-of-2 co-sign — and rejects a cosigner equal to the owner.
- Export the `CosignedActionBundle` type.
- Correct `ErrCosignRequired` to error code **6080** (was mislabeled 6089, which is `MintDeltaCapMisconfigured`) across the cosign helper, the cosign-digest module, and the error map.
- Regenerate the codama client against the hardened program: adds `cancelAgentPermissionsUpdate`, and `agentTransfer` now carries the auto-resolved `audit_log_success` PDA + slot_hashes sysvar.

Note: on a cosign-required vault the program now rejects these owner-ops unless the bound cosigner co-signs — callers must use the `*Elevated` builders for those vaults.
