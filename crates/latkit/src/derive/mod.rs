//! Derived data: tables the view computes from the scene and data.
//!
//! Every derivation works the same way. It stamps its inputs and recomputes only when the stamp
//! changes. Small work runs on the frame, within one budget ([`FRAME_WORK`]) that all derivations
//! share. Larger work runs as a host job, and its result is kept only while its inputs are
//! unchanged. Results are tables that stand beside the drawn tables, row for row, and marks read
//! them like data. Values the GPU computes (normals, segment counts, the texts labels need) use the
//! same stamps and are read back.
//!
//! The derivations are lanes of edges that share both endpoints, stars of nets, and, when the scene
//! has a layout, places of vertex rows without positions. They also derive shapes of geometry
//! fields (every area's triangles), text matches for `contains`, the pieces of given tile sets the
//! camera needs, and what each paged table draws.

pub(crate) mod graph;
mod lanes;
pub(crate) mod matches;
pub(crate) mod order;
pub(crate) mod places;
pub(crate) mod pyramid;
pub(crate) mod shapes;
pub(crate) mod sight;
mod stars;
pub(crate) mod tiled;

pub(crate) use lanes::words as lane_words;

use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::task::Waker;

use rustc_hash::FxHasher;

use crate::data::{Column, Field, Keyed, Name, Op, Page, Patch, Snapshot, Table, Value, Values, Version};
use crate::gpu::readback::Readback;
use crate::gpu::work::{Count, Counters};
use crate::host::{Host, Job, Key, Request};
use crate::tiles::TileSets;
use crate::{Pending, Result, Scene};
use places::Places;

/// Hashes `inputs` into a stamp. Never 0, which means no value has been made yet.
pub(crate) fn stamp_of(inputs: impl Hash) -> u64 {
    stamp_with(|hasher| inputs.hash(hasher))
}

/// A stamp of what `hash` writes, for inputs that hash themselves into a hasher.
pub(crate) fn stamp_with(hash: impl FnOnce(&mut FxHasher)) -> u64 {
    let mut hasher = FxHasher::default();
    hash(&mut hasher);
    hasher.finish().max(1)
}

/// Work whose bytes arrive later: a GPU readback, or a host job or fetch.
pub(crate) trait Answer {
    /// Takes the bytes once they arrive. `None` until then.
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

/// Work under way: its answer, the stamp of the inputs it was started for, and the context its
/// answer is read with. Work that lands counts as done for its stamp, whether it succeeded or
/// failed, so no work for that stamp starts again. A job runs once for each set of inputs. Stamp 0
/// is for work started on request, not for inputs, and is not tracked.
pub(crate) struct Working<C, A: Answer = Pending<Vec<u8>>> {
    pending: Option<(u64, A, C)>,
    /// The stamp of the work that landed last, or 0 for none.
    done: u64,
}

impl<C, A: Answer> Default for Working<C, A> {
    fn default() -> Self {
        Working { pending: None, done: 0 }
    }
}

impl<C, A: Answer> Working<C, A> {
    /// Whether work is pending.
    pub(crate) fn busy(&self) -> bool {
        self.pending.is_some()
    }

    /// Whether work for `stamp` may start: none is pending, and none for `stamp` landed.
    pub(crate) fn may_start(&self, stamp: u64) -> bool {
        self.pending.is_none() && (stamp == 0 || stamp != self.done)
    }

    /// The stamp of the pending work.
    pub(crate) fn stamp(&self) -> Option<u64> {
        self.pending.as_ref().map(|(stamp, ..)| *stamp)
    }

    /// The context of the pending work.
    pub(crate) fn context(&self) -> Option<&C> {
        self.pending.as_ref().map(|(_, _, context)| context)
    }

    /// Records `answer` as pending for `stamp`, read with `context`, replacing any pending work.
    pub(crate) fn start(&mut self, stamp: u64, answer: A, context: C) {
        self.pending = Some((stamp, answer, context));
    }

    /// Drops the pending work. Its answer is ignored.
    pub(crate) fn cancel(&mut self) {
        self.pending = None;
    }

    /// Drops the pending work, whose answer can no longer land, and returns what it was for.
    pub(crate) fn abandon(&mut self) -> Option<C> {
        self.pending.take().map(|(_, _, context)| context)
    }

