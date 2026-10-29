//! Places of vertex rows without positions, outside diagrams.
//!
//! On a plane or the earth, the scene's layout places the vertex rows that have no position. Rows
//! with positions are pinned, and edges are the layout's links, so an unpositioned row ends up
//! among its neighbors. Gaps are in the space's units. As on a diagram's sheet, places persist by
//! row. The layout (a host job) places only rows without a place, until `arrange` lays out every
//! unpositioned row again. The result is a table beside each vertex table that holds its rows'
//! positions, given or laid out. The vertex marks read it.

use std::hash::Hash;

use rustc_hash::FxHashMap;

use super::graph::{key_of, links, marks, position};
use super::{Derive, Input, Jobs, Tables, Working, answers, beside, kept, stamp_of, stamp_with};
use crate::data::{Name, Row, Value, Values};
use crate::expr::cpu::Rows;
use crate::host::{Job, Key, Placement};
use crate::{Arrange, Layout};

#[derive(Default)]
pub(crate) struct Places {
    tables: Tables,
    /// The places layouts gave rows without positions, by row.
    laid: FxHashMap<Row, [f64; 2]>,
    /// The stamp the tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so answers to earlier layouts are dropped.
    generation: u64,
    /// Which rows are to be laid out again, if any.
    arranging: Option<Arrange>,
    /// The result of the last arrange, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    /// The layout job, for the stamp of the inputs it lays out.
    placing: Working<Placing>,
    /// Bumps whenever an answer arrives.
    landed: u64,
}

/// A layout job's context: the generation it was started in, and the row each answer key names.
struct Placing {
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

impl Derive for Places {
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        if matches!(input.scene.layout, Layout::None) {
            let had = !self.tables.is_empty();
            self.clear();
            if self.arranging.take().is_some() {
                self.arranged = Some(Vec::new());
            }
            return had;
        }
        let mut changed = false;
        // Repeat so a job the host finishes at once is taken before the frame draws.
        for _ in 0..4 {
            self.settle();
            let inputs = stamp_with(|hasher| {
                (input.scene_version, self.generation).hash(hasher);
                input.structure(hasher);
            });
            // An answer changes the tables, but not what a layout would be asked to place.
            let stamp = stamp_of((inputs, self.landed));
            if stamp == self.stamp {
                break;
            }
            self.stamp = stamp;
            self.build(input, inputs, jobs);
            changed = true;
        }
        changed
    }

    fn busy(&self) -> bool {
        self.placing.busy()
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    /// Drops the tables but keeps the places, so when the scene has a layout again, rows return to
    /// where they were.
    fn clear(&mut self) {
        self.tables.clear();
        self.stamp = 0;
    }
}

impl Places {
    /// Lays out the rows `rows` names again, dropping any pending layout.
    pub(crate) fn arrange(&mut self, rows: Arrange) {
        self.arranging = Some(rows);
        self.placing.cancel();
        self.generation += 1;
        self.stamp = 0;
    }

    /// Takes the result of the last `arrange` once it arrives: each row laid out and its position.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(Row, [f64; 2])>> {
        self.arranged.take()
    }

    fn settle(&mut self) {
        let Some((_, placing, answer)) = self.placing.landed() else { return };
        if placing.generation == self.generation {
            let mut placed = Vec::new();
            for (key, values) in answer.map(|bytes| answers(&bytes, &["x", "y"])).unwrap_or_default() {
                if let (Some(row), [Some(Value::Number(x)), Some(Value::Number(y))]) =
                    (placing.rows.get(&key), &values[..])
                {
                    // The plane and the earth are y up, like layouts.
                    self.laid.insert(row.clone(), [*x, *y]);
                    placed.push((row.clone(), [*x, *y]));
                }
            }
            if self.arranging.take().is_some() {
                self.arranged = Some(placed);
            }
        }
        self.landed += 1;
    }

