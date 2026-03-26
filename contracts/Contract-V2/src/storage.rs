use crate::contracterror::Error;
use crate::types::StreamV2;
use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol, Vec};

const STATUS_ACTIVE: u8 = 0;
const STATUS_CANCELLED: u8 = 1;
const STATUS_PENDING: u8 = 2;
const STATUS_MASK: u128 = 0xFF;
const PENALTY_BPS_SHIFT: u32 = 8;
const PENALTY_BPS_MASK: u128 = 0xFFFF_FFFF;
const CURVE_TYPE_SHIFT: u32 = 40;
const CURVE_TYPE_MASK: u128 = 0xFF;
const MIGRATED_FROM_V1_SHIFT: u32 = 48;
const YIELD_ENABLED_SHIFT: u32 = 49;
const IS_RECURRENT_SHIFT: u32 = 50;
const CANCELLATION_TYPE_SHIFT: u32 = 51;
const CANCELLATION_TYPE_MASK: u128 = 0xFFFF_FFFF;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
struct StoredStreamV2 {
    pub sender: Address,
    pub receiver: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub withdrawn_amount: i128,
    pub packed_meta: u128,
    pub v1_stream_id: u64,
    pub step_duration: i128,
    pub multiplier_bps: i128,
    pub vault_address: Option<Address>,
    pub cycle_duration: u64,
}

// ----------------------------------------------------------------
// DataKeyV2 — all storage keys for the V2 contract.
//
// IMPORTANT: never reorder or remove variants — Soroban
// serialises the enum discriminant as the on-chain key.
// Only ever append new variants at the bottom.
// ----------------------------------------------------------------
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DataKeyV2 {
    // -- instance() keys -----------------------------------------
    Admin,       // 0
    Stream(u64), // 1

    // Issue #400 — multi-sig admin
    AdminList, // 2
    Threshold, // 3

    // -- Paused state --------------------------------------------
    Paused, // 4

    // -- Dust threshold ------------------------------------------
    /// Per-asset minimum stream amount. Falls back to DEFAULT_MIN_VALUE.
    MinValue(Address), // 5

    // -- Analytics -----------------------------------------------
    UserSeen(Address), // 6

    // -- Time-locked Admin Actions -------------------------------
    ScheduledOp(crate::types::Operation), // 7

    // -- Protocol Fees -------------------------------------------
    /// Protocol treasury address for fee collection
    Treasury, // 8
    /// Accumulated pending fees per (recipient, token) pair
    PendingFees(Address, Address), // 9
    /// Protocol fee in basis points (e.g. 100 = 1%)
    FeeBps, // 10
    /// Verified assets supported for V2 stream creation
    WhitelistedAsset(Address), // 11

    // -- Migration pause -----------------------------------------
    /// When true, migrate_stream is blocked while standard V2 ops remain live.
    MigrationPaused, // 12
}

/// Global stream counter.
pub const STREAM_COUNT_V2: Symbol = symbol_short!("STR_V2");
pub const V2_TVL: Symbol = symbol_short!("V2_TVL");
pub const V2_USER_COUNT: Symbol = symbol_short!("V2_USER");

// TTL constants (~5-second ledger close time)
const INSTANCE_TTL_THRESHOLD: u32 = 518_400; // ~30 days
const INSTANCE_TTL_BUMP: u32 = 535_680; // ~31 days

// Per-stream persistent TTL constants
pub const STREAM_TTL_THRESHOLD: u32 = 518_400; // ~30 days — extend if below this
pub const STREAM_TTL_BUMP: u32 = 2_073_600; // ~120 days — extend to this

// 48-hour delay for administrative operations.
pub const ADMIN_DELAY: u64 = 172_800; // 48h in seconds

// ----------------------------------------------------------------
// Backward-compat single-admin bootstrap (used by init)
// ----------------------------------------------------------------

/// Seed a single-admin list with threshold = 1.
pub fn set_admin(env: &Env, admin: &Address) {
    let mut list = Vec::new(env);
    list.push_back(admin.clone());
    set_admin_list_raw(env, &list, 1);
}

/// Return the first admin (legacy helper used by existing callers).
pub fn get_admin(env: &Env) -> Address {
    bump_instance(env);
    get_admin_list(env)
        .first()
        .unwrap_or_else(|| env.panic_with_error(Error::ContractNotInitialized))
}

pub fn try_get_admin(env: &Env) -> Result<Address, Error> {
    bump_instance(env);
    get_admin_list(env)
        .first()
        .ok_or(Error::ContractNotInitialized)
}

/// Returns true if the admin list has been initialised.
pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKeyV2::AdminList)
}

