use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, Instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount};

use crate::errors::SigilError;
// C-1 fix: FeesCollected moved to finalize_session (fees are now collected there
// on the MEASURED spend, inside the caps); no longer emitted here.
use crate::events::ActionAuthorized;
use crate::state::*;
use crate::utils::destination_check::enforce_destination_allowlist;

/// Maximum instructions to scan from any sysvar introspection loop.
///
/// Solana's per-tx instruction count is bounded at 64 by the v0 transaction
/// message format (1-byte length, but in practice limited by tx size and the
/// sysvar instructions accounting). This constant is a defense-in-depth cap
/// against SIMD-0296-class pad-attack DoS where an adversary fills a tx with
/// cheap ComputeBudget no-ops to inflate the cost of O(n) sysvar scans.
///
/// The constant is shared by:
///   - validate_and_authorize: backward pre-validate scan (5a)
///   - validate_and_authorize: forward spending/non-spending scans (6, 6b)
///   - finalize_session: post-finalize defense-in-depth scan
///
/// At 64, this is unreachable in legitimate flows (Solana caps tx ix count
/// at 64 already); only an attacker pushing ix beyond the protocol limit
/// would trip this.
pub const MAX_SYSVAR_SCAN_ITERATIONS: usize = 64;

#[derive(Accounts)]
#[instruction(token_mint: Pubkey)]
pub struct ValidateAndAuthorize<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault.is_agent(&agent.key()) @ SigilError::UnauthorizedAgent,
        seeds = [b"vault", vault.vault_authority.as_ref(), vault.vault_id.to_le_bytes().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        has_one = vault,
        seeds = [b"policy", vault.key().as_ref()],
        bump = policy.bump,
    )]
    /// Boxed to keep the `ValidateAndAuthorize::try_accounts` stack frame
    /// below BPF's 4 KB ceiling. Phase 10 D-5 added 32 bytes
    /// (`cosign_session_pubkey`) to PolicyConfig, pushing the codegen
    /// frame from 4072 to 4104 bytes (8 over). `Box` moves the deserialized
    /// wrapper to the heap, restoring headroom.
    pub policy: Box<Account<'info, PolicyConfig>>,

    /// Zero-copy SpendTracker
    #[account(
        mut,
        seeds = [b"tracker", vault.key().as_ref()],
        bump = tracker.load()?.bump,
    )]
    pub tracker: AccountLoader<'info, SpendTracker>,

    /// Zero-copy AgentSpendOverlay — per-agent rolling spend
    #[account(
        mut,
        seeds = [b"agent_spend", vault.key().as_ref(), &[0u8]],
        bump = agent_spend_overlay.load()?.bump,
    )]
    pub agent_spend_overlay: AccountLoader<'info, AgentSpendOverlay>,

    /// Ephemeral session PDA — `init` ensures no double-authorization.
    /// Seeds include token_mint for per-token concurrent sessions.
    #[account(
        init,
        payer = agent,
        space = SessionAuthority::SIZE,
        seeds = [
            b"session",
            vault.key().as_ref(),
            agent.key().as_ref(),
            token_mint.as_ref(),
        ],
        bump,
    )]
    pub session: Account<'info, SessionAuthority>,

    /// Vault's PDA-owned token account for the spend token
    #[account(
        mut,
        constraint = vault_token_account.owner == vault.key()
            @ SigilError::InvalidTokenAccount,
        constraint = vault_token_account.mint == token_mint_account.key()
            @ SigilError::InvalidTokenAccount,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The token mint being spent — constrained to match token_mint arg
    #[account(
        constraint = token_mint_account.key() == token_mint
            @ SigilError::InvalidTokenAccount,
    )]
    pub token_mint_account: Account<'info, Mint>,

    // C-1 fix: protocol_treasury_token_account + fee_destination_token_account
    // RELOCATED to FinalizeSession. Fees are no longer collected upfront at
    // validate (on the unbounded declared `amount`); they are collected at
    // finalize on the MEASURED spend, inside the spend caps. See finalize_session.
    /// Vault's stablecoin ATA to snapshot (for non-stablecoin input spending).
    /// Required when input token is NOT a stablecoin (output verification in finalize).
    #[account(mut)]
    pub output_stablecoin_account: Option<Account<'info, TokenAccount>>,

    /// M1 output-ownership pin — the VAULT-OWNED token account an acquiring swap
    /// on the STABLECOIN-INPUT path must credit. Pinned + snapshotted here;
    /// finalize asserts this exact account increased, so the agent cannot
    /// redirect the swap output to its own ATA. Must pre-exist (like the F-Q8
    /// output ATA above — the forward scan permits no in-tx ATA-create). GENERIC:
    /// any vault-owned token account of a non-input mint; no protocol knowledge.
    /// Its Token-2022 extensions (if any) are vetted by the forward scan's F-Q4
    /// destination check, since the output ATA is a writable vault-owned meta of
    /// the swap ix.
    ///
    /// Boxed: an unboxed `Option<Account>` here pushed `try_accounts` 8 bytes
    /// over the 4096 BPF stack limit; boxing moves the deserialized account to
    /// the heap (handler access is unchanged via deref).
    #[account(mut)]
    pub output_swap_account: Option<Box<Account<'info, TokenAccount>>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// Instructions sysvar for verifying DeFi instruction program_id
    /// and protocol slippage enforcement.
    /// CHECK: address constrained to sysvar::instructions::ID
    #[account(
        address = anchor_lang::solana_program::sysvar::instructions::ID
    )]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ValidateAndAuthorize>,
    token_mint: Pubkey,
    amount: u64,
    target_protocol: Pubkey,
    expected_policy_version: u64,
    // AC-10 (Phase 4) — durable-nonce replay defense per Audit #1 C-1.
    // The `session` account is `init` (not `init_if_needed`), so steady-state
    // operation creates a fresh SessionAuthority on every validate with
    // `nonce = 0`. Callers therefore pass 0 in the typical flow. The check
    // is structural: it sits behind every successful validate so a Phase 8
    // ownership-transfer flow (M-5) extension can extend the contract
    // without breaking the on-chain shape.
    expected_nonce: u64,
    // D-1 + D-6 (Bucket 2 2026-05-21): AL3 scalar intent digest. See
    // `lib.rs:validate_and_authorize` docstring for the full canonical
    // encoding. Verified below before any state-of-record mutation.
    expected_intent_digest: [u8; 32],
) -> Result<()> {
    // 0. Reject CPI calls — only top-level transaction instructions allowed.
    require!(
        get_stack_height()
            == anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
        SigilError::CpiCallNotAllowed
    );

    // D-1 close: AL3 scalar intent-digest verifier. Recompute the same
    // SHA-256 the wallet UI computed at preview time over the SCALAR
    // SealInput projection (vault, agent, token_mint, amount,
    // target_protocol, network) and reject on byte-equal mismatch.
    //
    // The check runs FIRST so a recipient/amount/mint/protocol-swap
    // preview-vs-execute attack costs no CU beyond the digest hash. We
    // hold off touching policy/tracker state until the digest matches.
    //
    // Network discriminant is derived on-chain from the program's build
    // feature — the caller doesn't pin it. A mainnet-targeted digest sent
    // to a devnet program (or vice-versa) reproducibly fails the byte-
    // equal check, closing the cross-network replay class.
    {
        let vault_key = ctx.accounts.vault.key();
        let agent_key = ctx.accounts.agent.key();
        let scalar_input = crate::utils::intent_digest::ScalarIntentInput {
            vault: &vault_key,
            agent: &agent_key,
            token_mint: &token_mint,
            amount,
            target_protocol: &target_protocol,
        };
        let recomputed = crate::utils::intent_digest::compute_scalar_intent_digest(&scalar_input);
        require!(
            crate::utils::intent_digest::digests_equal(&recomputed, &expected_intent_digest),
            SigilError::ErrIntentDigestMismatch
        );
    }

    let vault = &ctx.accounts.vault;
    let policy = &ctx.accounts.policy;
    let clock = Clock::get()?;

    // AC-10 (Phase 4): session nonce check. The session account is created
    // via `init` so a fresh account has `nonce = 0`. The caller's
    // `expected_nonce` MUST equal the stored value. Because `init` zeroes
    // the account, the check is effectively `expected_nonce == 0` for new
    // sessions — but written generically so Phase 8 ownership-transfer
    // flow (M-5) can reuse the field with stored-state semantics.
    //
    // The reject_cpi guard above prevents a nested validate from reusing a
    // partially-initialized session; the nonce check is defense-in-depth
    // for the durable-nonce class where an attacker pre-signs a validate
    // and replays it with a stale nonce after the session was closed by an
    // intervening finalize.
    require!(
        ctx.accounts.session.nonce == expected_nonce,
        SigilError::ErrSessionNonceMismatch
    );

    // TOCTOU fix: reject if policy changed since agent's off-chain RPC read.
    require!(
        policy.policy_version == expected_policy_version,
        SigilError::PolicyVersionMismatch
    );

    // F-13 audit fix: observe_only short-circuit BEFORE the 35KB constraints
    // PDA borrow. Previously this fired at line 216 after the zero-copy
    // load + discriminator check + PDA-derivation recompute consumed ~10-15K
    // CU. Moving it forward saves that work whenever the owner has parked
    // the vault in observe-only mode.
    //
    // Independent from Phase 2 TA-19: this is purely a CU-locality optimization;
    // the original at-entry observe_only check after vault.is_active() is now
    // redundant and is deleted below.
    require!(
        !vault.observe_only,
        SigilError::ObserveOnlyModeBlocksExecute
    );

    // TA-05 (Phase 3 pre-execution guard #2): operating_hours UTC bitmask.
    // Runs AFTER observe_only short-circuit (F-13: observe_only stays first
    // because it short-circuits the 35KB constraints PDA borrow). Runs
    // BEFORE the constraints PDA load because the hours check is cheap
    // (single arith + bit test) — fail fast for owners who park agents
    // outside their configured window. Bound by TA-19 at canonical position
    // 15 so owner-blind-sign can't slip a permissive 0xFFFFFF when the
    // owner thought they signed a narrow mask.
    require!(
        policy.is_within_operating_hours(clock.unix_timestamp),
        SigilError::ErrOutsideOperatingHours
    );

    // TA-06 (Phase 3 pre-execution guard #3): per-agent cooldown.
    // Per-AGENT, not per-vault (F-16): a per-vault cooldown would let one
    // agent's traffic DoS all other agents on the vault.
    //
    // Load the overlay, locate the agent's slot, check the elapsed time
    // against the configured cooldown_seconds. Failure surfaces as 6076
    // ErrCooldownActive. Agents without a configured cooldown
    // (cooldown_seconds == 0) auto-pass.
    {
        let overlay = ctx.accounts.agent_spend_overlay.load()?;
        let agent_key = ctx.accounts.agent.key();
        if let Some(slot_idx) = overlay.find_agent_slot(&agent_key) {
            require!(
                overlay.is_cooldown_elapsed(slot_idx, clock.unix_timestamp),
                SigilError::ErrCooldownActive
            );
        }
        // No overlay slot → no cooldown enforced. Owner-configured cooldown
        // requires a slot; the slot is auto-claimed at register_agent for
        // any agent with spending_limit_usd > 0 (existing F-16 fail-closed
        // path). Agents without a slot are read-only / non-spending and
        // bypass the cooldown — they have no spending state to pace.
    }

    let vault_key = vault.key();
    // Spending classification: amount > 0 = spending, amount == 0 = non-spending.
    let is_spending = amount > 0;
    let is_stablecoin_input = is_stablecoin_mint(&token_mint);

    // M1-04 (constraints-engine teardown, 2026-05-31): the instruction-data
    // constraints engine is removed. validate_and_authorize no longer loads or
    // enforces an InstructionConstraints PDA from remaining_accounts — the scan
    // below relies on the protocol allowlist + dangerous-opcode blocks + the
    // balance-delta / post-assertion outcome checks (all independent of the
    // deleted engine). `policy.has_constraints` is collapsed to always-false in
    // step 3 and removed in step 5; no runtime constraint load remains.

    // 1. Vault must be active
    require!(vault.is_active(), SigilError::VaultNotActive);

    // F-13 audit fix: observe_only check moved to BEFORE the constraints PDA
    // load (see top of handler). The earlier short-circuit saves the 35KB
    // borrow + discriminator check when the vault is in observe-only mode.

    // 1a-pre. Agent must not be paused
    require!(
        !vault.is_agent_paused(&ctx.accounts.agent.key()),
        SigilError::AgentPaused
    );

    // TA-17 (Phase 3): distinguish auto-revoked agents from manually-
    // disabled ones. If the agent's capability is DISABLED AND its
    // consecutive_failures hit the policy threshold, surface
    // ErrAutoRevoked (6081) instead of InsufficientPermissions — owner
    // observability into auto-revoke events. Owner re-enables via
    // queue_agent_permissions_update.
    let agent_key_check = ctx.accounts.agent.key();
    if let Some(entry) = vault.get_agent(&agent_key_check) {
        if entry.capability == CAPABILITY_DISABLED
            && entry.consecutive_failures >= policy.auto_revoke_threshold
            && policy.auto_revoke_threshold > 0
        {
            return Err(error!(SigilError::ErrAutoRevoked));
        }
    }

    // 1a. Agent must have capability for the spending level
    require!(
        vault.has_capability(&ctx.accounts.agent.key(), is_spending),
        SigilError::InsufficientPermissions
    );

    // 2. Protocol must be allowed (mode-based check) — ALL actions
    require!(
        policy.is_protocol_allowed(&target_protocol),
        SigilError::ProtocolNotAllowed
    );

    // 2b. Item 3 (verified-build gate, 2026-06-22): if the target protocol has a
    // non-zero pinned build hash in `policy.protocol_hashes` (index-aligned to
    // `policy.protocols`), enforce that the target's currently-deployed ELF still
    // matches the owner-attested hash. Closes the upgrade-TOCTOU: an
    // owner-allowlisted program upgraded to a drain would otherwise keep being
    // authorized. The SDK `seal()` satisfier supplies the target's ProgramData
    // account in `remaining_accounts` whenever a hash is armed; if it is absent
    // while armed, the gate is FAIL-CLOSED (ErrProgramDataUnresolvable 6116). The
    // lookup + hash compare are kept in an `#[inline(never)]` helper to protect
    // validate's already-tight BPF stack frame (same pattern as the TA-11 set
    // builder). When no hash is armed for the target, this is a cheap
    // index-scan + zero-check and returns immediately (gate disabled).
    enforce_verified_build_if_armed(policy, &target_protocol, ctx.remaining_accounts)?;

    // --- Stablecoin-only spending path ---
    let mut output_mint = Pubkey::default();
    let mut stablecoin_balance_before: u64 = 0;
    // F-Q8: pin the exact stablecoin ATA measured at validate so finalize
    // cannot be handed a different vault-owned stablecoin ATA.
    let mut output_stablecoin_account_key = Pubkey::default();
    // M1 output-ownership pin (stablecoin-input swap path). Defaults stay set
    // for non-swap / non-stablecoin-input / non-spending sessions.
    let mut output_swap_account_key = Pubkey::default();
    let mut output_swap_mint = Pubkey::default();
    let mut output_swap_balance_before: u64 = 0;
    // C-1 fix: fees are no longer computed/charged at validate. They are
    // collected at finalize on the MEASURED spend, INSIDE the spend caps (the
    // upfront fee on the UNBOUNDED declared `amount` was the fee-cap-bypass drain
    // vector). The SPL `Approve` below now delegates the full `amount` (no fee
    // subtraction).
    if is_spending {
        if is_stablecoin_input {
            // C-1 fix: bound the declared (USD-denominated) `amount` by the per-tx
            // cap. Without this the agent could declare an arbitrarily large amount;
            // pre-fix that inflated the upfront fee to ≈ the whole vault balance
            // (drained to the treasury) while finalize's caps saw only the dust
            // spend. With fees now charged on measured spend inside the caps, the
            // declared amount is also bound here so the delegation it authorizes
            // cannot exceed the per-tx cap. `amount` is USD on the stablecoin-input
            // path (stablecoin base units == USD 6dp), so this comparison is
            // unit-correct; the non-stablecoin path keeps native-unit `amount`
            // uncapped (by design — finalize measures the stablecoin inflow).
            if policy.max_transaction_size_usd > 0 {
                require!(
                    amount <= policy.max_transaction_size_usd,
                    SigilError::TransactionTooLarge
                );
            }

            // Snapshot stablecoin balance BEFORE spending.
            // Finalize uses this to compute actual spending delta.
            stablecoin_balance_before = ctx.accounts.vault_token_account.amount;
            output_mint = token_mint;

            // M1 output-ownership pin: if the caller declares an acquired-output
            // token account (an acquiring swap), pin it VAULT-OWNED + snapshot its
            // pre-DeFi balance. finalize requires this EXACT account to have
            // INCREASED, so a compromised agent cannot redirect the swap output to
            // its own ATA. Optional here (validate cannot see actual_spend);
            // finalize mandates it when actual_spend > 0. GENERIC — any vault-owned
            // token account of a non-input mint; no protocol knowledge.
            if let Some(swap_acct) = ctx.accounts.output_swap_account.as_ref() {
                require!(
                    swap_acct.owner == vault_key,
                    SigilError::ErrOutputNotVaultOwned
                );
                // Must be a genuine acquisition, not a same-mint self-move.
                require!(
                    swap_acct.mint != token_mint,
                    SigilError::ErrOutputNotVaultOwned
                );
                output_swap_account_key = swap_acct.key();
                output_swap_mint = swap_acct.mint;
                output_swap_balance_before = swap_acct.amount;
            }

            // Cap checks, fee collection, and spend recording all deferred to
            // finalize_session where the actual stablecoin balance delta is
            // measured (outcome-based).
        } else {
            // Non-stablecoin input: snapshot stablecoin balance, verify at finalize.
            // No cap check or fees here — USD tracked when stablecoin flows in finalize.
            let stablecoin_acct = ctx
                .accounts
                .output_stablecoin_account
                .as_ref()
                .ok_or(error!(SigilError::InvalidTokenAccount))?;

            // Verify the stablecoin account belongs to the vault
            require!(
                stablecoin_acct.owner == vault_key,
                SigilError::InvalidTokenAccount
            );
            // Verify it's actually a stablecoin mint
            require!(
                is_stablecoin_mint(&stablecoin_acct.mint),
                SigilError::UnsupportedToken
            );

            output_mint = stablecoin_acct.mint;
            stablecoin_balance_before = stablecoin_acct.amount;
            // F-Q8: pin this exact ATA's pubkey; finalize asserts it matches.
            output_stablecoin_account_key = stablecoin_acct.key();
        }
    }

    // Shared across spending and non-spending scan paths
    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    let current_idx = load_current_index_checked(&ix_sysvar)
        .map_err(|_| error!(SigilError::MissingFinalizeInstruction))?;
    let current_idx_usize = current_idx as usize;

    let spl_token_id = ctx.accounts.token_program.key();
    // P3.1 audit fix (2026-05-19): use the shared COMPUTE_BUDGET_PROGRAM_ID
    // const from state/mod.rs (eliminates the 32-byte literal duplication
    // with finalize_session.rs that used to drift independently).
    let compute_budget_id = crate::state::COMPUTE_BUDGET_PROGRAM_ID;

    // 5a. Backward instruction scan (Phase B2 security fix):
    // Reject any non-infrastructure instructions BEFORE validate_and_authorize.
    // Prevents DeFi-before-validate ordering attack where an agent places the
    // DeFi instruction first to make snapshot capture post-modification state.
    //
    // M11 hardening (SIMD-0296 pad-attack DoS guard): cap iterations at
    // MAX_SYSVAR_SCAN_ITERATIONS. In legitimate flows current_idx_usize <= 64
    // (Solana v0 tx caps at 64 ix), so the cap is unreachable; only an attacker
    // would trip it, in which case we return an explicit error rather than
    // silently truncating the scan (the unscanned ixs could be hostile).
    let mut pre_iter_count: usize = 0;
    for pre_idx in 0..current_idx_usize {
        require!(
            pre_iter_count < MAX_SYSVAR_SCAN_ITERATIONS,
            SigilError::SysvarScanBoundExceeded
        );
        if let Ok(ix) = load_instruction_at_checked(pre_idx, &ix_sysvar) {
            require!(
                ix.program_id == compute_budget_id
                    || ix.program_id == anchor_lang::solana_program::system_program::ID,
                SigilError::UnauthorizedPreValidateInstruction
            );
        }
        pre_iter_count = pre_iter_count.saturating_add(1);
    }
    let finalize_hash = FINALIZE_SESSION_DISCRIMINATOR;

    // ── TA-10 (Phase 4) sandwich-integrity uniqueness ───────────────
    //
    // Reject if there is ANOTHER `validate_and_authorize` instruction in
    // the same transaction whose (vault, agent, mint) tuple matches the
    // current execution's tuple.
    //
    // **Why this matters.** Phase 1/Phase 2 already enforced
    // "immediate-next ix after validate is an allowed protocol" + the
    // forward scan that finds finalize. What's still possible without this
    // check: an attacker stages a second `validate_and_authorize` inside
    // the same tx (between this validate and the first finalize) targeting
    // the same (vault, agent, mint) tuple. The second authorize would
    // open a fresh session with its own delegated amount BEFORE the first
    // finalize revokes the SPL approval. If the second session has a
    // different / larger authorized amount, the attacker has bypassed the
    // outer authorize's spending intent.
    //
    // **Tuple match by account-meta pubkeys.** Codama-generated discriminator
    // [22, 183, 48, 222, 218, 11, 197, 152]. From the Accounts struct:
    //   accounts[0] = agent (signer)
    //   accounts[1] = vault PDA
    //   accounts[7] = token_mint_account
    // We compare on these three pubkeys. The discriminator alone identifies
    // the ix type; meta[1]/meta[0]/meta[7] disambiguate the tuple.
    //
    // **Allowed interleave (Q-6 default).** ComputeBudget + SystemProgram
    // remain operationally interleaveable (no restriction on those types).
    // This check ONLY counts SIBLING `validate_and_authorize` ixs with the
    // SAME tuple — a second validate against a DIFFERENT vault/agent/mint
    // is fine.
    //
    // **CU profile.** O(N) over instructions, no per-ix sub-loops; the
    // discriminator/tuple compares are constant. Bounded by
    // MAX_SYSVAR_SCAN_ITERATIONS (64) which is unreachable in legitimate
    // flows (Solana v0 tx ix cap is 64). Worst-case ≈ 1K CU.
    //
    // **F-13 ordering preserved.** This scan runs AFTER observe_only
    // short-circuit and TA-05 / TA-06 cheap checks but BEFORE any
    // expensive constraints PDA loading or fee CPIs. A tx that violates
    // sandwich integrity is rejected before paying for fee transfers.
    let current_agent_key = ctx.accounts.agent.key();
    let current_mint_account_key = ctx.accounts.token_mint_account.key();
    let va_disc = VALIDATE_AND_AUTHORIZE_DISCRIMINATOR;
    {
        let mut ta10_iter: usize = 0;
        let mut scan_idx: usize = 0;
        // Bound enforced by the `while` condition itself
        // (MAX_SYSVAR_SCAN_ITERATIONS). No inner `require!` needed.
        while ta10_iter < MAX_SYSVAR_SCAN_ITERATIONS {
            // Skip the current instruction — only check siblings.
            if scan_idx == current_idx_usize {
                scan_idx = scan_idx.saturating_add(1);
                ta10_iter = ta10_iter.saturating_add(1);
                continue;
            }
            let Ok(sibling) = load_instruction_at_checked(scan_idx, &ix_sysvar) else {
                break;
            };
            // Match: same program + same discriminator + at least 8 metas
            // (we read accounts[0]/[1]/[7]).
            if sibling.program_id == crate::ID
                && sibling.data.len() >= 8
                && sibling.data[..8] == va_disc
                && sibling.accounts.len() > 7
            {
                let sib_agent = sibling.accounts[0].pubkey;
                let sib_vault = sibling.accounts[1].pubkey;
                let sib_mint = sibling.accounts[7].pubkey;
                if sib_vault == vault_key
                    && sib_agent == current_agent_key
                    && sib_mint == current_mint_account_key
                {
                    return Err(error!(SigilError::ErrSandwichIntegrity));
                }
            }
            scan_idx = scan_idx.saturating_add(1);
            ta10_iter = ta10_iter.saturating_add(1);
        }
    }

    // ── TA-11 (Phase 4) DYNAMIC seed-prefix family check ─────────────
    //
    // Reject if ANY sibling instruction in the transaction passes a
    // Sigil-owned PDA as `is_writable=true`. Closes the class where a
    // foreign instruction tries to mutate Sigil state through the agent's
    // signer (the Solana BPF loader's owner-check already prevents the
    // mutation itself, but TA-11 fails the bundle BEFORE the foreign
    // program runs so an agent cannot accidentally route value through
    // a hostile compose that would trip later).
    //
    // **Algorithm.** Build the SET of protected pubkeys for THIS vault's
    // context (owner / vault_id / agent / mint), then scan every sibling
    // instruction's account metas. For each writable meta:
    //   1. If the meta.pubkey matches any pubkey in the protected set →
    //      additionally verify the on-chain `account.owner == &crate::ID`
    //      via remaining_accounts (F-30 — prevents discriminator spoofing
    //      from an attacker-deployed program at the same derived pubkey).
    //   2. If owner check passes → reject with 6083 ErrProtectedWritable.
    //   3. If owner check fails → the BPF loader's owner check will
    //      prevent the foreign program from mutating Sigil state anyway;
    //      continue (no reject).
    //
    // **Set construction.** We use the already-loaded `ctx.accounts.*` PDA
    // pubkeys for vault / policy / tracker / agent_spend_overlay / session
    // (no derivation cost — those are zero-cost reads of in-memory Anchor
    // accounts). For other families (post_assertions, pending_*, pending_owner)
    // we use `find_program_address` lazily — only one call per family.
    // Forward-looking families (audit_success, audit_rejected, cosign,
    // recipient) are listed in PROTECTED_SEED_PREFIXES for documentation but
    // the derivation step is skipped because no PDA of that family yet exists
    // for the current vault (Phase 7+ ship them).
    //
    // **Prefix count (M1-04c, 2026-06-01; was C-5 close + L-2 audit 2026-05-21).**
    // PROTECTED_SEED_PREFIXES lists 14 entries split as **12 active + 2
    // forward-compat** (M1-04c removed the 3 dead constraint seeds —
    // constraints, pending_constraints, pending_close_constraints — when the
    // constraints engine was torn down; those PDAs can never be allocated):
    //   ACTIVE (12): vault, policy, tracker, session, post_assertions,
    //     pending_policy, pending_agent_perms, pending_owner,
    //     pending_agent_grant, agent_spend, audit_success, audit_rejected
    //     (audit_* pair landed when Phase 7 audit-log PDAs went live;
    //     pending_agent_grant landed in Phase 8 PEN-CROSS-1).
    //   FORWARD-COMPAT (2): cosign (Phase 3 cosign session — no live PDA in
    //     V2 register yet), recipient (post-exec per-recipient cap).
    // The runtime TA-11 set below derives 11 vault-keyed base entries (the 12
    // active prefixes minus the 2 forward-compat plus per-agent expansion of
    // pending_agent_perms) + N per-agent pending_agent_perms keys.
    //
    // **CU profile (measured 2026-05-19 via LiteSVM in
    // tests/sysvar-scan-bound.ts "TA-11 protected-writable scan CU profile"
    // after SA4 H1 audit_success+audit_rejected derivations added; updated
    // C-5 close 2026-05-21 — added pending_agent_grant derivation +
    // helper extraction to keep validate_and_authorize stack frame under
    // BPF 4 KB ceiling).**
    //   - 30-sibling-noop bundle end-to-end: ~181K CU (validate + finalize +
    //     30 SystemProgram noops + 3 sysvar scans). Pre-SA4 baseline ~169K.
    //   - TA-11 scan delta for 20 extra siblings: ~61K CU (3K per extra ix).
    //   - lazy find_program_address derivations: now 7 (M1-04c removed 3
    //     constraint derivations). The measured ~50K CU above was for the
    //     prior 10 derivations; actual is now ~15K lower (3 fewer × ~5K).
    //   - Per-meta protected-set lookup (now 12 entries × pubkey-equality
    //     compare): < 240 CU per meta.
    //   - Worst-case 8 sibling ixs × 16 metas/ix ≈ 9K (scan-loop) + 50K
    //     (derivations) ≈ 55-60K total. Even doubling stays under the
    //     prompt's 90K budget; leaves > 1.3M CU for the actual sandwich.
    //     Bounded by MAX_SYSVAR_SCAN_ITERATIONS (64).
    //
    // **Token-2022/SPL token accounts NOT in set.** The vault's token ATAs
    // are NOT Sigil-owned PDAs (they're SPL Token program-owned). TA-11
    // does not gate those — `destination_check` (PEN-CROSS-4) handles
    // token-account allowlisting.
    //
    // **F-13 ordering preserved.** TA-11 runs AFTER TA-10 / observe_only /
    // operating_hours / cooldown but BEFORE constraints PDA loading or
    // any CPI. Failure rejects the bundle before paying any fee.
    {
        // TA-11 protected set built by an out-of-line helper to keep the
        // (now up to 16: 6 fixed + up to 10 per-agent) `find_program_address`
        // derivations + Vec growth out
        // of `validate_and_authorize`'s already-tight stack frame (C-5 close
        // 2026-05-21, FINDING-B follow-up 2026-05-21 — adding
        // `pending_agent_grant` + per-agent pending_agent_perms expansion
        // both grew the helper's heap footprint; main handler stack stays
        // at the 24-byte Vec header regardless).
        let protected = build_ta11_protected_set(
            vault_key,
            ctx.accounts.policy.key(),
            ctx.accounts.tracker.key(),
            ctx.accounts.agent_spend_overlay.key(),
            ctx.accounts.session.key(),
            &ctx.accounts.vault.agents,
        );

        let mut ta11_iter: usize = 0;
        let mut ix_idx: usize = 0;
        // Bound enforced by the `while` condition itself
        // (MAX_SYSVAR_SCAN_ITERATIONS). No inner `require!` needed.
        while ta11_iter < MAX_SYSVAR_SCAN_ITERATIONS {
            // Skip the current validate ix itself — its own protected metas
            // are legitimate (we OWN them) and they will be marked writable
            // for state-mutating instructions like cooldown updates.
            if ix_idx == current_idx_usize {
                ix_idx = ix_idx.saturating_add(1);
                ta11_iter = ta11_iter.saturating_add(1);
                continue;
            }
            let Ok(sibling) = load_instruction_at_checked(ix_idx, &ix_sysvar) else {
                break;
            };
            // Skip Sigil's own instructions — TA-10 already enforces
            // sandwich integrity for sibling validate_and_authorize, and
            // finalize_session's writable metas on session/vault/etc. are
            // legitimate (they're how the session closes). Other Sigil
            // ixs (queue/apply/etc.) cannot legally appear between
            // validate and finalize because the pre-validate scan blocks
            // non-infrastructure before, and the forward scan blocks
            // non-protocol between.
            if sibling.program_id == crate::ID {
                ix_idx = ix_idx.saturating_add(1);
                ta11_iter = ta11_iter.saturating_add(1);
                continue;
            }
            // Walk this foreign ix's account metas. For each writable meta,
            // check membership in the protected set + on-chain owner.
            for meta in sibling.accounts.iter() {
                if !meta.is_writable {
                    // F-13: legitimate read-only access (e.g. a frontend
                    // wallet reading PolicyConfig) is allowed.
                    continue;
                }
                let mut matched = false;
                for p in protected.iter() {
                    if *p == meta.pubkey {
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    continue;
                }
                // F-30: verify on-chain ownership. The attacker-deployed-
                // program-at-collision case is theoretical (Solana PDA
                // derivation excludes the curve so collision is
                // computationally infeasible) but we layer the check for
                // defense-in-depth.
                //
                // Lookup in remaining_accounts is best-effort: if the
                // foreign ix's protected meta is not present in our
                // remaining_accounts (the caller didn't pass it through),
                // we cannot read its owner. In that case Solana's runtime
                // owner-check will still prevent foreign mutation, so we
                // fail-closed: reject if the meta is in our protected set,
                // owner-check is best-effort to suppress false positives.
                //
                // H-4 audit fix (2026-05-19): refactored from `unwrap_or(true)`
                // (with an inverted boolean) to an explicit `match` that names
                // the FAIL_CLOSED_SIGIL_OWNED posture out loud. A future
                // refactor that flips an operand or removes the unwrap would
                // be obvious instead of silently disabling TA-11 defense.
                const FAIL_CLOSED_SIGIL_OWNED: bool = true;
                let on_chain_owner_is_sigil: bool = match ctx
                    .remaining_accounts
                    .iter()
                    .find(|ai| ai.key == &meta.pubkey)
                {
                    Some(ai) => ai.owner == &crate::ID,
                    // Account not present in remaining_accounts → owner
                    // unreadable → assume Sigil-owned and REJECT. The
                    // Solana runtime's own owner-check is the fallback
                    // layer; this is defense-in-depth.
                    None => FAIL_CLOSED_SIGIL_OWNED,
                };
                require!(!on_chain_owner_is_sigil, SigilError::ErrProtectedWritable);
            }
            ix_idx = ix_idx.saturating_add(1);
            ta11_iter = ta11_iter.saturating_add(1);
        }
    }

    // ── Shared instruction scan helper ──────────────────────────────
    // Extracted from spending + non-spending paths to eliminate ~55 lines
    // of duplicated security checks. See ON-CHAIN-IMPLEMENTATION-PLAN Step 10.
    enum ScanAction {
        FoundFinalize,
        Infrastructure,
        // Reached once an instruction has cleared the protocol allowlist + the
        // SPL/Token-2022 dangerous-opcode blocks + the async-fulfillment reject.
        // (M1-04: the instruction-data constraint-entry match was removed with
        // the constraints engine; outcome enforcement lives in the balance-delta
        // / post-assertion path at finalize_session.)
        PassedSharedChecks,
    }

    fn scan_instruction_shared(
        ix: &Instruction,
        spl_token_id: &Pubkey,
        compute_budget_id: &Pubkey,
        finalize_hash: &[u8; 8],
        policy: &PolicyConfig,
    ) -> anchor_lang::Result<ScanAction> {
        // Stop at finalize_session
        if ix.program_id == crate::ID && ix.data.len() >= 8 && ix.data[..8] == *finalize_hash {
            return Ok(ScanAction::FoundFinalize);
        }

        // Block dangerous top-level SPL Token instructions.
        if ix.program_id == *spl_token_id && !ix.data.is_empty() {
            match ix.data[0] {
                4 | 13 => return Err(error!(SigilError::UnauthorizedTokenApproval)),
                3 | 12 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                6 | 8 | 9 | 15 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                _ => {}
            }
        }

        // Token-2022: same SPL-shared opcodes (3, 4, 6, 8, 9, 12, 13, 15) plus
        // Token-2022-specific opcode 26 (TransferFeeExtension prefix — covers
        // TransferCheckedWithFee and the rest of the fee-transfer family),
        // opcode 27 (ConfidentialTransferExtension prefix — encrypted transfers
        // bypass plaintext SPL Transfer/Approve blocking entirely), and the
        // Pentester HIGH/MED follow-up batch: 35, 36, 38, 42, 45.
        //
        // Audit table — opcodes 27-46 (cross-referenced against
        // solana-program/token-2022/interface/src/instruction.rs main):
        //   27 ConfidentialTransferExtension       → BLOCKED (M3, PR 7)
        //   28 DefaultAccountStateExtension        → allowed (mint config; no
        //      value movement at top-level)
        //   29 Reallocate                          → allowed (resize only)
        //   30 MemoTransferExtension               → allowed (memo flag)
        //   31 CreateNativeMint                    → allowed (system-level)
        //   32 InitializeNonTransferableMint       → allowed (mint config)
        //   33 InterestBearingMintExtension        → allowed (mint config)
        //   34 CpiGuardExtension                   → DEFERRED (toggles a
        //      security flag on the user's token account; an agent flipping
        //      it weakens downstream CPI protections — needs explicit
        //      owner-allowlist UX, blocking now would break setup flows)
        //   35 InitializePermanentDelegate         → BLOCKED (Pentester MED:
        //      permanent delegate can transfer-from any holder of the mint
        //      without Approve; one-shot install survives session expiry)
        //   36 TransferHookExtension               → BLOCKED (Pentester MED:
        //      installs hostile hook program on the user's mint that survives
        //      session expiry and routes all future transfers through it)
        //   37 ConfidentialTransferFeeExtension    → DEFERRED (encrypted-balance
        //      fee accounting; pairs with 27 but is downstream-dependent —
        //      blocking 27 already neuters the value-flow path)
        //   38 WithdrawExcessLamports              → BLOCKED (Pentester MED:
        //      transfers lamports out of token accounts, bypassing the
        //      plaintext SPL transfer blocks entirely)
        //   39 MetadataPointerExtension            → allowed (metadata)
        //   40 GroupPointerExtension               → allowed (metadata)
        //   41 GroupMemberPointerExtension         → allowed (metadata)
        //   42 ConfidentialMintBurnExtension       → BLOCKED (Pentester HIGH:
        //      drains pre-existing confidential balance — plaintext snapshot
        //      diff won't trip; reuses ConfidentialTransferBlocked since this
        //      is the same confidential-transfer-extension class)
        //   43 ScaledUiAmountExtension             → allowed (UI scaling)
        //   44 PausableExtension                   → allowed (pause toggle;
        //      mint-level DoS but no drain)
        //   45 UnwrapLamports                      → BLOCKED (Pentester MED:
        //      same lamport-drain class as 38 — transfers lamports out of a
        //      native SOL token account)
        //   46 PermissionedBurnExtension           → BLOCKED (third-pass audit
        //      — third-party-permissioned forced burn; reuses LamportDrainBlocked
        //      semantically as a destructive-balance-mutation class)
        //  255 Batch                                → BLOCKED (third-pass audit
        //      — Token-2022 wraps a vector of inner TokenInstructions inside a
        //      single Batch ix. Without this guard, an attacker can wrap a
        //      blocked op (Withdraw 38, ConfidentialTransfer::Withdraw 27/sub=6,
        //      etc.) inside Batch (255) and the byte-0 check sees 255, not the
        //      inner opcode. Block outright; until a legitimate Batch use-case
        //      is identified for vault flows, no allowlist UX is offered.)
        //
        // The DEFERRED group (34 CpiGuard, 37 ConfTransferFee) is intentionally
        // not blocked here. Each has a legitimate setup-only use case and
        // requires explicit owner-allowlist UX before mass-blocking would
        // not break legitimate flows.
        if ix.program_id == TOKEN_2022_PROGRAM_ID && !ix.data.is_empty() {
            match ix.data[0] {
                4 | 13 => return Err(error!(SigilError::UnauthorizedTokenApproval)),
                3 | 12 | 26 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                6 | 8 | 9 | 15 => return Err(error!(SigilError::UnauthorizedTokenTransfer)),
                27 | 42 => return Err(error!(SigilError::ConfidentialTransferBlocked)),
                35 => return Err(error!(SigilError::PermanentDelegateBlocked)),
                36 => return Err(error!(SigilError::TransferHookBlocked)),
                38 | 45 | 46 => return Err(error!(SigilError::LamportDrainBlocked)),
                255 => return Err(error!(SigilError::BatchInstructionBlocked)),
                _ => {}
            }
        }

        // Whitelist infrastructure programs (no policy check needed)
        if ix.program_id == *compute_budget_id
            || ix.program_id == anchor_lang::solana_program::system_program::ID
        {
            return Ok(ScanAction::Infrastructure);
        }

        // C4 async-fulfillment deny — applies to BOTH spending and non-spending paths
        // because scan_instruction_shared is called from both. Closes the amount=0
        // bypass at validate.rs:381 / :442.
        //
        // These protocols (Jupiter Perps, Drift v2, Drift JIT proxy) use a
        // request/fulfillment model where the keeper submits the actual SPL
        // transfer 5-45s after finalize_session returns. Sigil's stablecoin
        // balance-delta measurement is always 0 at finalize, so daily caps +
        // protocol caps + spend tracker never record the real spend.
        if KNOWN_ASYNC_FULFILLMENT_PROGRAMS.contains(&ix.program_id) {
            return Err(error!(SigilError::AsyncFulfillmentNotPermitted));
        }

        // Protocol allowlist
        require!(
            policy.is_protocol_allowed(&ix.program_id),
            SigilError::ProtocolNotAllowed
        );

        // M1-04: the generic instruction-data constraint match was removed with
        // the constraints engine. An instruction that clears the allowlist +
        // opcode blocks + async-fulfillment reject is allowed through here; its
        // effects are bounded by spend caps and the balance-delta / post-
        // assertion outcome checks at finalize_session.

        Ok(ScanAction::PassedSharedChecks)
    }

    // Jupiter slippage helper removed in Phase 1 (Option A demolition).
    // The generic `policy.max_slippage_bps` config primitive is retained (D-5)
    // for runtime checks performed by post-execution assertions (Phase 6) or
    // off-chain SDK simulators — not by an on-chain Jupiter-specific parser.

    // 6. Instruction scan — validates all instructions between validate and finalize.
    // Shared checks (scan_instruction_shared): SPL/Token-2022 blocking, infrastructure
    // whitelist, protocol allowlist, generic constraints.
    // Spending-only checks (inline): recognized DeFi, ProtocolMismatch, defi_ix_count.
    //
    // F-Q2 (defense-in-depth, refactor-resistance): the SPL `Approve` armed
    // later (also under `is_spending`) MUST NOT arm unless the exactly-one-
    // DeFi-instruction invariant was checked here first. This flag is hoisted to
    // the function scope so a future reorder/split of the scan block cannot
    // re-open the free-delegation window (arming the delegate with no DeFi ix
    // for finalize to measure).
    let mut single_defi_ix_verified = false;
    if is_spending {
        let mut defi_ix_count: u8 = 0;
        let mut defi_ix_idx: Option<usize> = None;
        let mut found_finalize = false;
        let mut scan_idx = current_idx_usize.saturating_add(1);
        // M11 hardening (SIMD-0296 pad-attack DoS): bound iteration count.
        let mut iter_count: usize = 0;

        while let Ok(ix) = load_instruction_at_checked(scan_idx, &ix_sysvar) {
            require!(
                iter_count < MAX_SYSVAR_SCAN_ITERATIONS,
                SigilError::SysvarScanBoundExceeded
            );
            match scan_instruction_shared(
                &ix,
                &spl_token_id,
                &compute_budget_id,
                &finalize_hash,
                policy,
            )? {
                ScanAction::FoundFinalize => {
                    // F-Q1b adjacency (audit 2026-06-22): the single counted DeFi
                    // ix MUST sit immediately before finalize. finalize_session
                    // derives the DeFi ix as current_index - 1 for its completeness
                    // check, the per-recipient cap, and the stable-floor walk; since
                    // ComputeBudget/System ixs may interleave (classified
                    // Infrastructure above), a raw-tx caller could submit
                    // [validate, DeFi, noop, finalize] so current_index - 1 points at
                    // the inert ix and all three walks operate on the WRONG ix and
                    // pass vacuously. Require finalize to immediately follow the DeFi
                    // ix so the derivation is sound. (defi_ix_idx is None only when no
                    // DeFi ix preceded finalize — the defi_ix_count == 1 check below
                    // then rejects.) The honest seal() sandwich is always adjacent.
                    if let Some(d) = defi_ix_idx {
                        require!(
                            scan_idx == d.saturating_add(1),
                            SigilError::ErrDeFiInstructionNotAdjacentToFinalize
                        );
                    }
                    found_finalize = true;
                    break;
                }
                ScanAction::Infrastructure => {
                    scan_idx = scan_idx.saturating_add(1);
                    iter_count = iter_count.saturating_add(1);
                    continue;
                }
                ScanAction::PassedSharedChecks => {
                    // === SPENDING-ONLY CHECKS (must remain inline) ===

                    // M1 (is_recognized_defi removal, 2026-05-31): ANY
                    // instruction reaching PassedSharedChecks is a foreign DeFi
                    // instruction — it already cleared the protocol allowlist,
                    // the SPL / Token-2022 dangerous-opcode blocks, and (when
                    // present) generic constraints, and is neither infrastructure
                    // (ComputeBudget/System) nor finalize. Treat EVERY such
                    // instruction AGNOSTICALLY: enforce target_protocol
                    // consistency and count it toward the single-DeFi-ix limit.
                    //
                    // Previously these two checks fired only for FOUR hardcoded
                    // program IDs (FLASH_TRADE / JUPITER_LEND / JUPITER_EARN /
                    // JUPITER_BORROW); every OTHER allowlisted protocol (Orca,
                    // Raydium, Kamino, …) reached this arm UNCOUNTED and
                    // UNCHECKED — silently exempt from the "exactly one DeFi
                    // instruction per session" invariant and the authorized-
                    // target match. That protocol-specific favoritism is removed;
                    // the invariants now apply uniformly.
                    //
                    // JUPITER_PROGRAM swap parsing was removed in Phase 1 (Option
                    // A demolition); slippage enforcement against
                    // `policy.max_slippage_bps` is delegated to off-chain SDK
                    // simulators or generic post-execution assertions (Phase 6).
                    require!(
                        ix.program_id == target_protocol,
                        SigilError::ProtocolMismatch
                    );
                    defi_ix_count = defi_ix_count.saturating_add(1);
                    defi_ix_idx = Some(scan_idx);

                    // Phase 2 TA-02: wire allowed_destinations enforcement into
                    // BOTH spending paths (stablecoin input AND non-stablecoin
                    // input). Pre-Phase-2 this was checked only in
                    // `agent_transfer`. Closes the gap where a DeFi swap could
                    // route value to an ATA whose owner was NOT in the
                    // destination allowlist.
                    enforce_destination_allowlist(
                        &ix.accounts,
                        ctx.remaining_accounts,
                        &vault_key,
                        policy,
                        clock.unix_timestamp,
                    )?;
                }
            }
            scan_idx = scan_idx.saturating_add(1);
            iter_count = iter_count.saturating_add(1);
        }

        // DeFi instruction count enforcement (F-Q2): EXACTLY one DeFi ix on BOTH
        // paths. The stablecoin path was `<= 1`, which allowed a zero-DeFi
        // spending sandwich to arm the Approve with nothing for finalize to
        // measure (the "free-delegation window"). The in-window opcode scan
        // (Transfer/Approve blocked, :702-703) + the unconditional same-tx
        // finalize revoke made that non-draining, but require exactly one as
        // defense-in-depth, unifying with the non-stablecoin path.
        require!(defi_ix_count == 1, SigilError::TooManyDeFiInstructions);
        single_defi_ix_verified = true;

        require!(found_finalize, SigilError::MissingFinalizeInstruction);
    }

    // 6b. Non-spending instruction scan
    if !is_spending {
        let mut found_finalize = false;
        let mut idx = current_idx_usize.saturating_add(1);
        // M11 hardening (SIMD-0296 pad-attack DoS): bound iteration count.
        let mut iter_count: usize = 0;

        while let Ok(ix) = load_instruction_at_checked(idx, &ix_sysvar) {
            require!(
                iter_count < MAX_SYSVAR_SCAN_ITERATIONS,
                SigilError::SysvarScanBoundExceeded
            );
            match scan_instruction_shared(
                &ix,
                &spl_token_id,
                &compute_budget_id,
                &finalize_hash,
                policy,
            )? {
                ScanAction::FoundFinalize => {
                    found_finalize = true;
                    break;
                }
                ScanAction::Infrastructure => {
                    idx = idx.saturating_add(1);
                    iter_count = iter_count.saturating_add(1);
                    continue;
                }
                ScanAction::PassedSharedChecks => {
                    // Non-spending branch has no per-instruction work after
                    // shared checks pass. Jupiter slippage call removed in
                    // Phase 1 (Option A demolition).
                }
            }
            idx = idx.saturating_add(1);
            iter_count = iter_count.saturating_add(1);
        }

        require!(found_finalize, SigilError::MissingFinalizeInstruction);
    }

    // 7. Position counter system removed (council decision 2026-04-19, vote 9-1).
    // Spending caps + protocol allowlist + post-execution assertions (opt-in via
    // create_post_assertions) remain the load-bearing safety. Leverage enforcement
    // is delegated to the off-chain constraints package (@sigil-trade/constraints)
    // which compiles runtime byte-level CrossFieldLte assertions per protocol.
    // See Plans/we-need-to-plan-serialized-summit.md for rationale.

    // Extract vault PDA seeds data upfront — LBL-01: must use
    // vault.vault_authority (immutable PDA seed), NOT vault.owner (mutates on
    // ownership transfer). See full rationale in freeze_vault.rs:76-86.
    let vault_authority = vault.vault_authority;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;

    let bump_slice = [vault_bump];
    let signer_seeds = [
        b"vault" as &[u8],
        vault_authority.as_ref(),
        vault_id_bytes.as_ref(),
        bump_slice.as_ref(),
    ];
    let binding = [signer_seeds.as_slice()];

    // 10. Delegate. Armed for ALL spending sessions — both stablecoin AND
    //     volatile input. The SPL `Approve` is over the INPUT token's ATA
    //     (`vault_token_account`, constrained mint == token_mint) whenever
    //     `is_spending`.
    //
    //     C-1 fix: the delegation is now the FULL `amount` (no upfront fee
    //     subtraction). Fees are collected at finalize on the MEASURED spend,
    //     via a vault-PDA-signed transfer (NOT via this delegation), and counted
    //     inside the spend caps. On the stablecoin-input path `amount` is bounded
    //     above by `max_transaction_size_usd` (checked earlier), so this
    //     delegation can never exceed the per-tx cap.
    if is_spending {
        let delegation_amount = amount;

        // CPI: approve agent as delegate on vault's token account
        let cpi_accounts = Approve {
            to: ctx.accounts.vault_token_account.to_account_info(),
            delegate: ctx.accounts.agent.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            &binding,
        );
        // F-Q2 (refactor-resistance): never arm the delegate unless the
        // exactly-one-DeFi-ix invariant was verified in the scan block above.
        // Today this is always true when reached (the scan block reverts
        // otherwise); it fails closed if a future edit moves the Approve ahead
        // of, or removes, the count check.
        require!(single_defi_ix_verified, SigilError::TooManyDeFiInstructions);
        token::approve(cpi_ctx, delegation_amount)?;
    }

    // Create session PDA
    let session = &mut ctx.accounts.session;
    session.vault = vault_key;
    session.agent = ctx.accounts.agent.key();
    session.authorized = true;
    session.authorized_amount = amount;
    session.authorized_token = token_mint;
    session.authorized_protocol = target_protocol;
    // Wall-clock based — congestion-immune (audit F5-H1).
    // The slot is no longer load-bearing for expiry; only Clock::unix_timestamp.
    session.expires_at_timestamp = SessionAuthority::calculate_expiry(
        clock.unix_timestamp,
        policy.effective_session_expiry_seconds(),
    );
    session.delegation_token_account = ctx.accounts.vault_token_account.key();
    // C-1 fix: no fees are collected at validate. Fees are computed + collected at
    // finalize on the MEASURED spend (inside the caps), so the session no longer
    // carries pre-charged fee amounts. Stored as 0 explicitly.
    session.protocol_fee = 0;
    session.developer_fee = 0;
    session.delegated = is_spending;
    session.output_mint = output_mint;
    session.stablecoin_balance_before = stablecoin_balance_before;
    // F-Q8: pinned output ATA (default for stablecoin-input path).
    session.output_stablecoin_account = output_stablecoin_account_key;
    // M1: pinned acquired-output account + mint + pre-DeFi balance (defaults for
    // non-swap / non-stablecoin-input / non-spending sessions).
    session.output_swap_account = output_swap_account_key;
    session.output_swap_mint = output_swap_mint;
    session.output_swap_balance_before = output_swap_balance_before;
    session.bump = ctx.bumps.session;
    // Initialize snapshot fields to zero (default for non-delta sessions).
    // Phase 6 grow: capacity 4 → 8 to match MAX_POST_ASSERTION_ENTRIES.
    session.assertion_snapshots = [[0u8; 32]; 8];
    session.snapshot_lens = [0u8; 8];
    // AC-10 (Phase 4): session nonce starts at 0 on every fresh `init`.
    // finalize_session increments the field on success; because validate
    // uses `init` (not `init_if_needed`), the account is closed at finalize
    // and the next validate re-creates the PDA starting at 0 again. Stored
    // here explicitly so the contract is visible at the construction site
    // even though `init` already zeroed the account.
    session.nonce = 0;

    // ── Phase B2: Snapshot capture for delta assertions ─────────────────
    // If the vault has post-assertions with delta modes (1-3), capture target
    // account bytes BEFORE the DeFi instruction executes.
    if policy.has_post_assertions != 0 {
        // Find PostExecutionAssertions PDA via derivation (audit H3: single call)
        let (assertions_pda_expected, _) =
            Pubkey::find_program_address(&[b"post_assertions", vault_key.as_ref()], &crate::ID);

        // PDA-based lookup (not positional — security audit H2 fix)
        let assertions_info = ctx
            .remaining_accounts
            .iter()
            .find(|a| a.key() == assertions_pda_expected);

        if let Some(assertions_info) = assertions_info {
            require!(
                assertions_info.owner == &crate::ID,
                SigilError::PostAssertionFailed
            );
            let assertions_data = assertions_info.try_borrow_data()?;
            let struct_size = core::mem::size_of::<PostExecutionAssertions>();
            require!(
                assertions_data.len() >= 8 + struct_size,
                SigilError::PostAssertionFailed
            );
            // F-1 audit fix: verify Anchor discriminator before bytemuck cast.
            // Same Cashio/Crema lesson as the InstructionConstraints load above.
            require!(
                assertions_data[..8]
                    == *<PostExecutionAssertions as anchor_lang::Discriminator>::DISCRIMINATOR,
                SigilError::PostAssertionFailed,
            );
            let assertions: &PostExecutionAssertions =
                bytemuck::from_bytes(&assertions_data[8..8 + struct_size]);
            require!(
                assertions.vault == vault_key.to_bytes(),
                SigilError::PostAssertionFailed
            );

            let count = assertions.entry_count as usize;
            for i in 0..count {
                let entry = &assertions.entries[i];
                // Phase 6 R-1 MintDeltaCap: snapshot the sum of vault-owned
                // ATA balances (scope=0) or a single token-account balance
                // (scope=1). Stored as u64 LE in snapshot[0..8]; lens[i]=8.
                if entry.assertion_mode == 4 {
                    let mut mint_bytes = [0u8; 32];
                    mint_bytes.copy_from_slice(&entry.expected_value[0..32]);
                    let mint = Pubkey::new_from_array(mint_bytes);
                    let scope = entry.aux_byte;
                    let pre_sum = crate::utils::mint_delta_cap::sum_vault_mint_balance(
                        &vault_key,
                        &mint,
                        scope,
                        &Pubkey::new_from_array(entry.target_account),
                        ctx.remaining_accounts,
                    )?;
                    session.assertion_snapshots[i][0..8].copy_from_slice(&pre_sum.to_le_bytes());
                    session.snapshot_lens[i] = 8;
                    continue;
                }
                // Phase 6 R-3 OutputBalanceFloor: snapshot the configured
                // token_account's balance. Stored as u64 LE in snap[0..8];
                // lens[i]=8. Finalize checks (post - pre) >= aux_value.
                if entry.assertion_mode == 6 {
                    let target_pubkey = Pubkey::new_from_array(entry.target_account);
                    let target = ctx
                        .remaining_accounts
                        .iter()
                        .find(|a| a.key() == target_pubkey)
                        .ok_or(error!(SigilError::PostAssertionFailed))?;
                    require!(
                        target.owner == &anchor_spl::token::ID
                            || target.owner == &crate::state::TOKEN_2022_PROGRAM_ID,
                        SigilError::PostAssertionFailed
                    );
                    let target_data = target.try_borrow_data()?;
                    require!(target_data.len() >= 72, SigilError::PostAssertionFailed);
                    // Sanity: the target_account.mint MUST equal the
                    // configured mint. A mismatch means the caller passed
                    // the wrong account; better to fail fast at validate.
                    let mut mint_bytes = [0u8; 32];
                    mint_bytes.copy_from_slice(&entry.expected_value[0..32]);
                    let expected_mint = Pubkey::new_from_array(mint_bytes);
                    let mut actual_mint_bytes = [0u8; 32];
                    actual_mint_bytes.copy_from_slice(&target_data[0..32]);
                    let actual_mint = Pubkey::new_from_array(actual_mint_bytes);
                    require!(
                        actual_mint == expected_mint,
                        SigilError::PostAssertionFailed
                    );
                    // §RP HIGH (Phase 6 review): R-3 verifies the target
                    // account's BALANCE INCREASES by ≥ min_increase. Without
                    // a vault-ownership check, an owner misconfig (or a
                    // dashboard-supplied target) could point R-3 at an
                    // attacker-controlled token account; the attacker funds
                    // their own account by ≥ min_increase between validate
                    // and finalize and R-3 passes trivially while the vault
                    // sees no inflow. R-3's correct semantic is "the VAULT's
                    // output balance must rise" — so we require the token
                    // account's authority field (bytes 32..64) to equal the
                    // vault PDA. A "fee recipient floor" variant for non-
                    // vault destinations would require a separate primitive
                    // and is deferred to a future phase.
                    let mut authority_bytes = [0u8; 32];
                    authority_bytes.copy_from_slice(&target_data[32..64]);
                    let authority = Pubkey::new_from_array(authority_bytes);
                    require!(
                        authority == vault_key,
                        SigilError::MintDeltaCapMisconfigured
                    );
                    let mut amount_bytes = [0u8; 8];
                    amount_bytes.copy_from_slice(&target_data[64..72]);
                    let pre_balance = u64::from_le_bytes(amount_bytes);
                    session.assertion_snapshots[i][0..8]
                        .copy_from_slice(&pre_balance.to_le_bytes());
                    session.snapshot_lens[i] = 8;
                    continue;
                }
                // R-2 AtaAuthorityPin (mode=5) is purely a finalize-time
                // check — no snapshot needed.
                if entry.assertion_mode == 5 {
                    continue;
                }
                // §RP CRIT-1 (Phase 6 review): R-4 DeclarationConsistency
                // (mode=7) is also a finalize-only verifier. Its finalize
                // helper at `post_assertion_helpers::verify_declaration_consistency`
                // reads the DeFi CPI via instructions sysvar — it has NO
                // snapshot dependency. Without this skip, mode 7 falls into
                // the legacy delta-snapshot block below, which tries to
                // `try_borrow_data()` on `entry.target_account` (a WALLET
                // pubkey for R-4, not a token account). Result is either a
                // hard PostAssertionFailed (vault-wide DoS) or forced
                // recipient-account-info disclosure on every sandwich.
                if entry.assertion_mode == 7 {
                    continue;
                }
                // Only snapshot for delta modes (1=MaxDecrease, 2=MaxIncrease, 3=NoChange)
                if entry.assertion_mode == 0 {
                    continue;
                }
                // Hard-fail if delta assertion exists but we can't snapshot (security audit C1)
                let target_pubkey = Pubkey::new_from_array(entry.target_account);
                let target = ctx
                    .remaining_accounts
                    .iter()
                    .find(|a| a.key() == target_pubkey);
                require!(target.is_some(), SigilError::PostAssertionFailed);
                let target = target.unwrap();
                let target_data = target.try_borrow_data()?;

                let offset = entry.offset as usize;
                let len = entry.value_len as usize;
                let end = offset
                    .checked_add(len)
                    .ok_or(error!(SigilError::PostAssertionFailed))?;
                require!(end <= target_data.len(), SigilError::PostAssertionFailed);

                // Capture snapshot
                session.assertion_snapshots[i][..len].copy_from_slice(&target_data[offset..end]);
                session.snapshot_lens[i] = entry.value_len;
            }
        }
        // Note: if assertions PDA not provided but policy says assertions exist,
        // finalize_session will hard-fail (existing B1 defense at finalize line 508).
    }

    emit!(ActionAuthorized {
        vault: vault_key,
        agent: ctx.accounts.agent.key(),
        token_mint,
        amount,
        usd_amount: amount,
        protocol: target_protocol,
        rolling_spend_usd_after: 0,
        daily_cap_usd: policy.daily_spending_cap_usd,
        delegated: is_spending,
        timestamp: clock.unix_timestamp,
    });

    // H-1: Track active sessions for close_vault guard
    {
        let vault = &mut ctx.accounts.vault;
        vault.active_sessions = vault
            .active_sessions
            .checked_add(1)
            .ok_or(SigilError::Overflow)?;
    }

    // TA-06 (Phase 3): record last_action_unix on successful authorization.
    // Written at the END of validate after all checks pass and delegation
    // is approved — a transaction that errors mid-validate does NOT
    // advance the cooldown clock (the on-chain state-mutation rule is
    // atomic-or-none).
    //
    // Only update if the agent has an overlay slot. Agents without a slot
    // bypass cooldown enforcement entirely (cf. the gate above), so they
    // also have no last_action timestamp to track.
    {
        let agent_key = ctx.accounts.agent.key();
        let mut overlay = ctx.accounts.agent_spend_overlay.load_mut()?;
        if let Some(slot_idx) = overlay.find_agent_slot(&agent_key) {
            overlay.record_action_unix(slot_idx, clock.unix_timestamp)?;
        }
    }

    // TA-17 (Phase 3): on a successful validate_and_authorize, reset the
    // agent's consecutive_failures counter to 0. The full bundle isn't
    // executed yet (the DeFi instruction runs after this), but a
    // successful authorize is the strongest signal we have that the
    // agent is operating within policy. The reset prevents a long-
    // running agent from accruing stale failures that would auto-revoke
    // on the next isolated misconfiguration.
    {
        let agent_key = ctx.accounts.agent.key();
        let vault_mut = &mut ctx.accounts.vault;
        if let Some(entry) = vault_mut.agents.iter_mut().find(|a| a.pubkey == agent_key) {
            entry.consecutive_failures = 0;
        }
    }

    Ok(())
}

/// Build the TA-11 protected-PDA set for the active vault.
///
/// Lives in its own stack frame (via `#[inline(never)]`) to keep the lazy
/// `find_program_address` calls + heap-growing `Vec<Pubkey>` out of the
/// caller's frame. Without the separate frame, `validate_and_authorize`'s
/// inline construction pushes the BPF stack over the 4 KB limit (caught by
/// the C-5 audit 2026-05-21 when `pending_agent_grant` was added).
///
/// Derivations are pinned to `PROTECTED_SEED_PREFIXES` in `state/mod.rs:226`
/// (17 entries: 15 active + 2 forward-compat `cosign` / `recipient`). When a
/// forward-compat family ships, add its `find_program_address` + `push`
/// below.
///
/// **FINDING-B close (audit 2026-05-21 Bucket 1):** `pending_agent_perms` is
/// a per-agent family — each of up to `MAX_AGENTS_PER_VAULT` agents may have
/// its own PDA at `[b"pending_agent_perms", vault, AGENT]`. We walk
/// `vault.agents` and derive each so the full per-agent family is rejected
/// at TA-11 time, not just at the slower BPF runtime owner-check. CU budget:
/// 10 agents × ~5K CU = ~50K worst case, well within the 90K TA-11 envelope.
#[inline(never)]
fn build_ta11_protected_set(
    vault_key: Pubkey,
    policy_key: Pubkey,
    tracker_key: Pubkey,
    overlay_key: Pubkey,
    session_key: Pubkey,
    agents: &[AgentEntry],
) -> Vec<Pubkey> {
    use anchor_lang::solana_program::pubkey::Pubkey as SP;

    let vault_seed = vault_key.as_ref();
    // M1-04c: constraints / pending_constraints / pending_close_constraints
    // derivations removed — the constraints engine is gone, those PDAs can
    // never be allocated, so they cannot be smuggled as writable.
    let (pending_policy_key, _) =
        SP::find_program_address(&[b"pending_policy", vault_seed], &crate::ID);
    let (post_assertions_key, _) =
        SP::find_program_address(&[b"post_assertions", vault_seed], &crate::ID);
    let (pending_owner_key, _) =
        SP::find_program_address(&[b"pending_owner", vault_seed], &crate::ID);
    // FINDING-B close (audit 2026-05-21 Bucket 1): pending_agent_perms is a
    // PER-AGENT family — derive one PDA per agent in vault.agents. The
    // walker is bounded by MAX_AGENTS_PER_VAULT (10) so worst-case CU cost
    // is ~50K, well within the TA-11 envelope. This closes the prior fast-
    // fail gap where a sibling foreign ix smuggling agent B's
    // pending_agent_perms PDA as writable would only be caught by the
    // slower BPF runtime owner-check, not by TA-11 itself.
    let mut pending_agent_perms_keys: Vec<Pubkey> = Vec::with_capacity(agents.len());
    for agent_entry in agents.iter() {
        let (key, _) = SP::find_program_address(
            &[
                b"pending_agent_perms",
                vault_seed,
                agent_entry.pubkey.as_ref(),
            ],
            &crate::ID,
        );
        pending_agent_perms_keys.push(key);
    }
    // Phase 7 audit-log PDAs (post-audit-2026-05-19 SA4 H1 fix). Both are
    // LIVE Anchor `AccountLoader` accounts on `finalize_session` (see
    // finalize_session.rs:91-107). Foreign instructions attempting to mark
    // either writable must be rejected by TA-11 in addition to Solana's own
    // owner-check at runtime.
    let (audit_success_key, _) =
        SP::find_program_address(&[b"audit_success", vault_seed], &crate::ID);
    let (audit_rejected_key, _) =
        SP::find_program_address(&[b"audit_rejected", vault_seed], &crate::ID);
    // Phase 8 PEN-CROSS-1 OPERATOR-grant PDA (C-5 close, audit 2026-05-21).
    // Declared in PROTECTED_SEED_PREFIXES at state/mod.rs:245 but missing
    // from this runtime derivation prior to C-5 fix, leaving the TA-11
    // defense-in-depth check open for `pending_agent_grant` writable-meta
    // smuggling between validate and finalize. Seed schema verified in
    // queue_agent_grant.rs:56 / apply_agent_grant.rs:63.
    let (pending_agent_grant_key, _) =
        SP::find_program_address(&[b"pending_agent_grant", vault_seed], &crate::ID);

    // 11 base entries (vault-keyed) + N per-agent pending_agent_perms entries.
    // Capacity sized for the worst case (MAX_AGENTS_PER_VAULT = 10) so the
    // Vec never reallocates during the per-agent push loop below.
    let mut protected: Vec<Pubkey> = Vec::with_capacity(11 + agents.len());
    protected.push(vault_key);
    protected.push(policy_key);
    protected.push(tracker_key);
    protected.push(overlay_key);
    protected.push(session_key);
    protected.push(pending_policy_key);
    protected.push(post_assertions_key);
    protected.push(pending_owner_key);
    protected.push(pending_agent_grant_key);
    protected.push(audit_success_key);
    protected.push(audit_rejected_key);
    for key in pending_agent_perms_keys.into_iter() {
        protected.push(key);
    }
    protected
}

/// Item 3 (verified-build gate, 2026-06-22): enforce the target protocol's
/// pinned ELF hash if one is armed.
///
/// Locates `target_protocol`'s index in `policy.protocols` and reads the
/// index-aligned `policy.protocol_hashes[idx]`. An all-zero entry means the gate
/// is DISABLED for that protocol → return immediately (the common case; cheap).
/// A non-zero entry ARMS the gate: derive the target's BPFLoaderUpgradeable
/// `ProgramData` PDA, locate it in `remaining_accounts` (the SDK `seal()`
/// satisfier supplies it whenever a hash is armed), and call
/// `enforce_program_build_hash`. If the account is absent while armed, reject
/// FAIL-CLOSED with `ErrProgramDataUnresolvable` (6116) rather than silently
/// authorizing the target whose deployed build cannot be vetted.
///
/// `#[inline(never)]` is REQUIRED: this borrows the ProgramData account bytes and
/// builds a 32-byte hash buffer (via the helper); keeping it off
/// `validate_and_authorize`'s stack frame protects the already-tight BPF 4 KB
/// budget — the same established pattern as `build_ta11_protected_set`. Do NOT
/// inline.
///
/// NOTE: the target is matched by its canonical `ProgramData` PDA derivation, so
/// `remaining_accounts` need not be ordered; we scan for the derived key. The
/// account's bytes are only borrowed inside the helper.
#[inline(never)]
fn enforce_verified_build_if_armed(
    policy: &PolicyConfig,
    target_protocol: &Pubkey,
    remaining_accounts: &[AccountInfo],
) -> Result<()> {
    // Locate the target in the allowlist (caller already proved it is allowed).
    let Some(idx) = policy.protocols.iter().position(|p| p == target_protocol) else {
        // Defensive: is_protocol_allowed passed but the index is gone → fail
        // closed rather than skipping the gate. Unreachable in practice.
        return Err(error!(SigilError::ProtocolNotAllowed));
    };

    // Read the index-aligned pinned hash. Out-of-range (protocols longer than
    // protocol_hashes — impossible since both are bounded by MAX_ALLOWED_PROTOCOLS
    // and protocol_hashes is fixed-length) is treated as "no hash" defensively.
    let Some(expected_hash) = policy.protocol_hashes.get(idx) else {
        return Ok(());
    };

    // All-zero entry = gate disabled for this protocol. Common case.
    if expected_hash == &[0u8; 32] {
        return Ok(());
    }

    // Armed: derive the target's ProgramData PDA and locate it in
    // remaining_accounts.
    let (program_data_pda, _) = Pubkey::find_program_address(
        &[target_protocol.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    );
    let program_data_account = remaining_accounts
        .iter()
        .find(|ai| ai.key == &program_data_pda)
        .ok_or(error!(SigilError::ErrProgramDataUnresolvable))?;

    crate::utils::program_hash::enforce_program_build_hash(
        program_data_account,
        target_protocol,
        expected_hash,
    )
}
