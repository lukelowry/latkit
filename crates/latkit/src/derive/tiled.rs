//! Tables drawn in part. A table with a priority draws its rows in priority order, the highest on
//! top; one too large to draw whole draws the rows of the tiles the camera asks for, or where nothing
//! places its rows, those that matter most. What a view draws of such a dataset is a dataset of its
//! own, of the same name, ids, and origin: each such table's rows drawn in drawing order, with the
//! rows the edges drawn end at carried along and the rows pinned (selected, or framed by a fit)
//! kept; other tables as they are, their references naming the rows drawn. Marks draw it like any
//! other dataset, so picks, selection, hover, transitions, lanes, and labels follow it.
//!
//! Each table's pyramid is worked out from where its rows lie and their priority: on the frame while
//! that fits its budget, else in a job of its own, so a dataset's tables are placed side by side and
//! each draws once its own lands; until then a table draws an even sample of its rows, as many as a
//! first look needs. A pyramid serves while the rows it was placed from hold. The rows
//! drawn are gathered again when the tiles asked for or the data change, each field only when it
//! changed, and only the fields marks read.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::pyramid::{Leveling, Places, Placing, Pyramid, Wanted, answer, reaches};
use super::sight::{Domain, Sight};
use super::{Jobs, stamp_of};
use crate::data::{Column, Data, Field, Name, RowIds, Table, UNWIRED, Version};
use crate::expr::cpu::Rows;
use crate::expr::{Expr, Node};
use crate::host::Job;
use crate::{Pending, Row};

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
    /// The fields marks read of it, which its rows drawn hold with every reference field; `None`
    /// where they hold every field.
    pub(crate) reads: Option<FxHashSet<Name>>,
}

impl Planned {
    /// Whether the table draws as it is: whole, in its own order.
    pub(crate) fn as_is(&self) -> bool {
        self.draw == Draw::Whole && self.priority.is_none()
    }
}

/// How each table drawn draws, by dataset and table.
pub(crate) type Plans = FxHashMap<(Name, Name), Planned>;

/// What drawing in part reads this frame.
pub(crate) struct Ask<'a> {
    pub(crate) sources: &'a [Data],
    pub(crate) plans: &'a Plans,
    /// What the camera sees, on a map or a plane.
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) earth: bool,
    /// Rows drawn whatever the tiles: those selected, and those a fit frames.
    pub(crate) pinned: &'a [Row],
    /// The axis coordinate shown, which sampled fields drawn in part are gathered about.
    pub(crate) at: f64,
}

/// What each dataset drawn in part draws.
#[derive(Default)]
pub(crate) struct Tiled {
    sets: Vec<Set>,
}

impl Tiled {
    /// Brings what each dataset drawn in part draws up to `ask`: the datasets drawn that changed, and
    /// the names of those no longer drawn in part, which draw as they are.
    pub(crate) fn update(&mut self, ask: &Ask<'_>, jobs: &mut Jobs<'_>) -> (Vec<Data>, Vec<Name>) {
        let mut wanted: Vec<&Name> = Vec::new();
        for ((data, _), planned) in ask.plans {
            if !planned.as_is() && !wanted.contains(&data) {
                wanted.push(data);
            }
        }
        let mut gone = Vec::new();
        self.sets.retain(|set| {
            let keep = wanted.contains(&&set.name) && ask.sources.iter().any(|d| *d.name() == set.name);
            if !keep {
                gone.push(set.name.clone());
            }
            keep
        });
        let mut changed = Vec::new();
        for name in wanted {
            let Some(source) = ask.sources.iter().find(|d| d.name() == name) else { continue };
            let i = self.sets.iter().position(|s| s.name == *name).unwrap_or_else(|| {
                self.sets.push(Set::new(name.clone()));
                self.sets.len() - 1
            });
            if let Some(drawn) = self.sets[i].update(source, ask, jobs) {
                changed.push(drawn);
            }
        }
        (changed, gone)
    }

