---
"@agent-shield/core": patch
"@agent-shield/sdk": patch
"@agent-shield/mcp": patch
---

fix(security): audit findings batch 1

- **core**: Add `checkpoint()` and `rollback()` to `ShieldState` to prevent phantom spend recording when `signAllTransactions` fails
- **sdk**: Enforce `maxPayment` ceiling in `shieldedFetch()` (rejects if server asks more than specified cap); wrap `signAllTransactions` evaluate-record-sign loop in checkpoint/rollback to prevent phantom spend on signing failure
- **mcp**: Lazy-cache `ShieldedWallet` across x402 tool calls so spending caps persist; pass `maxPayment` through to `shieldedFetch()`; tighten `maxPayment` schema with regex validation
