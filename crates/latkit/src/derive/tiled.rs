//! Tables drawn in part. A table with a priority draws its rows in priority order, the highest on
//! top; one too large to draw whole draws the rows of the tiles the camera asks for, or where nothing
//! places its rows, those that matter most. Each draws in an [`Order`]: its pyramid's, worked out from
//! where its rows lie and their priority, on the frame while that fits its budget, else in a job, a
//! dataset's tables in one; until it lands, an even sample of its rows first, as many as a first look
//! needs, after the rows the edges sampled end at. A table and the tables its edges end at draw from
//! their pyramids together, or from their samples. A pyramid serves while the rows it was made from
//! hold; rows appended since draw after them, so appending never thins what draws, until they are an
//! eighth as many and it is made again. What the camera asks for of a table is ranges of its order:
//! nothing is gathered as it moves.

use std::ops::Range;
use std::sync::Arc;

use super::order::{Lifted, Order, PAGE};
use super::pyramid::{Leveling, Places, Placing, Pyramid, answer};
use super::sight::{Domain, Sight};
use super::{Jobs, stamp_of};
use crate::Pending;
use crate::data::{Column, Data, Field, Keyed, Name, Named, Reference, Table, UNWIRED, Version};
use crate::expr::cpu::Rows;
use crate::expr::{Expr, Node};
use crate::host::Job;

/// Microseconds placing a row takes, by estimate.
const PLACE_COST: f64 = 1.0;
/// Rows a table drawn in part draws at most until its pyramid lands: a first look at all of it.
const SAMPLE: u32 = 1 << 16;

/// How a table draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Draw {
    /// Every row.
    Whole,
    /// The rows of the tiles the camera asks for, as many as `rows` at most.
    Tiles { rows: u32 },
    /// The `rows` rows that matter most.
    First { rows: u32 },
}

/// Where a table's rows lie, as the mark drawing them places them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Place {
    /// Nowhere a camera's tiles reach: off a map or a plane.
    Nowhere,
    /// At a point each: x and y.
    Points([Expr; 2]),
    /// Along a geometry field.
    Geometry(Name),
    /// Between the rows its reference fields name.
    Ends(Vec<Name>),
}

/// How one table draws, and what that reads.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Planned {
    pub(crate) draw: Draw,
    /// Each row's priority, as the first mark giving one has it.
    pub(crate) priority: Option<Expr>,
    pub(crate) place: Place,
}

impl Planned {
    /// Whether the table draws as it is: whole, in its own order.
    pub(crate) fn as_is(&self) -> bool {
        self.draw == Draw::Whole && self.priority.is_none()
    }
}

/// How each table drawn draws, by dataset and table.
pub(crate) type Plans = Keyed<(Name, Name), Planned>;

/// What drawing in part reads this frame.
pub(crate) struct Ask<'a> {
    pub(crate) sources: &'a [Data],
    pub(crate) plans: &'a Plans,
    /// What the camera sees, on a map or a plane.
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) earth: bool,
}

/// What a view draws of a table drawn in part: its order, and the ranges of it the camera asks for,
/// finest tiles first, so what matters more draws on top.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Chosen {
    pub(crate) order: Order,
    pub(crate) ranges: Vec<Range<u32>>,
}

/// What each table drawn in part draws, by dataset and table.
pub(crate) type Choices = Keyed<(Name, Name), Chosen>;

/// The pyramids of each dataset drawn in part.
#[derive(Default)]
pub(crate) struct Tiled {
    sets: Vec<Set>,
}

impl Tiled {
    /// Brings each dataset's pyramids up to `ask`, and chooses what each table drawn in part draws.
    pub(crate) fn update(&mut self, ask: &Ask<'_>, jobs: &mut Jobs<'_>) -> Choices {
        let mut wanted: Vec<&Name> = Vec::new();
        for ((data, _), planned) in ask.plans {
            if !planned.as_is() && !wanted.contains(&data) {
                wanted.push(data);
            }
        }
        self.sets.retain(|set| wanted.contains(&&set.name) && ask.sources.iter().any(|d| *d.name() == set.name));
        let mut choices = Choices::default();
        for name in wanted {
            let Some(source) = ask.sources.iter().find(|d| d.name() == name) else { continue };
            let i = self.sets.iter().position(|s| s.name == *name).unwrap_or_else(|| {
                self.sets.push(Set::new(name.clone()));
                self.sets.len() - 1
            });
            self.sets[i].update(source, ask, jobs, &mut choices);
        }
        choices
    }

    /// Whether every table drawn in part draws from its pyramid: none draws its first sample while
    /// its pyramid is worked out.
    pub(crate) fn complete(&self) -> bool {
        self.sets.iter().all(|s| s.working.is_none() && !s.sampling)
    }

