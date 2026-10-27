//! The plan: how each drawn table fits the GPU budget.
//!
//! A table draws all its rows (in priority order when a mark gives one) unless it is too large. A
//! table a mark places on a map or a plane is paged when it is denser than a screen can show. The
//! largest such tables are paged until the rest fit the view's budget share. A table of vector
//! tiles is always paged, with the vector tiles drawn as its tiles. Other tables drawn from tiles
//! never are. A paged table draws the rows of the tiles the camera needs, as many as its share
//! holds. Edges ending at it are paged too, so they show with their endpoints. If the unpaged
//! tables still do not fit, a table a line traces still draws all its rows, with its traces
//! spanning only as many pixel columns as fit. Any other table draws the rows that matter most, as
//! many as fit. What a view draws always fits.
//!
//! A table costs what the arena allocates for it: its columns' pages, the arena blocks of its
//! marks' per-row words, and its geometry. The GPU's ledger grants each view a share based on its
//! cost with every table drawn in full. Costs are recomputed only when the scene, or a drawn
//! table's rows or geometry, change. The plan is recomputed only when the costs or the share
//! change.
//!
//! Paged tables can need more than the costs predict, such as the kept rows that drawn edges end
//! at. When the view's memory exceeds its share, or its pages do not fit in a full arena, paged
//! tables are planned within a smaller part of the share until the share changes. That way the
//! current drawing and its replacement both fit, with space left to keep idle pages.

use std::hash::Hash;

use rustc_hash::FxHashMap;

use super::View;
use super::marks::Shown;
use crate::data::{Field, Keyed, Name, Table};
use crate::derive::tiled::{Draw, Place, Planned, Plans};
use crate::derive::{Derived, stamp_of, stamp_with};
use crate::expr::compile::Words;
use crate::gpu::arena::{path_page_bytes, rounded};
use crate::gpu::shaders as wgsl;
use crate::gpu::{Ask, Ledger};
use crate::{Expr, Kind, Mark, Space};

/// Rows past which a table a mark places is paged: more than a screen shows at one row per cell.
pub(crate) const DENSE: usize = 1 << 18;
/// Pixel columns a view requests trace space for: a wide screen's width.
const ASKED_COLUMNS: f64 = 4096.0;
/// The fewest rows a paged table draws: one tile's worth.
const LEAST: u32 = 1 << 14;
/// Bytes a row's trace takes per pixel column: the minimum and maximum values of two buckets.
const TRACE_COLUMN_BYTES: f64 = 16.0;
/// The fewest pixel columns a trace spans, however little budget is left.
const TRACE_COLUMNS: u32 = 32;

/// A table's cost as the arena allocates it: its row count, bytes per page of rows, bytes of
/// geometry, and bytes its traces take per pixel column.
struct Cost {
    rows: usize,
    per_page: f64,
    geometry: f64,
    traced: f64,
}

impl Cost {
    fn bytes(&self) -> f64 {
        self.rows.div_ceil(wgsl::PAGE_ROWS as usize) as f64 * self.per_page + self.geometry
    }

    /// Bytes a row takes on average.
    fn per_row(&self) -> f64 {
        self.per_page / f64::from(wgsl::PAGE_ROWS) + self.geometry / self.rows.max(1) as f64
    }
}

/// Each table the scene draws, planned as drawn in full, and its cost.
#[derive(Default)]
struct Costs {
    whole: Plans,
    tables: Keyed<(Name, Name), Cost>,
    /// Pages in the costs that every view drawing the same data shares, keyed by field version and
    /// read mode: the bytes the costs count for each, and its size counted once.
    shared: FxHashMap<u64, (f64, f64)>,
}

/// The plan and the costs it uses, each recomputed only when its inputs change.
pub(crate) struct Planning {
    costs: Derived<Costs>,
    /// How each table draws, and the most pixel columns a trace spans.
    plan: Derived<(Plans, u32)>,
    /// The fraction of the remaining budget the plan gives paged tables. Lowered each time their
    /// pages do not fit in a full arena or exceed the share. Reset when the share changes.
    fit: f64,
    share: f64,
}

