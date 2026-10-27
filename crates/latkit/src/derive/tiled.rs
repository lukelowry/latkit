//! Tables drawn in a computed order: by priority, or by the tiles in sight.
//!
//! A table with a priority draws its rows in priority order, highest on top. A paged table (too
//! large to draw whole) draws the rows of the tiles the camera needs, or, where nothing places its
//! rows, the rows that matter most. Each draws in an [`Order`]. The order is its pyramid's,
//! computed from where its rows lie and their priority: on the frame when that fits the budget,
//! else in one job per dataset. Until the pyramid arrives, the table draws an even sample of its
//! rows first, enough for a first look, after the rows that sampled edges end at.
//!
//! A table and the table its edges end at draw from their pyramids together, or both from their
//! samples. A pyramid serves while the rows it was made from are unchanged. Rows appended since
//! draw after them, so appending never thins the drawn rows; once the appended rows reach an
//! eighth of the pyramid's rows (at least a page), the pyramid is rebuilt. What the camera needs of
//! a table is ranges of its order, so nothing is gathered as it moves.

use std::ops::Range;
use std::sync::Arc;

use super::order::{Lifted, Order};
use super::pyramid::{Leveling, Places, Placing, Pyramid, answer};
use super::sight::{Domain, Sight};
use super::{Jobs, Working, stamp_of};
use crate::data::{Column, Field, Keyed, Name, Named, Reference, Snapshot, Table, UNWIRED, Version};
use crate::expr::Expr;
use crate::expr::cpu::Rows;
use crate::gpu::shaders::PAGE_ROWS;
use crate::host::Job;

/// Estimated microseconds to place one row in a pyramid.
const PLACE_COST: f64 = 1.0;
/// The most rows a table samples before its pyramid arrives: enough for a first look at all of it.
const SAMPLE: u32 = 1 << 16;

/// How a table draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Draw {
    /// Every row.
    Whole,
    /// The rows of the tiles the camera needs, at most `rows`.
    Tiles { rows: u32 },
    /// The `rows` rows that matter most.
    First { rows: u32 },
}

/// Where a table's rows lie, as the mark drawing them places them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Place {
    /// Not in a space tiles cover: neither a map nor a plane.
    Nowhere,
    /// At one point per row: x and y.
    Points([Expr; 2]),
    /// Along a geometry field.
    Geometry(Name),
    /// Between the rows its endpoint reference fields name.
    Ends(Vec<Name>),
}

/// How one table draws, with the inputs its order reads: priority and placement.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Planned {
    pub(crate) draw: Draw,
    /// Each row's priority, from the first mark that gives one.
    pub(crate) priority: Option<Expr>,
    pub(crate) place: Place,
}

impl Planned {
    /// Whether the table draws whole in table order, needing no pyramid.
    pub(crate) fn as_is(&self) -> bool {
        self.draw == Draw::Whole && self.priority.is_none()
    }
}

/// How each drawn table draws, by dataset and table.
pub(crate) type Plans = Keyed<(Name, Name), Planned>;

/// This frame's inputs for tables drawn in a computed order.
pub(crate) struct Ask<'a> {
    pub(crate) data: &'a [Snapshot],
    pub(crate) plans: &'a Plans,
    /// The camera's view, on a map or a plane.
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) earth: bool,
}

/// What a view draws of a paged table: its order, and the ranges of it to draw, finest tiles first
/// so more important rows draw on top. `capped` is whether the plan's row budget dropped some of
/// what the camera needs; only then does a smaller budget draw less of the table.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Chosen {
    pub(crate) order: Order,
    pub(crate) ranges: Vec<Range<u32>>,
    pub(crate) capped: bool,
}

/// What each paged table draws, by dataset and table.
pub(crate) type Choices = Keyed<(Name, Name), Chosen>;

/// The pyramids of each dataset with paged tables.
#[derive(Default)]
pub(crate) struct Tiled {
    sets: Vec<Set>,
}

