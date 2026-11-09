//! Places of vertex rows without positions.
//!
//! On a plane or the earth, the scene's layout places the vertex rows whose data gives no
//! position. Rows with positions are pinned, and edges and nets are the layout's links, so a row
//! without one ends up among its neighbors. Gaps are in position units. Places persist by row:
//! adding a row moves nothing else, and a row that loses its position takes the place the layout
//! last gave it, or gets one. The layout places only rows without a place, until `arrange` lays
//! out rows again. It runs on the frame when it fits the frame's budget, and as a host job
//! otherwise.
//!
//! The result is a table beside each vertex table holding the place the layout gave each row, or
//! nothing. A vertex mark draws a row at its data's position, and at this place only where the
//! data gives none. So editing positions, as a drag does every frame, changes no place: the
//! derivation checks only the rows the edit wrote, for a lost position.

use std::hash::Hash;

use rustc_hash::FxHashMap;

use super::graph::{EdgeMark, VertexMark, key_of, links, marks, position};
use super::{Derive, Input, Jobs, Tables, Working, answers, beside, kept, stamp_with};
use crate::data::{Field, Id, Name, Row, Value, Values, Version};
use crate::expr::cpu::Rows;
use crate::host::{Job, Key, Placement};
use crate::{Arrange, Layout};

#[derive(Default)]
pub(crate) struct Places {
    tables: Tables,
    /// The places layouts gave rows, by dataset and table, then row id. Kept after a row is
    /// removed, so undo puts it back where it was.
    laid: FxHashMap<(Name, Name), Laid>,
    /// Each vertex table's rows whose data gives no position, as last checked.
    unplaced: FxHashMap<(Name, Name), Unplaced>,
    /// Bumps whenever a row gains or loses its data position.
    checked: u64,
    /// The inputs the layout last considered placing rows for.
    considered: u64,
    /// The stamp the tables were last made from.
    stamp: u64,
    /// Bumps when places start over, so answers to earlier layouts are dropped.
    generation: u64,
    /// Which rows are to be laid out again, if any.
    arranging: Option<Arrange>,
    /// The result of the last arrange, until the view takes it.
    arranged: Option<Vec<(Row, [f64; 2])>>,
    /// The layout, for the stamp of the inputs it lays out.
    placing: Working<Placing>,
    /// Bumps whenever an answer arrives.
    landed: u64,
}

/// The places layouts gave a vertex table's rows, by row id.
type Laid = FxHashMap<Id, [f64; 2]>;

/// A layout's context: the generation it was started in, and the row each answer key names.
struct Placing {
    generation: u64,
    rows: FxHashMap<Key, Row>,
}

/// A vertex table's rows whose data gives no position, and what that was checked against: the
/// table's row order and the fields its position reads.
struct Unplaced {
    order: Version,
    fields: Vec<Read>,
    /// Whether each row's data gives no position.
    rows: Vec<bool>,
}

/// A field a vertex table's position reads, as of a check: where it is, and the field itself.
struct Read {
    at: (Name, Name, Name),
    field: Option<Field>,
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
        let (vertex_marks, edge_marks) = marks(input);
        self.check(input, &vertex_marks);
        self.settle();
        let inputs = stamp_with(|hasher| {
            (input.scene_version, self.generation, self.checked).hash(hasher);
            for vm in &vertex_marks {
                (vm.data.name(), vm.table.name(), vm.table.structure, vm.table.order).hash(hasher);
            }
            for em in &edge_marks {
                (em.data.name(), em.table.name(), em.table.structure, em.table.order).hash(hasher);
                input.links(em.mark, &mut |read| read.stamp(hasher));
            }
        });
        if inputs != self.considered && !self.placing.busy() {
            self.considered = inputs;
            self.place(input, &vertex_marks, &edge_marks, inputs, jobs);
            // A layout run on the frame, or a job the host finishes at once, lands before the
            // frame draws.
            self.settle();
        }
        let stamp = stamp_with(|hasher| {
            self.landed.hash(hasher);
            for vm in &vertex_marks {
                (vm.data.name(), vm.table.name(), vm.table.structure, vm.table.order).hash(hasher);
            }
        });
        if stamp == self.stamp {
            return false;
        }
        self.stamp = stamp;
        self.write(&vertex_marks);
        true
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
        self.considered = 0;
    }
}

