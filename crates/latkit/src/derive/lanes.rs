//! Lanes: outside a diagram, each edge row's lane among the edges joining the same two vertices, its
//! family, so they bow apart instead of drawing over each other. A lane is data, made from the table's
//! ends alone: the stroke bows in world space by its lane, so it never moves as the camera does. A row's
//! lane and its family's size share one word: twice its lane, offset by `HALF`, above, and the size
//! below. Derived again only when the table's rows or ends change: on the frame while that fits its
//! budget, else in a job; a table whose edges share no ends derives nothing.

use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use super::{Derive, Derived, Input, Jobs, Tables, beside, kept, stamp_of};
use crate::Mark;
use crate::Pending;
use crate::data::{Field, Keyed, Name, Reference, Table, UNWIRED, Values};
use crate::host::Job;

/// Microseconds a row takes to find its lane, by estimate.
const LANE_COST: f64 = 0.06;
/// What a lane word adds to twice the lane, so it is never negative; and the most a family's size
/// says, past which it says this.
const HALF: u32 = 1 << 15;
const MOST: u32 = (1 << 16) - 1;

/// What a table's lanes were made from, and a job under way.
type Made = Derived<(), Pending<Vec<u8>>>;

#[derive(Default)]
pub(crate) struct Lanes {
    tables: Tables,
    /// Each table's lanes, made or making.
    made: Keyed<(Name, Name), Made>,
}

impl Derive for Lanes {
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        let mut changed = false;
        let mut drawn: FxHashSet<(Name, Name)> = FxHashSet::default();
        for mark in &input.scene.marks {
            let Mark::Edges(edges) = mark else { continue };
            let Some((from, to)) = &edges.ends else { continue };
            let style = &edges.style;
            let Some(table) = input.data(&style.data).and_then(|d| d.table(&style.table)) else { continue };
            let (Some(a), Some(b)) = (reference(table, from), reference(table, to)) else { continue };
            let key = (style.data.clone(), style.table.clone());
            if !drawn.insert(key.clone()) {
                continue;
            }
            let stamp = stamp_of((table.structure, table.order, a.version, b.version));
            let made = self.made.entry(key.clone()).or_default();
            if let Some((landed, bytes)) = made.landed()
                && landed == stamp
            {
                made.make(stamp, ());
                changed |= keep(&mut self.tables, key.clone(), table, answered(&bytes));
                continue;
            }
            if !made.due(stamp) {
                continue;
            }
            let rows = table.len();
            if jobs.fits((rows as f64 * LANE_COST) as u64) {
                made.make(stamp, ());
                changed |= keep(&mut self.tables, key, table, words(&a.targets(), &b.targets()));
            } else {
                made.start(stamp, jobs.spawn(Job::lanes(&a.targets(), &b.targets())));
            }
        }
        let before = self.tables.len();
        self.tables.retain(|key, _| drawn.contains(key));
        self.made.retain(|key, _| drawn.contains(key));
        changed || self.tables.len() != before
    }

    fn busy(&self) -> bool {
        self.made.values().any(Derived::busy)
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    fn clear(&mut self) {
        self.tables.clear();
        self.made.clear();
    }
}

/// Keeps `lanes`, a lane word each row, beside `table` as its field `lane`, or drops its lanes when
/// there are none; whether anything changed.
fn keep(tables: &mut Tables, key: (Name, Name), table: &Table, lanes: Option<Vec<u32>>) -> bool {
    match lanes.filter(|l| l.len() == table.len()) {
        Some(lanes) => {
            let words: Vec<f64> = lanes.into_iter().map(f64::from).collect();
            let lane = kept("lane", &Values::from(words), table, tables.get(&key));
            tables.insert(key, beside(table, [("lane".into(), lane)]));
            true
        }
        None => tables.remove(&key).is_some(),
    }
}

/// The reference field `name` of `table`.
fn reference<'t>(table: &'t Table, name: &str) -> Option<&'t Reference> {
    match table.field_named(name)? {
        Field::Reference(reference) => Some(reference),
        _ => None,
    }
}

/// The lane words a lanes job answered, a little-endian `u32` each; none where it answered nothing.
fn answered(bytes: &[u8]) -> Option<Vec<u32>> {
    (!bytes.is_empty()).then(|| bytes.as_chunks::<4>().0.iter().map(|&w| u32::from_le_bytes(w)).collect())
}

