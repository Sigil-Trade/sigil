# Phalnx Discriminator Tables — Verified from Source

> Companion to `WRAP-ARCHITECTURE-PLAN.md` v3
> All bytes verified from: Jupiter (`programs/phalnx/src/instructions/integrations/jupiter.rs`),
> Flash Trade (`sdk/kit/src/generated/protocols/flash-trade/instructions/*.ts`)

---

## Rust: On-Chain Discriminator Map (`action_type_verification.rs`)

```rust
use anchor_lang::prelude::*;
use crate::errors::PhalnxError;
use crate::state::{ActionType, JUPITER_PROGRAM, FLASH_TRADE_PROGRAM};

#[derive(PartialEq)]
pub enum SpendingCategory {
    Spending,
    NonSpending,
}

struct DiscriminatorEntry {
    program_id: Pubkey,
    discriminator: [u8; 8],
    category: SpendingCategory,
}

const DISCRIMINATOR_MAP: &[DiscriminatorEntry] = &[
    // ═══ JUPITER V6 (4 entries, all Spending) ═══
    // Source: programs/phalnx/src/instructions/integrations/jupiter.rs:9-19
    DiscriminatorEntry {
        program_id: JUPITER_PROGRAM,
        discriminator: [229, 23, 203, 151, 122, 227, 173, 42],  // route
        category: SpendingCategory::Spending,
    },
    DiscriminatorEntry {
        program_id: JUPITER_PROGRAM,
        discriminator: [193, 32, 155, 51, 65, 214, 156, 129],  // shared_accounts_route
        category: SpendingCategory::Spending,
    },
    DiscriminatorEntry {
        program_id: JUPITER_PROGRAM,
        discriminator: [208, 51, 239, 151, 123, 43, 237, 92],  // exact_out_route
        category: SpendingCategory::Spending,
    },
    DiscriminatorEntry {
        program_id: JUPITER_PROGRAM,
        discriminator: [176, 209, 105, 168, 154, 125, 69, 62],  // shared_accounts_exact_out_route
        category: SpendingCategory::Spending,
    },

    // ═══ FLASH TRADE — SPENDING (8 entries) ═══
    // Source: sdk/kit/src/generated/protocols/flash-trade/instructions/
    // ActionType mapping: Canonical Spending Classification Table in WRAP-ARCHITECTURE-PLAN.md

    // openPosition → ActionType::OpenPosition (Spending, Increment)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [135, 128, 47, 77, 15, 152, 240, 49],
        category: SpendingCategory::Spending,
    },
    // increaseSize → ActionType::IncreasePosition (Spending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [107, 13, 141, 238, 152, 165, 96, 87],
        category: SpendingCategory::Spending,
    },
    // addCollateral → ActionType::AddCollateral (Spending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [127, 82, 121, 42, 161, 176, 249, 206],
        category: SpendingCategory::Spending,
    },
    // swap → ActionType::Swap (Spending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [248, 198, 158, 145, 225, 117, 135, 200],
        category: SpendingCategory::Spending,
    },
    // swapAndOpen → ActionType::SwapAndOpenPosition (Spending, Increment)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [26, 209, 42, 0, 169, 62, 30, 118],
        category: SpendingCategory::Spending,
    },
    // swapAndAddCollateral → ActionType::AddCollateral (Spending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [135, 207, 228, 112, 247, 15, 29, 150],
        category: SpendingCategory::Spending,
    },
    // placeLimitOrder → ActionType::PlaceLimitOrder (Spending, Increment)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [108, 176, 33, 186, 146, 229, 1, 197],
        category: SpendingCategory::Spending,
    },
    // addLiquidity → ActionType::Deposit (Spending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [181, 157, 89, 67, 143, 182, 52, 72],
        category: SpendingCategory::Spending,
    },

    // ═══ FLASH TRADE — NON-SPENDING (12 entries) ═══

    // closePosition → ActionType::ClosePosition (NonSpending, Decrement)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [123, 134, 81, 0, 49, 68, 98, 98],
        category: SpendingCategory::NonSpending,
    },
    // decreaseSize → ActionType::DecreasePosition (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [171, 28, 203, 29, 118, 16, 214, 169],
        category: SpendingCategory::NonSpending,
    },
    // removeCollateral → ActionType::RemoveCollateral (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [86, 222, 130, 86, 92, 20, 72, 65],
        category: SpendingCategory::NonSpending,
    },
    // removeCollateralAndSwap → ActionType::RemoveCollateral (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [197, 216, 82, 134, 173, 128, 23, 62],
        category: SpendingCategory::NonSpending,
    },
    // closeAndSwap → ActionType::CloseAndSwapPosition (NonSpending, Decrement)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [147, 164, 185, 240, 155, 33, 165, 125],
        category: SpendingCategory::NonSpending,
    },
    // placeTriggerOrder → ActionType::PlaceTriggerOrder (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [32, 156, 50, 188, 232, 159, 112, 236],
        category: SpendingCategory::NonSpending,
    },
    // editTriggerOrder → ActionType::EditTriggerOrder (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [180, 43, 215, 112, 254, 116, 20, 133],
        category: SpendingCategory::NonSpending,
    },
    // cancelTriggerOrder → ActionType::CancelTriggerOrder (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [144, 84, 67, 39, 27, 25, 202, 141],
        category: SpendingCategory::NonSpending,
    },
    // editLimitOrder → ActionType::EditLimitOrder (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [42, 114, 3, 11, 137, 245, 206, 50],
        category: SpendingCategory::NonSpending,
    },
    // cancelLimitOrder → ActionType::CancelLimitOrder (NonSpending, Decrement)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [132, 156, 132, 31, 67, 40, 232, 97],
        category: SpendingCategory::NonSpending,
    },
    // removeLiquidity → ActionType::Withdraw (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [80, 85, 209, 72, 24, 206, 177, 108],
        category: SpendingCategory::NonSpending,
    },
    // cancelAllTriggerOrders → ActionType::CancelTriggerOrder (NonSpending, None)
    DiscriminatorEntry {
        program_id: FLASH_TRADE_PROGRAM,
        discriminator: [130, 108, 33, 153, 228, 31, 216, 219],
        category: SpendingCategory::NonSpending,
    },
];

/// Verify spending category consistency between declared ActionType and instruction discriminator.
pub fn verify_action_type_consistency(
    ix_program_id: &Pubkey,
    ix_data: &[u8],
    declared_action_type: &ActionType,
) -> Result<()> {
    if ix_data.len() < 8 {
        return Ok(());
    }

    let disc = &ix_data[..8];
    let declared_spending = declared_action_type.is_spending();

    for entry in DISCRIMINATOR_MAP {
        if entry.program_id == *ix_program_id {
            let mut matches = true;
            for i in 0..8 {
                if entry.discriminator[i] != disc[i] {
                    matches = false;
                    break;
                }
            }
            if matches {
                let actual_spending = entry.category == SpendingCategory::Spending;
                if actual_spending && !declared_spending {
                    msg!("ActionType mismatch: instruction is spending but declared as non-spending");
                    return Err(error!(PhalnxError::ActionTypeMismatch));
                }
                if !actual_spending && declared_spending {
                    msg!("ActionType mismatch: instruction is non-spending but declared as spending");
                    return Err(error!(PhalnxError::ActionTypeMismatch));
                }
                return Ok(());
            }
        }
    }

    // Not in map. Two cases:
    // 1. Program is in the vault's allowlist but discriminator isn't mapped:
    //    REJECT non-spending declarations. An allowlisted program with an unknown
    //    discriminator MUST be treated as spending to prevent cap bypass.
    //    The SDK already defaults to spending (safe), but a malicious agent
    //    calling RPC directly could declare non-spending to bypass caps.
    // 2. Program is not in any known list: allow (the protocol allowlist
    //    already gates it in the instruction scan).
    //
    // Since this function is called DURING the instruction scan (which already
    // verified the program is on the allowlist), we know the program is allowed.
    // Therefore: reject non-spending for ANY unmapped discriminator.
    if !declared_spending {
        msg!("Unknown discriminator on allowlisted program — non-spending declaration rejected");
        return Err(error!(PhalnxError::ActionTypeMismatch));
    }

    Ok(())
}
```