impl Default for Planning {
    fn default() -> Planning {
        Planning { costs: Derived::default(), plan: Derived::default(), fit: 1.0, share: 0.0 }
    }
}

impl Planning {
    /// How each table draws.
    pub(crate) fn plans(&self) -> &Plans {
        &self.plan.value.0
    }

    /// Bytes `pages` pages of `key`'s table take, as its costs count them.
    pub(crate) fn page_bytes(&self, key: &(Name, Name), pages: u32) -> f64 {
        self.costs.value.tables.get(key).map_or(0.0, |cost| f64::from(pages) * cost.per_page)
    }

    /// The most pixel columns a trace spans.
    pub(crate) fn trace_columns(&self) -> u32 {
        self.plan.value.1
    }

    /// Records that paged tables did not fit in a full arena, so they draw within less while any
    /// draws more than its minimum. Returns whether the plan shrank.
    pub(crate) fn overflowed(&mut self) -> bool {
        self.tighten(0.75)
    }

    /// Records that the view uses `bytes` for what it draws. If that exceeds the share and the plan
    /// left out some of the rows the camera needs from a paged table (`capped`), paged tables draw
    /// within less, in proportion to the excess. If nothing was left out, a smaller plan would draw
    /// no less and only release idle pages, so the plan stays.
    pub(crate) fn held(&mut self, bytes: u64, capped: bool) {
        if capped && self.share > 0.0 && bytes as f64 > self.share {
            self.tighten(self.share / bytes as f64);
        }
    }

    /// Scales the budget for paged tables by `part`, if any draws more than its minimum. Returns
    /// whether it did.
    fn tighten(&mut self, part: f64) -> bool {
        let shrinks = self.plans().values().any(|p| matches!(p.draw, Draw::Tiles { rows } if rows > LEAST));
        if shrinks {
            self.fit *= part;
        }
        shrinks
    }
}

impl View {
    /// Updates the plan for the scene, the data, and the share of `budget` that the GPU's `ledger`
    /// grants the view based on its cost with every table drawn in full.
    pub(super) fn update_plan(&mut self, ledger: &mut Ledger, budget: u64) {
        let stamp = self.costs_stamp();
        if self.planning.costs.due(stamp) {
            let costs = self.costs();
            self.planning.costs.make(stamp, costs);
        }
        let costs = &self.planning.costs.value;
        let traced: f64 = costs.tables.values().map(|c| c.traced).sum();
        let whole = costs.tables.values().map(Cost::bytes).sum::<f64>() + traced * ASKED_COLUMNS;
        let counted: f64 = costs.shared.values().map(|(counted, _)| counted).sum();
        let ask = Ask {
            own: (whole - counted).max(0.0),
            shared: costs.shared.iter().map(|(piece, (_, bytes))| (*piece, *bytes)).collect(),
        };
        let share = ledger.grant(self.id, whole, ask, budget);
        if share != self.planning.share {
            (self.planning.share, self.planning.fit) = (share, 1.0);
        }
        let stamp = stamp_of((self.planning.costs.stamp(), share.to_bits(), self.planning.fit.to_bits()));
        if self.planning.plan.due(stamp) {
            let planned = self.plan(costs, share, self.planning.fit);
            self.planning.plan.make(stamp, planned);
        }
    }

