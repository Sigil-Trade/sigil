//! Phase 2 Option A: small helpers shared across instruction handlers.
//!
//! - `policy_digest`: canonical Borsh encoding + SHA-256 of policy preview fields
//!   (TA-19). Used at `initialize_vault`, `queue_policy_update`, and re-asserted
//!   at `apply_pending_policy`.
//! - `destination_check`: token-account-owner resolution + allowlist check.
//!   Wires `PolicyConfig.allowed_destinations` into spending paths
//!   (`validate_and_authorize`), not just `agent_transfer`.
//! - `token2022_extension` (TA-08, Phase 3): Token-2022 mint TLV walker
//!   that enforces the 3-item extension allowlist at deposit time.

pub mod audit_log;
pub mod cosign_digest;
pub mod destination_check;
pub mod freeze_helper;
pub mod intent_digest;
pub mod mint_delta_cap;
pub mod operator_grant;
pub mod policy_digest;
pub mod post_assertion_helpers;
pub mod program_hash;
pub mod token2022_extension;
