//! Lanes: outside a diagram, each edge row's lane among the edges joining the same two vertices, so
//! they spread apart instead of drawing over each other. Derived again only when the table's rows or
//! ends change; a table whose edges share no ends derives nothing.

use rustc_hash::{FxHashMap, FxHashSet};

use super::{Derive, Input, Jobs, Tables, beside, kept, stamp_of};
use crate::Mark;
use crate::data::{Field, Name, Reference, Table, Values};

#[derive(Default)]
pub(crate) struct Lanes {
    tables: Tables,
    /// What each table's lanes were made from.
    stamps: FxHashMap<(Name, Name), u64>,
}

impl Derive for Lanes {
    fn update(&mut self, input: &Input<'_>, _: &mut Jobs<'_>) -> bool {
        let mut changed = false;
        let mut drawn: FxHashSet<(Name, Name)> = FxHashSet::default();
        for mark in &input.scene.marks {
            let Mark::Edges(edges) = mark else { continue };
            let Some((from, to)) = &edges.ends else { continue };
            let style = &edges.style;
            let Some(table) = input.data(&style.data).and_then(|d| d.table(&style.table)) else { continue };
            let key = (style.data.clone(), style.table.clone());
            let version = |name: &str| reference(table, name).map(|r| r.version);
            let stamp = stamp_of((table.structure, table.order, version(from), version(to)));
            drawn.insert(key.clone());
            if self.stamps.get(&key) == Some(&stamp) {
                continue;
            }
            self.stamps.insert(key.clone(), stamp);
            changed = true;
            let ends = reference(table, from).zip(reference(table, to));
            let lanes = ends
                .and_then(|(a, b)| spread(table.len(), |row| Some([a.target(row)? as usize, b.target(row)? as usize])));
            match lanes {
                Some(lanes) => {
                    let lane = kept("lane", &Values::from(lanes), table, self.tables.get(&key));
                    self.tables.insert(key, beside(table, [("lane".into(), lane)]));
                }
                None => {
                    self.tables.remove(&key);
                }
            }
        }
        let before = self.tables.len();
        self.tables.retain(|key, _| drawn.contains(key));
        self.stamps.retain(|key, _| drawn.contains(key));
        changed || self.tables.len() != before
    }

    fn busy(&self) -> bool {
        false
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    fn clear(&mut self) {
        self.tables.clear();
        self.stamps.clear();
    }
}

/// The reference field `name` of `table`.
fn reference<'t>(table: &'t Table, name: &str) -> Option<&'t Reference> {
    match table.field_named(name)? {
        Field::Reference(reference) => Some(reference),
        _ => None,
    }
}

/// Each of `rows` rows' lane among the rows joining the same two ends, which `ends` names: offsets
/// from the middle, signed so rows joining them either way spread apart. `None` when no two share
/// their ends.
pub(crate) fn spread(rows: usize, ends: impl Fn(usize) -> Option<[usize; 2]>) -> Option<Vec<f64>> {
    let mut pairs: FxHashMap<[usize; 2], Vec<usize>> = FxHashMap::default();
    for row in 0..rows {
        if let Some([a, b]) = ends(row) {
            pairs.entry([a.min(b), a.max(b)]).or_default().push(row);
        }
    }
    if pairs.values().all(|rows| rows.len() < 2) {
        return None;
    }
    let mut lanes = vec![0.0; rows];
    for rows in pairs.values().filter(|rows| rows.len() > 1) {
        let middle = (rows.len() - 1) as f64 / 2.0;
        for (k, &row) in rows.iter().enumerate() {
            let reversed = ends(row).is_some_and(|[a, b]| a > b);
            let lane = k as f64 - middle;
            lanes[row] = if reversed { -lane } else { lane };
        }
    }
    Some(lanes)
}
