---
"@usesigil/kit": patch
---

Add agent-error mapping for on-chain error 6115 (`ErrUnmeasurableSpend`) — the require-measurable-outcome invariant. A spending session that produces no measurable in-transaction vault outcome (no stablecoin movement out of the vault and no vault-owned acquisition increase) is now rejected, closing the async/CPI/data-mode cap-accounting bypass where a deferred-settlement action would otherwise slip through at dust-fee cost without binding the spending caps.
