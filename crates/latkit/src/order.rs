//! Stable sorts that share a few compiled sort functions.
//!
//! Each closure passed to a standard library sort compiles another copy of the sort. So keyed sorts
//! here build an array of keys, sort it with one of a few non-generic functions, and permute the
//! items to match. Keys sort ascending, and ties keep their input order.

/// Sorts 64-bit keys packed above their 32-bit source index. Every 64-bit keyed sort uses it.
#[inline(never)]
fn sort_narrow(keys: &mut [u128]) {
    keys.sort_unstable();
}

/// Sorts 128-bit keys paired with their source index.
#[inline(never)]
fn sort_wide(keys: &mut [(u128, u32)]) {
    keys.sort_unstable();
}

/// Sorts names paired with their source index.
#[inline(never)]
fn sort_names(keys: &mut [(&str, u32)]) {
    keys.sort_unstable();
}

/// Sorts `items` by `key`, ascending. Ties keep their input order.
pub(crate) fn by_key<T>(items: &mut [T], mut key: impl FnMut(&T) -> u64) {
    let mut keys: Vec<u128> =
        items.iter().zip(0u32..).map(|(item, i)| u128::from(key(item)) << 32 | u128::from(i)).collect();
    sort_narrow(&mut keys);
    permute(items, keys.into_iter().map(|k| k as u32 as usize).collect());
}

/// Sorts `items` by a 128-bit `key`, ascending. Ties keep their input order.
pub(crate) fn by_wide_key<T>(items: &mut [T], mut key: impl FnMut(&T) -> u128) {
    let mut keys: Vec<(u128, u32)> = items.iter().zip(0u32..).map(|(item, i)| (key(item), i)).collect();
    sort_wide(&mut keys);
    permute(items, keys.into_iter().map(|(_, i)| i as usize).collect());
}

/// Sorts `items` by `name`. Ties keep their input order.
pub(crate) fn by_name<T>(items: &mut [T], name: impl Fn(&T) -> &str) {
    let mut keys: Vec<(&str, u32)> = items.iter().zip(0u32..).map(|(item, i)| (name(item), i)).collect();
    sort_names(&mut keys);
    let from = keys.into_iter().map(|(_, i)| i as usize).collect();
    permute(items, from);
}

/// Sorts `values` by `f64::total_cmp`.
#[inline(never)]
pub(crate) fn numbers(values: &mut [f64]) {
    values.sort_unstable_by(f64::total_cmp);
}

/// Maps `x` to a key that orders as `f64::total_cmp` does.
pub(crate) fn number(x: f64) -> u64 {
    let bits = x.to_bits();
    if bits >> 63 == 1 { !bits } else { bits | 1 << 63 }
}

/// Maps `x` to a key that orders as `f32::total_cmp` does: the words `lib/reduce.wesl` reduces
/// values to.
#[cfg(feature = "gpu")]
pub(crate) fn number32(x: f32) -> u32 {
    let bits = x.to_bits();
    if bits >> 31 == 1 { !bits } else { bits | 1 << 31 }
}

/// The value whose key is `key`. The inverse of [`number32`].
#[cfg(feature = "gpu")]
pub(crate) fn from_number32(key: u32) -> f32 {
    f32::from_bits(if key >> 31 == 1 { key & !(1 << 31) } else { !key })
}

/// Packs two keys into one that orders by `high`, then `low`.
pub(crate) fn pair(high: u32, low: u32) -> u64 {
    u64::from(high) << 32 | u64::from(low)
}

/// Packs two keys into one that orders by `high`, then `low`.
pub(crate) fn wide(high: u64, low: u64) -> u128 {
    u128::from(high) << 64 | u128::from(low)
}

/// Reorders `items` in place so that item `k` becomes the item previously at `from[k]`.
fn permute<T>(items: &mut [T], mut from: Vec<usize>) {
    for k in 0..items.len() {
        let mut at = k;
        loop {
            let next = std::mem::replace(&mut from[at], at);
            if next == k {
                break;
            }
            items.swap(at, next);
            at = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{by_key, by_name, by_wide_key, number, wide};

    #[test]
    fn keys_order_as_the_standard_sorts_do() {
        let values = [3.5, -0.0, f64::NAN, 0.0, f64::NEG_INFINITY, -2.0, f64::INFINITY, 3.5, -f64::NAN];
        let mut ours: Vec<(usize, f64)> = values.iter().copied().enumerate().collect();
        by_key(&mut ours, |&(_, x)| number(x));
        let mut std: Vec<(usize, f64)> = values.iter().copied().enumerate().collect();
        std.sort_by(|a, b| a.1.total_cmp(&b.1));
        assert_eq!(ours.iter().map(|p| p.0).collect::<Vec<_>>(), std.iter().map(|p| p.0).collect::<Vec<_>>());
        let mut pairs = vec![(2, 1), (1, 9), (2, 0), (1, 9), (0, 5)];
        let mut expected = pairs.clone();
        expected.sort_by_key(|&(a, b)| (a, b));
        by_wide_key(&mut pairs, |&(a, b)| wide(a, b));
        assert_eq!(pairs, expected);
        let mut names = vec!["b", "a", "c", "a"];
        by_name(&mut names, |n| n);
        assert_eq!(names, ["a", "a", "b", "c"]);
    }

    #[cfg(feature = "gpu")]
    #[test]
    fn narrow_keys_order_like_their_values_and_invert() {
        use super::{from_number32, number32};
        let values = [-1e9_f32, -2.5, -0.0, 0.0, 1e-9, 3.0, 1e9];
        for pair in values.windows(2) {
            assert!(number32(pair[0]) <= number32(pair[1]), "{pair:?}");
        }
        for v in values {
            assert_eq!(from_number32(number32(v)), v);
        }
    }
}
