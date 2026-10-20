//! Shapes: what geometry fields become to draw, written beside the tables marks draw them from. Every
//! area's triangles, the point its label hangs from first; and on the earth every line's path,
//! unwrapped across the antimeridian and bent with the globe. Shapes are made page by page from a
//! field's pages and kept while a page holds; a page written again keeps the shapes of its rows
//! whose geometry did not change, so a tile landing shapes only its own rows. Triangles that do not
//! fit the frame's budget are made in a job, their rows drawing nothing until it lands; bending a
//! path is cheap, and done at once.

use rustc_hash::FxHashMap;

use super::{Derive, Input, Jobs, Tables, answers, beside, stamp_of};
use crate::data::{Column, Field, GeometryBuilder, Id, Name, PAGE_ROWS, Page, PageId, Table, Value, Values, Version};
use crate::host::{Job, Shaping};
use crate::scene::areas::triangles_of;
use crate::scene::lines::path_of;
use crate::{Mark, Pending, Space};

/// Microseconds a point takes to triangulate, by estimate.
const TRIANGULATE: f64 = 0.5;

/// Rows by id, each with the digest of the geometry it was shaped from.
type Digests = FxHashMap<Id, u64>;

/// A field to shape: its dataset, table, and field, and how.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct Want {
    data: Name,
    table: Name,
    field: Name,
    shaping: Shaping,
}

impl Want {
    /// The derived field the shapes are written as.
    fn derived(&self) -> Name {
        match self.shaping {
            Shaping::Triangles { .. } => triangles_of(&self.field),
            Shaping::Path => path_of(&self.field),
        }
    }
}

/// One field's shapes: the last whole set made, the derived field written, shapes made but not yet
/// written, and a job under way.
#[derive(Default)]
struct Shaped {
    /// The source table, its field, and the derived column the shapes were last wholly made from.
    made: Option<(Table, Column, Column)>,
    /// The derived field written last, and the stamp of what it was written from.
    field: Option<Field>,
    stamp: u64,
    /// Shapes made since, by row id: the digest of the geometry each was made from, and the shape.
    landed: FxHashMap<Id, (u64, Value)>,
    /// A job under way, with the digest of each row it shapes.
    working: Option<(Pending<Vec<u8>>, Digests)>,
    /// Bumps whenever a job's answer lands.
    landings: u64,
}

#[derive(Default)]
pub(crate) struct Shapes {
    tables: Tables,
    shaped: FxHashMap<Want, Shaped>,
}

impl Derive for Shapes {
    fn update(&mut self, input: &Input<'_>, jobs: &mut Jobs<'_>) -> bool {
        let wants = wants(input);
        self.shaped.retain(|want, _| wants.contains(want));
        let mut changed = false;
        for want in &wants {
            let Some(source) = input.data(&want.data).and_then(|d| d.table(&want.table)) else { continue };
            let shaped = self.shaped.entry(want.clone()).or_default();
            changed |= shaped.update(want, source, jobs);
        }
        // Each drawn table's derived table holds every field shaped from it.
        let mut fields: FxHashMap<(Name, Name), Vec<(Name, Field)>> = FxHashMap::default();
        for want in &wants {
            if let Some(field) = self.shaped.get(want).and_then(|s| s.field.clone()) {
                fields.entry((want.data.clone(), want.table.clone())).or_default().push((want.derived(), field));
            }
        }
        let before = self.tables.len();
        self.tables.retain(|key, _| fields.contains_key(key));
        changed |= self.tables.len() != before;
        if changed {
            for (key, fields) in fields {
                let Some(source) = input.data(&key.0).and_then(|d| d.table(&key.1)) else { continue };
                self.tables.insert(key, beside(source, fields));
            }
        }
        changed
    }