impl Tiled {
    /// Updates each dataset's pyramids to `ask`, and chooses what each paged table draws.
    pub(crate) fn update(&mut self, ask: &Ask<'_>, jobs: &mut Jobs<'_>) -> Choices {
        let mut wanted: Vec<&Name> = Vec::new();
        for ((data, _), planned) in ask.plans {
            if !planned.as_is() && !wanted.contains(&data) {
                wanted.push(data);
            }
        }
        self.sets.retain(|set| wanted.contains(&&set.name) && ask.data.iter().any(|d| *d.name() == set.name));
        let mut choices = Choices::default();
        for name in wanted {
            let Some(source) = ask.data.iter().find(|d| d.name() == name) else { continue };
            let i = self.sets.iter().position(|s| s.name == *name).unwrap_or_else(|| {
                self.sets.push(Set::new(name.clone()));
                self.sets.len() - 1
            });
            self.sets[i].update(source, ask, jobs, &mut choices);
        }
        choices
    }

    /// Whether every paged table draws from its pyramid: no pyramid job is pending and no table
    /// draws its sample.
    pub(crate) fn complete(&self) -> bool {
        self.sets.iter().all(|s| !s.working.busy() && !s.sampling)
    }

    /// The bounds of every row of paged table `table` of dataset `data` (west, south, east, north,
    /// in position units), regardless of the tiles drawn. A fit to everything frames them.
    pub(crate) fn bounds(&self, data: &Name, table: &Name) -> Option<[f64; 4]> {
        let set = self.sets.iter().find(|s| s.name == *data)?;
        set.placed.get(table).and_then(|placed| placed.bounds)
    }
}

/// A table's pyramid, with the table's order version it was made from, the square it tiles, and
/// the bounds of its rows in position units.
struct Placed {
    order: Version,
    domain: Domain,
    pyramid: Arc<Pyramid>,
    bounds: Option<[f64; 4]>,
}

impl Placed {
    /// Whether it still serves `table`: the rows it was made from are unchanged, apart from rows
    /// appended since.
    fn serves(&self, table: &Table) -> bool {
        self.order == table.order && table.len() >= self.pyramid.rows() as usize
    }
}

/// What a dataset's pyramid job answers: the tables, each with its index among those asked, its
/// order version when asked, and its bounds; and the square the pyramids tile.
struct Pyramids {
    tables: Vec<(u32, Name, Version, Option<[f64; 4]>)>,
    domain: Domain,
}

/// The inputs a table's pyramid was requested from, as last seen: its row count and order version,
/// a stamp of how it is placed, and the columns placing it. Also whether any of those rows was
/// written since.
struct Read {
    rows: usize,
    order: Version,
    inputs: u64,
    columns: Vec<(Name, Column)>,
    written: bool,
}

impl Read {
    fn new(table: &Table, planned: &Planned, earth: bool) -> Read {
        let columns = fields_read(planned)
            .into_iter()
            .filter_map(|name| column_of(table, &name).map(|column| (name.clone(), column.clone())))
            .collect();
        Read { rows: table.len(), order: table.order, inputs: inputs_of(planned, earth), columns, written: false }
    }

    /// Checks `table` again, setting `written` if a row it had was written since, or its rows were
    /// reordered or removed. Once set, it stays set.
    fn see(&mut self, table: &Table) {
        if self.written {
            return;
        }
        let rows = self.rows;
        self.written = table.order != self.order
            || table.len() < rows
            || self.columns.iter_mut().any(|(name, then)| match column_of(table, name) {
                Some(now) if now.kept_below(then, rows) => {
                    *then = now.clone();
                    false
                }
                _ => true,
            });
    }
}

/// The pyramids of one dataset with paged tables.
struct Set {
    name: Name,
    /// The stamp of everything its pyramids are placed from, as last seen.
    stamp: u64,
    /// Each table's latest pyramid.
    placed: Named<Placed>,
    /// The pyramid job, for the stamp it was asked at.
    working: Working<Pyramids>,
    /// The inputs of the last pyramid request, by table.
    read: Named<Read>,
    /// Per table: the stamp of its inputs, the rows that sampled edges ending at it end at (lifted
    /// into its sample), and the step of its own sample.
    lifted: Named<(u64, Lifted, u32)>,
    /// Whether any table draws its sample because no pyramid serves it yet.
    sampling: bool,
}