    /// The bounds of every row of table `table` of dataset `data` drawn through tiles, west, south,
    /// east, north in position units: what a fit of everything frames, whatever tiles are drawn.
    pub(crate) fn bounds(&self, data: &Name, table: &Name) -> Option<[f64; 4]> {
        let set = self.sets.iter().find(|s| s.name == *data)?;
        set.placed.get(table).and_then(|placed| placed.bounds)
    }
}

/// A table's pyramid: the order of the table's rows it was made from, the square it tiles, and the
/// bounds of its rows in position units.
struct Placed {
    order: Version,
    domain: Domain,
    pyramid: Arc<Pyramid>,
    bounds: Option<[f64; 4]>,
}

impl Placed {
    /// Whether it serves `table`: the rows it was made from hold, rows appended since aside.
    fn serves(&self, table: &Table) -> bool {
        self.order == table.order && table.len() >= self.pyramid.rows() as usize
    }
}

/// A dataset's pyramid job under way: the tables it answers, by their place among those asked, each
/// with the order of its rows asked from, and the square and bounds its pyramid is kept with.
struct Working {
    pending: Pending<Vec<u8>>,
    tables: Vec<(u32, Name, Version, Option<[f64; 4]>)>,
    domain: Domain,
}

/// What a table's pyramid was asked for from: its rows and their order then, how it is placed, and
/// the columns placing it, as last seen; and whether a row of those it had was written since.
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

    /// Sees `table` anew: whether a row it had was written since, or its rows reordered or removed.
    /// Once one was, it stays so.
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

/// One dataset drawn in part.
struct Set {
    name: Name,
    /// The stamp of everything its pyramids are placed from, as last seen.
    stamp: u64,
    /// Each table's pyramid, as last placed.
    placed: Named<Placed>,
    working: Option<Working>,
    /// What the pyramids last asked for were asked from, by table.
    read: Named<Read>,
    /// Each table's rows that the samples of the edges ending at it end at, and what they were worked
    /// out from.
    lifted: Named<(u64, Lifted)>,
    /// Whether a table draws an even sample of its rows until its pyramid lands.
    sampling: bool,
}

impl Set {
    fn new(name: Name) -> Set {
        Set {
            name,
            stamp: 0,
            placed: Named::default(),
            working: None,
            read: Named::default(),
            lifted: Named::default(),
            sampling: false,
        }
    }

    /// Brings the pyramids up to `ask`, and chooses what each table drawn in part draws.
    fn update(&mut self, source: &Data, ask: &Ask<'_>, jobs: &mut Jobs<'_>, choices: &mut Choices) {
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
        // Each draws from its pyramid while that serves it, and while the pyramids of the table its
        // edges end at and of the edges ending at it do: edges land with their ends.
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
        let steps: Vec<u32> = drawn
            .iter()
            .map(|(table, planned)| match planned.draw {
                Draw::Tiles { rows } | Draw::First { rows } => {
                    (table.len() as u32).div_ceil(rows.clamp(1, SAMPLE)).max(1)
                }
                Draw::Whole => 1,
            })
            .collect();
        let mut lifted: Named<(u64, Lifted)> = Named::default();
        for (i, (table, planned)) in drawn.iter().enumerate() {
            let key = (source.name().clone(), table.name.clone());
            let len = table.len() as u32;
            let placed = self.placed.get(&table.name).filter(|_| served[i]);
            let chosen = match (placed, planned.draw) {
                (None, Draw::Whole) => continue,
                (None, Draw::Tiles { .. } | Draw::First { .. }) => {
                    self.sampling = true;
                    // The rows the edges sampled end at draw first, as they land with them in a pyramid.
                    let edges: Vec<usize> = (0..drawn.len()).filter(|&e| ends[e] == Some(i)).collect();
                    let rows = if edges.is_empty() {
                        Lifted::default()
                    } else {
                        let was = self.lifted.get(&table.name);
                        let made = lift(&drawn, &edges, &steps, i, was);
                        let rows = made.1.clone();
                        lifted.insert(table.name.clone(), made);
                        rows
                    };
                    let order = Order::Sampled { rows: len, step: steps[i], lifted: rows };
                    let sampled = order.sampled();
                    Chosen { order, ranges: std::iter::once(0..sampled).collect() }
                }
                (Some(placed), draw) => {
                    let pyramid = &placed.pyramid;
                    let made = pyramid.rows();
                    let ranges = match draw {
                        Draw::Whole => std::iter::once(0..len).collect(),
                        // The rows that matter most draw last; rows appended since draw too.
                        Draw::First { rows } => std::iter::once(made - rows.min(made)..len).collect(),
                        Draw::Tiles { rows } => {
                            let mut wanted =
                                ask.sight.map(|s| pyramid.wanted(s, &placed.domain, rows)).unwrap_or_default();
                            // Finest first, so what matters more draws on top.
                            crate::order::by_key(&mut wanted, |(z, range)| {
                                !crate::order::pair(u32::from(*z), !range.start)
                            });
                            let mut ranges: Vec<Range<u32>> = wanted.into_iter().map(|(_, range)| range).collect();
                            if len > made {
                                ranges.push(made..len);
                            }
                            ranges
                        }
                    };
                    Chosen { order: Order::Pyramid { pyramid: pyramid.clone(), rows: len }, ranges }
                }
            };
            choices.insert(key, chosen);
        }
        self.lifted = lifted;
    }