    fn busy(&self) -> bool {
        self.shaped.values().any(|s| s.working.is_some())
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    fn clear(&mut self) {
        self.tables.clear();
        self.shaped.clear();
    }
}

/// The fields the scene's marks shape: every area's polygons, and on the earth every line's paths.
fn wants(input: &Input<'_>) -> Vec<Want> {
    let earth = matches!(input.scene.space, Space::Earth(_));
    let mut wants: Vec<Want> = Vec::new();
    for mark in &input.scene.marks {
        let (field, shaping) = match mark {
            Mark::Areas(areas) => (areas.field(), Shaping::Triangles { earth }),
            Mark::Lines(lines) if earth => (lines.traced(), Shaping::Path),
            _ => continue,
        };
        let style = mark.style();
        let want = Want { data: style.data.clone(), table: style.table.clone(), field, shaping };
        if !wants.contains(&want) {
            wants.push(want);
        }
    }
    wants
}

impl Shaped {
    /// Brings the shapes up to `source`; whether the derived field changed.
    fn update(&mut self, want: &Want, source: &Table, jobs: &mut Jobs<'_>) -> bool {
        if let Some((pending, asked)) = &self.working
            && let Some(answer) = pending.take()
        {
            for ((_, id), values) in answer.map(|bytes| answers(&bytes, &["shape"])).unwrap_or_default() {
                if let (Some(&digest), Some(Some(shape))) = (asked.get(&id), values.into_iter().next()) {
                    self.landed.insert(id, (digest, shape));
                }
            }
            self.working = None;
            self.landings += 1;
        }
        let Some(Field::Values(column, version)) = source.field_named(&want.field) else {
            let had = self.field.take().is_some();
            self.stamp = 0;
            return had;
        };
        let depth = column.kind().depth();
        let ((Some(depth @ (2 | 3)), Shaping::Triangles { .. }) | (Some(depth @ 1..), Shaping::Path)) =
            (depth, want.shaping)
        else {
            return self.field.take().is_some();
        };
        let stamp = stamp_of((source.structure, *version, self.landings, want.shaping));
        if stamp == self.stamp {
            return false;
        }
        self.stamp = stamp;
        // Rows shaped on the frame land at once; a second pass writes them.
        for _ in 0..2 {
            let (derived, missing) = self.build(want, source, column, depth);
            if missing.is_empty() {
                self.field = Some(Field::Values(derived.clone(), Version::next()));
                self.made = Some((source.clone(), column.clone(), derived));
                self.landed.clear();
                return true;
            }
            let points: usize = missing.iter().map(|&(row, ..)| points_of(column, row)).sum();
            if jobs.fits((points as f64 * TRIANGULATE).ceil() as u64) {
                for (row, id, digest) in missing {
                    let Some(value) = column.get(row) else { continue };
                    let shape = want.shaping.shape(&value).unwrap_or(value);
                    self.landed.insert(id, (digest, shape));
                }
                continue;
            }
            if self.working.is_none() {
                let rows: Vec<usize> = missing.iter().map(|&(row, ..)| row).collect();
                let job = Job::shapes(want.shaping, rows_of(source, column, &rows));
                let asked = missing.into_iter().map(|(_, id, digest)| (id, digest)).collect();
                self.working = Some((jobs.spawn(job), asked));
            }
            // Until the job lands, its rows draw nothing and the rest draw as they were.
            self.field = Some(Field::Values(derived, Version::next()));
            return true;
        }
        false
    }

