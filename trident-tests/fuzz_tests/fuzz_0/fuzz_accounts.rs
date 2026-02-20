use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// Each field maps to an account the AgentShield program operates on.
/// `AddressStorage` lets us create accounts once and reuse their
/// pubkeys across different instruction flows within an iteration.
#[derive(Default)]
#[allow(dead_code)]
pub struct AccountAddresses {
    pub owner: AddressStorage,
    pub agent: AddressStorage,
    pub fee_destination: AddressStorage,
    pub vault: AddressStorage,
    pub policy: AddressStorage,
    pub tracker: AddressStorage,
    pub session: AddressStorage,
    pub pending_policy: AddressStorage,
    pub token_mint: AddressStorage,
    pub owner_token_account: AddressStorage,
    pub vault_token_account: AddressStorage,
    pub fee_dest_token_account: AddressStorage,
    pub destination: AddressStorage,
    pub destination_token_account: AddressStorage,
    pub protocol_treasury_token_account: AddressStorage,
}
