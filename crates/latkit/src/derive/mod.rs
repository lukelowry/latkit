//! Derived data: what the view works out rather than is given. Every derivation shares one lifecycle:
//! a stamp of what it reads, so it works again only when that changes; work small enough for the
//! frame done on it, within one budget all derivations share; larger work a host job answering a
//! patch, kept only while what it was asked from still holds; and tables it writes beside the tables
//! marks draw, row for row, which marks read like data. What the GPU works out (the shadow map,
//! normals, segment counts, label placement) follows the same stamps, its answers read back.
//!
//! The derivations: a diagram's sheet (places, sizes, boxes, wires); elsewhere the lanes of edges
//! sharing their ends, the stars of nets, and where the scene has a layout the places of vertex rows
//! without positions;
//! the triangles of every area; and the tiles the camera asks for, which patch datasets the view
//! owns.

pub(crate) mod graph;
mod lanes;
pub(crate) mod places;
pub(crate) mod pyramid;
mod shapes;
pub(crate) mod sight;
mod stars;
pub(crate) mod tiled;
pub(crate) mod tiles;
mod tiling;

pub(crate) use lanes::{answer as lanes_answer, spread};

use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::task::Waker;

use rustc_hash::{FxHashMap, FxHasher};

use crate::data::{Column, Data, Field, Name, Op, Page, Patch, Table, Value, Values, Version};
use crate::gpu::readback::Readback;
use crate::gpu::work::{Count, Counters};
use crate::host::{Host, Job, Key, Request};
use crate::sheet::Sheet;
use crate::{Pending, Result, Scene, Space};
use places::Places;
use tiles::TileSets;

/// A stamp of `inputs`: never 0, which no value is made from.
pub(crate) fn stamp_of(inputs: impl Hash) -> u64 {
    let mut hasher = FxHasher::default();
    inputs.hash(&mut hasher);
    hasher.finish().max(1)
}

/// Work that lands later: bytes the GPU reads back, or a job or fetch the host does.
pub(crate) trait Answer {
    /// The bytes once they landed, taking them; `None` while they have not.
    fn take(&self) -> Option<Result<Vec<u8>>>;
}

impl Answer for Readback {
    fn take(&self) -> Option<Result<Vec<u8>>> {
        Readback::take(self)
    }
}

impl Answer for Pending<Vec<u8>> {
    fn take(&self) -> Option<Result<Vec<u8>>> {
        Pending::take(self)
    }
}

/// A derived product: its value, the stamp it was made from, and the work under way toward the value
/// of a newer stamp.
pub(crate) struct Derived<T, A: Answer = Readback> {
    pub(crate) value: T,
    stamp: u64,
    working: Option<(u64, A)>,
}

impl<T: Default, A: Answer> Default for Derived<T, A> {
    fn default() -> Self {
        Derived { value: T::default(), stamp: 0, working: None }
    }
}

impl<T, A: Answer> Derived<T, A> {
    /// The stamp the value was made from; 0 before it was.
    pub(crate) fn stamp(&self) -> u64 {
        self.stamp
    }

    /// Whether `stamp` is neither what the value was made from nor what work under way is for.
    pub(crate) fn due(&self, stamp: u64) -> bool {
        stamp != self.stamp && self.working.as_ref().is_none_or(|(s, _)| *s != stamp)
    }

    /// Takes `value` as made from `stamp`, dropping any work under way.
    pub(crate) fn make(&mut self, stamp: u64, value: T) {
        self.value = value;
        self.stamp = stamp;
        self.working = None;
    }

    /// Takes the value as made from `stamp` as it stands, dropping any work under way.
    pub(crate) fn mark(&mut self, stamp: u64) {
        self.stamp = stamp;
        self.working = None;
    }

    /// Starts `work` toward the value of `stamp`, replacing any under way.
    pub(crate) fn start(&mut self, stamp: u64, work: A) {
        self.working = Some((stamp, work));
    }

    /// The bytes of work that landed, and the stamp it was for. Work that failed lands as made,
    /// keeping the value, so it is not tried again until what it reads changes.
    pub(crate) fn landed(&mut self) -> Option<(u64, Vec<u8>)> {
        let (stamp, work) = self.working.as_ref()?;
        let stamp = *stamp;
        let landed = work.take()?;
        self.working = None;
        let Ok(bytes) = landed else {
            self.stamp = stamp;
            return None;
        };
        Some((stamp, bytes))
    }

