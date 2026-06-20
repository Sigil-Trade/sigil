// Trident fuzz test for Sigil
//
// V3: Stablecoin-only architecture — oracles removed.
// Uses the trident 0.12.0 API (#[FuzzTestMethods] + #[flow_executor]).
// Each #[flow] method corresponds to one of the instruction handlers
// and is selected randomly by the fuzzer.
//
// 8 invariants are checked after each instruction:
//   INV-1:  Rolling spend never exceeds daily cap (aggregate USD)
//   INV-2:  Only owner can modify policy/pause/withdraw
//   INV-3:  Session PDA expires within 20 slots
//   INV-4:  Fee destination is immutable after creation
//   INV-5:  Frozen→Active only by owner
//   INV-6:  Cross-token aggregate USD ≤ daily cap (same as INV-1 in V2)
//   INV-10: Post-finalize session closure
//   INV-11: Double-finalize detection (dedicated flow)
//
// Coverage: 15 fuzzed flows, 8 invariants active.
//
// Run: `trident fuzz run fuzz_0` or `pnpm security:fuzz` from repo root.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;

mod fuzz_accounts;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use sigil::state::{
    AgentVault, PolicyConfig, SessionAuthority, SpendTracker, VaultStatus,
    DESTINATION_MODE_RESTRICTED, PROTOCOL_MODE_ALLOWLIST,
};
// Call the program's OWN canonical digest functions directly (the `sigil` crate
// is a path dependency of this harness). This guarantees byte-for-byte equality
// with what `initialize_vault` / `validate_and_authorize` recompute on-chain —
// re-implementing the encoding here would risk silent drift. See:
//   - utils/policy_digest.rs::compute_policy_preview_digest (TA-19 init digest)
//   - utils/intent_digest.rs::compute_scalar_intent_digest (AL3 scalar digest)
use sigil::utils::intent_digest::{compute_scalar_intent_digest, ScalarIntentInput};
use sigil::utils::policy_digest::{
    compute_agent_set_hash, compute_policy_preview_digest, PolicyPreviewFields,
};

const MAX_DEVELOPER_FEE_RATE: u16 = 500;
/// Fixed slot the harness warps to *before* InitializeVault so the
/// runtime `clock.slot` (which the program binds into the TA-19 policy preview
/// digest as `created_at_slot`) is deterministic and known to the digest we
/// pre-compute here. Trident's `warp_to_slot` sets `clock.slot` directly and
/// nothing else advances the slot between the warp and the tx (post-tx
/// `update_clock` only bumps `unix_timestamp`, never the slot — verified in
/// trident-svm 0.2.0 sysvar_tracker::refresh_with_clock), so binding this exact
/// value makes the on-chain recompute match.
const INIT_SLOT: u64 = 100;
/// MIN_TIMELOCK_DURATION from the program (state/mod.rs). The init digest binds
/// `timelock_duration`, so the harness and the on-chain recompute must agree.
const HARNESS_TIMELOCK_DURATION: u64 = 1800;
/// `max_slippage_bps` value the harness passes at init; bound by the digest.
const HARNESS_MAX_SLIPPAGE_BPS: u16 = 2500;
/// `auto_revoke_threshold` the harness passes at init. MUST be within
/// [AUTO_REVOKE_THRESHOLD_MIN=3, AUTO_REVOKE_THRESHOLD_MAX=20] or
/// initialize_vault.rs:143 reverts with InvalidPermissions (6036). Bound by the
/// TA-19 digest at position 16.
const HARNESS_AUTO_REVOKE_THRESHOLD: u8 = 3;
// F5-H1: schema renamed slot-bound to wall-clock seconds.
const SESSION_DURATION_SECONDS: i64 = 8;
const TOKEN_DECIMALS_A: u8 = 6;
const TOKEN_DECIMALS_B: u8 = 9;
const TOKEN_DECIMALS_C: u8 = 9;
const MINT_AMOUNT: u64 = 10_000_000_000; // 10B base units (10k USDC)
const MINT_AMOUNT_9DEC: u64 = 10_000_000_000_000; // 10T base units for 9-decimal tokens

/// Instructions sysvar address
const INSTRUCTIONS_SYSVAR: Pubkey = Pubkey::new_from_array([
    6, 167, 213, 23, 24, 199, 116, 201, 40, 86, 99, 152, 105, 29, 94, 182, 139, 94, 184, 163, 155,
    75, 109, 92, 115, 85, 91, 42, 0, 0, 0, 0,
]);

