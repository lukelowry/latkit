//! Places outside diagrams: where a vertex row without a position stands on a plane or the earth,
//! by the scene's layout. Rows whose data positions them pin the layout, and links are the edges
//! between them, so a row without coordinates stands among its neighbors; gaps are in the space's
//! units. As on a diagram's sheet, a place persists by row, layouts place only rows without one
//! until arranging lays every row without a position out again, and the layout is a host job. The
//! places are a table beside each vertex table: its rows' positions, given or laid out, which the
//! vertex marks read.

use rustc_hash::FxHashMap;

use super::{Derive, Input, Jobs, Tables, answers, beside, kept};
use crate::data::{Name, Row, Value, Values};
use crate::expr::cpu::Rows;
use crate::host::{Job, Key, Placement};
use crate::sheet::{key_of, links, marks, position};
use crate::{Layout, Pending};

#[derive(Default)]
pub(crate) struct Places {
    tables: Tables,
    /// Where layouts placed rows without positions, kept by row.
    laid: FxHashMap<Row, [f64; 2]>,
    /// What the tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so layouts asked before are dropped.
    generation: u64,
    /// Whether every row without a position is to be laid out again.
    arranging: bool,
    /// What the last arranging laid out, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    placing: Option<Placing>,
    /// Bumps whenever an answer lands.
    landed: u64,
}

/// A layout under way: the generation it was asked in, and the row each key it answers names.
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
        // A job its host does at once is taken before the frame draws.
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

    /// Forgets the tables but keeps the places: a scene with a layout again finds its rows where they
    /// stood.
    fn clear(&mut self) {
        self.tables.clear();
        self.stamp = 0;
    }
}

impl Places {
    /// Lays every row without a position out again.
    pub(crate) fn arrange(&mut self) {
        self.arranging = true;
        self.placing = None;
        self.generation += 1;
        self.stamp = 0;
    }

    /// What the last arranging laid out, once it landed: each row placed, and where.
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
                    // The plane and the earth run y up, as layouts do.
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

    /// Writes each vertex table's positions, asking the layout for the rows without one.
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
            // Nothing to lay out: the arranging is done as asked.
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