    /// Whether every table drawn in part draws from its pyramid: none draws its first sample while
    /// its pyramid is worked out.
    pub(crate) fn complete(&self) -> bool {
        self.sets.iter().all(|s| s.working.is_empty() && !s.deferred && !s.sampling)
    }

    /// Whether a dataset waits for a frame to ask for its pyramids.
    pub(crate) fn due(&self) -> bool {
        self.sets.iter().any(|s| s.deferred)
    }

    /// Whether dataset `name` draws in part.
    pub(crate) fn draws(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.name == *name)
    }

    /// The bounds of every row of table `table` of dataset `data` drawn through tiles, west, south,
    /// east, north in position units: what a fit of everything frames, whatever tiles are drawn.
    pub(crate) fn bounds(&self, data: &Name, table: &Name) -> Option<[f64; 4]> {
        let set = self.sets.iter().find(|s| s.name == *data)?;
        set.placed.get(table).and_then(|placed| placed.bounds)
    }
}

/// A table's pyramid: the rows it was placed from (the table's structure and order), the square it
/// tiles, the bounds of its rows in position units, and the version that tells it from any other.
struct Placed {
    made: Version,
    rows: (Version, Version),
    domain: Domain,
    pyramid: Pyramid,
    bounds: Option<[f64; 4]>,
}

/// A pyramid job under way: the table it places, where the answer holds its pyramid, and what the
/// pyramid is kept with once it lands.
struct Working {
    table: Name,
    pending: Pending<Vec<u8>>,
    answered: u32,
    placed: Placed,
}

/// One table's rows drawn last time, the versions of the table drawn while they hold, its fields as
/// gathered with what each was gathered from, and each source row's row drawn.
#[derive(Default)]
struct Gathered {
    rows: Option<Arc<[u32]>>,
    versions: Option<(Version, Version)>,
    ids: Option<RowIds>,
    fields: FxHashMap<Name, (u64, Field)>,
    /// Each reference field's ids as gathered, and every row's target by it, as of a version of it.
    references: FxHashMap<Name, (u64, Column)>,
    targets: FxHashMap<Name, (Version, Arc<[u32]>)>,
    /// Each source row's row drawn, `UNWIRED` where none, and the rows it was written for.
    map: Vec<u32>,
    mapped: Arc<[u32]>,
}

/// One dataset drawn in part.
struct Set {
    name: Name,
    /// The stamp of everything its pyramids are placed from: every table placed, and the square.
    stamp: u64,
    /// Each table's pyramid, as last placed.
    placed: FxHashMap<Name, Arc<Placed>>,
    working: Vec<Working>,
    /// Whether asking for its pyramids waits for a frame that gathers nothing.
    deferred: bool,
    /// What the dataset drawn was gathered from.
    gathered: u64,
    tables: FxHashMap<Name, Gathered>,
    /// Whether a table draws an even sample of its rows until its pyramid lands.
    sampling: bool,
}

impl Set {
    fn new(name: Name) -> Set {
        Set {
            name,
            stamp: 0,
            placed: FxHashMap::default(),
            working: Vec::new(),
            deferred: false,
            gathered: 0,
            tables: FxHashMap::default(),
            sampling: false,
        }
    }

    /// Brings the pyramids and the rows drawn up to `ask`; the dataset drawn, when it changed.
    fn update(&mut self, source: &Data, ask: &Ask<'_>, jobs: &mut Jobs<'_>) -> Option<Data> {
        let placing = placed(source, ask);
        // Pyramids that landed serve from now on.
        let mut i = 0;
        while i < self.working.len() {
            let Some(landed) = self.working[i].pending.take() else {
                i += 1;
                continue;
            };
            let working = self.working.swap_remove(i);
            if let Ok(bytes) = landed
                && let Some(pyramid) = Pyramid::read(&bytes).remove(&working.answered)
            {
                self.placed
                    .insert(working.table, Arc::new(Placed { pyramid, made: Version::next(), ..working.placed }));
            }
        }
        let stamp = stamp(source, ask, &placing);
        let due = !placing.is_empty() && stamp != self.stamp;
        // Pyramids small enough are placed at once, before the rows drawn are gathered from them;
        // asking jobs for larger ones waits for a frame that gathers nothing, so no frame does both.
        let cost: f64 = placing
            .iter()
            .map(|(t, p)| {
                t.len() as f64 * if matches!(p.draw, Draw::Tiles { .. }) { PLACE_COST } else { PLACE_COST / 20.0 }
            })
            .sum();
        let at_once = cost <= jobs.left() as f64;
        if due && at_once {
            self.level(&placing, ask, stamp, jobs);
        }
        let drawn = self.gather(source, ask);
        self.deferred = due && !at_once && drawn.is_some();
        if due && !at_once && drawn.is_none() {
            self.level(&placing, ask, stamp, jobs);
        }
        drawn
    }