// ----------------------------------------------------------------
// Multi-sig admin storage (Issue #400)
// ----------------------------------------------------------------

/// Atomically replace the admin set and threshold.
/// Validation (threshold bounds) is enforced in lib.rs.
pub fn set_admin_list_raw(env: &Env, admins: &Vec<Address>, threshold: u32) {
    env.storage().instance().set(&DataKeyV2::AdminList, admins);
    env.storage()
        .instance()
        .set(&DataKeyV2::Threshold, &threshold);
    bump_instance(env);
}

/// Return the full admin list.
pub fn get_admin_list(env: &Env) -> Vec<Address> {
    bump_instance(env);
    env.storage()
        .instance()
        .get(&DataKeyV2::AdminList)
        .unwrap_or_else(|| env.panic_with_error(Error::AdminListNotSet))
}

pub fn try_get_admin_list(env: &Env) -> Result<Vec<Address>, Error> {
    bump_instance(env);
    env.storage()
        .instance()
        .get(&DataKeyV2::AdminList)
        .ok_or(Error::AdminListNotSet)
}

/// Return the approval threshold.
pub fn get_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKeyV2::Threshold)
        .unwrap_or(1)
}

/// Require that at least `threshold` of the admin list have authorised
/// this invocation.
///
/// Callers pass `signers` — the subset of admins that are signing this
/// particular transaction. The function:
///   1. Verifies every address in `signers` is in the admin list.
///   2. Calls `require_auth()` on each (host enforces the auth entry).
///   3. Checks `signers.len() >= threshold`.
pub fn require_multisig(env: &Env, signers: &Vec<Address>) -> Result<(), Error> {
    let admins = try_get_admin_list(env)?;
    let threshold = get_threshold(env);

    // Every supplied signer must be a registered admin.
    for signer in signers.iter() {
        if !admins.contains(&signer) {
            return Err(Error::NotEnoughSigners);
        }
        signer.require_auth();
    }

    if signers.len() < threshold {
        return Err(Error::NotEnoughSigners);
    }

    Ok(())
}

// ----------------------------------------------------------------
// persistent() helpers — Streams
// Stream storage
// ----------------------------------------------------------------

pub fn next_stream_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&STREAM_COUNT_V2).unwrap_or(0);
    env.storage().instance().set(&STREAM_COUNT_V2, &(id + 1));
    id
}

pub(crate) fn pack_stream_metadata(stream: &StreamV2) -> u128 {
    let status = if stream.cancelled {
        STATUS_CANCELLED
    } else if stream.is_pending {
        STATUS_PENDING
    } else {
        STATUS_ACTIVE
    };

    let mut packed = status as u128;
    packed |= ((stream.penalty_bps as u128) & PENALTY_BPS_MASK) << PENALTY_BPS_SHIFT;
    packed |= (0u128 & CURVE_TYPE_MASK) << CURVE_TYPE_SHIFT;

    if stream.migrated_from_v1 {
        packed |= 1u128 << MIGRATED_FROM_V1_SHIFT;
    }
    if stream.yield_enabled {
        packed |= 1u128 << YIELD_ENABLED_SHIFT;
    }
    if stream.is_recurrent {
        packed |= 1u128 << IS_RECURRENT_SHIFT;
    }

    packed | ((stream.cancellation_type as u128 & CANCELLATION_TYPE_MASK) << CANCELLATION_TYPE_SHIFT)
}

pub(crate) fn unpack_stream_metadata(packed: u128) -> (u8, u32, u8, bool, bool, bool, u32) {
    let status = (packed & STATUS_MASK) as u8;
    let penalty_bps = ((packed >> PENALTY_BPS_SHIFT) & PENALTY_BPS_MASK) as u32;
    let curve_type = ((packed >> CURVE_TYPE_SHIFT) & CURVE_TYPE_MASK) as u8;
    let migrated_from_v1 = ((packed >> MIGRATED_FROM_V1_SHIFT) & 1) != 0;
    let yield_enabled = ((packed >> YIELD_ENABLED_SHIFT) & 1) != 0;
    let is_recurrent = ((packed >> IS_RECURRENT_SHIFT) & 1) != 0;
    let cancellation_type =
        ((packed >> CANCELLATION_TYPE_SHIFT) & CANCELLATION_TYPE_MASK) as u32;

    (
        status,
        penalty_bps,
        curve_type,
        migrated_from_v1,
        yield_enabled,
        is_recurrent,
        cancellation_type,
    )
}

