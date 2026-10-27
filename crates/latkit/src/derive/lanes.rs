//! Lanes of parallel edges, outside diagrams.
//!
//! Edges joining the same two vertices form a family. Each edge row gets a lane within its family,
//! so the strokes bow apart instead of drawing over each other. Lanes depend only on the table's
//! endpoints, and strokes bow in world space, so lanes never change as the camera moves.
//!
//! A row's lane and its family size share one 32-bit word: twice the lane plus `HALF` in the high
//! 16 bits, the family size in the low 16. Lanes are recomputed only when the table's rows or
//! endpoints change: on the frame when that fits the budget, else in a job. A table whose edges
//! share no endpoints gets no lane field.

use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use super::{Derive, Derived, Input, Jobs, Tables, beside, kept, stamp_of};
use crate::Mark;
use crate::Pending;
use crate::data::{Field, Keyed, Name, Reference, Table, UNWIRED, Values};
use crate::host::Job;

/// Estimated microseconds to compute one row's lane.
const LANE_COST: f64 = 0.06;
/// The offset added to twice the lane, so the high half of a lane word is never negative.
const HALF: u32 = 1 << 15;
/// The largest family size a lane word stores; larger families store this.
const MOST: u32 = (1 << 16) - 1;

/// The stamp a table's lanes were made from, and any pending job.
type Made = Derived<(), Pending<Vec<u8>>>;

#[derive(Default)]
pub(crate) struct Lanes {
    tables: Tables,
    /// Each table's lane state: made, or pending in a job.
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

/// Writes `lanes`, one lane word per row, as field `lane` of the table beside `table`. Drops that
/// table when there are no lanes or their count differs from the rows. Returns whether it wrote or
/// dropped a table.
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

/// The lane words in a lanes job's answer, each a little-endian `u32`. `None` for an empty answer,
/// which means no rows share endpoints.
fn answered(bytes: &[u8]) -> Option<Vec<u32>> {
    (!bytes.is_empty()).then(|| crate::wire::words(bytes))
}

/// Each row's lane word, as shaders read it, from the rows' endpoints: twice the lane plus `HALF`
/// in the high 16 bits, the family size (at most `MOST`) in the low 16. `None` when no two rows
/// share endpoints.
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

/// Each row's lane among the rows joining the same two vertices, and the size of that family, from
/// the rows' endpoints ([`UNWIRED`] where a reference is unset). A lane is an offset from the
/// family's middle, negated for rows running the other way, so every row of a family bows apart.
/// A row with no parallel rows (including unset rows and self-loops) gets lane 0 in a family of 1.
/// `None` when no two rows share endpoints. It counts each pair in one map, then assigns lanes only
/// to shared pairs, so it allocates nothing per pair.
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

/// Each of `rows` rows' lane among the rows joining the same two vertices, where `ends` gives each
/// row's endpoints. The sheet spreads straight wires by lane. `None` if no rows share endpoints.
pub(crate) fn spread(rows: usize, ends: impl Fn(usize) -> Option<[usize; 2]>) -> Option<Vec<f64>> {
    let (from, to): (Vec<u32>, Vec<u32>) =
        (0..rows).map(|r| ends(r).map_or((UNWIRED, UNWIRED), |[a, b]| (a as u32, b as u32))).unzip();
    lanes(&from, &to).map(|lanes| lanes.into_iter().map(|(lane, _)| f64::from(lane)).collect())
}

#[cfg(test)]
mod tests {
    use super::{HALF, UNWIRED, lanes, words};

    #[test]
    fn edges_joining_the_same_vertices_bow_apart_in_either_direction() {
        // Rows 0, 1, and 3 join vertices 1 and 2, row 3 the other way; row 2 is alone.
        let lanes = lanes(&[1, 1, 4, 2, UNWIRED], &[2, 2, 5, 1, 0]).expect("rows share endpoints");
        assert_eq!(lanes, vec![(-1.0, 3), (0.0, 3), (0.0, 1), (-1.0, 3), (0.0, 1)]);
    }

    #[test]
    fn a_lane_word_holds_twice_the_lane_and_the_family_size() {
        let words = words(&[1, 1], &[2, 2]).expect("rows share endpoints");
        assert_eq!(words, vec![(HALF - 1) << 16 | 2, (HALF + 1) << 16 | 2], "lanes -0.5 and 0.5 in a family of two");
    }

    #[test]
    fn rows_sharing_no_endpoints_get_no_lanes() {
        assert_eq!(lanes(&[0, 1, 2], &[1, 2, 0]), None);
    }
}
