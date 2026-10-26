//! The kept-row table: a drawing's kept rows, keyed by their place in its order.
//!
//! It is an open-addressed hash table with linear probing. Each bucket holds a place and its held
//! row, `[NONE, NONE]` when empty. A new table is built three fifths full, with at least `LEAST`
//! buckets and any count above that, not just powers of two. Updating from a previous table
//! removes the rows that left and inserts those that came, as long as it stays between three
//! tenths and four fifths full. Only their buckets, and the few after a removed row that shift
//! back, change, so the end table's words change only where rows did. Past those bounds the table
//! is rebuilt, slightly larger or smaller, never larger than needed. A lookup ends within a few
//! buckets, on the GPU (`lib/ends.wesl`) as here.

use std::sync::Arc;

use crate::gpu::shaders as wgsl;

/// The fewest buckets a table has once it has any.
const LEAST: usize = 64;
const EMPTY: [u32; 2] = [wgsl::NONE, wgsl::NONE];

/// A drawing's kept rows: buckets of `[place, held row]`, as the module docs describe.
#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct KeptTable(Arc<[[u32; 2]]>);

impl KeptTable {
    /// The table of `rows`, each `[place, held row]`, updated from `before`. If `before`'s size
    /// suits `rows`, its buckets are reused with places `gone` removed and rows `came` inserted;
    /// otherwise the table is rebuilt.
    pub(crate) fn laid(before: &KeptTable, rows: &[[u32; 2]], gone: &[u32], came: &[[u32; 2]]) -> KeptTable {
        let buckets = before.0.len();
        // A table of the fewest buckets is updated in place however few rows it keeps.
        if buckets > 0 && rows.len() * 5 <= buckets * 4 && (rows.len() * 10 >= buckets * 3 || buckets == LEAST) {
            let mut table = before.0.to_vec();
            for &d in gone {
                remove(&mut table, d);
            }
            for &row in came {
                insert(&mut table, row);
            }
            return KeptTable(table.into());
        }
        if rows.is_empty() {
            return KeptTable::default();
        }
        let mut table = vec![EMPTY; (rows.len() * 5).div_ceil(3).max(LEAST)];
        for &row in rows {
            insert(&mut table, row);
        }
        KeptTable(table.into())
    }

    /// The held row of place `d`, if kept.
    pub(crate) fn held(&self, d: u32) -> Option<u32> {
        if self.0.is_empty() {
            return None;
        }
        let mut b = home(d, self.0.len());
        loop {
            match self.0[b] {
                [place, held] if place == d => return Some(held),
                [wgsl::NONE, _] => return None,
                _ => b = next(b, self.0.len()),
            }
        }
    }

    /// Its buckets, as the end table packs them.
    pub(crate) fn buckets(&self) -> &[[u32; 2]] {
        &self.0
    }
}

/// The bucket, of `buckets`, where a probe for place `d` starts: a hash of `d`'s bits. Must match
/// `home` in `lib/ends.wesl`.
fn home(d: u32, buckets: usize) -> usize {
    let mut h = d ^ (d >> 16);
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    (h ^ (h >> 16)) as usize % buckets
}

/// The bucket after `b`, wrapping to 0.
fn next(b: usize, buckets: usize) -> usize {
    if b + 1 == buckets { 0 } else { b + 1 }
}

/// Puts `row` in the first empty bucket from where its place's probe starts.
fn insert(table: &mut [[u32; 2]], row: [u32; 2]) {
    let mut b = home(row[0], table.len());
    while table[b][0] != wgsl::NONE {
        b = next(b, table.len());
    }
    table[b] = row;
}

