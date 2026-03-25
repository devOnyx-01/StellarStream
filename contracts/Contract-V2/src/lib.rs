#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};

mod errors;
mod storage;
mod types;
mod v1_interface;

use errors::ContractError;
pub use types::{
    AdminTransferredEvent, BatchStreamsCreatedEvent, ClawbackRebalanceEvent, ContractPausedEvent, ContractUnpausedEvent, MigrationEvent, PermitArgs, PermitStreamCreatedEvent, StreamArgs,
    StreamCancelledV2Event, StreamClaimV2Event, StreamCreatedV2Event, StreamMigratedEvent, StreamToppedUpEvent,
    StreamV2,
};
use v1_interface::Client as V1Client;

#[contract]
pub struct Contract;

#[soroban_sdk::contractclient(name = "VaultClient")]
pub trait VaultTrait {
    fn deposit(env: Env, amount: i128);
    fn withdraw(env: Env, amount: i128) -> i128; // returns actual amount withdrawn
}

#[contractimpl]
impl Contract {
    // ----------------------------------------------------------------
    // Init
    // ----------------------------------------------------------------

    pub fn init(env: Env, admin: Address) -> Result<(), ContractError> {
        if storage::has_admin(&env) {
            return Err(ContractError::AlreadyInitialized);
        }
        storage::set_admin(&env, &admin);
        Ok(())
    }

    pub fn admin(env: Env) -> Address {
        storage::get_admin(&env)
    }

    // ----------------------------------------------------------------
    // Issue #400 — Multi-sig Admin Handover
    // ----------------------------------------------------------------

    /// Replace the admin set and threshold.
    ///
    /// `signers` must contain at least the current threshold of existing
    /// admins so the handover itself is multi-sig protected.
    pub fn set_admins(
        env: Env,
        signers: Vec<Address>, // current admins authorising this change
        new_admins: Vec<Address>,
        new_threshold: u32,
    ) -> Result<(), ContractError> {
        // Validate new config before touching state.
        if new_threshold == 0 || new_threshold > new_admins.len() {
            return Err(ContractError::InvalidThreshold);
        }

        // Require current multi-sig quorum.
        storage::require_multisig(&env, &signers)?;

        storage::set_admin_list_raw(&env, &new_admins, new_threshold);
        Ok(())
    }

    /// Return the current admin list.
    pub fn get_admins(env: Env) -> Vec<Address> {
        storage::get_admin_list(&env)
    }

    /// Return the current approval threshold.
    pub fn get_threshold(env: Env) -> u32 {
        storage::get_threshold(&env)
    }

    /// Transfer admin rights to a new address (e.g. a multisig or DAO contract).
    ///
    /// The current admin must authorise this call. The new admin becomes the
    /// sole admin with threshold = 1, ready to be promoted to a full multisig
    /// via `set_admins` if desired.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        let previous_admin = storage::get_admin(&env);
        previous_admin.require_auth();

        storage::set_admin(&env, &new_admin);