    /// The derived column for `column` of `source`, page by page: a page whose source page is the
    /// one shaped last keeps its shapes; others are assembled row by row from shapes landed, or kept
    /// from the last set where a row's geometry did not change. Rows with neither are missing: each
    /// row, its id, and the digest of its geometry.
    fn build(&self, want: &Want, source: &Table, column: &Column, depth: u8) -> (Column, Vec<(usize, Id, u64)>) {
        let made_pages: FxHashMap<PageId, &Page> = self
            .made
            .iter()
            .flat_map(|(_, field, derived)| field.pages().iter().map(|p| p.id).zip(derived.pages()))
            .collect();
        let depth = want.shaping.depth(depth);
        let mut pages: Vec<Page> = Vec::with_capacity(column.pages().len());
        let mut missing = Vec::new();
        for (p, page) in column.pages().iter().enumerate() {
            if let Some(&kept) = made_pages.get(&page.id) {
                pages.push(kept.clone());
                continue;
            }
            let Some(geometry) = page.values.geometry() else {
                pages.push(Page::new(Values::of_geometry(GeometryBuilder::new(depth).finish())));
                continue;
            };
            // A path page that needs no bending is its own shape: shared, nothing uploads again.
            if want.shaping == Shaping::Path && !bends(geometry.coords()) {
                pages.push(page.clone());
                continue;
            }
            let mut shapes = GeometryBuilder::new(depth);
            for local in 0..page.values.len() {
                let row = p * PAGE_ROWS + local;
                let Some(id) = source.ids.id(row) else {
                    shapes.push_empty();
                    continue;
                };
                if !page.values.is_valid(local) {
                    shapes.push_empty();
                    continue;
                }
                let digest = geometry.row_hash(local);
                if let Some((d, shape)) = self.landed.get(&id)
                    && *d == digest
                {
                    shapes.push_value(shape);
                } else if let Some((page, at)) = self.kept(&id, digest) {
                    shapes.push_from(page, at);
                } else if want.shaping == Shaping::Path {
                    // Bending is cheap, so done here; rows that need none keep their geometry.
                    match page.values.get(local).and_then(|v| want.shaping.shape(&v)) {
                        Some(shape) => {
                            shapes.push_value(&shape);
                        }
                        None => shapes.push_from(geometry, local),
                    }
                } else {
                    missing.push((row, id, digest));
                    shapes.push_empty();
                }
            }
            pages.push(Page::new(Values::of_geometry(shapes.finish())));
        }
        let like = Values::of_geometry(GeometryBuilder::new(depth).finish());
        (Column::of_pages(pages, &like), missing)
    }

    /// Where the last whole set holds the shape of the row with `id`, when its geometry's digest was
    /// `digest`: the derived page's geometry and the row's place in it.
    fn kept(&self, id: &Id, digest: u64) -> Option<(&crate::data::Geometry, usize)> {
        let (table, field, derived) = self.made.as_ref()?;
        let row = table.row(id.as_ref())?;
        let (page, at) = (row / PAGE_ROWS, row % PAGE_ROWS);
        let was = field.pages().get(page)?.values.geometry()?;
        if !field.pages()[page].values.is_valid(at) || was.row_hash(at) != digest {
            return None;
        }
        Some((derived.pages().get(page)?.values.geometry()?, at))
    }
}

/// Whether any two coordinates in a row of `coords` lie farther apart than an earth path's step: a
/// page with none needs no bending.
fn bends(coords: &[[f64; 2]]) -> bool {
    let step = crate::geo::shapes::EARTH_STEP;
    coords.windows(2).any(|w| (w[1][0] - w[0][0]).abs() > step || (w[1][1] - w[0][1]).abs() > step)
}

/// How many points row `row` of geometry column `column` holds.
fn points_of(column: &Column, row: usize) -> usize {
    let Some(page) = column.pages().get(row / PAGE_ROWS) else { return 0 };
    page.values.geometry().map_or(0, |g| g.row_coords(row % PAGE_ROWS).len())
}

/// Rows `rows` of `source`, by id, with their geometry from `column` as field `geometry`: what a
/// shapes job reads.
fn rows_of(source: &Table, column: &Column, rows: &[usize]) -> Table {
    let ids: Vec<Id> = rows.iter().filter_map(|&row| source.ids.id(row)).collect();
    let depth = column.kind().depth().expect("a geometry column");
    let mut geometry = GeometryBuilder::new(depth);
    for &row in rows {
        let page = &column.pages()[row / PAGE_ROWS];
        match page.values.geometry() {
            Some(g) if page.values.is_valid(row % PAGE_ROWS) => geometry.push_from(g, row % PAGE_ROWS),
            _ => geometry.push_empty(),
        }
    }
    Table::new(source.name.clone(), ids).field("geometry", Values::of_geometry(geometry.finish()))
}