/// Persist a V2 stream in persistent storage and set its initial TTL.
pub fn set_stream(env: &Env, stream_id: u64, stream: &StreamV2) {
    let key = DataKeyV2::Stream(stream_id);
    let stored = StoredStreamV2 {
        sender: stream.sender.clone(),
        receiver: stream.receiver.clone(),
        beneficiary: stream.beneficiary.clone(),
        token: stream.token.clone(),
        total_amount: stream.total_amount,
        start_time: stream.start_time,
        end_time: stream.end_time,
        cliff_time: stream.cliff_time,
        withdrawn_amount: stream.withdrawn_amount,
        packed_meta: pack_stream_metadata(stream),
        v1_stream_id: stream.v1_stream_id,
        step_duration: stream.step_duration,
        multiplier_bps: stream.multiplier_bps,
        vault_address: stream.vault_address.clone(),
        cycle_duration: stream.cycle_duration,
    };
    env.storage().persistent().set(&key, &stored);
    env.storage()
        .persistent()
        .extend_ttl(&key, STREAM_TTL_THRESHOLD, STREAM_TTL_BUMP);
}

/// Read a V2 stream from persistent storage.
pub fn get_stream(env: &Env, stream_id: u64) -> Option<StreamV2> {
    let key = DataKeyV2::Stream(stream_id);
    let stream: Option<StoredStreamV2> = env.storage().persistent().get(&key);
    if stream.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, STREAM_TTL_THRESHOLD, STREAM_TTL_BUMP);
    }
    stream.map(|stored| {
        let (status, penalty_bps, _curve_type, migrated_from_v1, yield_enabled, is_recurrent, cancellation_type) =
            unpack_stream_metadata(stored.packed_meta);

        StreamV2 {
            sender: stored.sender,
            receiver: stored.receiver,
            beneficiary: stored.beneficiary,
            token: stored.token,
            total_amount: stored.total_amount,
            start_time: stored.start_time,
            end_time: stored.end_time,
            cliff_time: stored.cliff_time,
            withdrawn_amount: stored.withdrawn_amount,
            cancelled: status == STATUS_CANCELLED,
            migrated_from_v1,
            v1_stream_id: stored.v1_stream_id,
            step_duration: stored.step_duration,
            multiplier_bps: stored.multiplier_bps,
            vault_address: stored.vault_address,
            yield_enabled,
            is_pending: status == STATUS_PENDING,
            is_recurrent,
            cycle_duration: stored.cycle_duration,
            cancellation_type,
            penalty_bps,
        }
    })
}

// ----------------------------------------------------------------
// instance() helpers — Analytics
// ----------------------------------------------------------------

/// Update TVL and unique user count.
pub fn update_stats(env: &Env, amount: i128, sender: &Address, receiver: &Address) {
    // Update TVL
    let tvl: i128 = env.storage().instance().get(&V2_TVL).unwrap_or(0);
    env.storage().instance().set(&V2_TVL, &(tvl + amount));

    // Update User Count
    let mut user_count: u32 = env.storage().instance().get(&V2_USER_COUNT).unwrap_or(0);

    if !env
        .storage()
        .persistent()
        .has(&DataKeyV2::UserSeen(sender.clone()))
    {
        env.storage()
            .persistent()
            .set(&DataKeyV2::UserSeen(sender.clone()), &true);
        user_count += 1;
    }

    if !env
        .storage()
        .persistent()
        .has(&DataKeyV2::UserSeen(receiver.clone()))
    {
        env.storage()
            .persistent()
            .set(&DataKeyV2::UserSeen(receiver.clone()), &true);
        user_count += 1;
    }

    env.storage().instance().set(&V2_USER_COUNT, &user_count);
    bump_instance(env);
}

/// Retrieve all V2 summary metrics.
pub fn get_health(env: &Env) -> crate::types::ProtocolHealthV2 {
    crate::types::ProtocolHealthV2 {
        total_v2_tvl: env.storage().instance().get(&V2_TVL).unwrap_or(0),
        active_v2_users: env.storage().instance().get(&V2_USER_COUNT).unwrap_or(0),
        total_v2_streams: env.storage().instance().get(&STREAM_COUNT_V2).unwrap_or(0),
    }
}

// ----------------------------------------------------------------
// instance() helpers — Migration pause
// ----------------------------------------------------------------

/// Returns true if migration-only pause is active.
pub fn is_migration_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKeyV2::MigrationPaused)
        .unwrap_or(false)
}

/// Sets the migration-only paused state.
pub fn set_migration_paused(env: &Env, paused: bool) {
    env.storage()
        .instance()
        .set(&DataKeyV2::MigrationPaused, &paused);
    bump_instance(env);
}

// ----------------------------------------------------------------
// instance() helpers — Paused
// ----------------------------------------------------------------

/// Returns true if the contract is currently paused.
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKeyV2::Paused)
        .unwrap_or(false)
}