---

## TypeScript: SDK Inference Map (`action-type-inference.ts`)

```typescript
import type { Address, Instruction } from "@solana/kit";
import { ActionType } from "./generated/types/actionType.js";

interface DiscriminatorMapping {
  programId: Address;
  discriminator: Uint8Array;
  actionType: ActionType;
  isSpending: boolean;
}

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const FLASH_TRADE = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn" as Address;

const MAP: DiscriminatorMapping[] = [
  // Jupiter V6 (all Spending → ActionType.Swap)
  { programId: JUPITER, discriminator: new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42]), actionType: ActionType.Swap, isSpending: true },
  { programId: JUPITER, discriminator: new Uint8Array([193, 32, 155, 51, 65, 214, 156, 129]), actionType: ActionType.Swap, isSpending: true },
  { programId: JUPITER, discriminator: new Uint8Array([208, 51, 239, 151, 123, 43, 237, 92]), actionType: ActionType.Swap, isSpending: true },
  { programId: JUPITER, discriminator: new Uint8Array([176, 209, 105, 168, 154, 125, 69, 62]), actionType: ActionType.Swap, isSpending: true },

  // Flash Trade — Spending
  { programId: FLASH_TRADE, discriminator: new Uint8Array([135, 128, 47, 77, 15, 152, 240, 49]), actionType: ActionType.OpenPosition, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([107, 13, 141, 238, 152, 165, 96, 87]), actionType: ActionType.IncreasePosition, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([127, 82, 121, 42, 161, 176, 249, 206]), actionType: ActionType.AddCollateral, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]), actionType: ActionType.Swap, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([26, 209, 42, 0, 169, 62, 30, 118]), actionType: ActionType.SwapAndOpenPosition, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([135, 207, 228, 112, 247, 15, 29, 150]), actionType: ActionType.AddCollateral, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([108, 176, 33, 186, 146, 229, 1, 197]), actionType: ActionType.PlaceLimitOrder, isSpending: true },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([181, 157, 89, 67, 143, 182, 52, 72]), actionType: ActionType.Deposit, isSpending: true },

  // Flash Trade — NonSpending
  { programId: FLASH_TRADE, discriminator: new Uint8Array([123, 134, 81, 0, 49, 68, 98, 98]), actionType: ActionType.ClosePosition, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([171, 28, 203, 29, 118, 16, 214, 169]), actionType: ActionType.DecreasePosition, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([86, 222, 130, 86, 92, 20, 72, 65]), actionType: ActionType.RemoveCollateral, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([197, 216, 82, 134, 173, 128, 23, 62]), actionType: ActionType.RemoveCollateral, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([147, 164, 185, 240, 155, 33, 165, 125]), actionType: ActionType.CloseAndSwapPosition, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([32, 156, 50, 188, 232, 159, 112, 236]), actionType: ActionType.PlaceTriggerOrder, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([180, 43, 215, 112, 254, 116, 20, 133]), actionType: ActionType.EditTriggerOrder, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([144, 84, 67, 39, 27, 25, 202, 141]), actionType: ActionType.CancelTriggerOrder, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([42, 114, 3, 11, 137, 245, 206, 50]), actionType: ActionType.EditLimitOrder, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([132, 156, 132, 31, 67, 40, 232, 97]), actionType: ActionType.CancelLimitOrder, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([80, 85, 209, 72, 24, 206, 177, 108]), actionType: ActionType.Withdraw, isSpending: false },
  { programId: FLASH_TRADE, discriminator: new Uint8Array([130, 108, 33, 153, 228, 31, 216, 219]), actionType: ActionType.CancelTriggerOrder, isSpending: false },
];

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function inferActionType(ix: Instruction): {
  actionType: ActionType;
  isSpending: boolean;
  confidence: "exact" | "default";
} | null {
  if (!ix.data || ix.data.length < 8) return null;
  const disc = new Uint8Array(ix.data.slice(0, 8));

  for (const m of MAP) {
    if (m.programId === ix.programAddress && arraysEqual(m.discriminator, disc)) {
      return { actionType: m.actionType, isSpending: m.isSpending, confidence: "exact" };
    }
  }

  // Safe default: unknown instruction → Swap (spending)
  return { actionType: ActionType.Swap, isSpending: true, confidence: "default" };
}
```

