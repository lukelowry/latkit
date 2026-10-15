//! Derived data: what the view works out rather than is given. Every derivation shares one lifecycle:
//! a stamp of what it reads, so it works again only when that changes; work small enough for the
//! frame done on it, within one budget all derivations share; larger work a host job answering a
//! patch, kept only while what it was asked from still holds; and tables it writes beside the tables
//! marks draw, row for row, which marks read like data. What the GPU works out (the shadow map,
//! normals, segment counts, label placement) follows the same stamps, its answers read back.
//!
//! The derivations: a diagram's sheet (places, sizes, boxes, wires); elsewhere the lanes of edges
//! sharing their ends; the triangles of every area; and the tiles the camera asks for, which patch
//! datasets the view owns.

mod lanes;
pub(crate) mod pyramid;
mod shapes;
pub(crate) mod sight;
pub(crate) mod tiled;
pub(crate) mod tiles;

pub(crate) use lanes::{answer as lanes_answer, spread};

use std::hash::{Hash, Hasher};
use std::task::Waker;

use rustc_hash::{FxHashMap, FxHasher};

use crate::data::{Column, Data, Field, Name, Op, Patch, Table, Value, Values, Version};
use crate::gpu::readback::Readback;
use crate::host::{Host, Job, Key, Request};
use crate::sheet::Sheet;
use crate::{Pending, Result, Scene, Space};

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
    host: Option<&'a dyn Host>,
    waker: &'a Waker,
    /// Microseconds of inline work left this frame, by estimate.
    left: u32,
}

impl<'a> Jobs<'a> {
    pub(crate) fn new(host: Option<&'a dyn Host>, waker: &'a Waker) -> Jobs<'a> {
        Jobs { host, waker, left: FRAME_WORK }
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
        let pending = match self.host {
            Some(host) => host.spawn(job),
            None => Pending::ready(Ok(job.run())),
        };
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

/// What every derivation reads: the scene and its data, the host that measures text and does jobs,
/// what a landing job wakes, and whether rows are being dragged.
pub(crate) struct Input<'a> {
    pub(crate) scene: &'a Scene,
    /// Bumps whenever the scene changes.
    pub(crate) scene_version: u64,
    pub(crate) data: &'a [Data],
    pub(crate) host: Option<&'a dyn Host>,
    pub(crate) waker: &'a Waker,
    /// Whether rows are being dragged: what they move derives on the frame, however much.
    pub(crate) dragging: bool,
}

impl Input<'_> {
    /// The dataset named `name`.
    pub(crate) fn data(&self, name: &str) -> Option<&Data> {
        self.data.iter().find(|d| d.name() == name)
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

    /// The tables it derives.
    fn tables(&self) -> &Tables;

    /// Forgets what it derived: its space no longer asks for it.
    fn clear(&mut self);
}

/// Every derivation of a view, run in order each frame with one budget.
#[derive(Default)]
pub(crate) struct Derivations {
    /// A diagram's sheet.
    pub(crate) sheet: Sheet,
    /// Elsewhere, the lanes of edges sharing their ends.
    lanes: lanes::Lanes,
    shapes: shapes::Shapes,
    /// The tiles the camera asks for, as datasets the view owns.
    pub(crate) tiles: tiles::TileSets,
    /// What the view draws of each dataset it draws in part.
    pub(crate) tiled: tiled::Tiled,
}

/// The derived tables beside one drawn table: the sheet's or the lanes', then the shapes'.
pub(crate) type Beside<'a> = [Option<&'a Table>; 2];

impl Derivations {
    /// Brings every derivation up to `input`; whether any table changed.
    pub(crate) fn update(&mut self, input: &Input<'_>) -> bool {
        let mut jobs = Jobs::new(input.host, input.waker);
        let diagram = matches!(input.scene.space, Space::Diagram(_));
        let (on, off): (&mut dyn Derive, &mut dyn Derive) =
            if diagram { (&mut self.sheet, &mut self.lanes) } else { (&mut self.lanes, &mut self.sheet) };
        off.clear();
        let mut changed = on.update(input, &mut jobs);
        changed |= self.shapes.update(input, &mut jobs);
        changed
    }

    /// Whether a job or a fetch any derivation asked for is under way.
    pub(crate) fn busy(&self) -> bool {
        self.sheet.busy() || self.lanes.busy() || self.shapes.busy() || self.tiles.busy() || self.tiled.busy()
    }

    /// Whether shapes are being triangulated or bent: until they land, marks draw the ones before.
    pub(crate) fn shaping(&self) -> bool {
        self.shapes.busy()
    }

    /// The derived tables beside table `table` of dataset `data`.
    pub(crate) fn beside(&self, data: &Name, table: &Name) -> Beside<'_> {
        let key = (data.clone(), table.clone());
        let first = self.sheet.tables().get(&key).or_else(|| self.lanes.tables().get(&key));
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
/// them, so nothing uploads again.
pub(crate) fn kept(name: &str, values: &Values, source: &Table, before: Option<&Table>) -> Field {
    let old = before.filter(|b| b.structure == source.structure).and_then(|b| match b.field_named(name) {
        Some(field @ Field::Values(column, _)) if same(column, values) => Some(field.clone()),
        _ => None,
    });
    old.unwrap_or_else(|| Field::Values(Column::new(values), Version::next()))
}

/// Whether `column` holds exactly `values`.
fn same(column: &Column, values: &Values) -> bool {
    column.len() == values.len() && (0..values.len()).all(|i| column.get(i) == values.get(i))
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