    /// A stamp of the costs' inputs: the scene, and for each table a mark draws, its dataset's
    /// schema, its row structure, its geometry's version, and whether it comes from tiles, and
    /// from vector tiles.
    fn costs_stamp(&self) -> u64 {
        stamp_with(|hasher| {
            self.scene_version.hash(hasher);
            for shown in &self.marks {
                let style = shown.mark.style();
                let data = self.snapshot(&style.data);
                let table = data.and_then(|d| d.table(&style.table));
                let geometry = geometry_of(&shown.mark).and_then(|f| table?.field_named(&f)).map(Field::version);
                let owned = (self.derived.tiles.owns(&style.data), self.derived.tiles.vector(&style.data));
                (data.map(crate::Snapshot::schema), table.map(|t| t.structure), geometry, owned).hash(hasher);
            }
        })
    }

    /// Plans how each table the scene draws fits in `share` bytes given `costs`, giving paged
    /// tables `fit` of the remaining budget. Also returns the most pixel columns a trace spans.
    fn plan(&self, costs: &Costs, share: f64, fit: f64) -> (Plans, u32) {
        let (mut plans, costs) = (costs.whole.clone(), &costs.tables);
        let vector = |key: &(Name, Name)| self.derived.tiles.vector(&key.0);
        let tileable =
            |key: &(Name, Name), planned: &Planned| planned.place != Place::Nowhere && !self.derived.tiles.owns(&key.0);
        let mut whole: f64 = costs.values().map(Cost::bytes).sum();
        let mut tiled: Vec<(Name, Name)> = Vec::new();
        let mut tile = |key: &(Name, Name), plans: &mut Plans, whole: &mut f64| {
            if let Some(planned) = plans.get_mut(key).filter(|p| p.draw == Draw::Whole) {
                planned.draw = Draw::Tiles { rows: LEAST };
                *whole -= costs[key].bytes();
                tiled.push(key.clone());
            }
        };
        // Page tables of vector tiles and dense tables, then the largest ones until the unpaged
        // tables fit.
        let keys: Vec<(Name, Name)> = plans.keys().cloned().collect();
        for key in &keys {
            if vector(key) || (tileable(key, &plans[key]) && costs[key].rows > DENSE) {
                tile(key, &mut plans, &mut whole);
            }
        }
        while whole > share {
            let largest = keys
                .iter()
                .filter(|k| plans[*k].draw == Draw::Whole && tileable(k, &plans[*k]))
                .max_by(|a, b| costs[*a].bytes().total_cmp(&costs[*b].bytes()));
            let Some(key) = largest.cloned() else { break };
            tile(&key, &mut plans, &mut whole);
        }
        // Edges ending at a paged table are paged too, so they show with their endpoints.
        for key in &keys {
            if self.ends_tiled(key, &plans) {
                tile(key, &mut plans, &mut whole);
            }
        }
        // If the unpaged tables still do not fit, each draws the rows that matter most, as many as
        // fit. A table a line traces still draws all its rows, and its traces get coarser in time
        // instead.
        if whole > share {
            let kept: f64 = keys
                .iter()
                .filter(|k| plans[*k].draw == Draw::Whole && costs[*k].traced > 0.0)
                .map(|k| costs[k].bytes())
                .sum();
            let ratio = if whole > kept { ((share - kept) / (whole - kept)).clamp(0.0, 1.0) } else { 1.0 };
            for key in &keys {
                let planned = plans.get_mut(key).expect("listed");
                if planned.draw == Draw::Whole && costs[key].traced == 0.0 {
                    let rows = (costs[key].rows as f64 * ratio) as u32;
                    planned.draw = Draw::First { rows: rows.max(1) };
                }
            }
            whole = share.max(kept);
        }
        // Paged tables and traces share the remaining budget.
        let traced: f64 = costs.values().map(|c| c.traced).sum();
        let left = (share - whole).max(share / 4.0) * fit;
        let each = left / (tiled.len() + usize::from(traced > 0.0)).max(1) as f64;
        for key in &tiled {
            // A paged table's drawn row takes one more word: its held row.
            let per_row = costs[key].per_row().max(1.0) + 4.0;
            let rows = (each / per_row).min(f64::from(u32::MAX)) as u32;
            plans.get_mut(key).expect("listed").draw = Draw::Tiles { rows: rows.max(LEAST) };
        }
        let columns = if traced > 0.0 { ((each / traced) as u32).max(TRACE_COLUMNS) } else { u32::MAX };
        (plans, columns)
    }

