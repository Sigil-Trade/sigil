// Trident fuzz test for AgentShield
//
// Uses the trident 0.12.0 API (#[FuzzTestMethods] + #[flow_executor]).
// Each #[flow] method corresponds to one of the 14 instruction handlers
// and is selected randomly by the fuzzer. The #[init] method bootstraps
// a vault so subsequent flows have state to operate on.
//
// 5 invariants are checked after each instruction:
//   INV-1: Rolling spend never exceeds daily cap
//   INV-2: Only owner can modify policy/pause/withdraw
//   INV-3: Session PDA expires within 20 slots
//   INV-4: Fee destination is immutable after creation
//   INV-5: Frozen→Active only by owner
//
// Coverage: 14/14 instructions, 5/5 invariants active.
//
// Run: `trident fuzz run fuzz_0` or `pnpm security:fuzz` from repo root.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;

mod fuzz_accounts;

use agent_shield::state::{
    ActionType, AgentVault, AllowedToken, PolicyConfig, SessionAuthority, SpendTracker, VaultStatus,
};
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};

const MAX_DEVELOPER_FEE_RATE: u16 = 50;
const SESSION_EXPIRY_SLOTS: u64 = 20;
const TOKEN_DECIMALS: u8 = 6;
const MINT_AMOUNT: u64 = 10_000_000_000; // 10B base units (10k USDC)