    /// Whether what was last asked for still serves `placing`: the same tables, placed alike, none of
    /// whose rows were written since but those appended; while no job is under way, each table's
    /// pyramid serving it, the rows appended since fewer than an eighth of those it was made from, a
    /// page at least. A job under way keeps going while only rows were appended since it was asked,
    /// so appending never starves the pyramids; once it lands, it serves until the rows appended
    /// since are that many.
    fn holds(&self, placing: &[(&Table, &Planned)], earth: bool) -> bool {
        placing.len() == self.read.len()
            && placing.iter().all(|(table, planned)| {
                let Some(read) = self.read.get(&table.name) else { return false };
                if read.written || read.inputs != inputs_of(planned, earth) {
                    return false;
                }
                let served = planned.as_is() || self.placed.get(&table.name).is_some_and(|p| p.serves(table));
                let appended = table.len().saturating_sub(read.rows);
                self.working.is_some() || (served && appended < (read.rows / 8).max(PAGE as usize))
            })
    }

    /// Takes the pyramids a job answered, once it landed: whether it placed any. One that failed is
    /// asked again only once what it was asked from changes.
    fn land(&mut self) -> bool {
        let Some(working) = &self.working else { return false };
        let Some(landed) = working.pending.take() else { return false };
        let working = self.working.take().expect("under way");
        let Ok(bytes) = landed else { return false };
        for (index, pyramid) in Pyramid::read(&bytes) {
            if let Some((_, name, order, bounds)) = working.tables.iter().find(|t| t.0 == index) {
                let placed =
                    Placed { order: *order, domain: working.domain, pyramid: Arc::new(pyramid), bounds: *bounds };
                self.placed.insert(name.clone(), placed);
            }
        }
        true
    }

    /// Asks for the pyramids of `placing`: at once where they fit the frame, else in one job for the
    /// dataset.
    fn level(&mut self, placing: &[(&Table, &Planned)], ask: &Ask<'_>, jobs: &mut Jobs<'_>) {
        // What was asked before no longer serves once it lands.
        self.working = None;
        self.read =
            placing.iter().map(|(table, planned)| (table.name.clone(), Read::new(table, planned, ask.earth))).collect();
        let (leveling, bounds) = leveling(ask, placing);
        // Placing a row takes about a microsecond; ordering one by priority alone, far less.
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
        let pending = jobs.spawn(Job::pyramid(&leveling));
        self.working = Some(Working { pending, tables, domain });
    }
}

/// The rows of table `drawn[at]` that the samples of the edge tables `edges` among `drawn`, each
/// every `steps`th row, end at, lifted in its own sample: `was` where nothing it was worked out from
/// changed, else worked out again; and what they were worked out from.
fn lift(
    drawn: &[(&Table, &Planned)],
    edges: &[usize],
    steps: &[u32],
    at: usize,
    was: Option<&(u64, Lifted)>,
) -> (u64, Lifted) {
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
        steps[at],
        edges
            .iter()
            .map(|&e| (drawn[e].0.len(), steps[e], references(e).iter().map(|r| r.version).collect::<Vec<_>>()))
            .collect::<Vec<_>>(),
    ));
    if let Some(was) = was.filter(|(had, _)| *had == from) {
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
    (from, Lifted::new(rows, target.len() as u32, steps[at]))
}

/// The tables of `source` a pyramid places, each with its plan: every table drawn in part, and every
/// table the ends of one drawn through tiles name, which only anchors them.
fn placed<'a>(source: &'a Data, ask: &'a Ask<'_>) -> Vec<(&'a Table, &'a Planned)> {
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
    // Tables an edge table's ends name come before it.
    crate::order::by_key(&mut out, |(_, p)| u64::from(matches!(p.place, Place::Ends(_))));
    out
}

/// The table the ends of `table` name, as `planned` places it.
pub(crate) fn ends_of<'t>(table: &'t Table, planned: &Planned) -> Option<&'t Name> {
    let Place::Ends(fields) = &planned.place else { return None };
    match table.field_named(fields.first()?)? {
        Field::Reference(reference) => Some(&reference.to),
        _ => None,
    }
}