    /// Whether work is under way.
    pub(crate) fn busy(&self) -> bool {
        self.working.is_some()
    }
}

/// Microseconds of work, by estimate, the derivations do on one frame between them; what does not fit
/// goes to the host as jobs.
const FRAME_WORK: u32 = 4000;

/// The frame's budget of inline work and the host's pool, which every derivation shares. Each job
/// and fetch wakes the view when it lands.
pub(crate) struct Jobs<'a> {
    errors: &'a Arc<Mutex<Vec<crate::Error>>>,
    host: Option<&'a dyn Host>,
    waker: &'a Waker,
    /// What counts the jobs handed out.
    counters: &'a Counters,
    /// Microseconds of inline work left this frame, by estimate.
    left: u32,
}

impl<'a> Jobs<'a> {
    pub(crate) fn new(
        host: Option<&'a dyn Host>,
        waker: &'a Waker,
        counters: &'a Counters,
        errors: &'a Arc<Mutex<Vec<crate::Error>>>,
    ) -> Jobs<'a> {
        Jobs { host, waker, counters, errors, left: FRAME_WORK }
    }

    /// Whether work of `cost` microseconds fits what is left of the frame's budget, spending it if so.
    pub(crate) fn fits(&mut self, cost: u64) -> bool {
        let fits = cost <= u64::from(self.left);
        if fits {
            self.left -= cost as u32;
        }
        fits
    }

    /// Microseconds of inline work left this frame, by estimate.
    pub(crate) fn left(&self) -> u64 {
        u64::from(self.left)
    }

    /// Spends `cost` microseconds of the budget whether it fits or not: work the frame cannot defer.
    pub(crate) fn spend(&mut self, cost: u64) {
        self.left = self.left.saturating_sub(cost.min(u64::from(u32::MAX)) as u32);
    }

    /// Has the host do `job` off the frame; without a host, at once.
    pub(crate) fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        self.counters.add(Count::Jobs, 1);
        let pending = match self.host {
            Some(host) => host.spawn(job),
            None => Pending::ready(Ok(job.run())),
        };
        pending.report_errors(self.errors);
        pending.notify(self.waker);
        pending
    }

    /// Has the host fetch `request`; without a host, nothing can be fetched.
    pub(crate) fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        let pending = match self.host {
            Some(host) => host.fetch(request),
            None => Pending::ready(Err(crate::Error::Unsupported("fetching needs a host".into()))),
        };
        pending.notify(self.waker);
        pending
    }
}

/// What every derivation reads: the scene and its data, the host that measures text, and whether
/// rows are being dragged. Jobs go through the frame's [`Jobs`].
pub(crate) struct Input<'a> {
    pub(crate) scene: &'a Scene,
    /// Bumps whenever the scene changes.
    pub(crate) scene_version: u64,
    pub(crate) data: &'a [Data],
    pub(crate) host: Option<&'a dyn Host>,
    /// Whether rows are being dragged: what they move derives on the frame, however much.
    pub(crate) dragging: bool,
}

impl Input<'_> {
    /// The dataset named `name`.
    pub(crate) fn data(&self, name: &str) -> Option<&Data> {
        self.data.iter().find(|d| d.name() == name)
    }

    /// Hashes what the structure of the scene's marks reads: of each table drawn, its rows and the
    /// fields its places, sizes, groups, ports, wires, and nets read. A field only a look reads, such
    /// as a value streaming in, changes nothing it hashes.
    pub(crate) fn structure(&self, hasher: &mut impl Hasher) {
        for mark in &self.scene.marks {
            let style = mark.style();
            let Some(table) = self.data(&style.data).and_then(|d| d.table(&style.table)) else { continue };
            (&style.data, &style.table, table.structure, table.order).hash(hasher);
            let mut read = |of: Option<&(Name, Name)>, name: &Name| {
                let (data, table) = of.map_or((&style.data, &style.table), |(d, t)| (d, t));
                let field = self.data(data).and_then(|d| d.table(table)).and_then(|t| t.field_named(name));
                (data, table, name, field.map(Field::version)).hash(hasher);
            };
            let mut expr = |e: &crate::Expr| e.for_each_field(&mut |f| read(f.of.as_ref(), &f.name));
            let named = |name: &Name| crate::field(name.clone());
            match mark {
                crate::Mark::Vertices(v) => {
                    match &v.position {
                        Some([x, y]) => {
                            expr(x);
                            expr(y);
                        }
                        None => expr(&crate::field(v.point_field())),
                    }
                    for size in v.size.iter().flatten().chain(&v.radius) {
                        expr(&size.expr);
                    }
                    if let Some(label) = &style.label {
                        expr(&label.text);
                    }
                    for (reference, _) in &v.ports {
                        expr(&named(reference));
                    }
                    if let Some((members, reference)) = &v.contains {
                        expr(&named(reference).of(style.data.clone(), members.clone()));
                    }
                }
                crate::Mark::Edges(e) => {
                    for name in e.ends.iter().flat_map(|(from, to)| [from, to]).chain(&e.bends) {
                        expr(&named(name));
                    }
                    if let Some((members, reference)) = &e.joins {
                        expr(&named(reference).of(style.data.clone(), members.clone()));
                    }
                }
                crate::Mark::Faces(_) | crate::Mark::Lines(_) | crate::Mark::Areas(_) => {}
            }
        }
    }
}