    /// Asks for the pyramids of `placing`, from what `stamp` stamps: at once where one fits the
    /// frame, else in a job of its own.
    fn level(&mut self, placing: &[(&Table, &Planned)], ask: &Ask<'_>, stamp: u64, jobs: &mut Jobs<'_>) {
        {
            self.stamp = stamp;
            // What was asked before no longer serves once it lands.
            self.working.clear();
            let (leveling, bounds) = leveling(ask, placing);
            let domain = leveling.domain;
            for (i, table) in leveling.tables.iter().enumerate().filter(|(_, t)| t.answered) {
                let name = placing[i].0.name.clone();
                // A table placed by its ends goes with the table they name, which only anchors it.
                let mut alone = Leveling { domain, tables: Vec::with_capacity(2) };
                let mut table = table.clone();
                if let Some((target, _)) = table.ends.as_mut() {
                    let at = &leveling.tables[*target as usize];
                    alone.tables.push(Placing { rows: at.rows, places: at.places.clone(), ..Placing::default() });
                    *target = 0;
                }
                let answered = alone.tables.len() as u32;
                let rows = (placing[i].0.structure, placing[i].0.order);
                alone.tables.push(table);
                // Placing a row takes about a microsecond; ordering one by priority alone, far less.
                let per_row = if alone.tables[answered as usize].leveled { PLACE_COST } else { PLACE_COST / 20.0 };
                let cost = per_row * alone.tables.iter().map(|t| f64::from(t.rows)).sum::<f64>();
                let made = Version::next();
                let placed =
                    Placed { made, rows, domain, pyramid: Pyramid::default(), bounds: bounds.get(&name).copied() };
                if jobs.fits(cost as u64) {
                    let pyramid = Pyramid::answered(answer(&alone)).remove(&answered).unwrap_or_default();
                    self.placed.insert(name, Arc::new(Placed { pyramid, ..placed }));
                } else {
                    let job = Job::pyramid(&alone);
                    let pending = jobs.spawn(job);
                    self.working.push(Working { table: name, pending, answered, placed });
                }
            }
        }
    }

    /// Table `name`'s pyramid while it serves: placed from the rows the table holds.
    fn pyramid(&self, source: &Data, name: &Name) -> Option<Arc<Placed>> {
        let table = source.table(name)?;
        self.placed.get(name).filter(|p| p.rows == (table.structure, table.order)).cloned()
    }