/// Sets the contract's paused state.
pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKeyV2::Paused, &paused);
    bump_instance(env);
}

// ----------------------------------------------------------------
// TTL
// ----------------------------------------------------------------

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
}

/// Extend persistent TTL for each stream ID in `ids`.
/// Skips IDs that no longer exist in storage.
/// Returns the count of streams whose TTL was extended.
pub fn bump_streams_ttl(env: &Env, ids: &soroban_sdk::Vec<u64>) -> u32 {
    let mut count: u32 = 0;
    for id in ids.iter() {
        let key = DataKeyV2::Stream(id);
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, STREAM_TTL_THRESHOLD, STREAM_TTL_BUMP);
            count += 1;
        }
    }
    count
}

// ----------------------------------------------------------------
// Dust threshold helpers
// ----------------------------------------------------------------

/// 10 XLM in stroops (1 XLM = 10_000_000 stroops).
pub const DEFAULT_MIN_VALUE: i128 = 100_000_000; // 10 XLM

/// Set a per-asset minimum stream amount. Admin-only enforcement is
/// done in the contract layer.
pub fn set_min_value(env: &Env, asset: &Address, min: i128) {
    env.storage()
        .instance()
        .set(&DataKeyV2::MinValue(asset.clone()), &min);
    bump_instance(env);
}

/// Return the minimum stream amount for `asset`, defaulting to 10 XLM.
pub fn get_min_value(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKeyV2::MinValue(asset.clone()))
        .unwrap_or(DEFAULT_MIN_VALUE)
}

// ----------------------------------------------------------------
// Time-locked operations
// ----------------------------------------------------------------

pub fn schedule_op(env: &Env, op: &crate::types::Operation, execution_time: u64) {
    env.storage()
        .instance()
        .set(&DataKeyV2::ScheduledOp(op.clone()), &execution_time);
    bump_instance(env);
}

pub fn get_scheduled_op_time(env: &Env, op: &crate::types::Operation) -> Option<u64> {
    env.storage()
        .instance()
        .get(&DataKeyV2::ScheduledOp(op.clone()))
}

pub fn clear_op(env: &Env, op: &crate::types::Operation) {
    env.storage()
        .instance()
        .remove(&DataKeyV2::ScheduledOp(op.clone()));
    bump_instance(env);
}

// ----------------------------------------------------------------
// Protocol fee helpers
// ----------------------------------------------------------------

/// Set the protocol treasury address. Admin-only enforcement is in lib.rs.
pub fn set_treasury(env: &Env, treasury: &Address) {
    env.storage().instance().set(&DataKeyV2::Treasury, treasury);
    bump_instance(env);
}

/// Return the treasury address, if configured.
pub fn get_treasury(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKeyV2::Treasury)
}

/// Set the protocol fee in basis points. Admin-only enforcement is in lib.rs.
pub fn set_fee_bps(env: &Env, bps: u32) {
    env.storage().instance().set(&DataKeyV2::FeeBps, &bps);
    bump_instance(env);
}

/// Return the current fee BPS (default 0 = no fee).
pub fn get_fee_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKeyV2::FeeBps)
        .unwrap_or(0)
}

/// Add `amount` to the pending fee balance for `(recipient, token)`.
pub fn add_pending_fees(env: &Env, recipient: &Address, token: &Address, amount: i128) {
    let key = DataKeyV2::PendingFees(recipient.clone(), token.clone());
    let current: i128 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(current + amount));
    bump_instance(env);
}

/// Return the accumulated pending fee balance for `(recipient, token)`.
pub fn get_pending_fees(env: &Env, recipient: &Address, token: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKeyV2::PendingFees(recipient.clone(), token.clone()))
        .unwrap_or(0)
}

/// Clear the pending fee balance for `(recipient, token)` after withdrawal.
pub fn clear_pending_fees(env: &Env, recipient: &Address, token: &Address) {
    env.storage()
        .instance()
        .remove(&DataKeyV2::PendingFees(recipient.clone(), token.clone()));
    bump_instance(env);
}

pub fn add_to_whitelist(env: &Env, asset: &Address) {
    env.storage()
        .instance()
        .set(&DataKeyV2::WhitelistedAsset(asset.clone()), &true);
    bump_instance(env);
}

pub fn remove_from_whitelist(env: &Env, asset: &Address) {
    env.storage()
        .instance()
        .remove(&DataKeyV2::WhitelistedAsset(asset.clone()));
    bump_instance(env);
}

pub fn is_asset_whitelisted(env: &Env, asset: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKeyV2::WhitelistedAsset(asset.clone()))
        .unwrap_or(false)
}
