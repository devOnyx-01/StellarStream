/// All contract errors for the V3 splitter.
#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    RecipientNotVerified = 3,
    NoVerifiedRecipients = 4,
    InvalidSplit = 5,       // bps don't sum to 10000
    Overflow = 6,
}