        env.events().publish(
            (symbol_short!("adm_xfer"), new_admin.clone()),
            AdminTransferredEvent {
                previous_admin,
                new_admin,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    // ----------------------------------------------------------------
    // Issue #396 — Dust Threshold
    // ----------------------------------------------------------------

    /// Return the minimum stream amount for `asset` (default: 10 XLM).
    pub fn get_min_value(env: Env, asset: Address) -> i128 {
        storage::get_min_value(&env, &asset)
    }

    /// Override the minimum for a specific asset. Admin-only.
    pub fn set_min_value(env: Env, asset: Address, min: i128) -> Result<(), ContractError> {
        storage::get_admin(&env).require_auth();
        storage::set_min_value(&env, &asset, min);
        Ok(())
    }

    // ----------------------------------------------------------------
    // Issue #359 — Migration Bridge
    // ----------------------------------------------------------------

    pub fn migrate_stream(
        env: Env,
        v1_contract: Address,
        v1_stream_id: u64,
        caller: Address,
    ) -> Result<u64, ContractError> {
        Self::require_not_paused(&env)?;
        caller.require_auth();

        let v1_client = V1Client::new(&env, &v1_contract);

        let v1_stream = v1_client
            .try_get_stream(&v1_stream_id)
            .map_err(|_| ContractError::NotStreamOwner)?
            .map_err(|_| ContractError::NotStreamOwner)?;

        if v1_stream.receiver != caller {
            return Err(ContractError::NotStreamOwner);
        }

        if v1_stream.cancelled || v1_stream.is_frozen || v1_stream.is_paused {
            return Err(ContractError::StreamNotMigratable);
        }

        let now = env.ledger().timestamp();
        if now >= v1_stream.end_time {
            return Err(ContractError::StreamNotMigratable);
        }

        let elapsed = {
            let effective_now = now.saturating_sub(v1_stream.total_paused_duration);
            if effective_now <= v1_stream.start_time {
                0i128
            } else {
                (effective_now - v1_stream.start_time) as i128
            }
        };
        let duration = (v1_stream.end_time - v1_stream.start_time) as i128;
        let unlocked = (v1_stream.total_amount * elapsed) / duration;
        let remaining = v1_stream.total_amount - unlocked;

        if remaining <= 0 {
            return Err(ContractError::NothingToMigrate);
        }

        v1_client
            .try_cancel(&v1_stream_id, &caller)
            .map_err(|_| ContractError::StreamNotMigratable)?
            .map_err(|_| ContractError::StreamNotMigratable)?;

        let v2_stream_id = storage::next_stream_id(&env);

        let v2_stream = StreamV2 {
            sender: v1_stream.sender.clone(),
            receiver: caller.clone(),
            token: v1_stream.token.clone(),
            total_amount: remaining,
            start_time: now,
            end_time: v1_stream.end_time,
            cliff_time: now, // migrated streams have no cliff in V2
            withdrawn_amount: 0,
            cancelled: false,
            migrated_from_v1: true,
            v1_stream_id,
            step_duration: 0,
            multiplier_bps: 0,
            vault_address: None, // Migrated streams don't use V2 vaults
            yield_enabled: false,
            is_pending: false,
        };

        storage::set_stream(&env, v2_stream_id, &v2_stream);
        storage::update_stats(&env, remaining, &v1_stream.sender, &caller);

        env.events().publish(
            (symbol_short!("migrated"), caller.clone()),
            StreamMigratedEvent {
                v2_stream_id,
                v1_stream_id,
                caller: caller.clone(),
                migrated_amount: remaining,
                timestamp: now,
            },
        );

        // Emit migration event for indexer
        env.events().publish(
            (Symbol::new(&env, "migrate"),),
            (v1_stream_id, v2_stream_id, caller.clone(), remaining),
        );

        Ok(v2_stream_id)
    }

    pub fn get_stream(env: Env, stream_id: u64) -> Option<StreamV2> {
        storage::get_stream(&env, stream_id)
    }

    pub fn get_v2_protocol_health(env: Env) -> types::ProtocolHealthV2 {
        storage::get_health(&env)
    }

    // ----------------------------------------------------------------
    // Stream Operations (Issue #363 — Escalating Rates)
    // ----------------------------------------------------------------

    pub fn withdraw(env: Env, stream_id: u64, receiver: Address) -> Result<i128, ContractError> {
        Self::require_not_paused(&env)?;
        receiver.require_auth();

        let mut stream =
            storage::get_stream(&env, stream_id).ok_or(ContractError::StreamNotFound)?;

        if stream.receiver != receiver {
            return Err(ContractError::NotStreamOwner);
        }

        if stream.cancelled {
            return Err(ContractError::AlreadyCancelled);
        }

        let now = env.ledger().timestamp();
        let unlocked = Self::calculate_unlocked_internal(&stream, now);
        let to_withdraw = unlocked.saturating_sub(stream.withdrawn_amount);

        if to_withdraw <= 0 {
            return Err(ContractError::NothingToMigrate); // TODO: Add NothingToWithdraw
        }

        // If Yield-Bearing, withdraw principal from Vault
        if stream.yield_enabled {
            if let Some(vault_addr) = &stream.vault_address {
                let vault_client = VaultClient::new(&env, vault_addr);
                // Attempt to withdraw from vault, catching if it's paused/fails
                let result = vault_client.try_withdraw(&to_withdraw);

                if result.is_err() {
                    stream.is_pending = true;
                    storage::set_stream(&env, stream_id, &stream);
                    // Return Ok(0) to persist the 'is_pending' state change.
                    // Returning Err automatically rolls back state in Soroban.
                    return Ok(0);
                }
            }
        }

        // Perform transfer
        let token_client = soroban_sdk::token::TokenClient::new(&env, &stream.token);
        token_client.transfer(
            &env.current_contract_address(),
            &stream.receiver,
            &to_withdraw,
        );

        // Update state
        stream.withdrawn_amount += to_withdraw;
        stream.is_pending = false; // Successfully withdrawn, any previous pending status cleared
        storage::set_stream(&env, stream_id, &stream);

        // Update analytics (TVL decreased)
        storage::update_stats(&env, -to_withdraw, &stream.sender, &stream.receiver);

        env.events().publish(
            (symbol_short!("claim"), receiver.clone()),
            StreamClaimV2Event {
                stream_id,
                receiver: receiver.clone(),
                amount: to_withdraw,
                total_claimed: stream.withdrawn_amount,
                timestamp: now,
            },
        );

        Ok(to_withdraw)
    }

    pub fn cancel(env: Env, stream_id: u64, caller: Address) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        caller.require_auth();

        let mut stream =
            storage::get_stream(&env, stream_id).ok_or(ContractError::StreamNotFound)?;

        if stream.sender != caller && stream.receiver != caller {
            return Err(ContractError::NotStreamOwner);
        }

        if stream.cancelled {
            return Err(ContractError::AlreadyCancelled);
        }

        let now = env.ledger().timestamp();
        let unlocked = Self::calculate_unlocked_internal(&stream, now);
        let to_receiver = unlocked.saturating_sub(stream.withdrawn_amount);
        let to_sender = stream.total_amount.saturating_sub(unlocked);
        let total_remaining = to_receiver + to_sender;

        // If Yield-Bearing, withdraw total remaining from Vault
        if stream.yield_enabled {
            if let Some(vault_addr) = &stream.vault_address {
                let vault_client = VaultClient::new(&env, vault_addr);
                let result = vault_client.try_withdraw(&total_remaining);

                if result.is_err() {
                    stream.is_pending = true;
                    storage::set_stream(&env, stream_id, &stream);
                    return Err(ContractError::VaultPaused);
                }
            }
        }

        stream.withdrawn_amount = unlocked;
        stream.cancelled = true;
        storage::set_stream(&env, stream_id, &stream);

        let token_client = soroban_sdk::token::TokenClient::new(&env, &stream.token);
        if to_receiver > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &stream.receiver,
                &to_receiver,
            );
        }
        if to_sender > 0 {
            token_client.transfer(&env.current_contract_address(), &stream.sender, &to_sender);
        }

