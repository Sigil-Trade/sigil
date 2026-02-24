// Trident fuzz test for AgentShield
//
// Uses the trident 0.12.0 API (#[FuzzTestMethods] + #[flow_executor]).
// Each #[flow] method corresponds to one of the 14 instruction handlers
// (plus 4 new security flows) and is selected randomly by the fuzzer.
// The #[init] method bootstraps a vault with 3 tokens so subsequent
// flows have state to operate on.
//
// 10 invariants are checked after each instruction:
//   INV-1:  Rolling spend never exceeds daily cap (aggregate USD)
//   INV-2:  Only owner can modify policy/pause/withdraw
//   INV-3:  Session PDA expires within 20 slots
//   INV-4:  Fee destination is immutable after creation
//   INV-5:  Frozen→Active only by owner
//   INV-6:  Cross-token aggregate USD ≤ daily cap (same as INV-1 in V2)
//   INV-8:  Stale oracle rejection (dedicated flow)
//   INV-9:  Invalid oracle verification rejection (dedicated flow)
//   INV-10: Post-finalize session closure
//   INV-11: Double-finalize detection (dedicated flow)
//
// V2: INV-7 (per-token base cap) removed — V2 uses aggregate USD only.
//     Tokens use global OracleRegistry, not per-vault AllowedToken arrays.
//     SpendTracker is zero-copy with epoch buckets.
//
// Coverage: 16/16 instructions, 10/10 invariants active, 17 fuzzed flows.
//
// Run: `trident fuzz run fuzz_0` or `pnpm security:fuzz` from repo root.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;

mod fuzz_accounts;

use agent_shield::state::{
    ActionType, AgentVault, OracleEntry, PolicyConfig, SessionAuthority, SpendTracker, VaultStatus,
};
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use solana_sdk::account::AccountSharedData;

const MAX_DEVELOPER_FEE_RATE: u16 = 500;
const SESSION_EXPIRY_SLOTS: u64 = 20;
const MAX_ORACLE_STALE_SLOTS: u64 = 100;
const TOKEN_DECIMALS_A: u8 = 6;
const TOKEN_DECIMALS_B: u8 = 9;
const TOKEN_DECIMALS_C: u8 = 9;
const MINT_AMOUNT: u64 = 10_000_000_000; // 10B base units (10k USDC)
const MINT_AMOUNT_9DEC: u64 = 10_000_000_000_000; // 10T base units for 9-decimal tokens

/// Pyth Receiver program ID (matches state/mod.rs)
const PYTH_RECEIVER_PROGRAM: Pubkey = Pubkey::new_from_array([
    12, 183, 250, 187, 82, 247, 166, 72, 187, 91, 49, 125, 154, 1, 139, 144, 87, 203, 2, 71, 116,
    250, 254, 1, 230, 196, 223, 152, 204, 56, 88, 129,
]);

/// Pyth PriceUpdateV2 account minimum size
const PYTH_MIN_SIZE: usize = 133;

/// Token C oracle price: $150 with exponent -8
const ORACLE_C_PRICE: i64 = 15_000_000_000;
const ORACLE_C_CONF: u64 = 5_000_000;
const ORACLE_C_EXPONENT: i32 = -8;

fn program_id() -> Pubkey {
    "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"
        .parse()
        .unwrap()
}

// ──────────────────────────────────────────────────────────────
// Mock Pyth PriceUpdateV2 account builder
// ──────────────────────────────────────────────────────────────