---

## Flash Trade Instruction Data Layouts (for leverage verification)

### openPosition
| Offset | Field | Type | Size |
|--------|-------|------|------|
| 0 | discriminator | u8[8] | 8 |
| 8 | priceWithSlippage | OraclePrice (u64 + i32) | 12 |
| **20** | **collateralAmount** | **u64** | **8** |
| **28** | **sizeAmount** | **u64** | **8** |
| 36 | privilege | enum (u8) | 1 |

**Leverage = sizeAmount / collateralAmount**

### increaseSize
| Offset | Field | Type | Size |
|--------|-------|------|------|
| 0 | discriminator | u8[8] | 8 |
| 8 | priceWithSlippage | OraclePrice | 12 |
| 20 | sizeDelta | u64 | 8 |
| 28 | privilege | enum (u8) | 1 |

**Cannot verify leverage from instruction data alone** — needs existing position's collateral from on-chain state.

### swapAndOpen
| Offset | Field | Type | Size |
|--------|-------|------|------|
| 0 | discriminator | u8[8] | 8 |
| 8 | priceWithSlippage | OraclePrice | 12 |
| **20** | **amountIn** | **u64** | **8** |
| **28** | **sizeAmount** | **u64** | **8** |
| 36 | privilege | enum (u8) | 1 |

**Leverage ≈ sizeAmount / amountIn** (amountIn is swap input, not direct collateral — approximate)

### swap
| Offset | Field | Type | Size |
|--------|-------|------|------|
| 0 | discriminator | u8[8] | 8 |
| 8 | amountIn | u64 | 8 |
| 16 | minAmountOut | u64 | 8 |

No leverage field — swaps don't create positions.
