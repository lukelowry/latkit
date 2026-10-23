//! The plan: how each table drawn fits the budget. A table draws whole, in priority order when a mark
//! drawing it gives one, unless it is too large to: denser than a screen shows, or more than the
//! view's share of the budget holds with the rest. The GPU's ledger grants each view its share, by
//! what it would draw whole. What the tables cost is worked out again only when the scene or a drawn
//! table's rows or geometry change, and the plan only when those costs or the share do. Then a table a mark places on a map or a plane
//! draws through tiles, the rows of the tiles the camera asks for, as many as its share holds, and
//! edges ending at it draw through tiles too, so they show with their ends; a table a mark traces
//! draws whole, its traces spanning as few pixel columns as fit; any other table draws the rows that
//! matter most, as many as fit. What a view draws always fits.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};

use super::View;
use super::marks::Shown;
use crate::data::{Field, Geometry, Keyed, Name, Table};
use crate::derive::tiled::{Draw, Place, Planned, Plans};
use crate::derive::{Derived, stamp_of};
use crate::expr::compile::Words;
use crate::gpu::shaders as wgsl;
use crate::gpu::{Ask, Ledger};
use crate::{Expr, Kind, Mark, Space};

/// Rows past which a table a mark places draws through tiles: more than a screen shows one to a cell.
pub(crate) const DENSE: usize = 1 << 18;
/// Pixel columns a view asks its traces' room for: a wide screen's.
const ASKED_COLUMNS: f64 = 4096.0;
/// Rows a table drawn through tiles draws at least: a tile's.
const LEAST: u32 = 1 << 14;
/// Bytes a row's trace takes for each pixel column it spans: the least and greatest values of two
/// buckets.
const TRACE_COLUMN_BYTES: f64 = 16.0;
/// Pixel columns a trace spans at least, however little room is left.
const TRACE_COLUMNS: u32 = 32;

/// What a table costs: its rows, bytes each row takes on the GPU, bytes its geometry takes, and bytes
/// its traces take for each pixel column they span.
struct Cost {
    rows: usize,
    per_row: f64,
    geometry: f64,
    traced: f64,
}

impl Cost {
    fn bytes(&self) -> f64 {
        self.rows as f64 * self.per_row + self.geometry
    }
}

/// Each table the scene draws, drawn whole, and what it costs.
#[derive(Default)]
struct Costs {
    whole: Plans,
    tables: Keyed<(Name, Name), Cost>,
    /// The pages the costs count that any view drawing the same data shares: each field's by its
    /// version and how it is read, the bytes the costs count of it, and its bytes once.
    shared: FxHashMap<u64, (f64, f64)>,
}

/// The plan, and the costs it weighs, each worked out again only when what it reads changes.
#[derive(Default)]
pub(crate) struct Planning {
    costs: Derived<Costs>,
    /// How each table draws, and the pixel columns a trace spans at most.
    plan: Derived<(Plans, u32)>,
}

impl Planning {
    /// How each table draws.
    pub(crate) fn plans(&self) -> &Plans {
        &self.plan.value.0
    }

    /// The pixel columns a trace spans at most.
    pub(crate) fn trace_columns(&self) -> u32 {
        self.plan.value.1
    }
}

