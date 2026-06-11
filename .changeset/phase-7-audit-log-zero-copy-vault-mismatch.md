---
"@usesigil/kit": minor
---

Phase 7 (audit log + N1 temporal binding) + §RP-2 breaking rename:

**Breaking (rename, code unchanged):**
- `SigilError::ConstraintsVaultMismatch` (code 6064) → `ZeroCopyVaultMismatch`.
  Generic message "Zero-copy account vault key mismatch (defense-in-depth)"
  now applies to BOTH `InstructionConstraints` zero-copy paths AND the
  new `AuditLogSuccess`/`AuditLogRejected` zero-copy paths. Error code
  number unchanged at 6064; only the variant name + message text changed.
  Affects: `sdk/kit/src/agent-errors.ts`,
  `sdk/kit/src/generated/errors/sigil.ts`,
  `sdk/kit/src/testing/errors/names.generated.ts`. If consumers imported
  the symbol by name, rename to `ZeroCopyVaultMismatch`.

**Breaking (field rename):**
- `AuditEntry.target_protocol` → `AuditEntry.subject` (32-byte raw pubkey).
  The field is semantically polymorphic per discriminator (mint for
  deposit/withdraw, vault for freeze/reactivate/policy/constraints, agent
  for pause/unpause/revoke/register, protocol for finalize). Codama
  regenerated the SDK type; consumers must read `entry.subject` instead of
  `entry.targetProtocol`. A deprecated `targetProtocolBytes()` helper is
  retained for one release; `subjectBytes()` is the canonical accessor.

**Additive (new APIs):**
- `fetchAuditLogSuccess(rpc, vault)`, `fetchAuditLogRejected(rpc, vault)`
- `subjectBytes(entry)` — canonical accessor for the renamed field
- `AUDIT_DISC_*` constants (0..=16) — discriminator labels
- `AUDIT_DISC_FINALIZE_REJECT = 16` — NEW, for expired-finalize cranks
  on the REJECT path (was incorrectly reusing disc=1 in Phase 7 initial
  ship; fixed §RP-1 HIGH-1).

**Operational:**
- `prepublishOnly` build hook added to sdk/kit/package.json (and sibling
  sdk/platform, sdk/agent, packages/plugins) to prevent stale dist on
  next publish. Caught by §RP-2 CRIT-2 in the prior audit closure cycle
  for sdk/custody and now generalized.