/// Derived tables, by the dataset and table each stands beside.
pub(crate) type Tables = FxHashMap<(Name, Name), Table>;

/// One derivation: what it reads, stamped; what it works out, on the frame or as jobs; and the tables
/// it writes.
pub(crate) trait Derive {
    /// Brings what it derives up to `input`, handing `jobs` what the frame cannot afford; whether its
    /// tables changed.
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool;

    /// Whether work it asked for is under way.
    fn busy(&self) -> bool;

    /// Whether what it derived is final: nothing it writes stands in for work under way. Rows
    /// standing where they were until a layout lands, elbows until routes land, earlier triangles
    /// until shapes land, and straight edges until lanes land all stand in.
    fn complete(&self) -> bool {
        !self.busy()
    }

    /// The tables it derives.
    fn tables(&self) -> &Tables;

    /// Forgets what it derived: its space no longer asks for it.
    fn clear(&mut self);

    /// Failures to tell since last asked, such as texts its host could not measure.
    fn take_errors(&mut self) -> Vec<crate::Error> {
        Vec::new()
    }
}

/// Every derivation of a view, run in order each frame with one budget.
#[derive(Default)]
pub(crate) struct Derivations {
    /// A diagram's sheet.
    pub(crate) sheet: Sheet,
    /// Elsewhere, the lanes of edges sharing their ends.
    lanes: lanes::Lanes,
    /// Elsewhere, where the scene has a layout, the places of vertex rows without positions.
    places: Places,
    /// Elsewhere, the stars of nets joining vertex rows.
    stars: stars::Stars,
    shapes: shapes::Shapes,
    /// The tiles the camera asks for, as datasets the view owns.
    pub(crate) tiles: TileSets,
    /// What the view draws of each dataset it draws in part.
    pub(crate) tiled: tiled::Tiled,
}

/// The derived tables beside one drawn table: the sheet's or the lanes', then the shapes'.
pub(crate) type Beside<'a> = [Option<&'a Table>; 2];

impl Derivations {
    /// Brings every derivation up to `input`, spending what the tiles left of the frame's `jobs`;
    /// whether any table changed.
    pub(crate) fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        let mut changed = if matches!(input.scene.space, Space::Diagram(_)) {
            self.lanes.clear();
            self.places.clear();
            self.stars.clear();
            self.sheet.update(input, jobs)
        } else {
            self.sheet.clear();
            let placed = self.places.update(input, jobs);
            self.lanes.update(input, jobs) | placed | self.stars.update(input, self.places.tables())
        };
        changed |= self.shapes.update(input, jobs);
        changed
    }

    /// Lays every vertex row without a position out again: a diagram's sheet, or elsewhere the
    /// places.
    pub(crate) fn arrange(&mut self, diagram: bool) {
        if diagram { self.sheet.arrange() } else { self.places.arrange() }
    }

    /// What the last arranging laid out, once it landed: each row placed, and where, in the
    /// space's coordinates.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(crate::Row, [f64; 2])>> {
        self.sheet.take_arranged().or_else(|| self.places.take_arranged())
    }

    /// Whether everything derived is final: no layout, route, lane, or shape job stands in, no tile
    /// draws its ancestor, and no table drawn in part draws its first sample.
    pub(crate) fn complete(&self) -> bool {
        self.sheet.complete()
            && self.lanes.complete()
            && self.places.complete()
            && self.shapes.complete()
            && self.tiles.complete()
            && self.tiled.complete()
    }

    /// Whether shapes are being triangulated or bent: until they land, marks draw the ones before.
    pub(crate) fn shaping(&self) -> bool {
        self.shapes.busy()
    }

    /// Failures every derivation has to tell since last asked.
    pub(crate) fn take_errors(&mut self) -> Vec<crate::Error> {
        let mut errors = self.sheet.take_errors();
        errors.extend(self.places.take_errors());
        errors.extend(self.tiles.take_errors());
        errors
    }

    /// The derived tables beside table `table` of dataset `data`.
    pub(crate) fn beside(&self, data: &Name, table: &Name) -> Beside<'_> {
        let key = (data.clone(), table.clone());
        let first = [self.sheet.tables(), self.places.tables(), self.stars.tables(), self.lanes.tables()]
            .into_iter()
            .find_map(|tables| tables.get(&key));
        [first, self.shapes.tables().get(&key)]
    }
}