impl Set {
    fn new(name: Name) -> Set {
        Set {
            name,
            stamp: 0,
            placed: Named::default(),
            working: Working::default(),
            read: Named::default(),
            lifted: Named::default(),
            sampling: false,
        }
    }

    /// Updates the pyramids to `ask`, and chooses what each paged table draws.
    fn update(&mut self, source: &Snapshot, ask: &Ask<'_>, jobs: &mut Jobs<'_>, choices: &mut Choices) {
        let landed = self.land();
        let placing = placed(source, ask);
        let stamp = stamp(source, ask, &placing);
        if !placing.is_empty() && (stamp != self.stamp || landed) {
            self.stamp = stamp;
            for (table, _) in &placing {
                if let Some(read) = self.read.get_mut(&table.name) {
                    read.see(table);
                }
            }
            if !self.holds(&placing, ask.earth) {
                self.level(&placing, ask, jobs);
            }
        }
        self.sampling = false;
        let drawn: Vec<(&Table, &Planned)> = source
            .tables()
            .filter_map(|table| {
                let planned = ask.plans.get(&(source.name().clone(), table.name.clone()))?;
                (!planned.as_is()).then_some((table, planned))
            })
            .collect();
        // A table draws from its pyramid only while that pyramid serves it and so do the pyramids
        // of the table its edges end at and of the edge tables ending at it, since edges and their
        // endpoints are assigned levels together.
        let ends: Vec<Option<usize>> = drawn
            .iter()
            .map(|(table, planned)| {
                let to = ends_of(table, planned).filter(|to| **to != table.name)?;
                drawn.iter().position(|(t, _)| t.name == *to)
            })
            .collect();
        let mut served: Vec<bool> =
            drawn.iter().map(|(table, _)| self.placed.get(&table.name).is_some_and(|p| p.serves(table))).collect();
        while let Some((i, j)) =
            ends.iter().enumerate().find_map(|(i, end)| end.filter(|&j| served[i] != served[j]).map(|j| (i, j)))
        {
            (served[i], served[j]) = (false, false);
        }
        let (sample, steps) = samples(&drawn, &ends);
        let mut lifted: Named<(u64, Lifted, u32)> = Named::default();
        for (i, (table, planned)) in drawn.iter().enumerate() {
            let key = (source.name().clone(), table.name.clone());
            let len = table.len() as u32;
            let placed = self.placed.get(&table.name).filter(|_| served[i]);
            let chosen = match (placed, planned.draw) {
                (None, Draw::Whole) => continue,
                (None, Draw::Tiles { .. } | Draw::First { .. }) => {
                    self.sampling = true;
                    // The rows sampled edges end at draw first, as in a pyramid.
                    let edges: Vec<usize> = (0..drawn.len()).filter(|&e| ends[e] == Some(i)).collect();
                    let (rows, step) = if edges.is_empty() {
                        (Lifted::default(), steps[i])
                    } else {
                        let was = self.lifted.get(&table.name);
                        let made = lift(&drawn, &edges, &steps, i, sample[i], was);
                        let chosen = (made.1.clone(), made.2);
                        lifted.insert(table.name.clone(), made);
                        chosen
                    };
                    let order = Order::Sampled { rows: len, step, lifted: rows };
                    let sampled = order.sampled();
                    Chosen { order, ranges: std::iter::once(0..sampled).collect(), capped: sampled < len }
                }
                (Some(placed), draw) => {
                    let pyramid = &placed.pyramid;
                    let made = pyramid.rows();
                    let (ranges, capped) = match draw {
                        Draw::Whole => (std::iter::once(0..len).collect(), false),
                        // The rows that matter most are last in the order; appended rows draw too.
                        Draw::First { rows } => (std::iter::once(made - rows.min(made)..len).collect(), rows < made),
                        Draw::Tiles { rows } => {
                            let (mut wanted, capped) =
                                ask.sight.map(|s| pyramid.wanted(s, &placed.domain, rows)).unwrap_or_default();
                            // Finest first, so more important rows draw last, on top.
                            crate::order::by_key(&mut wanted, |(z, range)| {
                                !crate::order::pair(u32::from(*z), !range.start)
                            });
                            let mut ranges: Vec<Range<u32>> = wanted.into_iter().map(|(_, range)| range).collect();
                            if len > made {
                                ranges.push(made..len);
                            }
                            (ranges, capped)
                        }
                    };
                    Chosen { order: Order::Pyramid { pyramid: pyramid.clone(), rows: len }, ranges, capped }
                }
            };
            choices.insert(key, chosen);
        }
        self.lifted = lifted;
    }