    /// Plans each table the scene draws as drawn in full, with the place and priority of the first
    /// mark that gives each, and computes each table's cost from the fields its marks read.
    fn costs(&self) -> Costs {
        let space = &self.scene.space;
        let placing = matches!(space, Space::Earth(_) | Space::Plane(_));
        let easing = !self.scene.ease.is_zero();
        let mut plans = Plans::default();
        let mut costs: Keyed<(Name, Name), Cost> = Keyed::default();
        let mut shared: FxHashMap<u64, (f64, f64)> = FxHashMap::default();
        let summing = super::graph::summing(&self.marks);
        for (shown, summing) in self.marks.iter().zip(summing) {
            let style = shown.mark.style();
            let Some(table) = self.snapshot(&style.data).and_then(|d| d.table(&style.table)) else { continue };
            let key = (style.data.clone(), style.table.clone());
            let planned = plans.entry(key.clone()).or_insert_with(|| Planned {
                draw: Draw::Whole,
                priority: None,
                place: Place::Nowhere,
            });
            if planned.priority.is_none() {
                planned.priority.clone_from(&style.priority);
            }
            if placing && planned.place == Place::Nowhere {
                planned.place = place_of(&shown.mark, table);
            }
            let cost =
                costs.entry(key).or_insert(Cost { rows: table.len(), per_page: 0.0, geometry: 0.0, traced: 0.0 });
            cost.per_page += page_bytes(shown, easing, summing);
            cost.geometry += geometry_bytes(shown, table);
            cost.traced += traced_bytes(shown, table);
            for (piece, bytes) in self.shared_pages(shown, table) {
                let (counted, once) = shared.entry(piece).or_insert((0.0, 0.0));
                *counted += bytes;
                *once = bytes;
            }
        }
        Costs { whole: plans, tables: costs, shared }
    }

    /// The pages `shown` reads of `table` and its joined tables that every view drawing the same
    /// data shares, sized as `page_bytes` and `geometry_bytes` count them. Each field's pages are
    /// keyed by its version and read mode.
    fn shared_pages(&self, shown: &Shown, table: &Table) -> Vec<(u64, f64)> {
        let Some(compiled) = &shown.compiled else { return Vec::new() };
        let mut pieces: Vec<(u64, f64)> = compiled
            .program
            .columns
            .iter()
            .filter(|c| c.words != Words::Path && !c.derived)
            .filter_map(|c| {
                let read = match &c.from {
                    None => table.field_named(&c.name),
                    Some((data, joined)) => self.snapshot(data)?.table(joined)?.field_named(&c.name),
                };
                let pages = table.len().div_ceil(wgsl::PAGE_ROWS as usize) as f64;
                Some((stamp_of((read?.version(), c.low)), pages * column_page_bytes(c.low)))
            })
            .collect();
        if let Some(field) = geometry_of(&shown.mark).and_then(|f| table.field_named(&f)) {
            let areas = matches!(shown.mark, Mark::Areas(_));
            pieces.push((stamp_of((field.version(), areas)), geometry_bytes(shown, table)));
        }
        pieces
    }

    /// Whether table `key` holds edges or faces whose endpoints lie in a paged table.
    fn ends_tiled(&self, key: &(Name, Name), plans: &Plans) -> bool {
        let Place::Ends(fields) = &plans[key].place else { return false };
        let Some(table) = self.snapshot(&key.0).and_then(|d| d.table(&key.1)) else { return false };
        let target = fields.first().and_then(|f| match table.field_named(f) {
            Some(Field::Reference(reference)) => Some(reference.to.clone()),
            _ => None,
        });
        target.is_some_and(|t| matches!(plans.get(&(key.0.clone(), t)).map(|p| p.draw), Some(Draw::Tiles { .. })))
    }
}