    /// The dataset drawn, gathered again when what it is gathered from changed.
    fn gather(&mut self, source: &Data, ask: &Ask<'_>) -> Option<Data> {
        // Each table's tiles drawn, or how many of its rows, by what it draws.
        let mut chosen: Vec<(Name, Choice)> = Vec::new();
        let mut serving: Vec<(Name, Arc<Placed>)> = Vec::new();
        for table in source.tables() {
            let Some(planned) = ask.plans.get(&(source.name().clone(), table.name.clone())) else { continue };
            if planned.as_is() {
                continue;
            }
            let placed = self.pyramid(source, &table.name);
            if let Some(placed) = &placed {
                serving.push((table.name.clone(), placed.clone()));
            }
            let pyramid = placed.as_deref().map(|placed| (&placed.pyramid, &placed.domain));
            let choice = match (pyramid, planned.draw) {
                (None, Draw::Whole) => Choice::AsIs,
                (None, Draw::Tiles { rows } | Draw::First { rows }) => {
                    Choice::Sample((table.len() as u32).div_ceil(rows.clamp(1, SAMPLE)).max(1))
                }
                (Some(_), Draw::Whole) => Choice::Tiles(Wanted { tiles: vec![(0, true)], cover: None }),
                (Some((pyramid, _)), Draw::First { rows }) => Choice::Last(rows.min(pyramid.order.len() as u32)),
                (Some((pyramid, domain)), Draw::Tiles { rows }) => {
                    Choice::Tiles(ask.sight.map(|sight| pyramid.wanted(sight, domain, rows)).unwrap_or_default())
                }
            };
            chosen.push((table.name.clone(), choice));
        }
        self.sampling = chosen.iter().any(|(_, choice)| matches!(choice, Choice::Sample(_)));
        let pinned: Vec<&Row> = ask.pinned.iter().filter(|r| r.data == self.name).collect();
        let frames: Vec<Option<u32>> = sampled_frames(source, ask);
        let pyramids: Vec<Version> = serving.iter().map(|(_, p)| p.made).collect();
        let inputs = stamp_of((source.0.version, pyramids, &chosen, &pinned, frames, reads_of(source, ask)));
        if inputs == self.gathered {
            return None;
        }
        self.gathered = inputs;
        let serving: FxHashMap<Name, Arc<Placed>> = serving.into_iter().collect();
        Some(self.build(source, ask, &serving, &chosen, &pinned))
    }

    /// The dataset drawn: every table's rows drawn, pinned rows kept, the ends of edges drawn
    /// carried along, each table gathered.
    fn build(
        &mut self,
        source: &Data,
        ask: &Ask<'_>,
        serving: &FxHashMap<Name, Arc<Placed>>,
        chosen: &[(Name, Choice)],
        pinned: &[&Row],
    ) -> Data {
        let mut rows: FxHashMap<Name, Vec<u32>> = chosen
            .iter()
            .filter_map(|(name, choice)| {
                let len = source.table(name).map_or(0, Table::len) as u32;
                Some((name.clone(), choice.rows(serving.get(name).map(Arc::as_ref), len)?))
            })
            .collect();
        // Rows pinned, and the rows the edges drawn end at, draw whatever their tiles.
        let mut drawn: FxHashMap<Name, Bitset> = rows
            .iter()
            .map(|(name, list)| (name.clone(), Bitset::of(list, source.table(name).map_or(0, Table::len))))
            .collect();
        for row in pinned {
            let (Some(list), Some(table)) = (rows.get_mut(&row.table), source.table(&row.table)) else { continue };
            if let Some(r) = table.row(row.id.as_ref())
                && drawn.get_mut(&row.table).is_some_and(|set| set.insert(r as u32))
            {
                list.push(r as u32);
            }
        }
        let mut carried: Vec<(Name, Vec<u32>)> = Vec::new();
        for table in source.tables() {
            // Only the ends of edges and faces drawn are carried.
            let Some(Place::Ends(ends)) = ask.plans.get(&(source.name().clone(), table.name.clone())).map(|p| &p.place)
            else {
                continue;
            };
            for (name, field) in &table.fields {
                let Field::Reference(reference) = field else { continue };
                if !rows.contains_key(&reference.to) || !ends.contains(name) {
                    continue;
                }
                let targets = self.targets(&table.name, name, field);
                let ends: Vec<u32> = match rows.get(&table.name) {
                    Some(list) => list.iter().map(|&r| targets[r as usize]).collect(),
                    None => targets.to_vec(),
                };
                carried.push((reference.to.clone(), ends));
            }
        }
        for (to, ends) in carried {
            let (Some(list), Some(set)) = (rows.get_mut(&to), drawn.get_mut(&to)) else { continue };
            for t in ends {
                if t != UNWIRED && set.insert(t) {
                    list.push(t);
                }
            }
        }
        // Each table drawn in part: the versions it holds while its rows do, and where each source
        // row is drawn.
        let mut versions: FxHashMap<Name, (Version, Version)> = FxHashMap::default();
        for (name, list) in &rows {
            let gathered = self.tables.entry(name.clone()).or_default();
            let same = gathered.rows.as_deref() == Some(list.as_slice());
            let held = gathered.versions.filter(|_| same).unwrap_or_else(|| {
                let v = Version::next();
                (v, v)
            });
            gathered.versions = Some(held);
            versions.insert(name.clone(), held);
            let len = source.table(name).map_or(0, Table::len);
            gathered.map.resize(len, UNWIRED);
            for &r in gathered.mapped.iter() {
                if let Some(m) = gathered.map.get_mut(r as usize) {
                    *m = UNWIRED;
                }
            }
            for (i, &r) in list.iter().enumerate() {
                if let Some(m) = gathered.map.get_mut(r as usize) {
                    *m = i as u32;
                }
            }
            gathered.mapped = list.as_slice().into();
            if !same {
                gathered.rows = Some(list.as_slice().into());
                gathered.ids = None;
                gathered.fields.clear();
                gathered.references.clear();
            }
        }
        let mut tables = Vec::with_capacity(source.tables().count());
        for table in source.tables() {
            tables.push(self.drawn(source, table, ask, &rows, &versions));
        }
        source.drawn(tables)
    }

