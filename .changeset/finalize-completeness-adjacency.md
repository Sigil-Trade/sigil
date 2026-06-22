---
"@usesigil/kit": patch
---

Add agent-error mappings for on-chain errors 6113 (`ErrFinalizeMetaUnresolvable`) and 6114 (`ErrDeFiInstructionNotAdjacentToFinalize`) — the F-Q1b finalize-side completeness check plus the DeFi↔finalize adjacency invariant. These close a value-attribution leak where a writable DeFi account meta could be omitted from `finalize_session` (or the counted DeFi instruction displaced from immediately before finalize) to dodge the per-recipient cap, output-ownership, and stable-floor walks.