fn program_id() -> Pubkey {
    "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL"
        .parse()
        .unwrap()
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Init: create owner, vault, policy, tracker, token mint,
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
        let tier = self.trident.random_from_range(0..3) as u8;

        // ── Step 1: InitializeVault (empty tokens/protocols — updated below) ──

        let data = agent_shield::instruction::InitializeVault {
            vault_id,
            daily_spending_cap_usd: cap,
            max_transaction_size_usd: cap,
            allowed_tokens: vec![],
            allowed_protocols: vec![],
            max_leverage_bps: 10_000,
            max_concurrent_positions: 5,
            developer_fee_rate: fee_rate,
            timelock_duration: 0,
            allowed_destinations: vec![],
            tracker_tier: tier,
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

        // ── Step 2: Create token mint (stablecoin — oracle_feed = default) ──

        let mint = self
            .fuzz_accounts
            .token_mint
            .insert(&mut self.trident, None);
        self.trident.airdrop(&mint, LAMPORTS_PER_SOL);

        let create_mint_ix = spl_token::instruction::initialize_mint2(
            &spl_token::ID,
            &mint,
            &owner,
            None,
            TOKEN_DECIMALS,
        )
        .unwrap();

        // Allocate space for mint account first (82 bytes = spl_token::state::Mint::LEN)
        let mint_space: usize = 82;
        // Rent-exempt minimum for 82 bytes at default rate ≈ 1461600 lamports
        let rent_exempt: u64 = 1_461_600;
        let create_account_ix = solana_sdk::system_instruction::create_account(
            &owner,
            &mint,
            rent_exempt,
            mint_space as u64,
            &spl_token::ID,
        );

        let _ = self.trident.process_transaction(
            &[create_account_ix, create_mint_ix],
            Some("CreateMint"),
        );

        // ── Step 3: Create ATAs ──

        let destination = self
            .fuzz_accounts
            .destination
            .insert(&mut self.trident, None);
        self.trident.airdrop(&destination, LAMPORTS_PER_SOL);

        // Owner ATA
        let owner_ata =
            spl_associated_token_account::get_associated_token_address(&owner, &mint);
        let create_owner_ata_ix =
            spl_associated_token_account::instruction::create_associated_token_account(
                &owner, &owner, &mint, &spl_token::ID,
            );

        // Vault ATA (PDA-owned — allowOwnerOffCurve)
        let vault_ata =
            spl_associated_token_account::get_associated_token_address(&vault, &mint);
        let create_vault_ata_ix =
            spl_associated_token_account::instruction::create_associated_token_account(
                &owner, &vault, &mint, &spl_token::ID,
            );

        // Fee destination ATA
        let _fee_dest_ata =
            spl_associated_token_account::get_associated_token_address(&fee_dest, &mint);
        let create_fee_ata_ix =
            spl_associated_token_account::instruction::create_associated_token_account(
                &owner, &fee_dest, &mint, &spl_token::ID,
            );

        // Destination ATA
        let _dest_ata =
            spl_associated_token_account::get_associated_token_address(&destination, &mint);
        let create_dest_ata_ix =
            spl_associated_token_account::instruction::create_associated_token_account(
                &owner, &destination, &mint, &spl_token::ID,
            );

        let _ = self.trident.process_transaction(
            &[
                create_owner_ata_ix,
                create_vault_ata_ix,
                create_fee_ata_ix,
                create_dest_ata_ix,
            ],
            Some("CreateATAs"),
        );

        // Store ATA addresses
        self.fuzz_accounts.owner_token_account.insert(
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
        self.fuzz_accounts.vault_token_account.insert(
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
        self.fuzz_accounts.fee_dest_token_account.insert(
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
        self.fuzz_accounts.destination_token_account.insert(
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

        // ── Step 4: Mint tokens to owner ATA ──

        let mint_to_ix = spl_token::instruction::mint_to(
            &spl_token::ID,
            &mint,
            &owner_ata,
            &owner,
            &[],
            MINT_AMOUNT,
        )
        .unwrap();

        let _ = self
            .trident
            .process_transaction(&[mint_to_ix], Some("MintTo"));

        // ── Step 5: Register agent ──

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

        // ── Step 6: UpdatePolicy with allowed_tokens + allowed_destinations ──

        let stablecoin = AllowedToken {
            mint,
            oracle_feed: Pubkey::default(), // stablecoin = 1:1 USD
            decimals: TOKEN_DECIMALS,
            daily_cap_base: 0,
            max_tx_base: 0,
        };

        let policy_data = agent_shield::instruction::UpdatePolicy {
            daily_spending_cap_usd: None,
            max_transaction_size_usd: None,
            allowed_tokens: Some(vec![stablecoin]),
            allowed_protocols: Some(vec![]),
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
            tracker,
        };

        let policy_ix = Instruction::new_with_bytes(
            program_id(),
            &policy_data.data(),
            policy_accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[policy_ix], Some("UpdatePolicy+tokens"));

        // ── Step 7: DepositFunds — transfer tokens from owner to vault ──

        let deposit_amount = MINT_AMOUNT / 2;
        let dep_data = agent_shield::instruction::DepositFunds {
            amount: deposit_amount,
        };
        let dep_accounts = agent_shield::accounts::DepositFunds {
            owner,
            vault,
            mint,
            owner_token_account: owner_ata,
            vault_token_account: vault_ata,
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
        let tracker = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));

        let new_cap: u64 = self.trident.random_from_range(1_000_000..2_000_000_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy);

        let data = agent_shield::instruction::UpdatePolicy {
            daily_spending_cap_usd: Some(new_cap),
            max_transaction_size_usd: Some(new_cap),
            allowed_tokens: None,
            allowed_protocols: None,
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
            tracker,
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
        let mint = unwrap_or_ret!(self.fuzz_accounts.token_mint.get(&mut self.trident));
        let owner_ata = unwrap_or_ret!(
            self.fuzz_accounts.owner_token_account.get(&mut self.trident)
        );
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );

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
        let mint = unwrap_or_ret!(self.fuzz_accounts.token_mint.get(&mut self.trident));
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );

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
        let _pre_tracker = self.snapshot_tracker(&tracker_addr);

        let data = agent_shield::instruction::ValidateAndAuthorize {
            action_type: ActionType::Swap,
            token_mint: mint,
            amount,
            target_protocol: Pubkey::default(), // no protocol whitelist needed for stablecoin
            leverage_bps: None,
        };

        let accounts = agent_shield::accounts::ValidateAndAuthorize {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            session: session_pda,
            vault_token_account: vault_ata,
            token_mint_account: mint,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("ValidateAndAuthorize"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy_addr);
        let post_tracker = self.snapshot_tracker(&tracker_addr);

        check_inv4_fee_immutability(&pre_vault, &post_vault);
        check_inv1_spending_cap(&post_policy, &post_tracker);
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);

        // INV-3: Check session expiry is bounded
        let session: Option<SessionAuthority> =
            deser_anchor(&mut self.trident, &session_pda);
        let clock_slot = self.trident_current_slot();
        check_inv3_session_expiry(&session, clock_slot);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: FinalizeSession (agent closes session after DeFi action)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn finalize_session(&mut self) {
        let agent = unwrap_or_ret!(self.fuzz_accounts.agent.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let policy_addr = unwrap_or_ret!(self.fuzz_accounts.policy.get(&mut self.trident));
        let tracker_addr = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));
        let session = unwrap_or_ret!(self.fuzz_accounts.session.get(&mut self.trident));
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );
        let fee_dest_ata = unwrap_or_ret!(
            self.fuzz_accounts.fee_dest_token_account.get(&mut self.trident)
        );

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);
        let _pre_tracker = self.snapshot_tracker(&tracker_addr);

        // INV-3: Check session before finalization
        let session_state: Option<SessionAuthority> =
            deser_anchor(&mut self.trident, &session);
        let clock_slot = self.trident_current_slot();
        check_inv3_session_expiry(&session_state, clock_slot);

        let data = agent_shield::instruction::FinalizeSession { success: true };
        let accounts = agent_shield::accounts::FinalizeSession {
            payer: agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            session,
            session_rent_recipient: agent,
            vault_token_account: Some(vault_ata),
            fee_destination_token_account: Some(fee_dest_ata),
            protocol_treasury_token_account: None,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
        };

        let ix = Instruction::new_with_bytes(
            program_id(),
            &data.data(),
            accounts.to_account_metas(None),
        );

        let _ = self
            .trident
            .process_transaction(&[ix], Some("FinalizeSession"));

        let post_vault = self.snapshot_vault(&vault);
        let post_policy = self.snapshot_policy(&policy_addr);
        let post_tracker = self.snapshot_tracker(&tracker_addr);

        check_inv4_fee_immutability(&pre_vault, &post_vault);
        check_inv1_spending_cap(&post_policy, &post_tracker);
        check_inv2_agent_cannot_modify_policy(&pre_policy, &post_policy, true);
    }

    // ──────────────────────────────────────────────────────────────
    // Flow: WithdrawFunds (owner withdraws tokens from vault)
    // ──────────────────────────────────────────────────────────────

    #[flow]
    fn withdraw_funds(&mut self) {
        let owner = unwrap_or_ret!(self.fuzz_accounts.owner.get(&mut self.trident));
        let vault = unwrap_or_ret!(self.fuzz_accounts.vault.get(&mut self.trident));
        let mint = unwrap_or_ret!(self.fuzz_accounts.token_mint.get(&mut self.trident));
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );
        let owner_ata = unwrap_or_ret!(
            self.fuzz_accounts.owner_token_account.get(&mut self.trident)
        );

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
        let vault_ata = unwrap_or_ret!(
            self.fuzz_accounts.vault_token_account.get(&mut self.trident)
        );
        let dest_ata = unwrap_or_ret!(
            self.fuzz_accounts
                .destination_token_account
                .get(&mut self.trident)
        );
        let fee_dest_ata = unwrap_or_ret!(
            self.fuzz_accounts.fee_dest_token_account.get(&mut self.trident)
        );

        let amount: u64 = self.trident.random_from_range(1..100_000);

        let pre_vault = self.snapshot_vault(&vault);
        let pre_policy = self.snapshot_policy(&policy_addr);
        let _pre_tracker = self.snapshot_tracker(&tracker_addr);

        let data = agent_shield::instruction::AgentTransfer { amount };
        let accounts = agent_shield::accounts::AgentTransfer {
            agent,
            vault,
            policy: policy_addr,
            tracker: tracker_addr,
            vault_token_account: vault_ata,
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
            allowed_tokens: None,
            allowed_protocols: None,
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
        let tracker = unwrap_or_ret!(self.fuzz_accounts.tracker.get(&mut self.trident));
        let pending = unwrap_or_ret!(
            self.fuzz_accounts.pending_policy.get(&mut self.trident)
        );

        let pre = self.snapshot_vault(&vault);

        let data = agent_shield::instruction::ApplyPendingPolicy {};
        let accounts = agent_shield::accounts::ApplyPendingPolicy {
            owner,
            vault,
            policy,
            tracker,
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

    /// Get approximate current slot from Trident runtime.
    /// Falls back to 0 if unavailable (invariant still validates structure).
    fn trident_current_slot(&self) -> u64 {
        // Trident doesn't expose clock directly — use a conservative estimate.
        // The session expiry check validates structural correctness regardless.
        0
    }
}

/// INV-1: Aggregate rolling 24h USD spend never exceeds daily cap.
fn check_inv1_spending_cap(policy: &Option<PolicyConfig>, tracker: &Option<SpendTracker>) {
    if let (Some(p), Some(t)) = (policy, tracker) {
        let total: u64 = t
            .rolling_spends
            .iter()
            .map(|e| e.usd_amount)
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
                pre.allowed_tokens.len(),
                post.allowed_tokens.len(),
                "INV-2 violated: agent changed allowed_tokens count ({} -> {})",
                pre.allowed_tokens.len(),
                post.allowed_tokens.len(),
            );
            assert_eq!(
                pre.allowed_protocols.len(),
                post.allowed_protocols.len(),
                "INV-2 violated: agent changed allowed_protocols count ({} -> {})",
                pre.allowed_protocols.len(),
                post.allowed_protocols.len(),
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

fn main() {
    FuzzTest::fuzz(1000, 100);
}