    /// Every row's target by reference field `name` of table `table`, `field`, as of its version.
    fn targets(&mut self, table: &Name, name: &Name, field: &Field) -> Arc<[u32]> {
        let Field::Reference(reference) = field else { return Arc::from([]) };
        let gathered = self.tables.entry(table.clone()).or_default();
        if let Some((version, targets)) = gathered.targets.get(name)
            && *version == reference.version
        {
            return targets.clone();
        }
        let targets: Arc<[u32]> = reference.targets().into();
        gathered.targets.insert(name.clone(), (reference.version, targets.clone()));
        targets
    }

    /// Table `table` as drawn: as it is, its references naming the rows drawn; or its rows drawn
    /// in part, with the fields marks read.
    fn drawn(
        &mut self,
        source: &Data,
        table: &Table,
        ask: &Ask<'_>,
        rows: &FxHashMap<Name, Vec<u32>>,
        versions: &FxHashMap<Name, (Version, Version)>,
    ) -> Table {
        // A table no mark draws stays as it is: only joins read it, by id.
        let planned = ask.plans.contains_key(&(source.name().clone(), table.name.clone()));
        let remaps = table.fields.iter().any(|(_, f)| matches!(f, Field::Reference(r) if rows.contains_key(&r.to)));
        let Some(list) = rows.get(&table.name) else {
            if !remaps || !planned {
                return table.clone();
            }
            // As it is, its references naming rows drawn.
            let mut out = table.clone();
            for (name, field) in &table.fields {
                let Field::Reference(reference) = field else { continue };
                let Some(&(order, structure)) = versions.get(&reference.to) else { continue };
                let targets = self.targets(&table.name, name, field);
                let map = &self.tables[&reference.to].map;
                let mapped: Vec<u32> = targets.iter().map(|&t| remap(map, t)).collect();
                let remapped = reference.resolved_to(reference.ids.clone(), &mapped, order, structure);
                out.insert(name.clone(), Field::Reference(remapped));
            }
            return out;
        };
        let reads = ask.plans.get(&(source.name().clone(), table.name.clone())).and_then(|p| p.reads.as_ref());
        let picked: Vec<usize> = list.iter().map(|&r| r as usize).collect();
        let (order, structure) = versions[&table.name];
        let ids = {
            let gathered = self.tables.get_mut(&table.name).expect("made with its rows");
            gathered.ids.get_or_insert_with(|| table.ids.gather(&picked)).clone()
        };
        let mut out =
            Table { name: table.name.clone(), ids, index: Arc::default(), fields: Vec::new(), structure, order };
        let frames = |samples: &crate::data::Samples| samples.frame_at(ask.at);
        for (name, field) in &table.fields {
            let read = reads.is_none_or(|r| r.contains(name));
            let made = match field {
                Field::Values(column, version) if read => {
                    let stamp = stamp_of(version);
                    self.cached(&table.name, name, stamp, || Field::Values(column.gather(&picked), Version::next()))
                }
                Field::Sampled(samples, version) if read => {
                    let frame = frames(samples);
                    let stamp = stamp_of((version, frame));
                    self.cached(&table.name, name, stamp, || {
                        let span = frame.map_or(0..0, |f| f..f + 2);
                        Field::Sampled(samples.gather_frames(&picked, span), Version::next())
                    })
                }
                Field::Reference(reference) => {
                    let targets = self.targets(&table.name, name, field);
                    let stamp = stamp_of(reference.version);
                    let gathered = self.tables.entry(table.name.clone()).or_default();
                    let ids = match gathered.references.get(name) {
                        Some((s, ids)) if *s == stamp => ids.clone(),
                        _ => {
                            let ids = reference.ids.gather(&picked);
                            gathered.references.insert(name.clone(), (stamp, ids.clone()));
                            ids
                        }
                    };
                    let mapped: Vec<u32> =
                        match self.tables.get(&reference.to).filter(|_| rows.contains_key(&reference.to)) {
                            Some(target) => list.iter().map(|&r| remap(&target.map, targets[r as usize])).collect(),
                            None => list.iter().map(|&r| targets[r as usize]).collect(),
                        };
                    let (order, structure) = match versions.get(&reference.to) {
                        Some(&held) => held,
                        None => source.table(&reference.to).map_or((order, structure), |t| (t.order, t.structure)),
                    };
                    Field::Reference(reference.resolved_to(ids, &mapped, order, structure))
                }
                _ => continue,
            };
            out.insert(name.clone(), made);
        }
        out
    }