    /// Whether the last request still serves `placing`: the same tables, placed the same way, with
    /// no rows written since except appended ones. With no job pending, each table's pyramid must
    /// also serve it, with fewer rows appended since than an eighth of the rows it was made from
    /// (at least a page). A pending job keeps running while only rows were appended, so appends
    /// never starve the pyramids; once it finishes, it serves until that many rows are appended.
    fn holds(&self, placing: &[(&Table, &Planned)], earth: bool) -> bool {
        placing.len() == self.read.len()
            && placing.iter().all(|(table, planned)| {
                let Some(read) = self.read.get(&table.name) else { return false };
                if read.written || read.inputs != inputs_of(planned, earth) {
                    return false;
                }
                let served = planned.as_is() || self.placed.get(&table.name).is_some_and(|p| p.serves(table));
                let appended = table.len().saturating_sub(read.rows);
                self.working.busy() || (served && appended < (read.rows / 8).max(PAGE_ROWS as usize))
            })
    }

    /// Takes the pyramids of a finished job. Returns true when a job succeeded. A failed job is not
    /// retried until its inputs change.
    fn land(&mut self) -> bool {
        let Some((_, asked, Ok(bytes))) = self.working.landed() else { return false };
        for (index, pyramid) in Pyramid::read(&bytes) {
            if let Some((_, name, order, bounds)) = asked.tables.iter().find(|t| t.0 == index) {
                let placed =
                    Placed { order: *order, domain: asked.domain, pyramid: Arc::new(pyramid), bounds: *bounds };
                self.placed.insert(name.clone(), placed);
            }
        }
        true
    }

    /// Requests the pyramids of `placing`: computed at once when they fit the frame's budget, else
    /// in one job for the dataset.
    fn level(&mut self, placing: &[(&Table, &Planned)], ask: &Ask<'_>, jobs: &mut Jobs<'_>) {
        // Drop any pending job; its answer would no longer serve.
        self.working.cancel();
        self.read =
            placing.iter().map(|(table, planned)| (table.name.clone(), Read::new(table, planned, ask.earth))).collect();
        let (leveling, bounds) = leveling(ask, placing);
        // Placing a row takes about a microsecond; ordering one by priority alone, a twentieth.
        let cost: f64 = leveling
            .tables
            .iter()
            .map(|t| f64::from(t.rows) * if t.leveled { PLACE_COST } else { PLACE_COST / 20.0 })
            .sum();
        let tables: Vec<(u32, Name, Version, Option<[f64; 4]>)> = placing
            .iter()
            .enumerate()
            .filter(|(i, _)| leveling.tables[*i].answered)
            .map(|(i, (table, _))| (i as u32, table.name.clone(), table.order, bounds.get(&table.name).copied()))
            .collect();
        let domain = leveling.domain;
        if jobs.fits(cost as u64) {
            for (index, pyramid) in answer(&leveling) {
                if let Some((_, name, order, bounds)) = tables.iter().find(|t| t.0 == index) {
                    let placed = Placed { order: *order, domain, pyramid: Arc::new(pyramid), bounds: *bounds };
                    self.placed.insert(name.clone(), placed);
                }
            }
            return;
        }
        self.working.start(self.stamp, jobs.spawn(Job::pyramid(&leveling)), Pyramids { tables, domain });
    }
}

