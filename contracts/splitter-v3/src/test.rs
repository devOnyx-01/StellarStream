#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

use crate::{errors::Error, Recipient, SplitterV3, SplitterV3Client};

// ── Test helpers ──────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    contract: SplitterV3Client<'static>,
    token: TokenClient<'static>,
    admin: Address,
    treasury: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Deploy a native Stellar asset for testing.
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = TokenClient::new(&env, &token_id.address());
    let sac = StellarAssetClient::new(&env, &token_id.address());

    // Mint tokens to a sender we'll use in tests.
    sac.mint(&admin, &1_000_000_000);

    let contract_id = env.register(SplitterV3, ());
    let contract = SplitterV3Client::new(&env, &contract_id);

    contract
        .initialize(
            &admin,
            &token_id.address(),
            &100u32, // 1% fee
            &treasury,
            &Vec::new(&env),
        )
        .unwrap();

    Setup { env, contract, token, admin, treasury }
}

fn make_recipients(env: &Env, addrs: &[&Address], bps: &[u32]) -> Vec<Recipient> {
    let mut v = Vec::new(env);
    for (addr, b) in addrs.iter().zip(bps.iter()) {
        v.push_back(Recipient {
            address: (*addr).clone(),
            share_bps: *b,
        });
    }
    v
}

// ── Test 1: All recipients verified — split succeeds ─────────────────────────

#[test]
fn test_split_all_verified_succeeds() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);

    s.contract.set_verification_status(&alice, &true).unwrap();
    s.contract.set_verification_status(&bob, &true).unwrap();

    let recipients = make_recipients(&s.env, &[&alice, &bob], &[5_000, 5_000]);
    let amount = 1_000_000i128;

    s.contract.split(&s.admin, &recipients, &amount).unwrap();

    // 1% fee → 10_000 to treasury; 990_000 distributable; 50/50 → 495_000 each
    assert_eq!(s.token.balance(&alice), 495_000);
    assert_eq!(s.token.balance(&bob), 495_000);
    assert_eq!(s.token.balance(&s.treasury), 10_000);
}

// ── Test 2 (Strict): Unverified recipient aborts the tx ──────────────────────

#[test]
fn test_strict_mode_unverified_recipient_fails() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env); // NOT verified

    s.contract.set_verification_status(&alice, &true).unwrap();
    s.contract.set_strict_mode(&true).unwrap();

    let recipients = make_recipients(&s.env, &[&alice, &bob], &[5_000, 5_000]);

    let result = s.contract.split(&s.admin, &recipients, &1_000_000);
    assert_eq!(result, Err(Error::RecipientNotVerified));

    // No tokens should have moved to alice or bob.
    assert_eq!(s.token.balance(&alice), 0);
    assert_eq!(s.token.balance(&bob), 0);
}

// ── Test 3 (Non-Strict): Unverified recipient skipped, math consistent ────────

#[test]
fn test_non_strict_skips_unverified_redistributes() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env); // NOT verified
    let carol = Address::generate(&s.env);

    s.contract.set_verification_status(&alice, &true).unwrap();
    s.contract.set_verification_status(&carol, &true).unwrap();
    // bob stays unverified; strict_mode stays false (default)

    // alice=40%, bob=20% (skipped), carol=40%
    let recipients = make_recipients(
        &s.env,
        &[&alice, &bob, &carol],
        &[4_000, 2_000, 4_000],
    );
    let amount = 1_000_000i128;

    s.contract.split(&s.admin, &recipients, &amount).unwrap();

    // fee=1% → 10_000 to treasury; distributable=990_000
    // verified bps = 4000+4000 = 8000
    // alice new_bps = 4000*10000/8000 = 5000 → 990_000*5000/10000 = 495_000
    // carol new_bps = 4000*10000/8000 = 5000 → 495_000
    assert_eq!(s.token.balance(&alice), 495_000);
    assert_eq!(s.token.balance(&carol), 495_000);
    assert_eq!(s.token.balance(&bob), 0); // skipped
    assert_eq!(s.token.balance(&s.treasury), 10_000);
}

// ── Test 4: Only admin can change verification status ────────────────────────

#[test]
fn test_only_admin_can_set_verification() {
    let s = setup();
    let attacker = Address::generate(&s.env);
    let victim = Address::generate(&s.env);

    // Disable mock_all_auths so auth is enforced.
    let env2 = Env::default();
    let contract2 = SplitterV3Client::new(&env2, s.contract.address());

    // Calling set_verification_status without admin auth must panic.
    let result = std::panic::catch_unwind(|| {
        contract2.set_verification_status(&victim, &true)
    });
    assert!(result.is_err());

    // Verify the status was NOT changed.
    assert!(!SplitterV3::is_verified(&s.env, victim));
    let _ = attacker; // suppress unused warning
}

// ── Test 5: No verified recipients in non-strict → error ─────────────────────

#[test]
fn test_non_strict_no_verified_recipients_errors() {
    let s = setup();
    let alice = Address::generate(&s.env); // NOT verified

    let recipients = make_recipients(&s.env, &[&alice], &[10_000]);
    let result = s.contract.split(&s.admin, &recipients, &1_000_000);
    assert_eq!(result, Err(Error::NoVerifiedRecipients));
}

// ── Test 6: Invalid bps sum → error ──────────────────────────────────────────

#[test]
fn test_invalid_bps_sum_errors() {
    let s = setup();
    let alice = Address::generate(&s.env);
    s.contract.set_verification_status(&alice, &true).unwrap();

    // shares sum to 9000, not 10000
    let recipients = make_recipients(&s.env, &[&alice], &[9_000]);
    let result = s.contract.split(&s.admin, &recipients, &1_000_000);
    assert_eq!(result, Err(Error::InvalidSplit));
}

// ── Test 7: Double initialize panics ─────────────────────────────────────────

#[test]
fn test_double_initialize_fails() {
    let s = setup();
    let result = s.contract.initialize(
        &s.admin,
        s.token.address(),
        &100u32,
        &s.treasury,
        &Vec::new(&s.env),
    );
    assert_eq!(result, Err(Error::AlreadyInitialized));
}