    /// Field `field` of table `table` as gathered from what `stamp` stamps for the rows drawn,
    /// gathered again by `make` when that changed.
    fn cached(&mut self, table: &Name, field: &Name, stamp: u64, make: impl FnOnce() -> Field) -> Field {
        let gathered = self.tables.entry(table.clone()).or_default();
        match gathered.fields.get(field) {
            Some((s, made)) if *s == stamp => made.clone(),
            _ => {
                let made = make();
                gathered.fields.insert(field.clone(), (stamp, made.clone()));
                made
            }
        }
    }
}

/// Rows, a bit each: which rows of a table are drawn.
struct Bitset(Vec<u64>);

impl Bitset {
    /// The rows of `list`, of a table of `len` rows.
    fn of(list: &[u32], len: usize) -> Bitset {
        let mut set = Bitset(vec![0; len.div_ceil(64)]);
        for &r in list {
            set.insert(r);
        }
        set
    }

    /// Adds row `r`; whether it was not there before.
    fn insert(&mut self, r: u32) -> bool {
        let Some(word) = self.0.get_mut(r as usize / 64) else { return false };
        let bit = 1 << (r % 64);
        let new = *word & bit == 0;
        *word |= bit;
        new
    }
}

/// What a table drawn in part draws of its pyramid.
#[derive(Clone, Debug, PartialEq, Hash)]
enum Choice {
    /// Every row as it is, until its pyramid lands.
    AsIs,
    /// Every row a step apart, until its pyramid lands.
    Sample(u32),
    /// The rows of these tiles.
    Tiles(Wanted),
    /// The last rows of its one tile: those that matter most.
    Last(u32),
}

