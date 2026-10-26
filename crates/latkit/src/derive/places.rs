//! Places of vertex rows without positions, outside diagrams.
//!
//! On a plane or the earth, the scene's layout places the vertex rows that have no position. Rows
//! with positions are pinned, and edges are the layout's links, so an unpositioned row ends up
//! among its neighbors. Gaps are in the space's units. As on a diagram's sheet, places persist by
//! row, and the layout (a host job) places only rows without a place until `arrange` lays out
//! every unpositioned row again. The result is a table beside each vertex table, holding its rows'
//! positions, given or laid out, which the vertex marks read.

use rustc_hash::FxHashMap;

use super::graph::{key_of, links, marks, position};
use super::{Derive, Input, Jobs, Tables, answers, beside, kept};
use crate::data::{Name, Row, Value, Values};
use crate::expr::cpu::Rows;
use crate::host::{Job, Key, Placement};
use crate::{Layout, Pending};

#[derive(Default)]
pub(crate) struct Places {
    tables: Tables,
    /// The places layouts gave rows without positions, by row.
    laid: FxHashMap<Row, [f64; 2]>,
    /// The stamp the tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so answers to earlier layouts are dropped.
    generation: u64,
    /// Whether every row without a position is to be laid out again.
    arranging: bool,
    /// The result of the last arrange, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    placing: Option<Placing>,
    /// Bumps whenever an answer arrives.
    landed: u64,
}

/// A pending layout job: the generation it was started in, and the row each answer key names.
struct Placing {
    pending: Pending<Vec<u8>>,
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

impl Derive for Places {
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        if matches!(input.scene.layout, Layout::None) {
            let had = !self.tables.is_empty();
            self.clear();
            if self.arranging {
                self.arranging = false;
                self.arranged = Some(Vec::new());
            }
            return had;
        }
        let mut changed = false;
        // Repeat so a job the host finishes at once is taken before the frame draws.
        for _ in 0..4 {
            self.settle();
            let mut hasher = rustc_hash::FxHasher::default();
            std::hash::Hash::hash(&(input.scene_version, self.landed, self.generation), &mut hasher);
            input.structure(&mut hasher);
            let stamp = std::hash::Hasher::finish(&hasher).max(1);
            if stamp == self.stamp {
                break;
            }
            self.stamp = stamp;
            self.build(input, jobs);
            changed = true;
        }
        changed
    }

    fn busy(&self) -> bool {
        self.placing.is_some()
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
    /// Lays out every row without a position again, dropping any pending layout.
    pub(crate) fn arrange(&mut self) {
        self.arranging = true;
        self.placing = None;
        self.generation += 1;
        self.stamp = 0;
    }

    /// Takes the result of the last `arrange` once it arrives: each row laid out and its position.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(Row, [f64; 2])>> {
        self.arranged.take()
    }

    fn settle(&mut self) {
        let Some(answer) = self.placing.as_ref().and_then(|p| p.pending.take()) else { return };
        let placing = self.placing.take().expect("a layout under way");
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
            if std::mem::take(&mut self.arranging) {
                self.arranged = Some(placed);
            }
        }
        self.landed += 1;
    }

    /// Writes each vertex table's positions, starting a layout job for rows without one.
    fn build(&mut self, input: &Input<'_>, jobs: &Jobs<'_>) {
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
        let arranging = self.arranging;
        let wanted = |i: usize| pins[i].is_none() && (arranging || !self.laid.contains_key(&keys[i]));
        if self.placing.is_none() && (0..keys.len()).any(wanted) {
            let pinned: Vec<Option<[f64; 2]>> = (0..keys.len())
                .map(|i| pins[i].or_else(|| (!arranging).then(|| self.laid.get(&keys[i]).copied()).flatten()))
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
            self.placing = Some(Placing { pending, generation: self.generation, rows });
        } else if self.arranging && self.placing.is_none() {
            // Nothing to lay out: the arrange finishes with no rows.
            self.arranging = false;
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