/// Each table's sample size until its pyramid arrives (its plan's row budget, at most `SAMPLE`),
/// and its sample step. The endpoints of sampled edges count toward their target table's sample
/// (per `ends`), so edges sample sparsely enough that their endpoints fill at most half the
/// target's sample; the target's own sample fills the rest.
fn samples(drawn: &[(&Table, &Planned)], ends: &[Option<usize>]) -> (Vec<u32>, Vec<u32>) {
    let sample: Vec<u32> = drawn
        .iter()
        .map(|(table, planned)| match planned.draw {
            Draw::Tiles { rows } | Draw::First { rows } => rows.clamp(1, SAMPLE),
            Draw::Whole => table.len() as u32,
        })
        .collect();
    let steps = drawn
        .iter()
        .enumerate()
        .map(|(e, (table, planned))| {
            let ends = ends[e].filter(|&i| planned.draw != Draw::Whole && drawn[i].1.draw != Draw::Whole);
            let room = ends.map_or(u32::MAX, |i| {
                let references = match &planned.place {
                    Place::Ends(fields) => fields.len().max(1) as u32,
                    _ => 1,
                };
                (sample[i] / 2 / references).max(1)
            });
            (table.len() as u32).div_ceil(sample[e].min(room)).max(1)
        })
        .collect();
    (sample, steps)
}

/// The rows of table `drawn[at]` that the sampled rows of edge tables `edges` end at (each edge
/// table sampling every `steps[e]`th row), lifted into its sample of `sample` rows, with the step
/// of its own even sample of the rest. Returns `was` when its input stamp is unchanged, else
/// recomputes; the result starts with that stamp.
fn lift(
    drawn: &[(&Table, &Planned)],
    edges: &[usize],
    steps: &[u32],
    at: usize,
    sample: u32,
    was: Option<&(u64, Lifted, u32)>,
) -> (u64, Lifted, u32) {
    let target = drawn[at].0;
    let references = |e: usize| -> Vec<&Reference> {
        let (table, planned) = drawn[e];
        let Place::Ends(fields) = &planned.place else { return Vec::new() };
        fields
            .iter()
            .filter_map(|f| match table.field_named(f) {
                Some(Field::Reference(r)) if r.to == target.name => Some(r),
                _ => None,
            })
            .collect()
    };
    let from = stamp_of((
        target.len(),
        sample,
        edges
            .iter()
            .map(|&e| (drawn[e].0.len(), steps[e], references(e).iter().map(|r| r.version).collect::<Vec<_>>()))
            .collect::<Vec<_>>(),
    ));
    if let Some(was) = was.filter(|(had, ..)| *had == from) {
        return was.clone();
    }
    let mut rows: Vec<u32> = Vec::new();
    for &e in edges {
        let references = references(e);
        let len = drawn[e].0.len() as u32;
        for k in 0..len.div_ceil(steps[e]) {
            for reference in &references {
                let t = reference.target_row((k * steps[e]) as usize);
                if t != UNWIRED {
                    rows.push(t);
                }
            }
        }
    }
    let (lifted, step) = Lifted::within(rows, target.len() as u32, sample);
    (from, lifted, step)
}

/// The tables of `source` a pyramid places, each with its plan: every table not drawn as is, and
/// every table that a tiled edge table's endpoints reference, placed only to anchor those edges.
fn placed<'a>(source: &'a Snapshot, ask: &'a Ask<'_>) -> Vec<(&'a Table, &'a Planned)> {
    let plan = |table: &Table| ask.plans.get(&(source.name().clone(), table.name.clone()));
    let mut out: Vec<(&Table, &Planned)> = Vec::new();
    for table in source.tables() {
        let Some(planned) = plan(table) else { continue };
        let named = source.tables().any(|other| {
            plan(other).is_some_and(|p| matches!(p.draw, Draw::Tiles { .. }) && ends_of(other, p) == Some(&table.name))
        });
        if !planned.as_is() || named {
            out.push((table, planned));
        }
    }
    // Tables an edge table's endpoints reference come before it.
    crate::order::by_key(&mut out, |(_, p)| u64::from(matches!(p.place, Place::Ends(_))));
    out
}

/// The table that `table`'s endpoint references point to, when `planned` places it by endpoints.
pub(crate) fn ends_of<'t>(table: &'t Table, planned: &Planned) -> Option<&'t Name> {
    let Place::Ends(fields) = &planned.place else { return None };
    match table.field_named(fields.first()?)? {
        Field::Reference(reference) => Some(&reference.to),
        _ => None,
    }
}