        env.events().publish(
            (symbol_short!("cancel"), caller.clone()),
            StreamCancelledV2Event {
                stream_id,
                canceller: caller,
                to_receiver,
                to_sender,
                timestamp: now,
            },
        );

        Ok(())
    }

    fn calculate_unlocked_internal(stream: &StreamV2, now: u64) -> i128 {
        if now < stream.cliff_time || now <= stream.start_time {
            return 0;
        }
        if now < stream.cliff_time || now <= stream.start_time {
            return 0;
        }
        if now >= stream.end_time {
            return stream.total_amount;
        }
        if stream.cancelled {
            return stream.total_amount;
        }

        if stream.step_duration > 0 {
            let elapsed = (now - stream.start_time) as i128;
            let duration = (stream.end_time - stream.start_time) as i128;
            let step_duration = stream.step_duration;
            let n_steps = (elapsed / step_duration) as u32;
            let delta_t = elapsed % step_duration;

            let m_bps = stream.multiplier_bps;
            let q_bps = 10000 + m_bps;

            let total_steps = (duration / step_duration) as u32;

            let q_pow_total = Self::power_scale(q_bps, total_steps);
            let q_pow_n = Self::power_scale(q_bps, n_steps);

            let scale = 1_000_000_000_i128;

            let term1 = (q_pow_n - scale) * step_duration;
            let term2 = (q_pow_n * delta_t * m_bps) / 10000;

            let numerator = stream.total_amount * (term1 + term2);
            let denominator = (q_pow_total - scale) * step_duration;

            if denominator <= 0 {
                return (stream.total_amount * elapsed) / duration;
            }

            numerator / denominator
        } else {
            let elapsed = (now - stream.start_time) as i128;
            let duration = (stream.end_time - stream.start_time) as i128;
            (stream.total_amount * elapsed) / duration
        }
    }

    fn power_scale(q_bps: i128, n: u32) -> i128 {
        let mut res = 1_000_000_000_i128;
        let mut base = q_bps;
        let mut exp = n;
        while exp > 0 {
            if exp % 2 == 1 {
                res = (res * base) / 10000;
            }
            base = (base * base) / 10000;
            exp /= 2;
        }
        res
    }

    pub fn top_up(env: Env, stream_id: u64, sender: Address, extra_amount: i128) -> Result<(), ContractError> {
        Self::require_not_paused(&env)?;
        sender.require_auth();

        if extra_amount <= 0 {
            return Err(ContractError::BelowDustThreshold);
        }

        let mut stream =
            storage::get_stream(&env, stream_id).ok_or(ContractError::StreamNotFound)?;

        if stream.sender != sender {
            return Err(ContractError::NotStreamOwner);
        }

        if stream.cancelled {
            return Err(ContractError::AlreadyCancelled);
        }

        let now = env.ledger().timestamp();

        // Checkpoint: calculate what's already unlocked so the rate stays consistent.
        let unlocked_at_now = Self::calculate_unlocked_internal(&stream, now);
        let remaining = stream.total_amount.saturating_sub(unlocked_at_now);

        // Pull the new funds into the contract.
        let token_client = soroban_sdk::token::TokenClient::new(&env, &stream.token);
        token_client.transfer(
            &sender,
            &env.current_contract_address(),
            &extra_amount,
        );

        // Extend end_time proportionally: keep the same rate over the new remaining balance.
        let duration = (stream.end_time - stream.start_time) as i128;
        let new_remaining = remaining + extra_amount;
        let rate = stream.total_amount; // tokens per `duration` seconds
        // new_end_time = now + (new_remaining * duration / rate)
        let extra_seconds = (new_remaining * duration) / rate;
        let new_end_time = now + extra_seconds as u64;

        stream.total_amount += extra_amount;
        stream.end_time = new_end_time;
        storage::set_stream(&env, stream_id, &stream);

        // Update TVL.
        storage::update_stats(&env, extra_amount, &stream.sender, &stream.receiver);

        env.events().publish(
            (symbol_short!("top_up"), sender.clone()),
            StreamToppedUpEvent {
                stream_id,
                sender,
                extra_amount,
                new_total_amount: stream.total_amount,
                new_end_time,
                timestamp: now,
            },
        );

        Ok(())
    }

    pub fn bump_active_streams_ttl(env: Env, ids: Vec<u64>) -> u32 {
        storage::bump_streams_ttl(&env, &ids)
    }

    // ----------------------------------------------------------------
    // Governance: Stream-Weighted Voting Power
    // ----------------------------------------------------------------

    /// Calculate the total value currently locked in active streams for a user.
    /// This represents the user's "skin in the game" for governance purposes.
    ///
    /// Returns the sum of (total_amount - withdrawn_amount) for all non-cancelled
    /// streams where the user is either sender or receiver.
    pub fn get_active_volume(env: Env, user: Address) -> i128 {
        let total_streams = storage::get_health(&env).total_v2_streams;
        let mut total_locked: i128 = 0;

        for i in 0..total_streams {
            if let Some(stream) = storage::get_stream(&env, i) {
                // Only count active (non-cancelled) streams
                if !stream.cancelled {
                    // Check if user is involved in this stream
                    if stream.sender == user || stream.receiver == user {
                        // Calculate remaining locked amount
                        let locked = stream.total_amount.saturating_sub(stream.withdrawn_amount);
                        total_locked = total_locked.saturating_add(locked);
                    }
                }
            }
        }

        total_locked
    }

    pub fn pause(env: Env) -> Result<(), ContractError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();
        storage::set_paused(&env, true);
        env.events().publish(
            (symbol_short!("pause"), admin.clone()),
            ContractPausedEvent {
                admin,
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), ContractError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();
        storage::set_paused(&env, false);
        env.events().publish(
            (symbol_short!("unpause"), admin.clone()),
            ContractUnpausedEvent {
                admin,
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    // ----------------------------------------------------------------
    // Compliance: Asset "Clawback" Support Logic
    // ----------------------------------------------------------------

    /// Compare the actual token balance in the contract with the sum of all
    /// active stream remaining balances.
    /// Returns (contract_balance, total_remaining_in_streams).
    pub fn check_balance_integrity(env: Env, token: Address) -> (i128, i128) {
        let total_streams = storage::get_health(&env).total_v2_streams;
        let mut sum_remaining: i128 = 0;

        for i in 0..total_streams {
            if let Some(stream) = storage::get_stream(&env, i) {
                if !stream.cancelled && stream.token == token {
                    let remaining = stream.total_amount.saturating_sub(stream.withdrawn_amount);
                    sum_remaining = sum_remaining.saturating_add(remaining);
                }
            }
        }

        let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
        let contract_balance = token_client.balance(&env.current_contract_address());

        (contract_balance, sum_remaining)
    }

    /// Proportionally reduce all active streams for a token if the contract
    /// balance is less than the total committed amount (e.g. after a clawback).
    /// Only the contract admin can trigger this.
    pub fn rebalance_after_clawback(env: Env, token: Address) -> Result<(), ContractError> {
        let admin = storage::get_admin(&env);
        admin.require_auth();

        let (balance, sum_remaining) = Self::check_balance_integrity(env.clone(), token.clone());

        if balance >= sum_remaining || sum_remaining == 0 {
            return Ok(());
        }

        // reduction_factor_bps = (balance * 10000) / sum_remaining
        let reduction_factor_bps = (balance * 10000) / sum_remaining;

        let total_streams = storage::get_health(&env).total_v2_streams;
        for i in 0..total_streams {
            if let Some(mut stream) = storage::get_stream(&env, i) {
                if !stream.cancelled && stream.token == token {
                    let old_remaining = stream.total_amount.saturating_sub(stream.withdrawn_amount);
                    let new_remaining = (old_remaining * reduction_factor_bps) / 10000;
                    
                    // New total = withdrawn + new_remaining
                    stream.total_amount = stream.withdrawn_amount + new_remaining;
                    storage::set_stream(&env, i, &stream);
                }
            }
        }

        env.events().publish(
            (symbol_short!("rebalance"), token.clone()),
            types::ClawbackRebalanceEvent {
                token,
                total_remaining: sum_remaining,
                contract_balance: balance,
                reduction_factor_bps,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        if storage::is_paused(env) {
            return Err(ContractError::ContractPaused);
        }
        Ok(())
    }

    pub fn create_stream(env: Env, args: StreamArgs) -> Result<u64, ContractError> {
        Self::require_not_paused(&env)?;
        args.sender.require_auth();

        if args.start_time >= args.end_time
            || args.cliff_time < args.start_time
            || args.cliff_time > args.end_time
        {
            return Err(ContractError::InvalidTimeRange);
        }

        if args.total_amount < storage::get_min_value(&env, &args.token) {
            return Err(ContractError::BelowDustThreshold);
        }

        let token_client = soroban_sdk::token::TokenClient::new(&env, &args.token);
        token_client.transfer(
            &args.sender,
            &env.current_contract_address(),
            &args.total_amount,
        );

        let stream_id = storage::next_stream_id(&env);

        let mut vault_used = None;
        if args.yield_enabled {
            if let Some(vault_addr) = &args.vault_address {
                let vault_client = VaultClient::new(&env, vault_addr);
                vault_client.deposit(&args.total_amount);
                vault_used = Some(vault_addr.clone());
            }
        }

        let stream = StreamV2 {
            sender: args.sender.clone(),
            receiver: args.receiver.clone(),
            token: args.token.clone(),
            total_amount: args.total_amount,
            start_time: args.start_time,
            end_time: args.end_time,
            cliff_time: args.cliff_time,
            withdrawn_amount: 0,
            cancelled: false,
            migrated_from_v1: false,
            v1_stream_id: 0,
            step_duration: args.step_duration,
            multiplier_bps: args.multiplier_bps,
            vault_address: vault_used,
            yield_enabled: args.yield_enabled,
            is_pending: false,
        };

        storage::set_stream(&env, stream_id, &stream);
        storage::update_stats(&env, args.total_amount, &args.sender, &args.receiver);

        env.events().publish(
            (symbol_short!("create_v2"), args.sender.clone()),
            StreamCreatedV2Event {
                stream_id,
                sender: args.sender,
                receiver: args.receiver,
                token: args.token,
                total_amount: args.total_amount,
                start_time: args.start_time,
                cliff_time: args.cliff_time,
                end_time: args.end_time,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(stream_id)
    }

    pub fn create_stream_with_signature(
        env: Env,
        args: PermitArgs,
        signature: soroban_sdk::BytesN<64>,
    ) -> Result<u64, ContractError> {
        Self::require_not_paused(&env)?;
        let now = env.ledger().timestamp();

        if now > args.deadline {
            return Err(ContractError::ExpiredDeadline);
        }

        if args.total_amount < storage::get_min_value(&env, &args.token) {
            return Err(ContractError::BelowDustThreshold);
        }

        let nonce_key = (symbol_short!("NONCE"), args.sender_pubkey.clone());
        let stored_nonce: u64 = env.storage().instance().get(&nonce_key).unwrap_or(0u64);

        if args.nonce != stored_nonce {
            return Err(ContractError::InvalidNonce);
        }

        let mut msg = soroban_sdk::Bytes::new(&env);
        msg.extend_from_slice(b"STELLARSTREAM_PERMIT_V2");
        msg.append(&env.current_contract_address().to_xdr(&env));
        msg.append(&args.sender_pubkey.clone().into());
        msg.append(&args.receiver.clone().to_xdr(&env));
        msg.append(&args.token.clone().to_xdr(&env));

        msg.extend_from_slice(&args.total_amount.to_be_bytes());
        msg.extend_from_slice(&args.start_time.to_be_bytes());
        msg.extend_from_slice(&args.cliff_time.to_be_bytes());
        msg.extend_from_slice(&args.end_time.to_be_bytes());
        msg.extend_from_slice(&args.nonce.to_be_bytes());
        msg.extend_from_slice(&args.deadline.to_be_bytes());

        if args.step_duration > 0 {
            msg.extend_from_slice(&args.step_duration.to_be_bytes());
            msg.extend_from_slice(&args.multiplier_bps.to_be_bytes());
        }

        let msg_hash: soroban_sdk::BytesN<32> = env.crypto().sha256(&msg).into();
        env.crypto()
            .ed25519_verify(&args.sender_pubkey, &msg_hash.into(), &signature);

        env.storage()
            .instance()
            .set(&nonce_key, &(stored_nonce + 1));

        let token_client = soroban_sdk::token::TokenClient::new(&env, &args.token);
        let sender_addr = Address::from_string_bytes(&args.sender_pubkey.clone().into());

        token_client.transfer_from(
            &env.current_contract_address(),
            &sender_addr,
            &env.current_contract_address(),
            &args.total_amount,
        );

        let stream_id = storage::next_stream_id(&env);

        let stream = StreamV2 {
            sender: sender_addr.clone(),
            receiver: args.receiver.clone(),
            token: args.token.clone(),
            total_amount: args.total_amount,
            start_time: args.start_time,
            end_time: args.end_time,
            cliff_time: args.cliff_time,
            withdrawn_amount: 0,
            cancelled: false,
            migrated_from_v1: false,
            v1_stream_id: 0,
            step_duration: args.step_duration,
            multiplier_bps: args.multiplier_bps,
            vault_address: None, // No vault support by permit yet
            yield_enabled: false,
            is_pending: false,
        };

        storage::set_stream(&env, stream_id, &stream);
        storage::update_stats(&env, args.total_amount, &sender_addr, &args.receiver);

        env.events().publish(
            (symbol_short!("permit"), args.receiver.clone()),
            PermitStreamCreatedEvent {
                stream_id,
                sender_pubkey: args.sender_pubkey,
                receiver: args.receiver,
                token: args.token,
                total_amount: args.total_amount,
                cliff_time: args.cliff_time,
                nonce: args.nonce,
                timestamp: now,
            },
        );

        Ok(stream_id)
    }

    // ----------------------------------------------------------------
    // Issue #367 — Batch Stream Creation
    // ----------------------------------------------------------------

    pub fn create_batch_streams(env: Env, streams: Vec<StreamArgs>) -> Result<Vec<u64>, ContractError> {
        Self::require_not_paused(&env)?;

        // Validate batch size limit (max 10 streams)
        if streams.len() > 10 {
            return Err(ContractError::BatchTooLarge);
        }

        if streams.is_empty() {
            return Err(ContractError::InvalidTimeRange); // Reuse error for empty batch
        }

        // Validate all streams upfront to ensure atomicity
        let mut total_amount: i128 = 0;
        let sender = streams.get(0).unwrap().sender.clone();

        for args in streams.iter() {
            // All streams must have the same sender
            if args.sender != sender {
                return Err(ContractError::InvalidTimeRange); // Reuse error for inconsistent sender
            }

            // Validate time ranges
            if args.start_time >= args.end_time
                || args.cliff_time < args.start_time
                || args.cliff_time > args.end_time
            {
                return Err(ContractError::InvalidTimeRange);
            }

            // Validate dust threshold
            if args.total_amount < storage::get_min_value(&env, &args.token) {
                return Err(ContractError::BelowDustThreshold);
            }

            total_amount = total_amount.checked_add(args.total_amount)
                .ok_or(ContractError::InvalidTimeRange)?; // Overflow protection
        }

        // Require auth from the sender
        sender.require_auth();

        // Calculate total amount needed and transfer all tokens at once
        let token_client = soroban_sdk::token::TokenClient::new(&env, &streams.get(0).unwrap().token);
        token_client.transfer(
            &sender,
            &env.current_contract_address(),
            &total_amount,
        );

        // Create all streams
        let mut stream_ids = Vec::new(&env);
        let mut total_created_amount: i128 = 0;

        for args in streams.iter() {
            let stream_id = storage::next_stream_id(&env);

            let stream = StreamV2 {
                sender: args.sender.clone(),
                receiver: args.receiver.clone(),
                token: args.token.clone(),
                total_amount: args.total_amount,
                start_time: args.start_time,
                end_time: args.end_time,
                cliff_time: args.cliff_time,
                withdrawn_amount: 0,
                cancelled: false,
                migrated_from_v1: false,
                v1_stream_id: 0,
                step_duration: args.step_duration,
                multiplier_bps: args.multiplier_bps,
                vault_address: None, // Batch creation default to no vault for now
                yield_enabled: false,
                is_pending: false,
            };

            storage::set_stream(&env, stream_id, &stream);
            storage::update_stats(&env, args.total_amount, &args.sender, &args.receiver);

            // Emit individual stream creation event
            env.events().publish(
                (symbol_short!("create_v2"), args.sender.clone()),
                StreamCreatedV2Event {
                    stream_id,
                    sender: args.sender.clone(),
                    receiver: args.receiver.clone(),
                    token: args.token.clone(),
                    total_amount: args.total_amount,
                    start_time: args.start_time,
                    cliff_time: args.cliff_time,
                    end_time: args.end_time,
                    timestamp: env.ledger().timestamp(),
                },
            );

            stream_ids.push_back(stream_id);
            total_created_amount = total_created_amount.checked_add(args.total_amount).unwrap();
        }

        // Emit batch creation summary event
        env.events().publish(
            (symbol_short!("batch_cr"), sender.clone()),
            BatchStreamsCreatedEvent {
                stream_ids: stream_ids.clone(),
                sender: sender.clone(),
                total_streams: stream_ids.len() as u32,
                total_amount: total_created_amount,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(stream_ids)
    }
}

mod test;
