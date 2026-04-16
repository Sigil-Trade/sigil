---
"@usesigil/kit": minor
---

Factory migration + fromJSON MCP round-trip + x402 documentation (PR 3.A).

**BREAKING:** `SigilClient` and `OwnerClient` classes are **deprecated**. Use the new factory functions:

```ts
// Before:
const client = new SigilClient({ rpc, vault, agent, network });
const owner = new OwnerClient({ rpc, vault, owner: signer, network });

// After:
const client = createSigilClient({ rpc, vault, agent, network });
const owner = createOwnerClient({ rpc, vault, owner: signer, network });
```

Both factory functions return the same API surface — same method names, same signatures. The factories carry context in closures (no `this` binding). Classes remain available for one minor as a migration ramp; removed at v1.0.

**Why factory over class:** Tree-shakeable, no `this` footguns, composable, testable, aligned with @solana/kit v2 and viem patterns. The /fns subpath compromise was rejected in favor of the principled architecture.

### New: fromJSON MCP round-trip

10 `fromJSON` functions for dashboard type deserialization:

```ts
import { overviewDataFromJSON } from "@usesigil/kit/dashboard";

// AI agent receives JSON from MCP tool → rehydrates typed object
const overview = overviewDataFromJSON(jsonFromMcpTool);
overview.spending.global.cap; // bigint (was string in JSON)
```

Essential for MCP-based AI agent workflows where data round-trips through JSON tool responses.

### New: x402 documentation

`@usesigil/kit/x402` subpath now documented in README with usage example. `shieldedFetch()` handles HTTP 402 payment negotiation with vault policy enforcement.

### Migration

1. Replace `new SigilClient(...)` → `createSigilClient(...)`
2. Replace `new OwnerClient(...)` → `createOwnerClient(...)`
3. All method calls remain identical — no other changes needed