/// The stamp of everything a dataset's pyramids are placed from.
fn stamp(source: &Snapshot, ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> u64 {
    let tables: Vec<_> = placed
        .iter()
        .map(|(table, planned)| {
            let versions: Vec<_> =
                fields_read(planned).iter().map(|f| table.field_named(f).map(Field::version)).collect();
            (inputs_of(planned, ask.earth), table.structure, table.order, versions)
        })
        .collect();
    stamp_of((source.name(), tables))
}

/// A stamp of what a pyramid for `planned` depends on besides its rows: how rows are placed and
/// prioritized, whether they draw by tile or as is, and whether the space is the earth.
fn inputs_of(planned: &Planned, earth: bool) -> u64 {
    let tiles = matches!(planned.draw, Draw::Tiles { .. });
    stamp_of((format!("{:?}{:?}", planned.priority, planned.place), tiles, planned.as_is(), earth))
}

/// The fields of its own table a pyramid for `planned` reads: those of its priority and its place.
fn fields_read(planned: &Planned) -> Vec<Name> {
    let mut fields = Vec::new();
    if let Some(priority) = &planned.priority {
        fields_of(priority, &mut fields);
    }
    match &planned.place {
        Place::Points(xy) => xy.iter().for_each(|e| fields_of(e, &mut fields)),
        Place::Geometry(field) => fields.push(field.clone()),
        Place::Ends(ends) => fields.extend(ends.iter().cloned()),
        Place::Nowhere => {}
    }
    fields
}

/// The column a pyramid reads for field `name` of `table`: its values, or a reference's target ids.
fn column_of<'t>(table: &'t Table, name: &Name) -> Option<&'t Column> {
    match table.field_named(name)? {
        Field::Values(column, _) => Some(column),
        Field::Reference(reference) => Some(&reference.ids),
        Field::Sampled(..) => None,
    }
}

/// The fields `expr` reads of its mark's own table.
fn fields_of(expr: &Expr, out: &mut Vec<Name>) {
    expr.for_each_field(&mut |f| {
        if f.from.is_none() {
            out.push(f.name.clone());
        }
    });
}

/// The box (west, south, east, north) around every placed row of `places`; inverted when none is.
fn bounds_of(places: &Places) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let mut take = |r: [f64; 4]| {
        if r.iter().all(|v| v.is_finite()) {
            b = [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[2]), b[3].max(r[3])];
        }
    };
    match places {
        Places::None => {}
        Places::Points(points) => points.iter().for_each(|p| take([p[0], p[1], p[0], p[1]].map(f64::from))),
        Places::Boxes(boxes) => boxes.iter().for_each(|r| take(r.map(f64::from))),
    }
    b
}

/// Where `table`'s rows lie, per `place`: a point or a geometry's box per row.
fn locate(table: &Table, place: &Place, all: &[Snapshot]) -> Places {
    match place {
        Place::Points([x, y]) => {
            let rows = Rows::new(table, all);
            let (xs, ys) = (rows.numbers(x, |v| v as f32), rows.numbers(y, |v| v as f32));
            Places::Points(xs.into_iter().zip(ys).map(|(x, y)| [x, y]).collect())
        }
        Place::Geometry(field) => {
            let Some(Field::Values(column, _)) = table.field_named(field) else { return Places::None };
            let mut boxes = Vec::with_capacity(table.len());
            for page in column.pages() {
                let geometry = page.values.geometry();
                for i in 0..page.values.len() {
                    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
                    if let Some(g) = geometry.filter(|_| page.values.is_valid(i)) {
                        for p in g.row_coords(i) {
                            if p[0].is_finite() && p[1].is_finite() {
                                b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
                            }
                        }
                    }
                    boxes.push(b);
                }
            }
            Places::Boxes(boxes.into_iter().map(|b: [f64; 4]| b.map(|v| v as f32)).collect())
        }
        Place::Ends(_) | Place::Nowhere => Places::None,
    }
}