impl Places {
    /// Lays out the rows `rows` names again, dropping any pending layout.
    pub(crate) fn arrange(&mut self, rows: Arrange) {
        self.arranging = Some(rows);
        self.placing.cancel();
        self.generation += 1;
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
                    let table = (row.data.clone(), row.table.clone());
                    self.laid.entry(table).or_default().insert(row.id.clone(), [*x, *y]);
                    placed.push((row.clone(), [*x, *y]));
                }
            }
            if self.arranging.take().is_some() {
                self.arranged = Some(placed);
            }
        }
        self.landed += 1;
    }

    /// Checks which rows of each vertex table its data gives no position. A table whose rows and
    /// position fields are unchanged costs nothing. After an edit or an append, only the rows
    /// written or added are checked. Bumps `checked` when any row gains or loses its position.
    fn check(&mut self, input: &Input<'_>, vertex_marks: &[VertexMark<'_>]) {
        let mut checked = FxHashMap::default();
        for vm in vertex_marks {
            let key = (vm.data.name().clone(), vm.table.name().clone());
            let mut fields = Vec::new();
            input.positions(vm.mark, &mut |read| {
                fields.push(Read {
                    at: (read.data.clone(), read.table.clone(), read.name.into()),
                    field: read.field.cloned(),
                });
            });
            let rows = Rows::new(vm.table, input.data);
            let gives_none = |row: usize| position(vm.mark, &rows, row).is_none();
            let before = self.unplaced.remove(&key);
            let rechecks = before.as_ref().and_then(|was| rechecks(was, vm, &fields));
            let unplaced = match (before, rechecks) {
                (Some(mut was), Some(rechecks)) => {
                    was.rows.resize(vm.table.len(), false);
                    for row in rechecks {
                        let now = gives_none(row);
                        if was.rows[row] != now {
                            was.rows[row] = now;
                            self.checked += 1;
                        }
                    }
                    Unplaced { fields, order: vm.table.order, rows: was.rows }
                }
                (was, _) => {
                    let rows: Vec<bool> = (0..vm.table.len()).map(gives_none).collect();
                    if was.is_none_or(|was| was.rows != rows) {
                        self.checked += 1;
                    }
                    Unplaced { fields, order: vm.table.order, rows }
                }
            };
            checked.insert(key, unplaced);
        }
        self.unplaced = checked;
    }

    /// Starts a layout of the rows to place, if any: each row whose data gives no position and the
    /// layout has not placed (while arranging, each row without a position, or every row when
    /// arranging all). Other rows are pinned at their positions or places. It runs on the frame
    /// when it fits the frame's budget.
    fn place(
        &mut self,
        input: &Input<'_>,
        vertex_marks: &[VertexMark<'_>],
        edge_marks: &[EdgeMark<'_>],
        inputs: u64,
        jobs: &mut Jobs<'_>,
    ) {
        let (arranging, all) = (self.arranging.is_some(), self.arranging == Some(Arrange::All));
        let none = FxHashMap::default();
        // Each vertex table's rows without a position, and its places.
        let tables: Vec<(Option<&Unplaced>, &Laid)> = vertex_marks
            .iter()
            .map(|vm| {
                let key = (vm.data.name().clone(), vm.table.name().clone());
                (self.unplaced.get(&key), self.laid.get(&key).unwrap_or(&none))
            })
            .collect();
        let unplaced = |t: usize, row: usize| tables[t].0.is_some_and(|u| u.rows[row]);
        let wanted = |t: usize, row: usize| {
            all || (unplaced(t, row)
                && (arranging || vertex_marks[t].table.ids.id(row).is_none_or(|id| !tables[t].1.contains_key(&id))))
        };
        if !(0..vertex_marks.len()).any(|t| (0..vertex_marks[t].table.len()).any(|row| wanted(t, row))) {
            // Nothing to lay out: the arrange finishes with no rows.
            if self.arranging.take().is_some() {
                self.arranged = Some(Vec::new());
            }
            return;
        }
        let count = vertex_marks.iter().map(|vm| vm.table.len()).sum();
        let (mut pinned, mut keys) = (Vec::with_capacity(count), Vec::with_capacity(count));
        let mut rows = FxHashMap::default();
        for (t, vm) in vertex_marks.iter().enumerate() {
            let data = Rows::new(vm.table, input.data);
            for row in 0..vm.table.len() {
                let id = vm.table.ids.id(row).expect("every row has an id");
                let key = Row { data: vm.data.name().clone(), table: vm.table.name().clone(), id };
                let pin = if all {
                    None
                } else if unplaced(t, row) {
                    tables[t].1.get(&key.id).copied().filter(|_| !arranging)
                } else {
                    position(vm.mark, &data, row)
                };
                pinned.push(pin);
                keys.push(wanted(t, row).then(|| {
                    let job_key = key_of(&key);
                    rows.insert(job_key.clone(), key);
                    job_key
                }));
            }
        }
        let links = links(vertex_marks, edge_marks);
        let layout = &input.scene.layout;
        let job = Job::layout(layout, &Placement { pinned: &pinned, links: &links, keys: &keys });
        let pending = jobs.run(job, Job::layout_cost(layout, count, links.len()));
        self.placing.start(inputs, pending, Placing { generation: self.generation, rows });
    }

    /// Writes each vertex table's places: the place the layout gave each row, or nothing.
    fn write(&mut self, vertex_marks: &[VertexMark<'_>]) {
        let none = FxHashMap::default();
        let mut tables = Tables::default();
        for vm in vertex_marks {
            let key: (Name, Name) = (vm.data.name().clone(), vm.table.name().clone());
            let laid = self.laid.get(&key).unwrap_or(&none);
            let places: Vec<Option<[f64; 2]>> =
                (0..vm.table.len()).map(|row| vm.table.ids.id(row).and_then(|id| laid.get(&id).copied())).collect();
            let column = |k: usize| Values::from(places.iter().map(|p| p.map(|p| p[k])).collect::<Vec<_>>());
            let before = self.tables.get(&key);
            let fields = [("x", column(0)), ("y", column(1))]
                .map(|(name, values)| (Name::from(name), kept(name, &values, vm.table, before)));
            tables.insert(key, beside(vm.table, fields));
        }
        self.tables = tables;
    }
}

/// The rows of `vm`'s table to check again since `was`: the rows each changed position field
/// wrote, and the rows added. `None` when every row needs checking: rows were removed, the
/// position reads other fields, or a changed field is not one whose writes are known.
fn rechecks(was: &Unplaced, vm: &VertexMark<'_>, fields: &[Read]) -> Option<Vec<usize>> {
    if was.order != vm.table.order || was.fields.len() != fields.len() {
        return None;
    }
    let mut rows: Vec<usize> = (was.rows.len()..vm.table.len()).collect();
    for (then, now) in was.fields.iter().zip(fields) {
        if then.at != now.at {
            return None;
        }
        if then.field.as_ref().map(Field::version) == now.field.as_ref().map(Field::version) {
            continue;
        }
        let own = now.at.0 == *vm.data.name() && now.at.1 == *vm.table.name();
        match (&then.field, &now.field) {
            (Some(Field::Values(before, _)), Some(Field::Values(after, _))) if own => {
                rows.extend(after.written_since(before).into_iter().filter(|&row| row < vm.table.len()));
            }
            _ => return None,
        }
    }
    rows.sort_unstable();
    rows.dedup();
    Some(rows)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::task::Waker;

    use super::*;
    use crate::derive::testing::Failing;
    use crate::gpu::work::Counters;
    use crate::{Data, Ids, Plane, Scene, Stress, Table, Vertices, field};

    /// One frame of `places` for `scene` over `data`, with `budget` microseconds of frame work.
    fn frame(places: &mut Places, scene: &Scene, data: &Data, host: &Failing, budget: u32) -> bool {
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let data = data.snapshot();
        let input = Input { scene, scene_version: 1, data: std::slice::from_ref(&data), paged: None };
        places.update(&input, &mut Jobs::new(Some(host), Waker::noop(), &counters, &errors, budget))
    }

    #[test]
    fn a_failed_layout_runs_once_until_its_inputs_change() {
        let data = Data::new("g");
        data.apply(Table::new("V", Ids::count(3))).expect("valid");
        let scene = Scene::new(Plane::default()).layout(Stress::default()).draw(Vertices::of("g", "V"));
        let (host, mut places) = (Failing::default(), Places::default());
        // No frame budget, so the layout goes to the host as a job.
        for _ in 0..5 {
            frame(&mut places, &scene, &data, &host, 0);
        }
        assert_eq!(host.jobs(), 1, "one job for these inputs, not one per frame");
        places.arrange(Arrange::Unplaced);
        frame(&mut places, &scene, &data, &host, 0);
        assert_eq!(host.jobs(), 2, "laying out again asks again");
    }

    #[test]
    fn a_small_layout_runs_on_the_frame_and_edits_of_positions_place_nothing() {
        let data = Data::new("g");
        let x = vec![Some(0.0), None, None];
        data.apply(Table::new("V", Ids::count(3)).field("x", x).field("y", vec![0.0; 3])).expect("valid");
        let scene = Scene::new(Plane::default())
            .layout(Stress::default())
            .draw(Vertices::of("g", "V").position(field("x"), field("y")));
        let (host, mut places) = (Failing::default(), Places::default());
        assert!(frame(&mut places, &scene, &data, &host, u32::MAX), "the places land on the first frame");
        assert_eq!(host.jobs(), 0, "a layout that fits the frame needs no job");
        let laid = |places: &Places, id: u64| places.tables.get(&("g".into(), "V".into()))?.get(id, "x");
        assert_eq!(laid(&places, 0), None, "a row its data positions has no place");
        assert!(matches!(laid(&places, 1), Some(Value::Number(_))), "a row without a position has one");
        // Moving the positioned row changes no place.
        data.apply(Table::new("V", vec![0_u64]).field("x", vec![50.0])).expect("valid");
        assert!(!frame(&mut places, &scene, &data, &host, u32::MAX), "nothing to place again");
        // A row that loses its position keeps nothing until the layout places it.
        data.apply(Table::new("V", vec![0_u64]).field("x", vec![None::<f64>])).expect("valid");
        assert!(frame(&mut places, &scene, &data, &host, u32::MAX));
        assert!(matches!(laid(&places, 0), Some(Value::Number(_))), "the row that lost its position is placed");
    }
}