    /// Writes each vertex table's positions, starting a layout job for rows without one unless a
    /// job for the same `inputs` already ran.
    fn build(&mut self, input: &Input<'_>, inputs: u64, jobs: &Jobs<'_>) {
        let (vertex_marks, edge_marks) = marks(input);
        let mut keys = Vec::new();
        let mut pins = Vec::new();
        for vm in &vertex_marks {
            let rows = Rows::new(vm.table, input.data);
            for row in 0..vm.table.len() {
                let id = vm.table.ids.id(row).expect("every row has an id");
                keys.push(Row { data: vm.data.name().clone(), table: vm.table.name().clone(), id });
                pins.push(position(vm.mark, &rows, row));
            }
        }
        let (arranging, all) = (self.arranging.is_some(), self.arranging == Some(Arrange::All));
        let pin = |i: usize| pins[i].filter(|_| !all);
        let wanted = |i: usize| pin(i).is_none() && (arranging || !self.laid.contains_key(&keys[i]));
        if self.placing.may_start(inputs) && (0..keys.len()).any(wanted) {
            let pinned: Vec<Option<[f64; 2]>> = (0..keys.len())
                .map(|i| pin(i).or_else(|| (!arranging).then(|| self.laid.get(&keys[i]).copied()).flatten()))
                .collect();
            let mut rows = FxHashMap::default();
            let job_keys: Vec<Option<Key>> = (0..keys.len())
                .map(|i| {
                    let key = key_of(&keys[i]);
                    (wanted(i) && rows.insert(key.clone(), keys[i].clone()).is_none()).then_some(key)
                })
                .collect();
            let (sizes, groups, pads) =
                (vec![[0.0; 2]; keys.len()], vec![None; keys.len()], vec![[0.0; 4]; keys.len()]);
            let links = links(&vertex_marks, &edge_marks);
            let placement = Placement {
                sizes: &sizes,
                pinned: &pinned,
                groups: &groups,
                pads: &pads,
                links: &links,
                keys: &job_keys,
            };
            let pending = jobs.spawn(Job::layout(&input.scene.layout, &placement));
            self.placing.start(inputs, pending, Placing { generation: self.generation, rows });
        } else if arranging && !self.placing.busy() {
            // Nothing to lay out: the arrange finishes with no rows.
            self.arranging = None;
            self.arranged = Some(Vec::new());
        }
        let mut tables = Tables::default();
        let mut at = 0;
        for vm in &vertex_marks {
            let own = at..at + vm.table.len();
            at = own.end;
            let place = |i: usize| pins[i].or_else(|| self.laid.get(&keys[i]).copied());
            let column = |k: usize| Values::from(own.clone().map(|i| place(i).map(|p| p[k])).collect::<Vec<_>>());
            let key: (Name, Name) = (vm.data.name().clone(), vm.table.name().clone());
            let before = self.tables.get(&key);
            let fields = [("x", column(0)), ("y", column(1))]
                .map(|(name, values)| (Name::from(name), kept(name, &values, vm.table, before)));
            tables.insert(key, beside(vm.table, fields));
        }
        self.tables = tables;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::task::Waker;

    use super::*;
    use crate::derive::testing::Failing;
    use crate::gpu::work::Counters;
    use crate::{Data, Ids, Plane, Scene, Stress, Table, Vertices};

    #[test]
    fn a_failed_layout_runs_once_until_its_inputs_change() {
        let data = Data::new("g");
        data.apply(Table::new("V", Ids::count(3))).expect("valid");
        let data = data.snapshot();
        let scene = Scene::new(Plane::default()).layout(Stress::default()).draw(Vertices::of("g", "V"));
        let (host, counters, errors) = (Failing::default(), Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut places = Places::default();
        let frame = |places: &mut Places| {
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(&data),
                host: Some(&host),
                dragging: false,
                paged: None,
            };
            places.update(&input, &mut Jobs::new(Some(&host), Waker::noop(), &counters, &errors, u32::MAX));
        };
        for _ in 0..5 {
            frame(&mut places);
        }
        assert_eq!(host.jobs(), 1, "one job for these inputs, not one per frame");
        assert_eq!(errors.lock().expect("unpoisoned").len(), 1, "its failure is reported once");
        places.arrange(Arrange::Unplaced);
        frame(&mut places);
        assert_eq!(host.jobs(), 2, "laying out again asks again");
    }
}