impl View {
    /// Brings the plan up to the scene, the data, and the share of `budget` the GPU's `ledger`
    /// grants the view by what it would draw whole.
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
        let stamp = stamp_of((self.planning.costs.stamp(), share.to_bits()));
        if self.planning.plan.due(stamp) {
            let planned = self.plan(costs, share);
            self.planning.plan.make(stamp, planned);
        }
    }

    /// What the costs read, stamped: the scene, and of each table a mark draws, its dataset's
    /// schema, its rows, its geometry, and whether the view fetches it as tiles.
    fn costs_stamp(&self) -> u64 {
        let mut hasher = FxHasher::default();
        self.scene_version.hash(&mut hasher);
        for shown in &self.marks {
            let style = shown.mark.style();
            let data = self.source(&style.data);
            let table = data.and_then(|d| d.table(&style.table));
            let geometry = geometry_of(&shown.mark).and_then(|f| table?.field_named(&f)).map(Field::version);
            let owned = self.derived.tiles.owns(&style.data);
            (data.map(crate::Data::schema), table.map(|t| t.structure), geometry, owned).hash(&mut hasher);
        }
        hasher.finish().max(1)
    }

    /// How each table the scene draws draws, within `share` bytes, from what `costs` says each
    /// costs, and the pixel columns a trace spans at most.
    fn plan(&self, costs: &Costs, share: f64) -> (Plans, u32) {
        let (mut plans, costs) = (costs.whole.clone(), &costs.tables);
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
        // Dense tables draw through tiles, then the largest until what draws whole fits.
        let keys: Vec<(Name, Name)> = plans.keys().cloned().collect();
        for key in &keys {
            if tileable(key, &plans[key]) && costs[key].rows > DENSE {
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
        // Edges ending at a table drawn through tiles draw through tiles, so they show with their ends.
        for key in &keys {
            if self.ends_tiled(key, &plans) {
                tile(key, &mut plans, &mut whole);
            }
        }
        // What still does not fit draws the rows that matter most, as many as fit; a table a mark
        // traces draws whole, its traces thinning in time instead.
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
        // Tables drawn through tiles, and traces, share what is left.
        let traced: f64 = costs.values().map(|c| c.traced).sum();
        let left = (share - whole).max(share / 4.0);
        let each = left / (tiled.len() + usize::from(traced > 0.0)).max(1) as f64;
        for key in &tiled {
            // A row drawn in part takes a word more: which held row it is.
            let per_row = costs[key].per_row.max(1.0) + 4.0 + costs[key].geometry / costs[key].rows.max(1) as f64;
            let rows = (each / per_row).min(f64::from(u32::MAX)) as u32;
            plans.get_mut(key).expect("listed").draw = Draw::Tiles { rows: rows.max(LEAST) };
        }
        let columns = if traced > 0.0 { ((each / traced) as u32).max(TRACE_COLUMNS) } else { u32::MAX };
        (plans, columns)
    }

    /// Each table the scene draws, drawn whole, placed and ordered by the first mark drawing it to
    /// give a place or a priority, with the fields its marks read; and what it costs.
    fn costs(&self) -> Costs {
        let space = &self.scene.space;
        let placing = matches!(space, Space::Earth(_) | Space::Plane(_));
        let mut plans = Plans::default();
        let mut costs: Keyed<(Name, Name), Cost> = Keyed::default();
        let mut shared: FxHashMap<u64, (f64, f64)> = FxHashMap::default();
        for shown in &self.marks {
            let style = shown.mark.style();
            let Some(table) = self.source(&style.data).and_then(|d| d.table(&style.table)) else { continue };
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
            let cost = costs.entry(key).or_insert(Cost { rows: table.len(), per_row: 0.0, geometry: 0.0, traced: 0.0 });
            cost.per_row += row_bytes(shown);
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

    /// The pages `shown` reads of `table`, and of the tables it joins, that every view drawing the
    /// same data shares, as `row_bytes` and `geometry_bytes` count them: each field's, by its version
    /// and how it is read.
    fn shared_pages(&self, shown: &Shown, table: &Table) -> Vec<(u64, f64)> {
        let Some(compiled) = &shown.compiled else { return Vec::new() };
        let mut pieces: Vec<(u64, f64)> = compiled
            .program
            .columns
            .iter()
            .filter(|c| c.words != Words::Path && !c.derived)
            .filter_map(|c| {
                let read = match &c.of {
                    None => table.field_named(&c.name),
                    Some((data, joined)) => self.source(data)?.table(joined)?.field_named(&c.name),
                };
                let width = if c.low { 8.0 } else { 4.0 };
                Some((stamp_of((read?.version(), c.low)), table.len() as f64 * width))
            })
            .collect();
        if let Some(field) = geometry_of(&shown.mark).and_then(|f| table.field_named(&f)) {
            let areas = matches!(shown.mark, Mark::Areas(_));
            pieces.push((stamp_of((field.version(), areas)), geometry_bytes(shown, table)));
        }
        pieces
    }

    /// Whether the table `key` names is edges or faces whose ends lie in a table drawn through tiles.
    fn ends_tiled(&self, key: &(Name, Name), plans: &Plans) -> bool {
        let Place::Ends(fields) = &plans[key].place else { return false };
        let Some(table) = self.source(&key.0).and_then(|d| d.table(&key.1)) else { return false };
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

/// Bytes a row of `shown` takes on the GPU: its state and the frozen mirror a transition keeps, its
/// focus word, a word for each column it reads and two for a position's, and its label's candidate.
fn row_bytes(shown: &Shown) -> f64 {
    let Some(compiled) = &shown.compiled else { return 0.0 };
    let state = f64::from(compiled.drawing.stride + compiled.drawing.extras) * 8.0;
    let columns: f64 =
        compiled.program.columns.iter().filter(|c| c.words != Words::Path).map(|c| if c.low { 8.0 } else { 4.0 }).sum();
    let label = if compiled.drawing.label.is_some() { f64::from(wgsl::CANDIDATE_WORDS) * 4.0 } else { 0.0 };
    state + 4.0 + columns + label
}

/// Bytes the traces `shown` draws of `table` take for each pixel column they span: a row's for each
/// field it traces.
fn traced_bytes(shown: &Shown, table: &Table) -> f64 {
    let Some(compiled) = &shown.compiled else { return 0.0 };
    let traced = compiled.program.columns.iter().filter(|c| {
        c.trace && c.of.is_none() && !c.derived && matches!(table.field_named(&c.name), Some(Field::Sampled(..)))
    });
    traced.count() as f64 * table.len() as f64 * TRACE_COLUMN_BYTES
}

/// Bytes the geometry `shown` draws of `table` takes: its points, and an area's triangles about
/// three times as many.
fn geometry_bytes(shown: &Shown, table: &Table) -> f64 {
    let Some(field) = geometry_of(&shown.mark) else { return 0.0 };
    let Some(Field::Values(column, _)) = table.field_named(&field) else { return 0.0 };
    let points: usize = column.pages().iter().filter_map(|p| p.values.geometry()).map(Geometry::coords_spanned).sum();
    let scale = if matches!(shown.mark, Mark::Areas(_)) { 3.0 } else { 1.0 };
    points as f64 * 8.0 * scale
}
