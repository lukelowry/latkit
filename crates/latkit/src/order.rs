//! The sorts latkit compiles. Each sort by a closure compiles the standard library's sort anew, so
//! every keyed sort ends in one of a few sorts of keys: items ordered by a key, least first, ties in
//! the order they came.

/// Sorts keys packed with the index they came from: the one sort of 64-bit keys.
#[inline(never)]
fn sort_narrow(keys: &mut [u128]) {
    keys.sort_unstable();
}

/// Sorts 128-bit keys with the index they came from.
#[inline(never)]
fn sort_wide(keys: &mut [(u128, u32)]) {
    keys.sort_unstable();
}

/// Sorts names with the index they came from.
#[inline(never)]
fn sort_names(keys: &mut [(&str, u32)]) {
    keys.sort_unstable();
}

/// `items` ordered by `key`, least first, ties in the order they came.
pub(crate) fn by_key<T>(items: &mut [T], mut key: impl FnMut(&T) -> u64) {
    let mut keys: Vec<u128> =
        items.iter().zip(0u32..).map(|(item, i)| u128::from(key(item)) << 32 | u128::from(i)).collect();
    sort_narrow(&mut keys);
    permute(items, keys.into_iter().map(|k| k as u32 as usize).collect());
}

/// `items` ordered by a 128-bit `key`, least first, ties in the order they came.
pub(crate) fn by_wide_key<T>(items: &mut [T], mut key: impl FnMut(&T) -> u128) {
    let mut keys: Vec<(u128, u32)> = items.iter().zip(0u32..).map(|(item, i)| (key(item), i)).collect();
    sort_wide(&mut keys);
    permute(items, keys.into_iter().map(|(_, i)| i as usize).collect());
}

/// `items` ordered by `name`, ties in the order they came.
pub(crate) fn by_name<T>(items: &mut [T], name: impl Fn(&T) -> &str) {
    let mut keys: Vec<(&str, u32)> = items.iter().zip(0u32..).map(|(item, i)| (name(item), i)).collect();
    sort_names(&mut keys);
    let from = keys.into_iter().map(|(_, i)| i as usize).collect();
    permute(items, from);
}

/// `values` ordered as `f64::total_cmp` orders them.
#[inline(never)]
pub(crate) fn numbers(values: &mut [f64]) {
    values.sort_unstable_by(f64::total_cmp);
}

/// A number as a key ordering as `f64::total_cmp` does.
pub(crate) fn number(x: f64) -> u64 {
    let bits = x.to_bits();
    if bits >> 63 == 1 { !bits } else { bits | 1 << 63 }
}

/// Two keys as one, `high` first.
pub(crate) fn pair(high: u32, low: u32) -> u64 {
    u64::from(high) << 32 | u64::from(low)
}

/// Two keys as one, `high` first.
pub(crate) fn wide(high: u64, low: u64) -> u128 {
    u128::from(high) << 64 | u128::from(low)
}

/// Moves `items` into the order `from` lists: item `k` becomes what was at `from[k]`.
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
}