/// Removes place `d`, shifting back each later row whose probe passed its bucket, so every probe
/// still ends at the first empty bucket.
fn remove(table: &mut [[u32; 2]], d: u32) {
    let mut hole = home(d, table.len());
    while table[hole][0] != d {
        if table[hole][0] == wgsl::NONE {
            return;
        }
        hole = next(hole, table.len());
    }
    let mut b = hole;
    loop {
        b = next(b, table.len());
        let [place, _] = table[b];
        if place == wgsl::NONE {
            break;
        }
        // A row whose probe starts after the hole and at or before its own bucket stays: its probe
        // never passed the hole.
        let home = home(place, table.len());
        let stays = if hole <= b { hole < home && home <= b } else { hole < home || home <= b };
        if !stays {
            table[hole] = table[b];
            hole = b;
        }
    }
    table[hole] = EMPTY;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// The next pseudo-random number below `n`, advancing `seed`.
    fn random(seed: &mut u64, n: u32) -> u32 {
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((*seed >> 33) % u64::from(n)) as u32
    }

    #[test]
    fn a_table_holds_every_kept_row_and_no_other() {
        let mut seed = 7;
        let mut kept: BTreeMap<u32, u32> = BTreeMap::new();
        let mut table = KeptTable::default();
        for round in 0..200 {
            // Each round, places come or go, each at most once.
            let (mut gone, mut came) = (Vec::new(), Vec::new());
            for _ in 0..random(&mut seed, 40) {
                let d = random(&mut seed, 5_000);
                if gone.contains(&d) || came.iter().any(|row: &[u32; 2]| row[0] == d) {
                    continue;
                }
                if kept.remove(&d).is_some() {
                    gone.push(d);
                } else {
                    kept.insert(d, round);
                    came.push([d, round]);
                }
            }
            let rows: Vec<[u32; 2]> = kept.iter().map(|(&d, &held)| [d, held]).collect();
            table = KeptTable::laid(&table, &rows, &gone, &came);
            let buckets = table.buckets().len();
            assert!(buckets == 0 || kept.len() * 5 <= buckets * 4, "at most four fifths full");
            for d in 0..5_000 {
                assert_eq!(table.held(d), kept.get(&d).copied(), "place {d} after round {round}");
            }
        }
    }

    #[test]
    fn rows_coming_and_going_change_only_nearby_buckets() {
        let rows: Vec<[u32; 2]> = (0..1_000).map(|d| [d * 7, d]).collect();
        let table = KeptTable::laid(&KeptTable::default(), &rows, &[], &[]);
        let gone: Vec<u32> = (0..10).map(|d| d * 70).collect();
        let came: Vec<[u32; 2]> = (0..10).map(|d| [100_000 + d, d]).collect();
        let now: Vec<[u32; 2]> =
            rows.iter().filter(|r| !gone.contains(&r[0])).copied().chain(came.iter().copied()).collect();
        let next = KeptTable::laid(&table, &now, &gone, &came);
        assert_eq!(next.buckets().len(), table.buckets().len(), "updated in place");
        let changed = table.buckets().iter().zip(next.buckets()).filter(|(a, b)| a != b).count();
        assert!(changed <= 60, "{changed} buckets changed for 20 rows that came or went");
    }

    #[test]
    fn a_table_is_rebuilt_past_four_fifths_full_and_under_three_tenths() {
        let rows = |n: u32| (0..n).map(|d| [d, d]).collect::<Vec<_>>();
        let small = KeptTable::laid(&KeptTable::default(), &rows(10), &[], &[]);
        assert_eq!(small.buckets().len(), LEAST, "few rows get the fewest buckets");
        let full = KeptTable::laid(&small, &rows(100), &[], &(10..100).map(|d| [d, d]).collect::<Vec<_>>());
        assert_eq!(full.buckets().len(), 167, "past four fifths of 64, rebuilt three fifths full");
        let more = KeptTable::laid(&full, &rows(130), &[], &(100..130).map(|d| [d, d]).collect::<Vec<_>>());
        assert_eq!(more.buckets().len(), 167, "up to four fifths full, updated in place");
        let gone: Vec<u32> = (51..130).collect();
        assert_eq!(KeptTable::laid(&more, &rows(51), &gone, &[]).buckets().len(), 167, "three tenths, in place");
        let gone: Vec<u32> = (20..130).collect();
        assert_eq!(KeptTable::laid(&more, &rows(20), &gone, &[]).buckets().len(), LEAST, "under three tenths, rebuilt");
        let gone: Vec<u32> = (0..130).collect();
        assert_eq!(KeptTable::laid(&more, &[], &gone, &[]), KeptTable::default(), "no rows, no buckets");
    }
}