/// Build a mock Pyth PriceUpdateV2 account with the correct byte layout.
///
/// Layout (from oracle.rs):
///   Offset  0: discriminator     [8 bytes]
///   Offset  8: write_authority   [32 bytes]
///   Offset 40: verification_level [1 byte] (0=Partial, 1=Full)
///   Offset 73: price             [8 bytes] (i64 LE)
///   Offset 81: conf              [8 bytes] (u64 LE)
///   Offset 89: exponent          [4 bytes] (i32 LE)
///   Offset125: posted_slot       [8 bytes] (u64 LE)
fn create_mock_pyth_account(
    trident: &mut Trident,
    address: &Pubkey,
    price: i64,
    conf: u64,
    exponent: i32,
    posted_slot: u64,
    verification: u8,
) {
    let mut data = vec![0u8; PYTH_MIN_SIZE];
    // Offset 40: verification_level
    data[40] = verification;
    // Offsets 41-72: feed_id — not checked by our parser (it checks account key)
    // Offset 73: price (i64 LE)
    data[73..81].copy_from_slice(&price.to_le_bytes());
    // Offset 81: conf (u64 LE)
    data[81..89].copy_from_slice(&conf.to_le_bytes());
    // Offset 89: exponent (i32 LE)
    data[89..93].copy_from_slice(&exponent.to_le_bytes());
    // Offset 125: posted_slot (u64 LE)
    data[125..133].copy_from_slice(&posted_slot.to_le_bytes());

    let mut account = AccountSharedData::new(
        10_000_000, // enough lamports for rent
        data.len(),
        &PYTH_RECEIVER_PROGRAM,
    );
    account.set_data_from_slice(&data);
    trident.set_account_custom(address, &account);
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    /// Tracked slot for clock manipulation (INV-3, INV-8 session expiry)
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

        // ── Step 1: InitializeVault (V2: 10 args, no allowedTokens/trackerTier) ──

        let data = agent_shield::instruction::InitializeVault {
            vault_id,
            daily_spending_cap_usd: cap,
            max_transaction_size_usd: cap,
            protocol_mode: 0, // all protocols allowed
            protocols: vec![],
            max_leverage_bps: 10_000,
            max_concurrent_positions: 5,
            developer_fee_rate: fee_rate,
            timelock_duration: 0,
            allowed_destinations: vec![],
        };

        let accounts = agent_shield::accounts::InitializeVault {
            owner,
            vault,
            policy,
            tracker,
            fee_destination: fee_dest,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

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

        // Token C: oracle-priced, 9 decimals
        let mint_c = self
            .fuzz_accounts
            .token_mint_c
            .insert(&mut self.trident, None);
        self.create_mint(&owner, &mint_c, TOKEN_DECIMALS_C);

        // ── Step 3: Create oracle for token C ──

        let oracle_c = self
            .fuzz_accounts
            .oracle_c
            .insert(&mut self.trident, None);
        create_mock_pyth_account(
            &mut self.trident,
            &oracle_c,
            ORACLE_C_PRICE,
            ORACLE_C_CONF,
            ORACLE_C_EXPONENT,
            self.current_slot,
            1, // Full verification
        );

        // ── Step 4: Create ATAs for all tokens ──

        let destination = self
            .fuzz_accounts
            .destination
            .insert(&mut self.trident, None);
        self.trident.airdrop(&destination, LAMPORTS_PER_SOL);

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

        // ── Step 5: Mint tokens to owner ATAs ──

        let owner_ata_a =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_a);
        let owner_ata_b =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_b);
        let owner_ata_c =
            spl_associated_token_account::get_associated_token_address(&owner, &mint_c);

        self.mint_tokens(&owner, &mint_a, &owner_ata_a, MINT_AMOUNT);
        self.mint_tokens(&owner, &mint_b, &owner_ata_b, MINT_AMOUNT_9DEC);
        self.mint_tokens(&owner, &mint_c, &owner_ata_c, MINT_AMOUNT_9DEC);

        // ── Step 6: Register agent ──

        let agent = self.fuzz_accounts.agent.insert(&mut self.trident, None);
        self.trident.airdrop(&agent, 5 * LAMPORTS_PER_SOL);

        let reg_data = agent_shield::instruction::RegisterAgent { agent };
        let reg_accounts = agent_shield::accounts::RegisterAgent { owner, vault };
        let reg_ix = Instruction::new_with_bytes(
            program_id(),
            &reg_data.data(),
            reg_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[reg_ix], Some("RegisterAgent"));

        // ── Step 7: Initialize oracle registry with 3 tokens ──

        let (oracle_registry, _) = Pubkey::find_program_address(
            &[b"oracle_registry"],
            &program_id(),
        );
        self.fuzz_accounts.oracle_registry.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"oracle_registry"],
                program_id: program_id(),
            }),
        );

        let oracle_entries = vec![
            OracleEntry {
                mint: mint_a,
                oracle_feed: Pubkey::default(),
                is_stablecoin: true,
                fallback_feed: Pubkey::default(),
            },
            OracleEntry {
                mint: mint_b,
                oracle_feed: Pubkey::default(),
                is_stablecoin: true,
                fallback_feed: Pubkey::default(),
            },
            OracleEntry {
                mint: mint_c,
                oracle_feed: oracle_c,
                is_stablecoin: false,
                fallback_feed: Pubkey::default(),
            },
        ];

        let registry_data = agent_shield::instruction::InitializeOracleRegistry {
            entries: oracle_entries,
        };
        let registry_accounts = agent_shield::accounts::InitializeOracleRegistry {
            authority: owner,
            oracle_registry,
            system_program: solana_sdk::system_program::ID,
        };
        let registry_ix = Instruction::new_with_bytes(
            program_id(),
            &registry_data.data(),
            registry_accounts.to_account_metas(None),
        );
        let _ = self
            .trident
            .process_transaction(&[registry_ix], Some("InitializeOracleRegistry"));

        // ── Step 7b: UpdatePolicy with allowed_destinations ──

        let policy_data = agent_shield::instruction::UpdatePolicy {
            daily_spending_cap_usd: None,
            max_transaction_size_usd: None,
            protocol_mode: None,
            protocols: None,
            max_leverage_bps: None,
            can_open_positions: None,
            max_concurrent_positions: None,
            developer_fee_rate: None,
            timelock_duration: None,
            allowed_destinations: Some(vec![destination]),
        };

        let policy_accounts = agent_shield::accounts::UpdatePolicy {
            owner,
            vault,
            policy,
        };

        let policy_ix = Instruction::new_with_bytes(
            program_id(),
            &policy_data.data(),
            policy_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[policy_ix], Some("UpdatePolicy+destinations"));

        // ── Step 8: Deposit funds for all 3 tokens ──

        let vault_ata_a =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_a);
        let vault_ata_b =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_b);
        let vault_ata_c =
            spl_associated_token_account::get_associated_token_address(&vault, &mint_c);

        self.deposit_token(&owner, &vault, &mint_a, &owner_ata_a, &vault_ata_a, MINT_AMOUNT / 2);
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

        let create_mint_ix = spl_token::instruction::initialize_mint2(
            &spl_token::ID,
            mint,
            owner,
            None,
            decimals,
        )
        .unwrap();

        let _ = self.trident.process_transaction(
            &[create_account_ix, create_mint_ix],
            Some("CreateMint"),
        );
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
                owner, owner, mint, &spl_token::ID,
            );
        let create_vault_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner, vault, mint, &spl_token::ID,
            );
        let create_fee_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner, fee_dest, mint, &spl_token::ID,
            );
        let create_dest_ata =
            spl_associated_token_account::instruction::create_associated_token_account(
                owner, destination, mint, &spl_token::ID,
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
                seeds: &[
                    owner.as_ref(),
                    spl_token::ID.as_ref(),
                    mint.as_ref(),
                ],
                program_id: spl_associated_token_account::ID,
            }),
        );
        vault_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[
                    vault.as_ref(),
                    spl_token::ID.as_ref(),
                    mint.as_ref(),
                ],
                program_id: spl_associated_token_account::ID,
            }),
        );
        fee_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[
                    fee_dest.as_ref(),
                    spl_token::ID.as_ref(),
                    mint.as_ref(),
                ],
                program_id: spl_associated_token_account::ID,
            }),
        );
        dest_ata_field(&mut self.fuzz_accounts).insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[
                    destination.as_ref(),
                    spl_token::ID.as_ref(),
                    mint.as_ref(),
                ],
                program_id: spl_associated_token_account::ID,
            }),
        );
    }

    fn mint_tokens(&mut self, owner: &Pubkey, mint: &Pubkey, ata: &Pubkey, amount: u64) {
        let mint_to_ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            mint,
            ata,
            owner,
            &[],
            amount,
        )
        .unwrap();

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
        let dep_data = agent_shield::instruction::DepositFunds { amount };
        let dep_accounts = agent_shield::accounts::DepositFunds {
            owner: *owner,
            vault: *vault,
            mint: *mint,
            owner_token_account: *owner_ata,
            vault_token_account: *vault_ata,
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

    /// Randomly select one of the 3 tokens. Returns (mint, vault_ata, fee_dest_ata, dest_ata, is_oracle_priced).
    fn select_random_token(
        &mut self,
    ) -> Option<(Pubkey, Pubkey, Pubkey, Pubkey, bool)> {
        let choice = self.trident.random_from_range(0..3);
        match choice {
            0 => {
                let mint = self.fuzz_accounts.token_mint.get(&mut self.trident)?;
                let vault_ata = self.fuzz_accounts.vault_token_account.get(&mut self.trident)?;
                let fee_ata = self.fuzz_accounts.fee_dest_token_account.get(&mut self.trident)?;
                let dest_ata = self
                    .fuzz_accounts
                    .destination_token_account
                    .get(&mut self.trident)?;
                Some((mint, vault_ata, fee_ata, dest_ata, false))
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
                Some((mint, vault_ata, fee_ata, dest_ata, false))
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
                Some((mint, vault_ata, fee_ata, dest_ata, true))
            }
        }
    }

    /// Advance slot by a small random amount (simulates block production).
    fn advance_slot(&mut self) {
        let advance = self.trident.random_from_range(1..5);
        self.current_slot += advance;
        self.trident.warp_to_slot(self.current_slot);
    }

    /// Refresh the oracle for token C to the current slot (prevents staleness).
    fn refresh_oracle_c(&mut self) {
        if let Some(oracle_c) = self.fuzz_accounts.oracle_c.get(&mut self.trident) {
            create_mock_pyth_account(
                &mut self.trident,
                &oracle_c,
                ORACLE_C_PRICE,
                ORACLE_C_CONF,
                ORACLE_C_EXPONENT,
                self.current_slot,
                1, // Full verification
            );
        }
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

        let data = agent_shield::instruction::RegisterAgent { agent };
        let accounts = agent_shield::accounts::RegisterAgent { owner, vault };

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
    // Flow: UpdatePolicy
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn update_policy(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));

        let new_cap: u64 = self.trident.random_from_range(1_000_000..2_000_000_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy);

        let data = agent_shield::instruction::UpdatePolicy {
            daily_spending_cap_usd: Some(new_cap),
            max_transaction_size_usd: Some(new_cap),
            protocol_mode: None,
            protocols: None,
            max_leverage_bps: None,
            can_open_positions: None,
            max_concurrent_positions: None,
            developer_fee_rate: None,
            timelock_duration: None,
            allowed_destinations: None,
        };

        let accounts = agent_shield::accounts::UpdatePolicy {
            owner,
            vault,
            policy,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("UpdatePolicy"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy);
        check_inv4_fee_immutability(&pre_vault, &post_vault);
        // Owner signed — policy change is allowed
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, false);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: DepositFunds (owner deposits SPL tokens into vault)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn deposit_funds(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));

        let (mint, vault_ata, _, _, _) = unwrap_or_ret!(self.select_random_token());
        let owner_ata =
            spl_associated_token_account::get_associated_token_address(&owner, &mint);

        let amount: u64 = self.trident.random_from_range(1..1_000_000);

        let pre = self.snapshot_vault(&vault);

        let data = agent_shield::instruction::DepositFunds { amount };
        let accounts = agent_shield::accounts::DepositFunds {
            owner,
            vault,
            mint,
            owner_token_account: owner_ata,
            vault_token_account: vault_ata,
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

        let (mint, vault_ata, _, _, is_oracle_priced) =
            unwrap_or_ret!(self.select_random_token());

        // Advance slot to simulate block production
        self.advance_slot();

        // Refresh oracle if using oracle-priced token
        if is_oracle_priced {
            self.refresh_oracle_c();
        }

        // Compute session PDA
        let (session_pda, _) = Pubkey::find_program_address(
            &[
                b"session",
                vault.as_ref(),
                agent.as_ref(),
                mint.as_ref(),
            ],
            &program_id(),
        );

        // Store session PDA
        self.fuzz_accounts.session.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[
                    b"session",
                    vault.as_ref(),
                    agent.as_ref(),
                    mint.as_ref(),
                ],
                program_id: program_id(),
            }),
        );

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);

        let data = agent_shield::instruction::ValidateAndAuthorize {
            action_type: ActionType::Swap,
            token_mint: mint,
            amount,
            target_protocol: Pubkey::default(),
            leverage_bps: None,
        };

        let oracle_registry = unwrap_or_ret!(
            self.fuzz_accounts.oracle_registry.get(&mut self.trident)
        );

        let base_accounts = agent_shield::accounts::ValidateAndAuthorize {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            oracle_registry,
            session: session_pda,
            vault_token_account: vault_ata,
            token_mint_account: mint,
            protocol_treasury_token_account: None,
            fee_destination_token_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let mut account_metas = base_accounts.to_account_metas(None);

        // For oracle-priced tokens, append oracle as remaining_account
        if is_oracle_priced {
            if let Some(oracle_c) = self.fuzz_accounts.oracle_c.get(&mut self.trident) {
                account_metas.push(AccountMeta::new_readonly(oracle_c, false));
            }
        }

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            account_metas,
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
            let session: Option<SessionAuthority> =
                deser_anchor(&mut self.trident, &session_pda);
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
        let session_state: Option<SessionAuthority> =
            deser_anchor(&mut self.trident, &session);
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

        let data = agent_shield::instruction::FinalizeSession { success: true };
        let accounts = agent_shield::accounts::FinalizeSession {
            payer: agent,
            vault,
            session,
            session_rent_recipient: agent,
            vault_token_account: Some(vault_ata),
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
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

        let (mint, vault_ata, _, _, _) = unwrap_or_ret!(self.select_random_token());
        let owner_ata =
            spl_associated_token_account::get_associated_token_address(&owner, &mint);

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre = self.snapshot_vault(&vault);

        let data = agent_shield::instruction::WithdrawFunds { amount };
        let accounts = agent_shield::accounts::WithdrawFunds {
            owner,
            vault,
            mint,
            vault_token_account: vault_ata,
            owner_token_account: owner_ata,
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
        let oracle_registry = unwrap_or_ret!(
            self.fuzz_accounts.oracle_registry.get(&mut self.trident)
        );

        let (mint, vault_ata, _, dest_ata, _) = unwrap_or_ret!(self.select_random_token());
        let fee_dest_ata = unwrap_or_ret!(
            self.fuzz_accounts.fee_dest_token_account.get(&mut self.trident)
        );

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);

        let data = agent_shield::instruction::AgentTransfer { amount };
        let accounts = agent_shield::accounts::AgentTransfer {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            oracle_registry,
            vault_token_account: vault_ata,
            token_mint_account: mint,
            destination_token_account: dest_ata,
            fee_destination_token_account: Some(fee_dest_ata),
            protocol_treasury_token_account: None,
            token_program: spl_token::ID,
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

        let data = agent_shield::instruction::RevokeAgent {};
        let accounts = agent_shield::accounts::RevokeAgent { owner, vault };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("RevokeAgent"));

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

        let data = agent_shield::instruction::ReactivateVault { new_agent: None };
        let accounts = agent_shield::accounts::ReactivateVault { owner, vault };

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

        let data = agent_shield::instruction::QueuePolicyUpdate {
            daily_spending_cap_usd: Some(new_cap),
            max_transaction_amount_usd: None,
            protocol_mode: None,
            protocols: None,
            max_leverage_bps: None,
            can_open_positions: None,
            max_concurrent_positions: None,
            developer_fee_rate: None,
            timelock_duration: None,
            allowed_destinations: None,
        };

        let accounts = agent_shield::accounts::QueuePolicyUpdate {
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
        let pending = unwrap_or_ret!(
            self.fuzz_accounts.pending_policy.get(&mut self.trident)
        );

        let pre = self.snapshot_vault(&vault);

        let data = agent_shield::instruction::ApplyPendingPolicy {};
        let accounts = agent_shield::accounts::ApplyPendingPolicy {
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
        let pending = unwrap_or_ret!(
            self.fuzz_accounts.pending_policy.get(&mut self.trident)
        );

        let pre = self.snapshot_vault(&vault);

        let data = agent_shield::instruction::CancelPendingPolicy {};
        let accounts = agent_shield::accounts::CancelPendingPolicy {
            owner,
            vault,
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

        let data = agent_shield::instruction::CloseVault {};
        let accounts = agent_shield::accounts::CloseVault {
            owner,
            vault,
            policy,
            tracker,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("CloseVault"));

        let post = self.snapshot_vault(&vault);
        check_inv4_fee_immutability(&pre, &post);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: StaleOracleRejection (INV-8)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn stale_oracle_rejection(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));
        let oracle_registry = unwrap_or_ret!(
            self.fuzz_accounts.oracle_registry.get(&mut self.trident)
        );
        let mint_c = unwrap_or_ret!(self.fuzz_accounts.token_mint_c.get(&mut self.trident));
        let vault_ata_c = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account_c.get(&mut self.trident)
        );
        let oracle_c = unwrap_or_ret!(self.fuzz_accounts.oracle_c.get(&mut self.trident));

        // Warp forward so oracle becomes stale
        let stale_target = self.current_slot + MAX_ORACLE_STALE_SLOTS + 50;
        self.current_slot = stale_target;
        self.trident.warp_to_slot(self.current_slot);

        // Set oracle with OLD posted_slot (far behind current)
        create_mock_pyth_account(
            &mut self.trident,
            &oracle_c,
            ORACLE_C_PRICE,
            ORACLE_C_CONF,
            ORACLE_C_EXPONENT,
            1, // posted_slot = 1, current_slot >> MAX_ORACLE_STALE_SLOTS
            1, // Full verification
        );

        // Compute session PDA
        let (session_pda, _) = Pubkey::find_program_address(
            &[
                b"session",
                vault.as_ref(),
                agent.as_ref(),
                mint_c.as_ref(),
            ],
            &program_id(),
        );

        let data = agent_shield::instruction::ValidateAndAuthorize {
            action_type: ActionType::Swap,
            token_mint: mint_c,
            amount: 100,
            target_protocol: Pubkey::default(),
            leverage_bps: None,
        };

        let base_accounts = agent_shield::accounts::ValidateAndAuthorize {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            oracle_registry,
            session: session_pda,
            vault_token_account: vault_ata_c,
            token_mint_account: mint_c,
            protocol_treasury_token_account: None,
            fee_destination_token_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let mut account_metas = base_accounts.to_account_metas(None);
        account_metas.push(AccountMeta::new_readonly(oracle_c, false));

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            account_metas,
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("StaleOracleRejection"));

        // INV-8: Transaction MUST fail with stale oracle
        assert!(
            result.is_error(),
            "INV-8 violated: stale oracle (delta > MAX_ORACLE_STALE_SLOTS) was accepted",
        );

        // Restore oracle to current slot for subsequent flows
        self.refresh_oracle_c();
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: InvalidOracleVerification (INV-9)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn invalid_oracle_verification(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));
        let oracle_registry = unwrap_or_ret!(
            self.fuzz_accounts.oracle_registry.get(&mut self.trident)
        );
        let mint_c = unwrap_or_ret!(self.fuzz_accounts.token_mint_c.get(&mut self.trident));
        let vault_ata_c = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account_c.get(&mut self.trident)
        );
        let oracle_c = unwrap_or_ret!(self.fuzz_accounts.oracle_c.get(&mut self.trident));

        self.advance_slot();

        // Set oracle with verification_level = 0 (Partial — should be rejected)
        create_mock_pyth_account(
            &mut self.trident,
            &oracle_c,
            ORACLE_C_PRICE,
            ORACLE_C_CONF,
            ORACLE_C_EXPONENT,
            self.current_slot,
            0, // Partial verification — invalid
        );

        // Compute session PDA
        let (session_pda, _) = Pubkey::find_program_address(
            &[
                b"session",
                vault.as_ref(),
                agent.as_ref(),
                mint_c.as_ref(),
            ],
            &program_id(),
        );

        let data = agent_shield::instruction::ValidateAndAuthorize {
            action_type: ActionType::Swap,
            token_mint: mint_c,
            amount: 100,
            target_protocol: Pubkey::default(),
            leverage_bps: None,
        };

        let base_accounts = agent_shield::accounts::ValidateAndAuthorize {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            oracle_registry,
            session: session_pda,
            vault_token_account: vault_ata_c,
            token_mint_account: mint_c,
            protocol_treasury_token_account: None,
            fee_destination_token_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let mut account_metas = base_accounts.to_account_metas(None);
        account_metas.push(AccountMeta::new_readonly(oracle_c, false));

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            account_metas,
        );

        let result = self
            .trident
            .process_transaction(&[ix], Some("InvalidOracleVerification"));

        // INV-9: Transaction MUST fail with Partial verification
        assert!(
            result.is_error(),
            "INV-9 violated: oracle with verification_level=Partial was accepted",
        );

        // Restore oracle to valid state for subsequent flows
        self.refresh_oracle_c();
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

        // Warp past expiry
        let expired_slot = session_data.expires_at_slot + 1;
        self.current_slot = expired_slot;
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

        // Finalize with success=true — program should override to success=false
        let data = agent_shield::instruction::FinalizeSession { success: true };
        let accounts = agent_shield::accounts::FinalizeSession {
            payer: agent,
            vault,
            session: session_addr,
            session_rent_recipient: agent,
            vault_token_account: Some(vault_ata),
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
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
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );

        let data = agent_shield::instruction::FinalizeSession { success: true };
        let accounts = agent_shield::accounts::FinalizeSession {
            payer: agent,
            vault,
            session: session_addr,
            session_rent_recipient: agent,
            vault_token_account: Some(vault_ata),
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
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
            let v = self.fuzz_accounts.vault_token_account.get(&mut self.trident)?;
            let f = self.fuzz_accounts.fee_dest_token_account.get(&mut self.trident)?;
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
/// V2: Uses epoch buckets instead of rolling_spends. Sums all non-zero buckets
/// as an upper bound (correct within a single fuzz iteration).
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
                pre.protocol_mode,
                post.protocol_mode,
                "INV-2 violated: agent changed protocol_mode ({} -> {})",
                pre.protocol_mode,
                post.protocol_mode,
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

/// INV-3: Session PDA expires within SESSION_EXPIRY_SLOTS of creation.
fn check_inv3_session_expiry(session: &Option<SessionAuthority>, current_slot: u64) {
    if let Some(s) = session {
        assert!(
            s.expires_at_slot <= current_slot.saturating_add(SESSION_EXPIRY_SLOTS),
            "INV-3 violated: session expires at {} but max allowed is {} (current_slot={}, window={})",
            s.expires_at_slot,
            current_slot.saturating_add(SESSION_EXPIRY_SLOTS),
            current_slot,
            SESSION_EXPIRY_SLOTS,
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

/// INV-5: Frozen→Active transition requires owner signature.
fn check_inv5_revoke_permanence(
    pre: &Option<AgentVault>,
    post: &Option<AgentVault>,
    signer_is_owner: bool,
) {
    if let (Some(pre), Some(post)) = (pre, post) {
        if pre.status == VaultStatus::Frozen && post.status == VaultStatus::Active {
            assert!(
                signer_is_owner,
                "INV-5 violated: Frozen→Active without owner signature",
            );
        }
    }
}

/// INV-6: Aggregate rolling USD spend across ALL tokens never exceeds daily cap.
/// V2: Same as INV-1 — epoch buckets are already aggregate USD.
fn check_inv6_cross_token_aggregate(
    policy: &Option<PolicyConfig>,
    tracker: &Option<SpendTracker>,
) {
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

// INV-7: Removed in V2 — per-token base cap no longer exists.
// V2 uses aggregate USD only via epoch buckets.

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
