---
"@usesigil/kit": patch
---

Document Sigil's honest security guarantee + boundary on `seal()`: it ENFORCES no-theft (output stays vault-owned), spend caps, allowlist, and the verified-build gate — but is value-blind (an agent can waste value within caps) and cannot generically verify ongoing custody of venue positions (perps/lending/LP). Surfacing this prevents over-implying value-conservation to users and agents (M3 of the foundation review).