    /// Takes finished work: its stamp, context, and bytes or error.
    pub(crate) fn landed(&mut self) -> Option<(u64, C, Result<Vec<u8>>)> {
        let answer = self.pending.as_ref()?.1.take()?;
        let (stamp, _, context) = self.pending.take().expect("pending work");
        self.done = stamp;
        Some((stamp, context, answer))
    }
}

/// A derived value, the stamp it was made from, and any pending work toward a newer stamp.
pub(crate) struct Derived<T, A: Answer = Readback> {
    pub(crate) value: T,
    stamp: u64,
    working: Working<(), A>,
}

impl<T: Default, A: Answer> Default for Derived<T, A> {
    fn default() -> Self {
        Derived { value: T::default(), stamp: 0, working: Working::default() }
    }
}

impl<T, A: Answer> Derived<T, A> {
    /// The stamp the value was made from, or 0 before the first value.
    pub(crate) fn stamp(&self) -> u64 {
        self.stamp
    }

    /// Whether `stamp` matches neither the value nor the pending work, so new work is needed.
    pub(crate) fn due(&self, stamp: u64) -> bool {
        stamp != self.stamp && self.working.stamp() != Some(stamp)
    }

    /// Stores `value` as made from `stamp`, dropping any pending work.
    pub(crate) fn make(&mut self, stamp: u64, value: T) {
        self.value = value;
        self.mark(stamp);
    }

    /// Marks the current value, unchanged, as made from `stamp`, dropping any pending work.
    pub(crate) fn mark(&mut self, stamp: u64) {
        self.stamp = stamp;
        self.working.cancel();
    }

    /// Records `work` as pending toward `stamp`, replacing any pending work.
    pub(crate) fn start(&mut self, stamp: u64, work: A) {
        self.working.start(stamp, work, ());
    }

    /// Takes the bytes of finished work and the stamp it was for. Failed work marks its stamp as
    /// made and keeps the old value, so it is not retried until the inputs change.
    pub(crate) fn landed(&mut self) -> Option<(u64, Vec<u8>)> {
        let (stamp, (), answer) = self.working.landed()?;
        let Ok(bytes) = answer else {
            self.stamp = stamp;
            return None;
        };
        Some((stamp, bytes))
    }

    /// Whether work is pending.
    pub(crate) fn busy(&self) -> bool {
        self.working.busy()
    }
}

/// Estimated microseconds of derivation work all of a GPU's views may do on one frame together.
/// Work that does not fit goes to the host as jobs.
pub(crate) const FRAME_WORK: u32 = 4000;

/// The frame's inline work budget and the host's job pool, shared by every derivation. Each job and
/// fetch wakes the view when it finishes.
pub(crate) struct Jobs<'a> {
    errors: &'a Arc<Mutex<Vec<crate::Error>>>,
    host: Option<&'a dyn Host>,
    /// Fetches in place of the host, for tiles given their own fetch.
    fetch: Option<&'a crate::tiles::Fetch>,
    waker: &'a Waker,
    /// Counts the jobs spawned.
    counters: &'a Counters,
    /// Estimated microseconds of inline work left this frame.
    left: u32,
}