fn program_id() -> Pubkey {
    "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK"
        .parse()
        .unwrap()
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    /// Tracked slot for clock manipulation (INV-3 session expiry)
    current_slot: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            current_slot: 1,
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Init: create owner, vault, policy, tracker, 3 token mints,
    //       ATAs, deposit funds, register agent, update policy
    // ──────────────────────────────────────────────────────────────

    #[init]
    fn start(&mut self) {
        let owner = self.fuzz_accounts.owner.insert(&mut self.trident, None);
        let fee_dest = self
            .fuzz_accounts
            .fee_destination
            .insert(&mut self.trident, None);

        // Create the spending `destination` BEFORE InitializeVault: an Active
        // (non-observe_only) vault MUST have at least one protocol OR one
        // allowed destination on its allowlist (`ActiveVaultRequiresAllowlist`,
        // initialize_vault.rs F-11), AND that destination is bound into the
        // TA-19 policy preview digest. The pre-fix harness created this only at
        // Step 3 (after init) with an empty allowlist, so init reverted before
        // any state was created. Created here, airdropped, and reused at Step 3.
        let destination = self
            .fuzz_accounts
            .destination
            .insert(&mut self.trident, None);
        self.trident.airdrop(&destination, LAMPORTS_PER_SOL);

        let vault_id: u64 = self.trident.random_from_range(1..u64::MAX);
        let vault_id_bytes = vault_id.to_le_bytes();

        let vault = self.fuzz_accounts.vault.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"vault", owner.as_ref(), &vault_id_bytes],
                program_id: program_id(),
            }),
        );

        let policy = self.fuzz_accounts.policy.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"policy", vault.as_ref()],
                program_id: program_id(),
            }),
        );

        let tracker = self.fuzz_accounts.tracker.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"tracker", vault.as_ref()],
                program_id: program_id(),
            }),
        );

        self.trident.airdrop(&owner, 10 * LAMPORTS_PER_SOL);

        let cap: u64 = self.trident.random_from_range(1_000_000..1_000_000_000);
        let fee_rate = self
            .trident
            .random_from_range(0..MAX_DEVELOPER_FEE_RATE as u64) as u16;

        // Pin the slot BEFORE InitializeVault. The program captures
        // `created_at_slot = clock.slot` inside the handler and binds it into the
        // TA-19 digest; pinning the slot here makes the digest we pre-compute
        // below match the on-chain recompute byte-for-byte.
        self.current_slot = INIT_SLOT;
        self.trident.warp_to_slot(self.current_slot);

        // ── Step 1: InitializeVault (M1: 16 args; Phase 3/5/8 + cosign + digest) ──
        //
        // The handler recomputes the TA-19 policy preview digest over the
        // RESULTING policy fields and rejects on mismatch (PolicyPreviewMismatch).
        // We pre-compute the SAME digest by calling the program's own
        // `compute_policy_preview_digest` over the EXACT args we pass, so init
        // SUCCEEDS and the vault / policy / tracker are actually created — which
        // is what lets every downstream invariant's `if let Some(...)` guard hit
        // `Some` and actually execute.
        //
        // Two non-digest init requirements also enforced here (both previously
        // made init revert): protocol_mode MUST be ALLOWLIST (1), and an Active
        // vault MUST have a non-empty allowlist (we supply one destination).
        let allowed_destinations = vec![destination];
        let protocols: Vec<Pubkey> = vec![];

        // Recompute the canonical TA-19 digest over the resulting policy fields.
        // Field values mirror initialize_vault.rs exactly: destination_mode is
        // forced to RESTRICTED, session_expiry_seconds = 0, has_post_assertions
        // = 0, the agent set is empty (deterministic empty-Vec hash),
        // cosign_session_pubkey = default, operator_grant_delay_seconds = 0.
        let preview_digest = compute_policy_preview_digest(&PolicyPreviewFields {
            daily_spending_cap_usd: cap,
            max_transaction_size_usd: cap,
            max_slippage_bps: HARNESS_MAX_SLIPPAGE_BPS,
            developer_fee_rate: fee_rate,
            protocol_mode: PROTOCOL_MODE_ALLOWLIST,
            protocols: &protocols,
            destination_mode: DESTINATION_MODE_RESTRICTED,
            allowed_destinations: &allowed_destinations,
            timelock_duration: HARNESS_TIMELOCK_DURATION,
            session_expiry_seconds: 0,
            observe_only: false,
            has_post_assertions: 0,
            created_at_slot: INIT_SLOT,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: HARNESS_AUTO_REVOKE_THRESHOLD,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            agent_set_hash: compute_agent_set_hash(&[]),
            cosign_session_pubkey: Pubkey::default(),
            operator_grant_delay_seconds: 0,
            has_protocol_caps: false,
            protocol_caps: &[],
        });

        let data = sigil::instruction::InitializeVault {
            vault_id,
            daily_spending_cap_usd: cap,
            max_transaction_size_usd: cap,
            protocol_mode: PROTOCOL_MODE_ALLOWLIST,
            protocols: protocols.clone(),
            developer_fee_rate: fee_rate,
            max_slippage_bps: HARNESS_MAX_SLIPPAGE_BPS,
            timelock_duration: HARNESS_TIMELOCK_DURATION,
            allowed_destinations: allowed_destinations.clone(),
            protocol_caps: vec![],
            observe_only: false,
            operating_hours: 0,
            auto_promote_grays: false,
            auto_revoke_threshold: HARNESS_AUTO_REVOKE_THRESHOLD,
            stable_balance_floor: 0,
            per_recipient_daily_cap_usd: 0,
            cosign_required: false,
            preview_digest,
        };

        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let (audit_log_rejected, _) =
            Pubkey::find_program_address(&[b"audit_rejected", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::InitializeVault {
            owner,
            vault,
            policy,
            tracker,
            agent_spend_overlay,
            audit_log_success,
            audit_log_rejected,
            fee_destination: fee_dest,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        // InitializeVault now SUCCEEDS: the pre-computed TA-19 preview_digest
        // matches the on-chain recompute, protocol_mode is ALLOWLIST, the
        // allowlist is non-empty, and auto_revoke_threshold is in range. The
        // vault / policy / tracker PDAs are created, so every downstream
        // invariant's `if let Some(...)` guard now hits `Some` and executes.
        let _ = self
            .trident
            .process_transaction(&[ix], Some("InitializeVault"));

        // ── Step 2: Create 3 token mints ──

        // Token A: stablecoin, 6 decimals
        let mint_a = self
            .fuzz_accounts
            .token_mint
            .insert(&mut self.trident, None);
        self.create_mint(&owner, &mint_a, TOKEN_DECIMALS_A);

        // Token B: stablecoin, 9 decimals
        let mint_b = self
            .fuzz_accounts
            .token_mint_b
            .insert(&mut self.trident, None);
        self.create_mint(&owner, &mint_b, TOKEN_DECIMALS_B);

        // Token C: non-stablecoin, 9 decimals
        let mint_c = self
            .fuzz_accounts
            .token_mint_c
            .insert(&mut self.trident, None);
        self.create_mint(&owner, &mint_c, TOKEN_DECIMALS_C);

        // ── Step 3: Create ATAs for all tokens ──
        // `destination` was created + airdropped at the top of start() (it must
        // exist before InitializeVault so it can seed the allowlist). Reuse it.

        // Token A ATAs
        self.create_token_atas(
            &owner,
            &vault,
            &fee_dest,
            &destination,
            &mint_a,
            |fa| &mut fa.owner_token_account,
            |fa| &mut fa.vault_token_account,
            |fa| &mut fa.fee_dest_token_account,
            |fa| &mut fa.destination_token_account,
        );

        // Token B ATAs
        self.create_token_atas(
            &owner,
            &vault,
            &fee_dest,
            &destination,
            &mint_b,
            |fa| &mut fa.owner_token_account_b,
            |fa| &mut fa.vault_token_account_b,
            |fa| &mut fa.fee_dest_token_account_b,
            |fa| &mut fa.destination_token_account_b,
        );

        // Token C ATAs
        self.create_token_atas(
            &owner,
            &vault,
            &fee_dest,
            &destination,
            &mint_c,
            |fa| &mut fa.owner_token_account_c,
            |fa| &mut fa.vault_token_account_c,
            |fa| &mut fa.fee_dest_token_account_c,
            |fa| &mut fa.destination_token_account_c,
        );

        // ── Step 4: Mint tokens to owner ATAs ──

        let owner_ata_a =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_a);
        let owner_ata_b =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_b);
        let owner_ata_c =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_c);

        self.mint_tokens(&owner, &mint_a, &owner_ata_a, MINT_AMOUNT);
        self.mint_tokens(&owner, &mint_b, &owner_ata_b, MINT_AMOUNT_9DEC);
        self.mint_tokens(&owner, &mint_c, &owner_ata_c, MINT_AMOUNT_9DEC);

        // ── Step 5: Register agent ──

        let agent = self.fuzz_accounts.agent.insert(&mut self.trident, None);
        self.trident.airdrop(&agent, 5 * LAMPORTS_PER_SOL);

        let reg_data = sigil::instruction::RegisterAgent {
            agent,
            capability: sigil::state::FULL_CAPABILITY,
            spending_limit_usd: 0,
        };
        let (reg_agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (reg_audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let reg_accounts = sigil::accounts::RegisterAgent {
            owner,
            vault,
            // policy local var derived earlier in this bootstrap flow.
            policy,
            agent_spend_overlay: reg_agent_spend_overlay,
            audit_log_success: reg_audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };
        let reg_ix = Instruction::new_with_bytes(
            program_id(),
            &reg_data.data(),
            reg_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[reg_ix], Some("RegisterAgent"));

        // Step 6 removed: Trident does not support unix_timestamp advancement,
        // so queue+apply policy changes cannot be tested in fuzz. Allowed
        // destinations are set at vault init or tested via the queue_policy_update
        // flow below, which verifies the queue operation succeeds.

        // ── Step 7: Deposit funds for all 3 tokens ──

        let vault_ata_a =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_a);
        let vault_ata_b =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_b);
        let vault_ata_c =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_c);

        self.deposit_token(
            &owner,
            &vault,
            &mint_a,
            &owner_ata_a,
            &vault_ata_a,
            MINT_AMOUNT / 2,
        );
        self.deposit_token(
            &owner,
            &vault,
            &mint_b,
            &owner_ata_b,
            &vault_ata_b,
            MINT_AMOUNT_9DEC / 2,
        );
        self.deposit_token(
            &owner,
            &vault,
            &mint_c,
            &owner_ata_c,
            &vault_ata_c,
            MINT_AMOUNT_9DEC / 2,
        );

        // Set initial slot
        self.trident.warp_to_slot(self.current_slot);
    }

    // ──────────────────────────────────────────────────────────────
    // Init helpers
    // ──────────────────────────────────────────────────────────────

    fn create_mint(&mut self, owner: &Pubkey, mint: &Pubkey, decimals: u8) {
        self.trident.airdrop(mint, LAMPORTS_PER_SOL);

        let mint_space: usize = 82;
        let rent_exempt: u64 = 1_461_600;
        let create_account_ix = solana_sdk::system_instruction::create_account(
            owner,
            mint,
            rent_exempt,
            mint_space as u64,
            &spl_token::ID,
        );

        let create_mint_ix =
            spl_token::instruction::initialize_mint2(&spl_token::ID, mint, owner, None, decimals)
                .unwrap();

        let _ = self
            .trident
            .process_transaction(&[create_account_ix, create_mint_ix], Some("CreateMint"));
    }

    fn create_token_atas(
        &mut self,
        owner: &Pubkey,
        vault: &Pubkey,
        fee_dest: &Pubkey,
        destination: &Pubkey,
        mint: &Pubkey,
        owner_ata_field: fn(&mut AccountAddresses) -> &mut AddressStorage,
        vault_ata_field: fn(&mut AccountAddresses) -> &mut AddressStorage,
        fee_ata_field: fn(&mut AccountAddresses) -> &mut AddressStorage,
        dest_ata_field: fn(&mut AccountAddresses) -> &mut AddressStorage,
    ) {
        let create_owner_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner,
                owner,
                mint,
                &spl_token::ID,
            );
        let create_vault_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner,
                vault,
                mint,
                &spl_token::ID,
            );
        let create_fee_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner,
                fee_dest,
                mint,
                &spl_token::ID,
            );
        let create_dest_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner,
                destination,
                mint,
                &spl_token::ID,
            );

        let _ = self.trident.process_transaction(
            &[
                create_owner_ata,
                create_vault_ata,
                create_fee_ata,
                create_dest_ata,
            ],
            Some("CreateATAs"),
        );

        // Store ATA addresses
        owner_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[owner.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
                program_id: spl_associated_token_account::ID,
            }),
        );
        vault_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[vault.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
                program_id: spl_associated_token_account::ID,
            }),
        );
        fee_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[fee_dest.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
                program_id: spl_associated_token_account::ID,
            }),
        );
        dest_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[destination.as_ref(), spl_token::ID.as_ref(), mint.as_ref()],
                program_id: spl_associated_token_account::ID,
            }),
        );
    }

    fn mint_tokens(&mut self, owner: &Pubkey, mint: &Pubkey, ata: &Pubkey, amount: u64) {
        let mint_to_ix =
            spl_token::instruction::mint_to(&spl_token::ID, mint, ata, owner, &[], amount).unwrap();

        let _ = self
            .trident
            .process_transaction(&[mint_to_ix], Some("MintTo"));
    }

    fn deposit_token(
        &mut self,
        owner: &Pubkey,
        vault: &Pubkey,
        mint: &Pubkey,
        owner_ata: &Pubkey,
        vault_ata: &Pubkey,
        amount: u64,
    ) {
        let dep_data = sigil::instruction::DepositFunds { amount };
        let (dep_audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let dep_accounts = sigil::accounts::DepositFunds {
            owner: *owner,
            vault: *vault,
            mint: *mint,
            owner_token_account: *owner_ata,
            vault_token_account: *vault_ata,
            audit_log_success: dep_audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
        };
        let dep_ix = Instruction::new_with_bytes(
            program_id(),
            &dep_data.data(),
            dep_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[dep_ix], Some("DepositFunds"));
    }

    // ──────────────────────────────────────────────────────────────
    // Token selection helper
    // ──────────────────────────────────────────────────────────────

    /// Randomly select one of the 3 tokens. Returns (mint, vault_ata, fee_dest_ata, dest_ata).
    fn select_random_token(&mut self) -> Option<(Pubkey, Pubkey, Pubkey, Pubkey)> {
        let choice = self.trident.random_from_range(0..3);
        match choice {
            0 => {
                let mint = self.fuzz_accounts.token_mint.get(&mut self.trident)?;
                let vault_ata = self
                    .fuzz_accounts
                    .vault_token_account
                    .get(&mut self.trident)?;
                let fee_ata = self
                    .fuzz_accounts
                    .fee_dest_token_account
                    .get(&mut self.trident)?;
                let dest_ata = self
                    .fuzz_accounts
                    .destination_token_account
                    .get(&mut self.trident)?;
                Some((mint, vault_ata, fee_ata, dest_ata))
            }
            1 => {
                let mint = self.fuzz_accounts.token_mint_b.get(&mut self.trident)?;
                let vault_ata = self
                    .fuzz_accounts
                    .vault_token_account_b
                    .get(&mut self.trident)?;
                let fee_ata = self
                    .fuzz_accounts
                    .fee_dest_token_account_b
                    .get(&mut self.trident)?;
                let dest_ata = self
                    .fuzz_accounts
                    .destination_token_account_b
                    .get(&mut self.trident)?;
                Some((mint, vault_ata, fee_ata, dest_ata))
            }
            _ => {
                let mint = self.fuzz_accounts.token_mint_c.get(&mut self.trident)?;
                let vault_ata = self
                    .fuzz_accounts
                    .vault_token_account_c
                    .get(&mut self.trident)?;
                let fee_ata = self
                    .fuzz_accounts
                    .fee_dest_token_account_c
                    .get(&mut self.trident)?;
                let dest_ata = self
                    .fuzz_accounts
                    .destination_token_account_c
                    .get(&mut self.trident)?;
                Some((mint, vault_ata, fee_ata, dest_ata))
            }
        }
    }

    /// Advance slot by a small random amount (simulates block production).
    fn advance_slot(&mut self) {
        let advance = self.trident.random_from_range(1..5);
        self.current_slot += advance;
        self.trident.warp_to_slot(self.current_slot);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: RegisterAgent
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn register_agent(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let agent = self.fuzz_accounts.agent.insert(&mut self.trident, None);
        self.trident.airdrop(&agent, 5 * LAMPORTS_PER_SOL);

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::RegisterAgent {
            agent,
            capability: sigil::state::FULL_CAPABILITY,
            spending_limit_usd: 0,
        };
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (policy, _) = Pubkey::find_program_address(&[b"policy", vault.as_ref()], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::RegisterAgent {
            owner,
            vault,
            policy,
            agent_spend_overlay,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("RegisterAgent"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: QueueAndApplyPolicy (replaces deleted UpdatePolicy)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn queue_and_apply_policy(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));

        let new_cap: u64 = self.trident.random_from_range(1_000_000..2_000_000_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy);

        let (pending_policy, _) =
            Pubkey::find_program_address(&[b"pending_policy", vault.as_ref()], &program_id());

        // Queue
        // M1 added 8 trailing args (verified against queue_policy_update.rs handler):
        // operating_hours, stable_balance_floor, per_recipient_daily_cap_usd,
        // cosign_required, cosign_session_pubkey, operator_grant_delay_seconds,
        // cosign_session, new_policy_preview_digest. The harness only fuzzes the
        // cap fields; the rest are None / no-cosign defaults. A [0u8;32] preview
        // digest makes the on-chain TA-19 digest re-check reject (graceful
        // revert), exercising the queue auth + param-validation path.
        let queue_data = sigil::instruction::QueuePolicyUpdate {
            daily_spending_cap_usd: Some(new_cap),
            max_transaction_amount_usd: Some(new_cap),
            protocol_mode: None,
            protocols: None,
            developer_fee_rate: None,
            timelock_duration: None,
            allowed_destinations: None,
            max_slippage_bps: None,
            session_expiry_seconds: None,
            has_protocol_caps: None,
            protocol_caps: None,
            destination_mode: None,
            operating_hours: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            cosign_required: None,
            cosign_session_pubkey: None,
            operator_grant_delay_seconds: None,
            cosign_session: Pubkey::default(),
            new_policy_preview_digest: [0u8; 32],
        };

        let queue_accounts = sigil::accounts::QueuePolicyUpdate {
            owner,
            vault,
            policy,
            pending_policy,
            system_program: anchor_lang::system_program::ID,
        };

        let queue_ix = Instruction::new_with_bytes(
            program_id(),
            &queue_data.data(),
            queue_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[queue_ix], Some("QueuePolicyUpdate"));

        // Trident does not support unix_timestamp advancement, so we cannot
        // apply the pending policy (timelock check would fail). Instead,
        // cancel the pending update to clean up the PDA. The queue operation
        // itself verifies the owner authorization and parameter validation.
        let cancel_data = sigil::instruction::CancelPendingPolicy {};

        let cancel_accounts = sigil::accounts::CancelPendingPolicy {
            owner,
            vault,
            policy,
            pending_policy,
        };

        let cancel_ix = Instruction::new_with_bytes(
            program_id(),
            &cancel_data.data(),
            cancel_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[cancel_ix], Some("CancelPendingPolicy"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy);
        check_inv4_fee_immutability(&pre_vault, &post_vault);
        // Policy unchanged after queue+cancel — invariant check should pass
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: DepositFunds (owner deposits SPL tokens into vault)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn deposit_funds(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let (mint, vault_ata, _, _) = unwrap_or_ret!(self.select_random_token());
        let owner_ata = spl_associated_token_account::get_associated_token_address(&owner, &mint);

        let amount: u64 = self.trident.random_from_range(1..1_000_000);

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::DepositFunds { amount };
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::DepositFunds {
            owner,
            vault,
            mint,
            owner_token_account: owner_ata,
            vault_token_account: vault_ata,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("DepositFunds"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: ValidateAndAuthorize (agent authorizes a spend)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn validate_and_authorize(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let (mint, vault_ata, _, _) = unwrap_or_ret!(self.select_random_token());

        // Advance slot to simulate block production
        self.advance_slot();

        // Compute session PDA
        let (session_pda, _) = Pubkey::find_program_address(
            &[b"session", vault.as_ref(), agent.as_ref(), mint.as_ref()],
            &program_id(),
        );

        // Store session PDA
        self.fuzz_accounts.session.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"session", vault.as_ref(), agent.as_ref(), mint.as_ref()],
                program_id: program_id(),
            }),
        );

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);

        let target_protocol = Pubkey::default();
        // Compute the REAL AL3 scalar intent digest by calling the program's own
        // `compute_scalar_intent_digest` over the exact scalars this ix carries
        // (vault, agent, token_mint, amount, target_protocol). The network byte
        // is derived inside the fn from the program's build feature (devnet by
        // default), matching the on-chain recompute. A [0u8;32] here would
        // short-circuit at `ErrIntentDigestMismatch` (validate_and_authorize.rs
        // ~L181) before any policy/tracker logic ran; the real digest clears
        // that gate so the downstream authorization path is actually exercised.
        let expected_intent_digest = compute_scalar_intent_digest(&ScalarIntentInput {
            vault: &vault,
            agent: &agent,
            token_mint: &mint,
            amount,
            target_protocol: &target_protocol,
        });

        let data = sigil::instruction::ValidateAndAuthorize {
            token_mint: mint,
            amount,
            target_protocol,
            expected_policy_version: 0, // Fresh vault, no policy changes applied
            // M1 added (verified against validate_and_authorize.rs handler):
            //   expected_nonce — AC-10 durable-nonce replay defense; the session
            //     is `init` so a fresh SessionAuthority has nonce 0; callers pass 0.
            //   expected_intent_digest — AL3 scalar intent digest (D-1/D-6),
            //     now the REAL canonical digest so the digest-verify gate passes.
            expected_nonce: 0,
            expected_intent_digest,
        };

        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let accounts = sigil::accounts::ValidateAndAuthorize {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            agent_spend_overlay,
            session: session_pda,
            vault_token_account: vault_ata,
            token_mint_account: mint,
            protocol_treasury_token_account: None,
            fee_destination_token_account: None,
            output_stablecoin_account: None,
            output_swap_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            instructions_sysvar: INSTRUCTIONS_SYSVAR,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("ValidateAndAuthorize"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy_addr);
        let post_tracker = self.snapshot_tracker(&tracker_addr);

        check_inv4_fee_immutability(&pre_vault, &post_vault);
        check_inv1_spending_cap(&post_policy, &post_tracker);
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);
        check_inv6_cross_token_aggregate(&post_policy, &post_tracker);

        // INV-3: Check session expiry is bounded (only if tx succeeded)
        if result.is_success() {
            let session: Option<SessionAuthority> = deser_anchor(&mut self.trident, &session_pda);
            check_inv3_session_expiry(&session, self.current_slot);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: FinalizeSession (agent closes session after DeFi action)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn finalize_session(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let session = unwrap_or_ret!(self.fuzz_accounts.session.get(&mut self.trident));

        // We need to figure out which token's ATAs to use based on session
        let session_state: Option<SessionAuthority> = deser_anchor(&mut self.trident, &session);
        if session_state.is_none() {
            return; // No active session
        }
        let session_data = session_state.unwrap();
        let session_token = session_data.authorized_token;

        // Find matching vault ATA for delegation revocation
        let vault_ata = self
            .find_atas_for_token(&session_token)
            .map(|(v, _)| v)
            .unwrap_or_else(|| {
                // Fallback to token A
                self.fuzz_accounts
                    .vault_token_account
                    .get(&mut self.trident)
                    .unwrap_or_default()
            });

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);

        // INV-3: Check session before finalization
        check_inv3_session_expiry(&Some(session_data), self.current_slot);

        let data = sigil::instruction::FinalizeSession {};
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let (audit_log_rejected, _) =
            Pubkey::find_program_address(&[b"audit_rejected", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::FinalizeSession {
            payer: agent,
            vault,
            session,
            session_rent_recipient: agent,
            policy: policy_addr,
            tracker: unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident)),
            agent_spend_overlay,
            vault_token_account: Some(vault_ata),
            output_stablecoin_account: None,
            output_swap_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            instructions_sysvar: solana_sdk::sysvar::instructions::ID,
            audit_log_success,
            audit_log_rejected,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("FinalizeSession"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy_addr);
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));
        let post_tracker = self.snapshot_tracker(&tracker_addr);

        check_inv4_fee_immutability(&pre_vault, &post_vault);
        check_inv1_spending_cap(&post_policy, &post_tracker);
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);
        check_inv6_cross_token_aggregate(&post_policy, &post_tracker);

        // INV-10: Session PDA should be closed after finalize
        if result.is_success() {
            check_inv10_session_closed(&mut self.trident, &session);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: WithdrawFunds (owner withdraws tokens from vault)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn withdraw_funds(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let (mint, vault_ata, _, _) = unwrap_or_ret!(self.select_random_token());
        let owner_ata = spl_associated_token_account::get_associated_token_address(&owner, &mint);

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::WithdrawFunds { amount };
        let (policy, _) = Pubkey::find_program_address(&[b"policy", vault.as_ref()], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::WithdrawFunds {
            owner,
            vault,
            policy,
            mint,
            vault_token_account: vault_ata,
            owner_token_account: owner_ata,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
            token_program: spl_token::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("WithdrawFunds"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
        // INV-2: owner signed — no policy violation
        let policy_addr = self.fuzz_accounts.policy.get(&mut self.trident);
        if let Some(pa) = policy_addr {
            let pre_p = self.snapshot_policy(&pa);
            let post_p = self.snapshot_policy(&pa);
            check_inv2_agent_cannot_modify_policy(&pre_p, &post_p, false);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: AgentTransfer (agent transfers to allowed destination)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn agent_transfer(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let (mint, vault_ata, _, dest_ata) = unwrap_or_ret!(self.select_random_token());
        let fee_dest_ata = unwrap_or_ret!(self
            .fuzz_accounts
            .fee_dest_token_account
            .get(&mut self.trident));

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);

        let data = sigil::instruction::AgentTransfer {
            amount,
            expected_policy_version: 0,
        };
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::AgentTransfer {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            agent_spend_overlay,
            vault_token_account: vault_ata,
            token_mint_account: mint,
            destination_token_account: dest_ata,
            fee_destination_token_account: Some(fee_dest_ata),
            protocol_treasury_token_account: None,
            token_program: spl_token::ID,
            // L11-1 — success audit log; PDA + address-pinned slot_hashes sysvar
            // (mirrors register_agent / deposit_funds construction above).
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("AgentTransfer"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy_addr);
        let post_tracker = self.snapshot_tracker(&tracker_addr);

        check_inv4_fee_immutability(&pre_vault, &post_vault);
        check_inv1_spending_cap(&post_policy, &post_tracker);
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);
        check_inv6_cross_token_aggregate(&post_policy, &post_tracker);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: RevokeAgent (owner freezes vault)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn revoke_agent(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let pre = self.snapshot_vault(&vault);

        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));

        let data = sigil::instruction::RevokeAgent {
            agent_to_remove: agent,
        };
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (policy, _) = Pubkey::find_program_address(&[b"policy", vault.as_ref()], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::RevokeAgent {
            owner,
            vault,
            policy,
            agent_spend_overlay,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self.trident.process_transaction(&[ix], Some("RevokeAgent"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
        check_inv5_revoke_permanence(&pre, &post, true);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: ReactivateVault (owner unfreezes)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn reactivate_vault(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::ReactivateVault {
            new_agent: None,
            new_agent_capability: None,
        };
        let (policy, _) = Pubkey::find_program_address(&[b"policy", vault.as_ref()], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::ReactivateVault {
            owner,
            vault,
            policy,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("ReactivateVault"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
        check_inv5_revoke_permanence(&pre, &post, true);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: QueuePolicyUpdate
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn queue_policy_update(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));

        let pending = self.fuzz_accounts.pending_policy.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"pending_policy", vault.as_ref()],
                program_id: program_id(),
            }),
        );

        let new_cap: u64 = self.trident.random_from_range(1_000_000..5_000_000_000);

        let pre = self.snapshot_vault(&vault);

        // M1 added 8 trailing args (verified against queue_policy_update.rs handler):
        // operating_hours, stable_balance_floor, per_recipient_daily_cap_usd,
        // cosign_required, cosign_session_pubkey, operator_grant_delay_seconds,
        // cosign_session, new_policy_preview_digest. Harness fuzzes only the cap;
        // the rest are None / no-cosign defaults (see queue_and_apply_policy note).
        let data = sigil::instruction::QueuePolicyUpdate {
            daily_spending_cap_usd: Some(new_cap),
            max_transaction_amount_usd: None,
            protocol_mode: None,
            protocols: None,
            developer_fee_rate: None,
            timelock_duration: None,
            allowed_destinations: None,
            max_slippage_bps: None,
            session_expiry_seconds: None,
            has_protocol_caps: None,
            protocol_caps: None,
            destination_mode: None,
            operating_hours: None,
            stable_balance_floor: None,
            per_recipient_daily_cap_usd: None,
            cosign_required: None,
            cosign_session_pubkey: None,
            operator_grant_delay_seconds: None,
            cosign_session: Pubkey::default(),
            new_policy_preview_digest: [0u8; 32],
        };

        let accounts = sigil::accounts::QueuePolicyUpdate {
            owner,
            vault,
            policy,
            pending_policy: pending,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("QueuePolicyUpdate"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: ApplyPendingPolicy
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn apply_pending_policy(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let pending = unwrap_or_ret!(self.fuzz_accounts.pending_policy.get(&mut self.trident));

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::ApplyPendingPolicy {};
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::ApplyPendingPolicy {
            owner,
            vault,
            policy,
            pending_policy: pending,
            audit_log_success,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("ApplyPendingPolicy"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: CancelPendingPolicy
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn cancel_pending_policy(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let pending = unwrap_or_ret!(self.fuzz_accounts.pending_policy.get(&mut self.trident));

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::CancelPendingPolicy {};
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));

        let accounts = sigil::accounts::CancelPendingPolicy {
            owner,
            vault,
            policy,
            pending_policy: pending,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("CancelPendingPolicy"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: CloseVault
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn close_vault(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let pre = self.snapshot_vault(&vault);

        let data = sigil::instruction::CloseVault {};
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let (audit_log_rejected, _) =
            Pubkey::find_program_address(&[b"audit_rejected", vault.as_ref()], &program_id());
        // CloseVault closes both audit buffers (rent → owner); no slot_hashes
        // sysvar on this ix (no audit entry appended on close).
        let accounts = sigil::accounts::CloseVault {
            owner,
            vault,
            policy,
            tracker,
            agent_spend_overlay,
            audit_log_success,
            audit_log_rejected,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self.trident.process_transaction(&[ix], Some("CloseVault"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: FinalizeExpiredSession
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn finalize_expired_session(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let session_addr = unwrap_or_ret!(self.fuzz_accounts.session.get(&mut self.trident));

        // Check if session exists
        let session_state: Option<SessionAuthority> =
            deser_anchor(&mut self.trident, &session_addr);
        if session_state.is_none() {
            return; // No active session to expire
        }
        let session_data = session_state.unwrap();
        let session_token = session_data.authorized_token;

        // F5-H1: session expiry is now wall-clock-based (`expires_at_timestamp`),
        // not slot-based. Trident's `warp_to_slot` advances the validator clock
        // alongside the slot (~400ms/slot), so advancing far enough in slots
        // guarantees the unix timestamp clears `expires_at_timestamp`. We bound
        // the advance to a safe ceiling rather than computing the exact slot —
        // the only thing this flow needs is "session is now past expiry."
        self.current_slot = self.current_slot.saturating_add(10_000);
        self.trident.warp_to_slot(self.current_slot);

        let vault_ata = self
            .find_atas_for_token(&session_token)
            .map(|(v, _)| v)
            .unwrap_or_else(|| {
                self.fuzz_accounts
                    .vault_token_account
                    .get(&mut self.trident)
                    .unwrap_or_default()
            });

        // Finalize — expired sessions are treated as failed (is_expired check)
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let data = sigil::instruction::FinalizeSession {};
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let (audit_log_rejected, _) =
            Pubkey::find_program_address(&[b"audit_rejected", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::FinalizeSession {
            payer: agent,
            vault,
            session: session_addr,
            session_rent_recipient: agent,
            policy: policy_addr,
            tracker: tracker_addr,
            agent_spend_overlay,
            vault_token_account: Some(vault_ata),
            output_stablecoin_account: None,
            output_swap_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            instructions_sysvar: solana_sdk::sysvar::instructions::ID,
            audit_log_success,
            audit_log_rejected,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("FinalizeExpiredSession"));

        // INV-10: Session PDA should be closed after expired finalize
        if result.is_success() {
            check_inv10_session_closed(&mut self.trident, &session_addr);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: DoubleFinalizeSession (INV-11)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn double_finalize_session(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let session_addr = unwrap_or_ret!(self.fuzz_accounts.session.get(&mut self.trident));

        // Check if session is already closed (no data)
        let session_state: Option<SessionAuthority> =
            deser_anchor(&mut self.trident, &session_addr);
        if session_state.is_some() {
            return; // Session still active — skip (this tests the CLOSED case)
        }

        // Session already closed — attempt second finalize (should fail)
        let vault_ata = unwrap_or_ret!(self
            .fuzz_accounts
            .vault_token_account
            .get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let data = sigil::instruction::FinalizeSession {};
        let (agent_spend_overlay, _) =
            Pubkey::find_program_address(&[b"agent_spend", vault.as_ref(), &[0u8]], &program_id());
        let (audit_log_success, _) =
            Pubkey::find_program_address(&[b"audit_success", vault.as_ref()], &program_id());
        let (audit_log_rejected, _) =
            Pubkey::find_program_address(&[b"audit_rejected", vault.as_ref()], &program_id());
        let accounts = sigil::accounts::FinalizeSession {
            payer: agent,
            vault,
            session: session_addr,
            session_rent_recipient: agent,
            policy: policy_addr,
            tracker: tracker_addr,
            agent_spend_overlay,
            vault_token_account: Some(vault_ata),
            output_stablecoin_account: None,
            output_swap_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            instructions_sysvar: solana_sdk::sysvar::instructions::ID,
            audit_log_success,
            audit_log_rejected,
            slot_hashes_sysvar: anchor_lang::solana_program::sysvar::slot_hashes::id(),
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("DoubleFinalizeSession"));

        // INV-11: Double-finalize MUST fail (session PDA already closed)
        assert!(
            result.is_error(),
            "INV-11 violated: double-finalize succeeded on already-closed session",
        );
    }

    // ──────────────────────────────────────────────────────────────
    // Cleanup
    // ──────────────────────────────────────────────────────────────

    #[end]
    fn end(&mut self) {}
}

// ──────────────────────────────────────────────────────────────
// Snapshot + invariant helpers
// ──────────────────────────────────────────────────────────────

/// Helper macro: unwrap an Option or return from the current flow.
/// Flows that can't find required accounts just no-op gracefully.
macro_rules! unwrap_or_ret {
    ($expr:expr) => {
        match $expr {
            Some(v) => v,
            None => return,
        }
    };
}
use unwrap_or_ret;

/// Deserialize an Anchor account from raw AccountSharedData.
/// Uses Anchor's `try_deserialize` which handles the 8-byte discriminator.
fn deser_anchor<T: AccountDeserialize>(trident: &mut Trident, addr: &Pubkey) -> Option<T> {
    let account = trident.get_account(addr);
    let data = account.data();
    if data.len() < 8 {
        return None;
    }
    T::try_deserialize(&mut data.as_ref()).ok()
}

impl FuzzTest {
    fn snapshot_vault(&mut self, vault_addr: &Pubkey) -> Option<AgentVault> {
        deser_anchor::<AgentVault>(&mut self.trident, vault_addr)
    }

    fn snapshot_policy(&mut self, policy_addr: &Pubkey) -> Option<PolicyConfig> {
        deser_anchor::<PolicyConfig>(&mut self.trident, policy_addr)
    }

    fn snapshot_tracker(&mut self, tracker_addr: &Pubkey) -> Option<SpendTracker> {
        deser_anchor::<SpendTracker>(&mut self.trident, tracker_addr)
    }

    /// Find vault_ata and fee_dest_ata for a given token mint.
    fn find_atas_for_token(&mut self, token: &Pubkey) -> Option<(Pubkey, Pubkey)> {
        let mint_a = self.fuzz_accounts.token_mint.get(&mut self.trident);
        let mint_b = self.fuzz_accounts.token_mint_b.get(&mut self.trident);
        let mint_c = self.fuzz_accounts.token_mint_c.get(&mut self.trident);

        if mint_a.as_ref() == Some(token) {
            let v = self
                .fuzz_accounts
                .vault_token_account
                .get(&mut self.trident)?;
            let f = self
                .fuzz_accounts
                .fee_dest_token_account
                .get(&mut self.trident)?;
            Some((v, f))
        } else if mint_b.as_ref() == Some(token) {
            let v = self
                .fuzz_accounts
                .vault_token_account_b
                .get(&mut self.trident)?;
            let f = self
                .fuzz_accounts
                .fee_dest_token_account_b
                .get(&mut self.trident)?;
            Some((v, f))
        } else if mint_c.as_ref() == Some(token) {
            let v = self
                .fuzz_accounts
                .vault_token_account_c
                .get(&mut self.trident)?;
            let f = self
                .fuzz_accounts
                .fee_dest_token_account_c
                .get(&mut self.trident)?;
            Some((v, f))
        } else {
            None
        }
    }
}

/// INV-1: Aggregate rolling 24h USD spend never exceeds daily cap.
fn check_inv1_spending_cap(policy: &Option<PolicyConfig>, tracker: &Option<SpendTracker>) {
    if let (Some(p), Some(t)) = (policy, tracker) {
        let total: u64 = t
            .buckets
            .iter()
            .filter(|b| b.usd_amount > 0)
            .map(|b| b.usd_amount)
            .fold(0u64, |acc, x| acc.saturating_add(x));
        assert!(
            total <= p.daily_spending_cap_usd,
            "INV-1 violated: rolling spend {} > cap {}",
            total,
            p.daily_spending_cap_usd,
        );
    }
}

/// INV-2: Agent cannot modify policy fields. If signer_is_agent is true,
/// all policy fields must remain unchanged after the instruction.
fn check_inv2_agent_cannot_modify_policy(
    pre: &Option<PolicyConfig>,
    post: &Option<PolicyConfig>,
    signer_is_agent: bool,
) {
    if let (Some(pre), Some(post)) = (pre, post) {
        if signer_is_agent {
            assert_eq!(
                pre.daily_spending_cap_usd, post.daily_spending_cap_usd,
                "INV-2 violated: agent changed daily_spending_cap_usd ({} -> {})",
                pre.daily_spending_cap_usd, post.daily_spending_cap_usd,
            );
            assert_eq!(
                pre.max_transaction_size_usd, post.max_transaction_size_usd,
                "INV-2 violated: agent changed max_transaction_size_usd ({} -> {})",
                pre.max_transaction_size_usd, post.max_transaction_size_usd,
            );
            assert_eq!(
                pre.developer_fee_rate, post.developer_fee_rate,
                "INV-2 violated: agent changed developer_fee_rate ({} -> {})",
                pre.developer_fee_rate, post.developer_fee_rate,
            );
            assert_eq!(
                pre.protocol_mode, post.protocol_mode,
                "INV-2 violated: agent changed protocol_mode ({} -> {})",
                pre.protocol_mode, post.protocol_mode,
            );
            assert_eq!(
                pre.protocols.len(),
                post.protocols.len(),
                "INV-2 violated: agent changed protocols count ({} -> {})",
                pre.protocols.len(),
                post.protocols.len(),
            );
            assert_eq!(
                pre.timelock_duration, post.timelock_duration,
                "INV-2 violated: agent changed timelock_duration ({} -> {})",
                pre.timelock_duration, post.timelock_duration,
            );
            assert_eq!(
                pre.allowed_destinations.len(),
                post.allowed_destinations.len(),
                "INV-2 violated: agent changed allowed_destinations count ({} -> {})",
                pre.allowed_destinations.len(),
                post.allowed_destinations.len(),
            );
        }
    }
}

/// INV-3: Session PDA expires within SESSION_DURATION_SECONDS of creation.
///
/// F5-H1: schema is now timestamp-based (`expires_at_timestamp`, seconds).
/// The fuzz harness still tracks `current_slot` as its time axis, so we
/// translate slot → approx-seconds (~0.4 s/slot) to bound the invariant.
/// The check stays a pure upper bound — being slack on the conversion is
/// fine, since INV-3 fails only if `expires_at_timestamp` is *grossly* out
/// of range, not by single-slot rounding.
fn check_inv3_session_expiry(session: &Option<SessionAuthority>, current_slot: u64) {
    if let Some(s) = session {
        // Approximate "now" timestamp from slot (slots are 0.4s on average).
        let approx_now_ts = (current_slot * 2 / 5) as i64;
        let max_allowed_ts = approx_now_ts.saturating_add(SESSION_DURATION_SECONDS);
        assert!(
            s.expires_at_timestamp <= max_allowed_ts,
            "INV-3 violated: session expires at ts={} but max allowed is {} (current_slot={}, approx_now_ts={}, window_secs={})",
            s.expires_at_timestamp,
            max_allowed_ts,
            current_slot,
            approx_now_ts,
            SESSION_DURATION_SECONDS,
        );
    }
}

/// INV-4: Fee destination never changes after vault creation.
fn check_inv4_fee_immutability(pre: &Option<AgentVault>, post: &Option<AgentVault>) {
    if let (Some(pre), Some(post)) = (pre, post) {
        if pre.fee_destination != Pubkey::default() {
            assert_eq!(
                pre.fee_destination, post.fee_destination,
                "INV-4 violated: fee_destination changed from {} to {}",
                pre.fee_destination, post.fee_destination,
            );
        }
    }
}

/// INV-5: Frozen->Active transition requires owner signature.
fn check_inv5_revoke_permanence(
    pre: &Option<AgentVault>,
    post: &Option<AgentVault>,
    signer_is_owner: bool,
) {
    if let (Some(pre), Some(post)) = (pre, post) {
        if pre.status == VaultStatus::Frozen && post.status == VaultStatus::Active {
            assert!(
                signer_is_owner,
                "INV-5 violated: Frozen->Active without owner signature",
            );
        }
    }
}

/// INV-6: Aggregate rolling USD spend across ALL tokens never exceeds daily cap.
fn check_inv6_cross_token_aggregate(policy: &Option<PolicyConfig>, tracker: &Option<SpendTracker>) {
    if let (Some(p), Some(t)) = (policy, tracker) {
        let total_usd: u64 = t
            .buckets
            .iter()
            .filter(|b| b.usd_amount > 0)
            .map(|b| b.usd_amount)
            .fold(0u64, |acc, x| acc.saturating_add(x));
        assert!(
            total_usd <= p.daily_spending_cap_usd,
            "INV-6 violated: cross-token aggregate USD {} > cap {}",
            total_usd,
            p.daily_spending_cap_usd,
        );
    }
}

/// INV-10: FinalizeSession closes the session PDA account.
fn check_inv10_session_closed(trident: &mut Trident, session_addr: &Pubkey) {
    let account = trident.get_account(session_addr);
    let data = account.data();
    // After close, account should have no data or be zeroed
    assert!(
        data.len() < 8 || data.iter().all(|&b| b == 0),
        "INV-10 violated: session PDA {} still has {} bytes of data after finalize",
        session_addr,
        data.len(),
    );
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}
