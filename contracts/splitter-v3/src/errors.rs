/// All contract errors for the V3 splitter.
#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    RecipientNotVerified = 3,
    NoVerifiedRecipients = 4,
    InvalidSplit = 5,
    Overflow = 6,
    NotAuthorizedAdmin = 7,   // caller is not in the 3-admin list
    AlreadyApproved = 8,      // caller already voted on this proposal
    ProposalNotFound = 9,
    AlreadyExecuted = 10,
    QuorumNotReached = 11,    // < 2 approvals
    SplitNotFound = 12,       // no scheduled split with that id
    NotSplitSender = 13,      // caller is not the original sender
    SplitAlreadyCancelled = 14, // split was already cancelled
    SplitAlreadyExecuted = 15,  // split was already executed
    SplitNotYetDue = 16,      // release_time has not been reached (cancel guard)
    NotYetReleased = 22,      // min_timestamp not yet reached (execute guard)
    NothingToClaim = 17,      // claimable balance is zero
    CouncilNotSet = 18,       // council keys not initialized
    InsufficientCouncilSignatures = 19, // fewer than 5 unique valid signatures
    DuplicateCouncilSigner = 20,        // same council key signed twice
    InvalidCouncilSigner = 21,          // signer not in the stored council list
}