impl<'a> Jobs<'a> {
    /// A frame's jobs, with `left` microseconds of inline work still to spend.
    pub(crate) fn new(
        host: Option<&'a dyn Host>,
        waker: &'a Waker,
        counters: &'a Counters,
        errors: &'a Arc<Mutex<Vec<crate::Error>>>,
        left: u32,
    ) -> Jobs<'a> {
        Jobs { errors, host, fetch: None, waker, counters, left }
    }

    /// Whether `cost` microseconds fit the rest of the frame's budget. Spends them if so.
    pub(crate) fn fits(&mut self, cost: u64) -> bool {
        let fits = cost <= u64::from(self.left);
        if fits {
            self.left -= cost as u32;
        }
        fits
    }

    /// Estimated microseconds of inline work left this frame.
    pub(crate) fn left(&self) -> u64 {
        u64::from(self.left)
    }

    /// The waker its jobs and fetches wake when they finish.
    pub(crate) fn waker(&self) -> &Waker {
        self.waker
    }

    /// The same host's jobs and fetches, but waking `waker` instead of this frame's view, and with
    /// no inline budget. Used for work shared by every view that draws its result.
    pub(crate) fn waking<'b>(&'b self, waker: &'b Waker) -> Jobs<'b> {
        Jobs { errors: self.errors, host: self.host, fetch: self.fetch, waker, counters: self.counters, left: 0 }
    }

    /// The same jobs, with fetches made by `fetch` when given.
    pub(crate) fn fetching(self, fetch: Option<&'a crate::tiles::Fetch>) -> Jobs<'a> {
        Jobs { fetch: fetch.or(self.fetch), ..self }
    }

    /// Runs `job` on the frame when its estimated `cost` in microseconds fits the rest of the
    /// frame's budget, spending it, and on the host otherwise.
    pub(crate) fn run(&mut self, job: Job, cost: u64) -> Pending<Vec<u8>> {
        if self.fits(cost) { Pending::ready(Ok(job.run())) } else { self.spawn(job) }
    }

    /// Runs `job` on the host, off the frame. Without a host, runs it immediately.
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

    /// Fetches `request` with the tiles' own fetch, or through the host. Without either, the fetch
    /// fails as unsupported.
    pub(crate) fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        let pending = match (self.fetch, self.host) {
            (Some(fetch), _) => fetch(request),
            (None, Some(host)) => host.fetch(request),
            (None, None) => Pending::ready(Err(crate::Error::Unsupported("fetching needs a host".into()))),
        };
        pending.notify(self.waker);
        pending
    }
}

/// The inputs every derivation reads: the scene, its data, and what each paged table draws. Jobs go
/// through the frame's [`Jobs`], which hold the host.
pub(crate) struct Input<'a> {
    pub(crate) scene: &'a Scene,
    /// Bumps whenever the scene changes.
    pub(crate) scene_version: u64,
    pub(crate) data: &'a [Snapshot],
    /// Each paged table, by dataset and table. Row-local derivations work only on the pages and
    /// kept rows listed here.
    pub(crate) paged: Option<&'a Keyed<(Name, Name), Paged>>,
}

/// What a paged table draws this frame: its order, the pages drawn, and the places of kept rows
/// outside those pages. Both lists ascend.
pub(crate) struct Paged {
    pub(crate) order: order::Order,
    pub(crate) pages: Vec<u32>,
    pub(crate) kept: Vec<u32>,
}

impl Input<'_> {
    /// The dataset named `name`.
    pub(crate) fn data(&self, name: &str) -> Option<&Snapshot> {
        self.data.iter().find(|d| d.name() == name)
    }

    /// Calls `read` with each field that places the rows vertex mark `mark` draws: the fields its
    /// position reads, or its point field.
    pub(crate) fn positions<'a>(&'a self, mark: &'a crate::Vertices, read: &mut impl FnMut(Read<'a>)) {
        let own = (&mark.style.data, &mark.style.table);
        match &mark.position {
            Some(xy) => xy.iter().for_each(|expr| self.read_expr(own, expr, read)),
            None => self.read_field(own, mark.point_field(), read),
        }
    }

    /// Calls `read` with each field that joins the rows edge mark `mark` draws to vertices: its
    /// ends, or the reference by which its members name each net.
    pub(crate) fn links<'a>(&'a self, mark: &'a crate::Edges, read: &mut impl FnMut(Read<'a>)) {
        let own = (&mark.style.data, &mark.style.table);
        for name in mark.ends.iter().flat_map(|(from, to)| [from, to]) {
            self.read_field(own, name, read);
        }
        if let Some((members, reference)) = &mark.joins {
            self.read_field((&mark.style.data, members), reference, read);
        }
    }

    /// Calls `read` with every field that `expr` reads, for a mark drawing `table`.
    fn read_expr<'a>(&'a self, table: (&'a Name, &'a Name), expr: &'a crate::Expr, read: &mut impl FnMut(Read<'a>)) {
        expr.for_each_field(&mut |f| {
            let (data, read_from) = f.from.as_ref().map_or(table, |(d, t)| (d, t));
            let field = self.data(data).and_then(|d| d.table(read_from)).and_then(|t| t.field_named(&f.name));
            read(Read { data, table: read_from, name: f.name.as_str(), field });
        });
    }

    /// Calls `read` with field `name` of `table`.
    fn read_field<'a>(&'a self, (data, table): (&'a Name, &'a Name), name: &'a str, read: &mut impl FnMut(Read<'a>)) {
        let field = self.data(data).and_then(|d| d.table(table)).and_then(|t| t.field_named(name));
        read(Read { data, table, name, field });
    }
}

