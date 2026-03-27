use soroban_sdk::{contracttype, Address};

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DataKey {
    /// instance() — contract admin
    Admin,
    /// instance() — token address
    Token,
    /// instance() — fee in basis points
    FeeBps,
    /// instance() — treasury address
    Treasury,
    /// instance() — strict verification mode flag
    StrictMode,
    /// persistent() — per-address verification status
    VerifiedUsers(Address),
}