/// A table beside `source`, row for row, holding `fields`.
pub(crate) fn beside(source: &Table, fields: impl IntoIterator<Item = (Name, Field)>) -> Table {
    let mut table = Table {
        name: source.name.clone(),
        ids: source.ids.clone(),
        index: source.index.clone(),
        fields: Vec::new(),
        structure: source.structure,
        order: source.order,
    };
    for (name, field) in fields {
        table.insert(name, field);
    }
    table
}

/// Field `name` of a table beside `source`, holding `values`: `before`'s own while it holds exactly
/// them, so nothing uploads again; else a column keeping each of `before`'s pages that holds what its
/// page would, so only the pages that changed upload and evaluate again.
pub(crate) fn kept(name: &str, values: &Values, source: &Table, before: Option<&Table>) -> Field {
    let fresh = Column::new(values);
    let old = before.filter(|b| b.structure == source.structure).and_then(|b| match b.field_named(name) {
        Some(Field::Values(column, version)) if column.len() == fresh.len() => Some((column, *version)),
        _ => None,
    });
    let Some((column, version)) = old else { return Field::Values(fresh, Version::next()) };
    let pages: Vec<Page> = fresh
        .pages()
        .iter()
        .zip(column.pages())
        .map(|(new, old)| if new.values.same(&old.values) { old.clone() } else { new.clone() })
        .collect();
    if pages.iter().zip(column.pages()).all(|(page, old)| page.id == old.id) {
        return Field::Values(column.clone(), version);
    }
    Field::Values(Column::of_pages(pages, column.like()), Version::next())
}

/// The values `fields` an answer's patch writes for each row it names, by its key.
pub(crate) fn answers(bytes: &[u8], fields: &[&str]) -> Vec<(Key, Vec<Option<Value>>)> {
    let Ok(patch) = Patch::from_bytes(bytes) else { return Vec::new() };
    let mut out = Vec::new();
    for op in patch.ops {
        let Op::Set(table) = op else { continue };
        for row in 0..table.len() {
            let Some(id) = table.ids.id(row) else { continue };
            let values = fields.iter().map(|f| table.value(row, f, f64::INFINITY)).collect();
            out.push(((table.name.clone(), id), values));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::PAGE_ROWS;

    #[test]
    fn kept_keeps_the_pages_that_hold_the_same() {
        let rows = PAGE_ROWS + 10;
        let source = Table::new("T", crate::Ids::count(rows as u32));
        let numbers = |changed: f64| {
            Values::from((0..rows).map(|r| if r == rows - 1 { changed } else { 1.0 }).collect::<Vec<f64>>())
        };
        let first = beside(&source, [(Name::from("x"), kept("x", &numbers(1.0), &source, None))]);
        let same = kept("x", &numbers(1.0), &source, Some(&first));
        assert_eq!(same.version(), first.field_named("x").expect("x").version(), "nothing changed");
        let Field::Values(before, _) = first.field_named("x").expect("x") else { panic!("values") };
        let Field::Values(after, _) = kept("x", &numbers(2.0), &source, Some(&first)) else { panic!("values") };
        assert_eq!(after.pages()[0].id, before.pages()[0].id, "the first page held the same");
        assert_ne!(after.pages()[1].id, before.pages()[1].id, "the last page changed");
    }
}