/// A field a derivation reads: where it is, and the field, `None` where it is missing.
pub(crate) struct Read<'a> {
    pub(crate) data: &'a Name,
    pub(crate) table: &'a Name,
    pub(crate) name: &'a str,
    pub(crate) field: Option<&'a Field>,
}

impl Read<'_> {
    /// Hashes where the field is and its version, so a stamp changes when the field does.
    pub(crate) fn stamp(&self, hasher: &mut impl Hasher) {
        (self.data, self.table, self.name, self.field.map(Field::version)).hash(hasher);
    }
}

/// Derived tables, by the dataset and table each stands beside.
pub(crate) type Tables = Keyed<(Name, Name), Table>;

/// One derivation: it stamps its inputs, computes on the frame or in jobs, and writes tables.
pub(crate) trait Derive {
    /// Updates the derivation to `input`, sending work the frame cannot afford to `jobs`. Returns
    /// whether its tables changed.
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool;

    /// Whether work it started is pending.
    fn busy(&self) -> bool;

    /// Whether its tables are final, with no placeholder for pending work. Placeholders include
    /// rows at their old places until a layout arrives, rows without triangles until shapes arrive,
    /// and straight edges until lanes arrive.
    fn complete(&self) -> bool {
        !self.busy()
    }

    /// The tables it derives.
    fn tables(&self) -> &Tables;

    /// Drops its derived tables, once the scene no longer needs them.
    fn clear(&mut self);

    /// Takes the errors since the last call.
    fn take_errors(&mut self) -> Vec<crate::Error> {
        Vec::new()
    }
}

/// Every derivation of a view, updated in order each frame within one budget.
#[derive(Default)]
pub(crate) struct Derivations {
    /// The lanes of edges that share both endpoints.
    lanes: lanes::Lanes,
    /// When the scene has a layout, the places of vertex rows without positions.
    places: Places,
    /// The stars of nets joining vertex rows.
    stars: stars::Stars,
    shapes: shapes::Shapes,
    /// Whether each row's text contains a string a mark asks about.
    matches: matches::Matches,
    /// The pieces of each given tile set the camera needs, as datasets.
    pub(crate) tiles: TileSets,
    /// The pyramids of each dataset with paged tables, and what those tables draw.
    pub(crate) tiled: tiled::Tiled,
}

/// The derived tables beside one drawn table: the first found of the places', stars', or lanes'
/// tables, then the shapes' table, then the matches' table.
pub(crate) type Beside<'a> = [Option<&'a Table>; 3];

impl Derivations {
    /// Takes over `old`'s derivations that depend only on the data and the scene, as when the view
    /// moves to a new device: the places, lanes, and stars layouts gave, the shapes, and the text
    /// matches. Rows keep their laid-out places, and an arrangement or job in progress
    /// lands here. Tiles and paged tables belong to the old device, so they start again.
    pub(crate) fn carry(&mut self, old: &mut Derivations) {
        std::mem::swap(&mut self.lanes, &mut old.lanes);
        std::mem::swap(&mut self.places, &mut old.places);
        std::mem::swap(&mut self.stars, &mut old.stars);
        std::mem::swap(&mut self.shapes, &mut old.shapes);
        std::mem::swap(&mut self.matches, &mut old.matches);
    }