/// Each row's lane word, as shaders read it, from the rows' two ends: twice its lane offset by `HALF`
/// above, its family's size below. `None` when no two rows share their ends.
pub(crate) fn words(from: &[u32], to: &[u32]) -> Option<Vec<u32>> {
    let lanes = lanes(from, to)?;
    Some(
        lanes
            .into_iter()
            .map(|(lane, size)| {
                let twice = (2.0 * lane).clamp(-f32::from(HALF as u16 - 1), f32::from(HALF as u16 - 1)) as i32;
                ((twice + HALF as i32) as u32) << 16 | size.min(MOST)
            })
            .collect(),
    )
}

/// Each row's lane among the rows joining the same two vertices, from the rows' two ends
/// ([`UNWIRED`] where a reference names no row): offsets from the middle, signed so rows joining them
/// either way bow apart, with how many rows join them. `None` when no two rows share their ends.
/// Counts each pair once, then hands out lanes only to the pairs shared, so it allocates nothing per
/// pair.
pub(crate) fn lanes(from: &[u32], to: &[u32]) -> Option<Vec<(f32, u32)>> {
    let key = |r: usize| {
        let (a, b) = (from[r], to[r]);
        (a != UNWIRED && b != UNWIRED && a != b).then(|| u64::from(a.min(b)) << 32 | u64::from(a.max(b)))
    };
    let rows = from.len().min(to.len());
    let mut counts: FxHashMap<u64, u32> = FxHashMap::with_capacity_and_hasher(rows, FxBuildHasher);
    let mut shared = false;
    for r in 0..rows {
        if let Some(k) = key(r) {
            let n = counts.entry(k).or_insert(0);
            *n += 1;
            shared |= *n > 1;
        }
    }
    if !shared {
        return None;
    }
    counts.retain(|_, n| *n > 1);
    let mut taken: FxHashMap<u64, u32> = FxHashMap::with_capacity_and_hasher(counts.len(), FxBuildHasher);
    Some(
        (0..rows)
            .map(|r| {
                let Some((k, &n)) = key(r).and_then(|k| Some((k, counts.get(&k)?))) else { return (0.0, 1) };
                let next = taken.entry(k).or_insert(0);
                let lane = *next as f32 - (n - 1) as f32 / 2.0;
                *next += 1;
                (if from[r] > to[r] { -lane } else { lane }, n)
            })
            .collect(),
    )
}

/// Each of `rows` rows' lane among the rows joining the same two ends, which `ends` names: the
/// sheet's straight wires spread by it. `None` when no two share their ends.
pub(crate) fn spread(rows: usize, ends: impl Fn(usize) -> Option<[usize; 2]>) -> Option<Vec<f64>> {
    let (from, to): (Vec<u32>, Vec<u32>) =
        (0..rows).map(|r| ends(r).map_or((UNWIRED, UNWIRED), |[a, b]| (a as u32, b as u32))).unzip();
    lanes(&from, &to).map(|lanes| lanes.into_iter().map(|(lane, _)| f64::from(lane)).collect())
}

#[cfg(test)]
mod tests {
    use super::{HALF, UNWIRED, lanes, words};

    #[test]
    fn rows_joining_the_same_ends_bow_apart_either_way() {
        // Rows 0, 1, and 3 join vertices 1 and 2, row 3 the other way; row 2 is alone.
        let lanes = lanes(&[1, 1, 4, 2, UNWIRED], &[2, 2, 5, 1, 0]).expect("shared ends");
        assert_eq!(lanes, vec![(-1.0, 3), (0.0, 3), (0.0, 1), (-1.0, 3), (0.0, 1)]);
    }

    #[test]
    fn a_lane_word_holds_twice_the_lane_and_the_family() {
        let words = words(&[1, 1], &[2, 2]).expect("shared ends");
        assert_eq!(words, vec![(HALF - 1) << 16 | 2, (HALF + 1) << 16 | 2], "lanes of half either side, of two");
    }

    #[test]
    fn tables_sharing_no_ends_have_no_lanes() {
        assert_eq!(lanes(&[0, 1, 2], &[1, 2, 0]), None);
    }
}