/// The stamp of everything a dataset's pyramids are placed from.
fn stamp(source: &Data, ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> u64 {
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

/// What a pyramid placing `planned`'s rows is made for besides its rows: how they are placed and
/// ordered, whether they draw through tiles or as they are, and on the earth or not.
fn inputs_of(planned: &Planned, earth: bool) -> u64 {
    let tiles = matches!(planned.draw, Draw::Tiles { .. });
    stamp_of((format!("{:?}{:?}", planned.priority, planned.place), tiles, planned.as_is(), earth))
}

/// The fields of its own table a pyramid places `planned`'s rows by: their priority, and where they
/// lie.
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

/// The column of field `name` of `table` a pyramid places its rows by: its values, or the rows a
/// reference names.
fn column_of<'t>(table: &'t Table, name: &Name) -> Option<&'t Column> {
    match table.field_named(name)? {
        Field::Values(column, _) => Some(column),
        Field::Reference(reference) => Some(&reference.ids),
        Field::Sampled(..) => None,
    }
}

/// The fields `expr` reads of its mark's own table.
fn fields_of(expr: &Expr, out: &mut Vec<Name>) {
    match &*expr.0 {
        Node::Field(f) if f.of.is_none() => out.push(f.name.clone()),
        Node::Unary(_, a) | Node::Is(a, _) => fields_of(a, out),
        Node::Binary(_, a, b) => {
            fields_of(a, out);
            fields_of(b, out);
        }
        Node::When(c, a, b) => {
            fields_of(c, out);
            fields_of(a, out);
            fields_of(b, out);
        }
        Node::Scale { input, .. } | Node::Colormap { input, .. } => fields_of(input, out),
        _ => {}
    }
}

/// The box every placed row of `places` lies in, west, south, east, north; inverted when none is.
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

/// Where `table`'s rows lie, as `place` puts them.
fn locate(table: &Table, place: &Place, all: &[Data]) -> Places {
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

/// What to ask pyramid jobs for `placed`, in the square they tile, and each table's bounds.
fn leveling(ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> (Leveling, Named<[f64; 4]>) {
    let names: Vec<Name> = placed.iter().map(|(t, _)| t.name.clone()).collect();
    let mut tables: Vec<Placing> = placed
        .iter()
        .map(|(table, planned)| {
            // Tables drawn through tiles are placed; one only an edge table's ends name anchors them.
            let anchors = matches!(planned.draw, Draw::Tiles { .. }) || planned.as_is();
            let places = if anchors { locate(table, &planned.place, ask.sources) } else { Places::None };
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
            placing.priority = Rows::new(table, ask.sources).numbers(priority, |p| p as f32).into();
        }
    }
    (Leveling { domain, tables }, bounds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Ids, Patch};

    #[test]
    fn a_sample_lifts_the_rows_its_edges_sampled_end_at() {
        // A thousand vertices, and a thousand edges between vertices far apart in the table.
        let n = 1000_u64;
        let mut data = Data::new("g");
        data.apply(
            Patch::new().set(Table::new("V", Ids::count(n as u32)).field("x", vec![0.0; n as usize])).set(
                Table::new("E", Ids::count(n as u32))
                    .reference("a", "V", (0..n).map(|e| (e * 7) % n).collect::<Vec<_>>())
                    .reference("b", "V", (0..n).map(|e| (e * 13 + 1) % n).collect::<Vec<_>>()),
            ),
        )
        .expect("valid");
        let (vertices, edges) = (data.table("V").expect("set"), data.table("E").expect("set"));
        let tiles = |place| Planned { draw: Draw::Tiles { rows: 100 }, priority: None, place };
        let (at, ends) = (tiles(Place::Nowhere), tiles(Place::Ends(vec!["a".into(), "b".into()])));
        let drawn = [(vertices, &at), (edges, &ends)];
        let (from, lifted) = lift(&drawn, &[1], &[10, 10], 0, None);
        let order = Order::Sampled { rows: n as u32, step: 10, lifted: lifted.clone() };
        // Every edge the edges' sample draws ends at a row the vertices' sample draws.
        for e in (0..n).step_by(10) {
            for t in [(e * 7) % n, (e * 13 + 1) % n] {
                assert!(order.rank(t as u32) < order.sampled(), "edge {e} ends at vertex {t}, drawn first");
            }
        }
        assert!(order.sampled() < n as u32, "and the rest wait for the pyramid");
        let again = lift(&drawn, &[1], &[10, 10], 0, Some(&(from, lifted)));
        assert_eq!(again.0, from, "worked out once while its edges hold");
    }
}