    /// Updates every derivation to `input`, spending what remains of `jobs`' frame budget after
    /// the tiles. Returns whether any table changed.
    pub(crate) fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        let placed = self.places.update(input, jobs);
        let mut changed = self.lanes.update(input, jobs) | placed | self.stars.update(input, self.places.tables());
        changed |= self.shapes.update(input, &self.tiles, jobs);
        changed |= self.matches.update(input, jobs);
        changed
    }

    /// Lays out the vertex `rows` names again.
    pub(crate) fn arrange(&mut self, rows: crate::Arrange) {
        self.places.arrange(rows);
    }

    /// Takes the result of the last `arrange` once it arrives: each row laid out and its position,
    /// in the space's coordinates.
    pub(crate) fn take_arranged(&mut self) -> Option<Vec<(crate::Row, [f64; 2])>> {
        self.places.take_arranged()
    }

    /// Whether everything derived is final: no layout, lane, or shape job is pending, no tile draws
    /// its ancestor as a placeholder, and no paged table draws its first sample.
    pub(crate) fn complete(&self) -> bool {
        self.lanes.complete()
            && self.places.complete()
            && self.shapes.complete()
            && self.tiles.complete()
            && self.tiled.complete()
    }

    /// Whether a layout job is pending for the places of vertex rows without a position. Rows stand
    /// at placeholder places until it lands, so a fit waits for it.
    pub(crate) fn placing(&self) -> bool {
        self.places.busy()
    }

    /// Whether a triangulation job is pending. The rows it shapes draw nothing until it finishes.
    pub(crate) fn shaping(&self) -> bool {
        self.shapes.busy()
    }

    /// Takes the errors every derivation reported since the last call.
    pub(crate) fn take_errors(&mut self) -> Vec<crate::Error> {
        let mut errors = self.places.take_errors();
        errors.extend(self.tiles.take_errors());
        errors
    }

    /// The derived tables beside table `table` of dataset `data`.
    pub(crate) fn beside(&self, data: &Name, table: &Name) -> Beside<'_> {
        let key = (data.clone(), table.clone());
        let first = [self.places.tables(), self.stars.tables(), self.lanes.tables()]
            .into_iter()
            .find_map(|tables| tables.get(&key));
        [first, self.shapes.tables().get(&key), self.matches.tables().get(&key)]
    }

    /// The shapes of paged table `table` of dataset `data`, made per page of its order, keyed by
    /// the derived field each is written as.
    pub(crate) fn paged(&self, data: &Name, table: &Name) -> Vec<(Name, &shapes::PagedShapes)> {
        self.shapes.paged(data, table)
    }
}

/// A table holding `fields` that stands beside `source`, row for row: it shares `source`'s ids,
/// index, structure, and order.
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

/// Field `name` of a derived table beside `source`, holding `values`. Returns `before`'s field when
/// its values are equal, so nothing uploads again. Otherwise builds a column that reuses each of
/// `before`'s pages whose values are unchanged, so only changed pages upload and evaluate again.
/// Reuse needs `before` to share `source`'s structure and the field's length.
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

/// Reads a job's answer patch: for each row it sets, the row's key and its values of `fields`. An
/// unreadable patch yields nothing.
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

/// Hosts for derivations' tests.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::Pending;
    use crate::host::{Host, Job, Raster, TextRun};

    /// A host whose every job fails, counting the jobs it is given.
    #[derive(Default)]
    pub(crate) struct Failing(AtomicUsize);

    impl Failing {
        /// The jobs it was given.
        pub(crate) fn jobs(&self) -> usize {
            self.0.load(Ordering::Relaxed)
        }
    }

    impl Host for Failing {
        fn rasterize(&self, _: &TextRun) -> crate::Result<Raster> {
            Err(crate::Error::Unsupported("this host has no text".into()))
        }

        fn spawn(&self, _: Job) -> Pending<Vec<u8>> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Pending::ready(Err(crate::Error::Io("the worker stopped".into())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::PAGE_ROWS;

    #[test]
    fn kept_reuses_pages_whose_values_are_unchanged() {
        let rows = PAGE_ROWS + 10;
        let source = Table::new("T", crate::Ids::count(rows as u32));
        let numbers = |changed: f64| {
            Values::from((0..rows).map(|r| if r == rows - 1 { changed } else { 1.0 }).collect::<Vec<f64>>())
        };
        let first = beside(&source, [(Name::from("x"), kept("x", &numbers(1.0), &source, None))]);
        let same = kept("x", &numbers(1.0), &source, Some(&first));
        assert_eq!(same.version(), first.field_named("x").expect("x").version(), "unchanged values keep the version");
        let Field::Values(before, _) = first.field_named("x").expect("x") else { panic!("values") };
        let Field::Values(after, _) = kept("x", &numbers(2.0), &source, Some(&first)) else { panic!("values") };
        assert_eq!(after.pages()[0].id, before.pages()[0].id, "the unchanged first page is reused");
        assert_ne!(after.pages()[1].id, before.pages()[1].id, "the last page changed");
    }
}