/// Where `mark` places the rows of `table`.
fn place_of(mark: &Mark, table: &Table) -> Place {
    match mark {
        Mark::Vertices(v) => match &v.position {
            Some([x, y]) => Place::Points([x.clone(), y.clone()]),
            None if table.kind(v.point_field()) == Some(Kind::Point) => {
                Place::Points([Expr::component(v.point_field(), 0), Expr::component(v.point_field(), 1)])
            }
            None => Place::Nowhere,
        },
        Mark::Edges(e) => e.ends.as_ref().map_or(Place::Nowhere, |(a, b)| Place::Ends(vec![a.clone(), b.clone()])),
        Mark::Faces(f) => f.corners.as_ref().map_or(Place::Nowhere, |c| Place::Ends(c.to_vec())),
        Mark::Lines(_) | Mark::Areas(_) => match geometry_of(mark) {
            Some(field) if table.kind(&field).and_then(Kind::depth).is_some() => Place::Geometry(field),
            _ => Place::Nowhere,
        },
    }
}

/// The geometry field a line or an area draws.
fn geometry_of(mark: &Mark) -> Option<Name> {
    match mark {
        Mark::Lines(lines) => Some(lines.traced()),
        Mark::Areas(areas) => Some(areas.field()),
        _ => None,
    }
}

/// Bytes of the arena block for a page of rows at `width` words per row.
fn block_bytes(width: u32) -> f64 {
    f64::from(rounded(wgsl::PAGE_ROWS * width)) * 4.0
}

/// Bytes a page of a column's rows takes: its values, and its low parts where it reads them.
fn column_page_bytes(low: bool) -> f64 {
    block_bytes(1) * if low { 2.0 } else { 1.0 }
}

/// Bytes a page of `shown`'s rows takes, as the arena allocates them: a page of each column it
/// reads, plus each kind of word page it keeps (with the normals faces are `summing` at its rows),
/// and when `easing`, a transition's frozen and settled words.
fn page_bytes(shown: &Shown, easing: bool, summing: bool) -> f64 {
    let Some(compiled) = &shown.compiled else { return 0.0 };
    let columns: f64 =
        compiled.program.columns.iter().filter(|c| c.words != Words::Path).map(|c| column_page_bytes(c.low)).sum();
    let kept: f64 =
        shown.kept_widths(summing).iter().filter(|&&(_, width)| width > 0).map(|&(_, width)| block_bytes(width)).sum();
    let eased = if easing { 2.0 * block_bytes(shown.width()) } else { 0.0 };
    columns + kept + eased
}

/// Bytes the traces `shown` draws of `table` take per pixel column: `TRACE_COLUMN_BYTES` for each
/// row of each traced field.
fn traced_bytes(shown: &Shown, table: &Table) -> f64 {
    let Some(compiled) = &shown.compiled else { return 0.0 };
    let traced = compiled.program.columns.iter().filter(|c| {
        c.trace && c.from.is_none() && !c.derived && matches!(table.field_named(&c.name), Some(Field::Sampled(..)))
    });
    traced.count() as f64 * table.len() as f64 * TRACE_COLUMN_BYTES
}

/// Bytes the geometry `shown` draws of `table` takes, as the arena allocates it: per page of rows,
/// a row table and the points in pieces. An area's triangles take about three times the points of
/// its outlines.
fn geometry_bytes(shown: &Shown, table: &Table) -> f64 {
    let Some(field) = geometry_of(&shown.mark) else { return 0.0 };
    let Some(Field::Values(column, _)) = table.field_named(&field) else { return 0.0 };
    let scale = if matches!(shown.mark, Mark::Areas(_)) { 3 } else { 1 };
    column.pages().iter().map(|p| path_page_bytes(p.values.len(), p.points() * scale) as f64).sum()
}