/// The pyramid job input for `placed`, in the square they tile, and each table's bounds.
fn leveling(ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> (Leveling, Named<[f64; 4]>) {
    let names: Vec<Name> = placed.iter().map(|(t, _)| t.name.clone()).collect();
    let mut tables: Vec<Placing> = placed
        .iter()
        .map(|(table, planned)| {
            // Tiled tables are placed, and so are tables drawn as is, which are here only to anchor
            // the tiled edges ending at them.
            let anchors = matches!(planned.draw, Draw::Tiles { .. }) || planned.as_is();
            let places = if anchors { locate(table, &planned.place, ask.data) } else { Places::None };
            Placing { rows: table.len() as u32, answered: !planned.as_is(), places, ..Placing::default() }
        })
        .collect();
    let mut bounds: Named<[f64; 4]> = Named::default();
    let mut all = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for (name, placing) in names.iter().zip(&tables) {
        let b = bounds_of(&placing.places);
        if b[0] <= b[2] {
            all = [all[0].min(b[0]), all[1].min(b[1]), all[2].max(b[2]), all[3].max(b[3])];
            bounds.insert(name.clone(), b);
        }
    }
    let domain = if ask.earth { Domain::Earth } else { Domain::plane(all) };
    for (i, (table, planned)) in placed.iter().enumerate() {
        let placing = &mut tables[i];
        if let (Place::Ends(fields), Some(to)) = (&planned.place, ends_of(table, planned))
            && let Some(target) = names.iter().position(|n| n == to)
            && !placed[target].1.place.eq(&Place::Nowhere)
        {
            let ends: Option<Vec<Arc<[u32]>>> = fields
                .iter()
                .map(|f| match table.field_named(f) {
                    Some(Field::Reference(r)) if r.to == *to => Some(r.targets().into()),
                    _ => None,
                })
                .collect();
            placing.ends = ends.map(|ends| (target as u32, ends));
        }
        placing.leveled = matches!(planned.draw, Draw::Tiles { .. })
            && (!matches!(placing.places, Places::None) || placing.ends.is_some());
        if let Some(priority) = &planned.priority {
            placing.priority = Rows::new(table, ask.data).numbers(priority, |p| p as f32).into();
        }
    }
    (Leveling { domain, tables }, bounds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Data, Ids, Patch};

    #[test]
    fn a_sample_lifts_the_endpoints_of_its_sampled_edges() {
        // A thousand vertices, and a thousand edges between vertices far apart in the table.
        let n = 1000_u64;
        let data = Data::new("g");
        data.apply(
            Patch::new().set(Table::new("V", Ids::count(n as u32)).field("x", vec![0.0; n as usize])).set(
                Table::new("E", Ids::count(n as u32))
                    .reference("a", "V", (0..n).map(|e| (e * 7) % n).collect::<Vec<_>>())
                    .reference("b", "V", (0..n).map(|e| (e * 13 + 1) % n).collect::<Vec<_>>()),
            ),
        )
        .expect("valid");
        let data = data.snapshot();
        let (vertices, edges) = (data.table("V").expect("set"), data.table("E").expect("set"));
        let tiles = |place| Planned { draw: Draw::Tiles { rows: 100 }, priority: None, place };
        let (at, ends) = (tiles(Place::Nowhere), tiles(Place::Ends(vec!["a".into(), "b".into()])));
        let drawn = [(vertices, &at), (edges, &ends)];
        let (from, lifted, step) = lift(&drawn, &[1], &[10, 10], 0, 300, None);
        let order = Order::Sampled { rows: n as u32, step, lifted: lifted.clone() };
        // Every sampled edge ends at rows the vertices' sample draws.
        for e in (0..n).step_by(10) {
            for t in [(e * 7) % n, (e * 13 + 1) % n] {
                assert!(order.rank(t as u32) < order.sampled(), "vertex {t}, an endpoint of edge {e}, draws first");
            }
        }
        assert!(order.sampled() <= 300, "lifted rows count toward the sample's 300 rows");
        let again = lift(&drawn, &[1], &[10, 10], 0, 300, Some(&(from, lifted, step)));
        assert_eq!(again.0, from, "computed once while its edges are unchanged");
    }

    #[test]
    fn a_pyramid_reads_every_field_its_priority_tests() {
        let priority = crate::when(crate::field("name").contains("lake")).then(crate::field("size")).otherwise(0.0);
        let x = [crate::field("x"), crate::field("y")];
        let planned = Planned { draw: Draw::Tiles { rows: 100 }, priority: Some(priority), place: Place::Points(x) };
        assert_eq!(fields_read(&planned), ["name", "size", "x", "y"].map(Name::from));
    }
}
