/// Fixed-point scalar with 7 decimal places of precision (SCALE = 10^7).
///
/// Internally stores values as `inner * SCALE`, so 1.0 is represented as
/// 10_000_000. This gives enough headroom for Stellar token amounts (which
/// use 7 decimal places) while keeping all arithmetic in i128.
use crate::contracterror::Error;

pub const SCALE: i128 = 10_000_000; // 10^7

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct FixedPoint(pub i128);

impl FixedPoint {
    /// Wrap a raw scaled value (already multiplied by SCALE).
    pub fn from_raw(raw: i128) -> Self {
        FixedPoint(raw)
    }

    /// Wrap a whole-number token amount (e.g. stroops).
    pub fn from_amount(amount: i128) -> Self {
        FixedPoint(amount * SCALE)
    }

    /// Return the floor integer value (truncates fractional part).
    pub fn to_amount(self) -> i128 {
        self.0 / SCALE
    }

    /// `(amount * numerator) / denominator` with full i128 intermediate
    /// precision and checked arithmetic throughout.
    ///
    /// Returns `Err(Error::Overflow)` on overflow or divide-by-zero.
    pub fn mul_div(amount: i128, numerator: i128, denominator: i128) -> Result<i128, Error> {
        if denominator == 0 {
            return Err(Error::Overflow);
        }
        // Scale up before dividing to preserve 7 decimal places of precision.
        let scaled = amount
            .checked_mul(numerator)
            .ok_or(Error::Overflow)?
            .checked_mul(SCALE)
            .ok_or(Error::Overflow)?;

        let result = scaled.checked_div(denominator).ok_or(Error::Overflow)?;

        // Return floor value (drop the SCALE factor).
        Ok(result / SCALE)
    }

    /// Checked addition.
    pub fn checked_add(self, rhs: FixedPoint) -> Result<FixedPoint, Error> {
        self.0
            .checked_add(rhs.0)
            .map(FixedPoint)
            .ok_or(Error::Overflow)
    }

    /// Checked subtraction.
    pub fn checked_sub(self, rhs: FixedPoint) -> Result<FixedPoint, Error> {
        self.0
            .checked_sub(rhs.0)
            .map(FixedPoint)
            .ok_or(Error::Overflow)
    }

    /// Checked multiplication of two FixedPoint values.
    /// Result is re-scaled: (a * b) / SCALE.
    pub fn checked_mul(self, rhs: FixedPoint) -> Result<FixedPoint, Error> {
        self.0
            .checked_mul(rhs.0)
            .map(|v| FixedPoint(v / SCALE))
            .ok_or(Error::Overflow)
    }

    /// Checked division of two FixedPoint values.
    /// Result is re-scaled: (a * SCALE) / b.
    pub fn checked_div(self, rhs: FixedPoint) -> Result<FixedPoint, Error> {
        if rhs.0 == 0 {
            return Err(Error::Overflow);
        }
        self.0
            .checked_mul(SCALE)
            .map(|v| FixedPoint(v / rhs.0))
            .ok_or(Error::Overflow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── mul_div ──────────────────────────────────────────────────────────────

    #[test]
    fn test_mul_div_exact() {
        assert_eq!(FixedPoint::mul_div(1000, 1, 2).unwrap(), 500);
    }

    #[test]
    fn test_mul_div_preserves_precision() {
        assert_eq!(FixedPoint::mul_div(10, 1, 3).unwrap(), 3);
        assert_eq!(FixedPoint::mul_div(100_000_000, 50, 100).unwrap(), 50_000_000);
    }

    #[test]
    fn test_mul_div_divide_by_zero() {
        assert_eq!(FixedPoint::mul_div(1000, 1, 0), Err(Error::Overflow));
    }

    #[test]
    fn test_mul_div_overflow() {
        assert_eq!(FixedPoint::mul_div(i128::MAX, 2, 1), Err(Error::Overflow));
    }

    // ── FixedPoint arithmetic ────────────────────────────────────────────────

    #[test]
    fn test_checked_add() {
        let a = FixedPoint::from_amount(3);
        let b = FixedPoint::from_amount(4);
        assert_eq!(a.checked_add(b).unwrap().to_amount(), 7);
    }

    #[test]
    fn test_checked_add_overflow() {
        let a = FixedPoint::from_raw(i128::MAX);
        let b = FixedPoint::from_raw(1);
        assert_eq!(a.checked_add(b), Err(Error::Overflow));
    }

    #[test]
    fn test_checked_sub() {
        let a = FixedPoint::from_amount(10);
        let b = FixedPoint::from_amount(3);
        assert_eq!(a.checked_sub(b).unwrap().to_amount(), 7);
    }

    #[test]
    fn test_checked_sub_underflow() {
        let a = FixedPoint::from_raw(i128::MIN);
        let b = FixedPoint::from_raw(1);
        assert_eq!(a.checked_sub(b), Err(Error::Overflow));
    }

    #[test]
    fn test_checked_mul() {
        let a = FixedPoint::from_amount(3);
        let b = FixedPoint::from_amount(4);
        assert_eq!(a.checked_mul(b).unwrap().to_amount(), 12);
    }

    #[test]
    fn test_checked_div() {
        let a = FixedPoint::from_amount(10);
        let b = FixedPoint::from_amount(4);
        // 10 / 4 = 2.5 → floor = 2
        assert_eq!(a.checked_div(b).unwrap().to_amount(), 2);
    }

    #[test]
    fn test_checked_div_by_zero() {
        let a = FixedPoint::from_amount(10);
        let b = FixedPoint::from_raw(0);
        assert_eq!(a.checked_div(b), Err(Error::Overflow));
    }
}