impl Choice {
    /// The rows it draws of a table of `len` rows, by `placed`, its pyramid, in drawing order: finest
    /// tiles first, so what matters more draws on top. `None` for a table drawn as it is.
    fn rows(&self, placed: Option<&Placed>, len: u32) -> Option<Vec<u32>> {
        Some(match (self, placed) {
            (Choice::AsIs, _) => return None,
            (Choice::Tiles(wanted), Some(placed)) => {
                let pyramid = &placed.pyramid;
                let mut tiles = wanted.tiles.clone();
                tiles.sort_by_key(|&(t, _)| std::cmp::Reverse((pyramid.tiles[t as usize].key.z, u32::MAX - t)));
                let mut list = Vec::new();
                for (t, finest) in tiles {
                    let range = pyramid.tiles[t as usize].rows.clone();
                    let rows = &pyramid.order[range.start as usize..range.end as usize];
                    // A coarser tile draws only its rows reaching where the finest cover.
                    match wanted.cover.filter(|_| !finest && !pyramid.anchors.is_empty()) {
                        Some(cover) => list.extend(rows.iter().copied().filter(|&r| {
                            let extent = pyramid.extents.get(r as usize).copied().unwrap_or(0);
                            reaches(&cover, pyramid.anchors[r as usize], extent)
                        })),
                        None => list.extend_from_slice(rows),
                    }
                }
                list
            }
            (Choice::Last(n), Some(placed)) => {
                let order = &placed.pyramid.order;
                order[order.len() - *n as usize..].to_vec()
            }
            (Choice::Sample(step), _) => (0..len).step_by(*step as usize).collect(),
            (_, None) => Vec::new(),
        })
    }
}

/// The row `t` is drawn at, by `map`.
fn remap(map: &[u32], t: u32) -> u32 {
    map.get(t as usize).copied().unwrap_or(UNWIRED)
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
    out.sort_by_key(|(_, p)| matches!(p.place, Place::Ends(_)));
    out
}

/// The table the ends of `table` name, as `planned` places it.
fn ends_of<'t>(table: &'t Table, planned: &Planned) -> Option<&'t Name> {
    let Place::Ends(fields) = &planned.place else { return None };
    match table.field_named(fields.first()?)? {
        Field::Reference(reference) => Some(&reference.to),
        _ => None,
    }
}

/// The stamp of everything a dataset's pyramids are placed from.
fn stamp(source: &Data, ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> u64 {
    let rows: Vec<_> = placed.iter().map(|(t, _)| (t.name.clone(), t.structure, t.order)).collect();
    let mut inputs = Vec::new();
    for (table, planned) in placed {
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
        let versions: Vec<_> = fields.iter().map(|f| table.field_named(f).map(Field::version)).collect();
        let tiles = matches!(planned.draw, Draw::Tiles { .. });
        inputs.push((format!("{:?}{:?}", planned.priority, planned.place), versions, tiles, planned.as_is()));
    }
    stamp_of((source.name(), rows, inputs, ask.earth))
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

/// The frame shown of each sampled field marks read of a table drawn in part.
fn sampled_frames(source: &Data, ask: &Ask<'_>) -> Vec<Option<u32>> {
    let mut frames = Vec::new();
    for table in source.tables() {
        let Some(planned) = ask.plans.get(&(source.name().clone(), table.name.clone())) else { continue };
        if planned.as_is() {
            continue;
        }
        for (name, field) in &table.fields {
            if let Field::Sampled(samples, _) = field
                && planned.reads.as_ref().is_none_or(|r| r.contains(name))
            {
                frames.push(samples.frame_at(ask.at));
            }
        }
    }
    frames
}

/// The fields read of each table drawn in part, in a stable order; `None` for every field.
fn reads_of(source: &Data, ask: &Ask<'_>) -> Vec<Option<Vec<Name>>> {
    source
        .tables()
        .filter_map(|t| ask.plans.get(&(source.name().clone(), t.name.clone())))
        .map(|p| {
            p.reads.as_ref().map(|reads| {
                let mut reads: Vec<Name> = reads.iter().cloned().collect();
                reads.sort();
                reads
            })
        })
        .collect()
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
fn leveling(ask: &Ask<'_>, placed: &[(&Table, &Planned)]) -> (Leveling, FxHashMap<Name, [f64; 4]>) {
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
    let mut bounds: FxHashMap<Name, [f64; 4]> = FxHashMap::default();
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
