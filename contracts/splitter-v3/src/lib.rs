#![no_std]

use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, Env, Vec,
};

mod errors;
mod storage;

use errors::Error;
use storage::DataKey;

#[cfg(test)]
mod test;

// ── Token interface ───────────────────────────────────────────────────────────

/// A recipient and their share in basis points (0–10000).
/// All shares in a split call must sum to exactly 10000.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug)]
pub struct Recipient {
    pub address: Address,
    /// Share in basis points. 10000 = 100%.
    pub share_bps: u32,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct SplitterV3;

#[contractimpl]
impl SplitterV3 {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Called once by the factory immediately after deployment.
    /// `owner` becomes the admin of this specific instance.
    pub fn initialize(
        env: Env,
        owner: Address,
        token: Address,
        fee_bps: u32,
        treasury: Address,
        extra_admins: Vec<Address>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        owner.require_auth();
        env.storage().instance().set(&DataKey::Admin, &owner);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::StrictMode, &false);

        // Auto-verify the owner and any extra admins.
        Self::_set_verified(&env, &owner, true);
        for addr in extra_admins.iter() {
            Self::_set_verified(&env, &addr, true);
        }

        Ok(())
    }

    // ── Admin: verification management ───────────────────────────────────────

    /// Add or remove an address from the verified whitelist.
    /// Only the admin can call this.
    pub fn set_verification_status(
        env: Env,
        user: Address,
        status: bool,
    ) -> Result<(), Error> {
        Self::_require_admin(&env)?;
        Self::_set_verified(&env, &user, status);
        env.events().publish(
            (symbol_short!("verified"), user.clone()),
            status,
        );
        Ok(())
    }

    /// Toggle strict mode on/off. Only the admin can call this.
    pub fn set_strict_mode(env: Env, strict: bool) -> Result<(), Error> {
        Self::_require_admin(&env)?;
        env.storage().instance().set(&DataKey::StrictMode, &strict);
        Ok(())
    }

    // ── Core: split ───────────────────────────────────────────────────────────

    /// Pull `total_amount` of the configured token from `sender` and distribute
    /// it to `recipients` according to their `share_bps`.
    ///
    /// **Strict mode ON** — if any recipient is unverified the entire tx panics.
    /// **Strict mode OFF** — unverified recipients are skipped; their shares are
    /// redistributed proportionally among verified recipients.
    ///
    /// `share_bps` values must sum to 10000 (100%).
    pub fn split(
        env: Env,
        sender: Address,
        recipients: Vec<Recipient>,
        total_amount: i128,
    ) -> Result<(), Error> {
        sender.require_auth();

        let strict: bool = env
            .storage()
            .instance()
            .get(&DataKey::StrictMode)
            .unwrap_or(false);

        // ── Validate shares sum to 10000 ──────────────────────────────────────
        let mut bps_sum: u32 = 0;
        for r in recipients.iter() {
            bps_sum = bps_sum.checked_add(r.share_bps).ok_or(Error::Overflow)?;
        }
        if bps_sum != 10_000 {
            return Err(Error::InvalidSplit);
        }

        // ── Collect token from sender ─────────────────────────────────────────
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(&env, &token_addr);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&sender, &contract_addr, &total_amount);

        // ── Apply protocol fee ────────────────────────────────────────────────
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let fee_amount = if fee_bps > 0 {
            let f = (total_amount as i128)
                .checked_mul(fee_bps as i128)
                .ok_or(Error::Overflow)?
                / 10_000;
            let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
            if f > 0 {
                token_client.transfer(&contract_addr, &treasury, &f);
            }
            f
        } else {
            0
        };
        let distributable = total_amount
            .checked_sub(fee_amount)
            .ok_or(Error::Overflow)?;

        // ── Verification pass ─────────────────────────────────────────────────
        if strict {
            // Strict: any unverified recipient aborts the whole tx.
            for r in recipients.iter() {
                if !Self::is_verified(&env, r.address.clone()) {
                    return Err(Error::RecipientNotVerified);
                }
            }
            // All verified — distribute directly.
            Self::_distribute(&env, &token_client, &contract_addr, &recipients, distributable)?;
        } else {
            // Non-strict: filter to verified only, redistribute shares.
            let mut verified: Vec<Recipient> = Vec::new(&env);
            let mut verified_bps: u32 = 0;
            for r in recipients.iter() {
                if Self::is_verified(&env, r.address.clone()) {
                    verified_bps = verified_bps
                        .checked_add(r.share_bps)
                        .ok_or(Error::Overflow)?;
                    verified.push_back(r);
                }
            }
            if verified.is_empty() {
                return Err(Error::NoVerifiedRecipients);
            }
            // Redistribute: scale each verified share up proportionally.
            // new_share = original_share * 10000 / verified_bps
            let mut scaled: Vec<Recipient> = Vec::new(&env);
            for r in verified.iter() {
                let new_bps = (r.share_bps as u64)
                    .checked_mul(10_000)
                    .ok_or(Error::Overflow)? as u32
                    / verified_bps;
                scaled.push_back(Recipient {
                    address: r.address.clone(),
                    share_bps: new_bps,
                });
            }
            Self::_distribute(&env, &token_client, &contract_addr, &scaled, distributable)?;
        }

        Ok(())
    }

    // ── View ──────────────────────────────────────────────────────────────────

    pub fn is_verified(env: &Env, address: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::VerifiedUsers(address))
            .unwrap_or(false)
    }

    pub fn strict_mode(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::StrictMode)
            .unwrap_or(false)
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn _require_admin(env: &Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAdmin)?;
        admin.require_auth();
        Ok(())
    }

    fn _set_verified(env: &Env, user: &Address, status: bool) {
        env.storage()
            .persistent()
            .set(&DataKey::VerifiedUsers(user.clone()), &status);
    }

    /// Transfer `distributable` to each recipient proportional to `share_bps`.
    /// Any dust from integer truncation stays in the contract.
    fn _distribute(
        env: &Env,
        token_client: &token::Client,
        from: &Address,
        recipients: &Vec<Recipient>,
        distributable: i128,
    ) -> Result<(), Error> {
        for r in recipients.iter() {
            let amount = distributable
                .checked_mul(r.share_bps as i128)
                .ok_or(Error::Overflow)?
                / 10_000;
            if amount > 0 {
                token_client.transfer(from, &r.address, &amount);
            }
        }
        env.events().publish(
            (symbol_short!("split"),),
            distributable,
        );
        Ok(())
    }
}
