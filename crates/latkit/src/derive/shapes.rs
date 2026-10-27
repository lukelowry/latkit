//! Shapes: the drawable forms of geometry fields.
//!
//! Each area becomes triangles, preceded by its label point. On the earth, each line's path is
//! unwrapped across the antimeridian and bent to follow the globe.
//!
//! A table drawn whole is shaped one page of its field at a time, into a field beside it. A page
//! keeps the shapes made from it before. A page written over another keeps the shapes of the rows
//! not written, so a write reshapes only the rows it wrote. A paged table is shaped one page of its
//! order at a time, the first time each page draws. A row whose geometry did not change keeps its
//! shape as its pages come and go.
//!
//! Triangulation that does not fit the frame's budget runs in a job. A page where every row needs
//! shaping goes to the job whole. Rows waiting on a job draw nothing until it finishes. Bending a
//! path is cheap and done at once. Vector tiles bring their own shapes, made in the job that
//! decodes them, as a field beside their rows. Their tables are paged and read that field one page
//! of their order at a time, like any other, so nothing shapes those rows again.

use rustc_hash::{FxHashMap, FxHashSet};

use super::order::Order;
use super::{Input, Jobs, Paged, Tables, Working, beside, stamp_of};
use crate::data::{
    Column, Field, Geometry, GeometryBuilder, Id, Keyed, Name, Page, PageId, RowIds, Table, Values, Version,
};
use crate::gpu::shaders::PAGE_ROWS;
use crate::host::{Job, Shaping, shapes_answer};
use crate::tiles::TileSets;
use crate::{Mark, Scene, Space};

/// Estimated microseconds to triangulate one point.
const TRIANGULATE: f64 = 0.5;

/// Rows to shape individually: each row index, its id, and its geometry digest.
type Rows = Vec<(usize, Id, u64)>;

/// Work left to shape: whole pages of the field where every row needs shaping (by page id, with
/// their values), and individual rows.
#[derive(Default)]
struct Missing {
    pages: Vec<(PageId, Values)>,
    rows: Rows,
}

impl Missing {
    fn is_empty(&self) -> bool {
        self.pages.is_empty() && self.rows.is_empty()
    }

    /// The number of points to shape.
    fn points(&self, column: &Column) -> usize {
        let pages: usize = self.pages.iter().map(|(_, values)| values.geometry().map_or(0, Geometry::points)).sum();
        pages + self.rows.iter().map(|&(row, ..)| points_of(column, row)).sum::<usize>()
    }

    /// Splits the work into a job's parts, each a geometry column: each whole page, then one part
    /// holding all the rows. Also returns what each part shapes.
    fn parts(self, column: &Column) -> (Vec<Values>, Vec<Asked>) {
        let (mut parts, mut asked) = (Vec::new(), Vec::new());
        for (id, values) in self.pages {
            asked.push(Asked::Page(id, values.len()));
            parts.push(values);
        }
        if !self.rows.is_empty() {
            let rows: Vec<usize> = self.rows.iter().map(|&(row, ..)| row).collect();
            parts.push(geometry_of(column, &rows));
            asked.push(Asked::Rows(self.rows.into_iter().map(|(_, id, digest)| (id, digest)).collect()));
        }
        (parts, asked)
    }
}

/// What one part of a job shapes: a whole page of the field (by page id, with its row count), or
/// rows (by id, each with its geometry digest).
#[derive(Hash)]
enum Asked {
    Page(PageId, usize),
    Rows(Vec<(Id, u64)>),
}

impl Asked {
    /// Empty shapes of depth `depth` for every row this part asks for.
    fn empty(&self, depth: u8) -> Values {
        empty_shapes(
            depth,
            match self {
                Asked::Page(_, rows) => *rows,
                Asked::Rows(rows) => rows.len(),
            },
        )
    }
}

/// `rows` empty shapes of depth `depth`, which draw nothing.
fn empty_shapes(depth: u8, rows: usize) -> Values {
    Values::of_rows(depth, std::iter::repeat_n(None, rows))
}

/// Shapes made since the last complete set. Whole pages are keyed by the id of the field page each
/// was made from. Rows are keyed by id, each with the geometry digest it was made from and its part
/// and index in `parts`.
#[derive(Default)]
struct Landed {
    pages: FxHashMap<PageId, Page>,
    rows: FxHashMap<Id, (u64, u32, u32)>,
    parts: Vec<Values>,
}

impl Landed {
    /// Stores `shapes`, the shapes of each part `asked` names.
    fn land(&mut self, asked: Vec<Asked>, shapes: Vec<Values>) {
        for (asked, shapes) in asked.into_iter().zip(shapes) {
            match asked {
                Asked::Page(id, _) => {
                    self.pages.insert(id, Page::new(shapes));
                }
                Asked::Rows(rows) => {
                    let part = self.parts.len() as u32;
                    for (i, (id, digest)) in rows.into_iter().enumerate() {
                        self.rows.insert(id, (digest, part, i as u32));
                    }
                    self.parts.push(shapes);
                }
            }
        }
    }

    /// Where the shape of the row with `id` lies, if made from geometry with digest `digest`.
    fn row(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        let &(made, part, at) = self.rows.get(id)?;
        (made == digest).then_some(())?;
        Some((self.parts[part as usize].geometry()?, at as usize))
    }
}

/// A field to shape: its dataset, table, field, and shaping.
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
        self.shaping.field_of(&self.field)
    }
}

/// The shapes of a paged table, per page of its order: each page holds its rows' shapes in order,
/// with a page id of its own. Kept rows whose pages are not drawn are shaped individually, by their
/// place in the order.
pub(crate) struct PagedShapes {
    /// The id of the order these pages belong to.
    pub(crate) order: u64,
    /// Bumps whenever a page or kept row is shaped.
    pub(crate) version: Version,
    pub(crate) pages: FxHashMap<u32, ShapedPage>,
    pub(crate) kept: FxHashMap<u32, Values>,
    /// The nesting depth of the shapes' geometry.
    pub(crate) depth: u8,
}

/// One shaped page of an order.
pub(crate) struct ShapedPage {
    pub(crate) id: PageId,
    pub(crate) shapes: Values,
    /// Whether every row has its shape, with none waiting for a job.
    whole: bool,
}

/// What a paged table's shapes were made from: the order, the source table and field column, and
/// the shaped pages.
struct Paging {
    order: Order,
    source: Table,
    column: Column,
    shapes: PagedShapes,
}

impl Paging {
    /// Where a complete page holds the shape of the row with `id`, if the row's geometry digest is
    /// still `digest`: the page's geometry and the row's index in it.
    fn held(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        let row = self.source.row(id.as_ref())?;
        let (values, i) = self.column.at(row).filter(|&(values, i)| values.is_valid(i))?;
        if row >= self.order.len() as usize || values.geometry()?.row_hash(i) != digest {
            return None;
        }
        let d = self.order.rank(row as u32);
        let page = self.shapes.pages.get(&(d / PAGE_ROWS)).filter(|page| page.whole)?;
        Some((page.shapes.geometry()?, (d % PAGE_ROWS) as usize))
    }
}

/// One field's shapes and any pending job. For a table drawn whole, it holds the last complete set,
/// the derived field written, and shapes made but not yet written. For a paged table, it holds its
/// pages and the previous order's pages.
#[derive(Default)]
struct Shaped {
    /// The source table, its field column, and the derived column from the last time every row
    /// was shaped.
    made: Option<(Table, Column, Column)>,
    /// The derived field written last.
    field: Option<Field>,
    /// The stamp of the inputs `field` was written from.
    stamp: u64,
    /// Shapes made since the last complete set.
    landed: Landed,
    /// Paged: its shaped pages.
    paging: Option<Paging>,
    /// The pages of the previous order. New pages copy the shapes of unchanged rows from it.
    before: Option<Paging>,
    /// A shaping job, for the stamp of what it asks, with what each of its parts shapes.
    working: Working<Vec<Asked>>,
    /// Bumps whenever a job's answer arrives.
    landings: u64,
}

#[derive(Default)]
pub(crate) struct Shapes {
    tables: Tables,
    shaped: FxHashMap<Want, Shaped>,
}

impl Shapes {
    /// Updates the shapes to `input`, using as is any shapes the vector tiles in `tiles` bring, and
    /// sending work the frame cannot afford to `jobs`. Returns whether its tables changed.
    pub(crate) fn update(&mut self, input: &Input<'_>, tiles: &TileSets, jobs: &mut Jobs<'_>) -> bool {
        let wants = wants(input);
        self.shaped.retain(|want, _| wants.contains(want));
        let mut changed = false;
        for want in &wants {
            let Some(source) = input.data(&want.data).and_then(|d| d.table(&want.table)) else { continue };
            let shaped = self.shaped.entry(want.clone()).or_default();
            // Vector tiles bring their own shapes, row for row.
            let brought = tiles.shaped(&want.data).and_then(|d| d.table(&want.table)?.field_named(&want.derived()));
            if let Some(field @ Field::Values(column, _)) = brought
                && column.len() == source.len()
            {
                changed |= shaped.take(field);
                continue;
            }
            let paged = input.paged.and_then(|paged| paged.get(&(want.data.clone(), want.table.clone())));
            changed |= shaped.update(want, source, paged, jobs);
        }
        // Each table drawn whole has a derived table holding every field shaped from it.
        let mut fields: Keyed<(Name, Name), Vec<(Name, Field)>> = Keyed::default();
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

    /// Whether a shape job is pending. The rows it shapes draw nothing until it finishes.
    pub(crate) fn busy(&self) -> bool {
        self.shaped.values().any(|s| s.working.busy())
    }

    /// Whether every drawn row has its shape.
    pub(crate) fn complete(&self) -> bool {
        !self.busy()
    }

    /// The derived tables beside tables drawn whole, each holding the fields shaped from it.
    pub(crate) fn tables(&self) -> &Tables {
        &self.tables
    }

    /// The shapes of paged table `table` of dataset `data`, each with its derived field's name.
    pub(crate) fn paged(&self, data: &Name, table: &Name) -> Vec<(Name, &PagedShapes)> {
        self.shaped
            .iter()
            .filter(|(want, _)| want.data == *data && want.table == *table)
            .filter_map(|(want, shaped)| Some((want.derived(), &shaped.paging.as_ref()?.shapes)))
            .collect()
    }
}

/// The field mark `mark` shapes, and how: an area's polygons, or on the earth a line's paths.
fn shaping_of(mark: &Mark, earth: bool) -> Option<(Name, Shaping)> {
    match mark {
        Mark::Areas(areas) => Some((areas.field(), Shaping::Triangles { earth })),
        Mark::Lines(lines) if earth => Some((lines.traced(), Shaping::Path)),
        _ => None,
    }
}

/// The fields of table `table` of dataset `data` that the scene's marks shape, and how, each once.
pub(crate) fn shapings(scene: &Scene, data: &Name, table: &Name) -> Vec<(Name, Shaping)> {
    let earth = matches!(scene.space, Space::Earth(_));
    let mut shapings = Vec::new();
    for mark in scene.marks.iter().filter(|m| m.style().data == *data && m.style().table == *table) {
        if let Some(shaping) = shaping_of(mark, earth).filter(|s| !shapings.contains(s)) {
            shapings.push(shaping);
        }
    }
    shapings
}

/// The fields the scene's marks shape: every area's polygons, and on the earth every line's paths.
fn wants(input: &Input<'_>) -> Vec<Want> {
    let earth = matches!(input.scene.space, Space::Earth(_));
    let mut wants: Vec<Want> = Vec::new();
    for mark in &input.scene.marks {
        let Some((field, shaping)) = shaping_of(mark, earth) else { continue };
        let style = mark.style();
        let want = Want { data: style.data.clone(), table: style.table.clone(), field, shaping };
        if !wants.contains(&want) {
            wants.push(want);
        }
    }
    wants
}

impl Shaped {
    /// Updates the shapes to `source`: as a paged table when `paged` is given, else drawn whole.
    /// Returns whether they changed.
    fn update(&mut self, want: &Want, source: &Table, paged: Option<&Paged>, jobs: &mut Jobs<'_>) -> bool {
        let Some(Field::Values(column, version)) = source.field_named(&want.field) else { return self.forget() };
        let Some(depth) = column.kind().depth().filter(|&depth| want.shaping.takes(depth)) else {
            return self.forget();
        };
        self.settle(want.shaping.depth(depth));
        if let Some(paged) = paged {
            // If it draws whole again later, its field is rewritten from scratch.
            let had = self.field.take().is_some();
            self.stamp = 0;
            return self.update_paged(want, source, column, depth, paged, jobs) || had;
        }
        // Drawn whole again: unchanged rows take their shapes from the paged shapes.
        let had = self.paging.is_some();
        if had {
            self.before = self.paging.take();
        }
        self.update_whole(want, source, column, *version, depth, jobs) || had
    }

    /// Takes a finished job's shapes, of depth `depth`. A job that failed, or that answered other
    /// parts than it was asked, gives its rows empty shapes: they draw nothing until their geometry
    /// changes.
    fn settle(&mut self, depth: u8) {
        let Some((_, asked, answer)) = self.working.landed() else { return };
        let shapes = answer.ok().and_then(|bytes| shapes_answer(&bytes)).filter(|shapes| shapes.len() == asked.len());
        let shapes = shapes.unwrap_or_else(|| asked.iter().map(|part| part.empty(depth)).collect());
        self.landed.land(asked, shapes);
        self.landings += 1;
    }

    /// Uses `field`, made elsewhere (by vector tiles), as its shapes. Returns whether they changed.
    fn take(&mut self, field: &Field) -> bool {
        let changed = self.field.as_ref().is_none_or(|f| f.version() != field.version());
        *self = Shaped { field: Some(field.clone()), ..Shaped::default() };
        changed
    }

    /// Drops its shapes and any pending job once its field no longer needs shaping. Returns whether
    /// it had any shapes.
    fn forget(&mut self) -> bool {
        let had = self.field.is_some() || self.paging.is_some();
        (self.field, self.paging, self.before, self.stamp) = (None, None, None, 0);
        self.working.cancel();
        had
    }

    /// Updates the shapes of a table drawn whole to `source`. Returns whether its field changed.
    fn update_whole(
        &mut self,
        want: &Want,
        source: &Table,
        column: &Column,
        version: Version,
        depth: u8,
        jobs: &mut Jobs<'_>,
    ) -> bool {
        let stamp = stamp_of((source.structure, version, self.landings, want.shaping));
        if stamp == self.stamp {
            return false;
        }
        self.stamp = stamp;
        let (mut derived, mut missing) = self.build(want, source, column, depth);
        // Shapes made on the frame apply at once. Rebuild the column with them.
        if !missing.is_empty() {
            match self.shape_now(want, column, missing, jobs) {
                Ok(()) => (derived, missing) = self.build(want, source, column, depth),
                Err(left) => missing = left,
            }
        }
        if missing.is_empty() {
            self.field = Some(Field::Values(derived.clone(), Version::next()));
            self.made = Some((source.clone(), column.clone(), derived));
            self.landed = Landed::default();
            self.before = None;
            return true;
        }
        self.ask(want, column, missing, jobs);
        // Until the job finishes, its rows draw nothing and the rest draw unchanged.
        self.field = Some(Field::Values(derived, Version::next()));
        true
    }

    /// Updates the shapes of a paged table to `source`. Shapes each page `paged` draws the first
    /// time it draws, and again once the rows it waited on arrive. Returns whether a page was made.
    fn update_paged(
        &mut self,
        want: &Want,
        source: &Table,
        column: &Column,
        depth: u8,
        paged: &Paged,
        jobs: &mut Jobs<'_>,
    ) -> bool {
        let order = &paged.order;
        // A new order: its pages are made from scratch, copying unchanged rows' shapes from the
        // previous order's pages.
        if self.paging.as_ref().is_none_or(|p| p.shapes.order != order.id()) {
            let shapes = PagedShapes {
                order: order.id(),
                version: Version::next(),
                pages: FxHashMap::default(),
                kept: FxHashMap::default(),
                depth: want.shaping.depth(depth),
            };
            let fresh = Paging { order: order.clone(), source: source.clone(), column: column.clone(), shapes };
            self.before = self.paging.replace(fresh).or(self.before.take());
        }
        let paging = self.paging.as_mut().expect("paged");
        paging.order = order.clone();
        // Remake the pages holding rows written since, and reshape those rows where kept.
        if !paging.column.shares(column) {
            let written = column.written_since(&paging.column);
            for &row in written.iter().filter(|&&row| row < order.len() as usize) {
                paging.shapes.pages.remove(&(order.rank(row as u32) / PAGE_ROWS));
            }
            if !paging.shapes.kept.is_empty() {
                let written: FxHashSet<u32> = written.into_iter().map(|row| row as u32).collect();
                paging.shapes.kept.retain(|&d, _| !written.contains(&order.source(d)));
            }
            (paging.source, paging.column) = (source.clone(), column.clone());
        }
        paging.shapes.kept.retain(|d, _| paged.kept.binary_search(d).is_ok());
        // Make drawn pages that are not made yet, or that wait on rows while no job runs. While no
        // job runs, also shape kept rows not shaped yet.
        let running = self.working.busy();
        let made = &paging.shapes.pages;
        let make: Vec<u32> =
            paged.pages.iter().copied().filter(|p| made.get(p).is_none_or(|page| !page.whole && !running)).collect();
        let kept_made = &paging.shapes.kept;
        let keep: Vec<u32> = if running {
            Vec::new()
        } else {
            paged.kept.iter().copied().filter(|d| !kept_made.contains_key(d)).collect()
        };
        if make.is_empty() && keep.is_empty() {
            return false;
        }
        let (mut made, mut kept, mut missing) = self.make_paged(want, order, &make, &keep, source, column, depth);
        // Shapes made on the frame apply at once. Remake the pages with them.
        if !missing.rows.is_empty() {
            match self.shape_now(want, column, missing, jobs) {
                Ok(()) => (made, kept, missing) = self.make_paged(want, order, &make, &keep, source, column, depth),
                Err(left) => missing = left,
            }
        }
        if !missing.is_empty() {
            self.ask(want, column, missing, jobs);
        }
        let paging = self.paging.as_mut().expect("paged");
        for (page, shapes, whole) in made {
            paging.shapes.pages.insert(page, ShapedPage { id: PageId::next(), shapes, whole });
        }
        paging.shapes.kept.extend(kept);
        paging.shapes.version = Version::next();
        // Every page complete and no job pending: the pages hold every shape that arrived, and the
        // previous order is no longer needed.
        if !self.working.busy() && paging.shapes.pages.values().all(|page| page.whole) {
            self.landed = Landed::default();
            self.before = None;
        }
        true
    }

    /// Shapes pages `make` of `order`, each with whether it is complete, and kept rows `keep` (by
    /// place in the order). Also returns the rows left to shape.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    fn make_paged(
        &self,
        want: &Want,
        order: &Order,
        make: &[u32],
        keep: &[u32],
        source: &Table,
        column: &Column,
        depth: u8,
    ) -> (Vec<(u32, Values, bool)>, Vec<(u32, Values)>, Missing) {
        let mut missing = Missing::default();
        let mut made = Vec::with_capacity(make.len());
        for &page in make {
            let (shapes, rows) = self.make_rows(want, &order.page(page), source, column, depth);
            made.push((page, shapes, rows.is_empty()));
            missing.rows.extend(rows);
        }
        let mut kept = Vec::with_capacity(keep.len());
        for &d in keep {
            let (shape, rows) = self.make_rows(want, &[order.source(d)], source, column, depth);
            if rows.is_empty() {
                kept.push((d, shape));
            }
            missing.rows.extend(rows);
        }
        (made, kept, missing)
    }

    /// Shapes `missing` on the frame if it fits the rest of the budget. Otherwise returns it.
    fn shape_now(
        &mut self,
        want: &Want,
        column: &Column,
        missing: Missing,
        jobs: &mut Jobs<'_>,
    ) -> Result<(), Missing> {
        if !jobs.fits((missing.points(column) as f64 * TRIANGULATE).ceil() as u64) {
            return Err(missing);
        }
        let (parts, asked) = missing.parts(column);
        let shapes = parts.iter().map(|part| want.shaping.shapes_of(part)).collect();
        self.landed.land(asked, shapes);
        Ok(())
    }

    /// Starts a job to shape `missing`, unless the same job already ran. While a job is pending it
    /// does nothing, and a later update asks again.
    fn ask(&mut self, want: &Want, column: &Column, missing: Missing, jobs: &mut Jobs<'_>) {
        if self.working.busy() {
            return;
        }
        let (parts, asked) = missing.parts(column);
        let stamp = stamp_of(&asked);
        if self.working.may_start(stamp) {
            self.working.start(stamp, jobs.spawn(Job::shapes(want.shaping, &parts)), asked);
        }
    }

    /// Builds the derived column for `column` of `source`, page by page, and returns what is left
    /// to shape. A page reuses the shapes made from it before, or that arrived for it. A page
    /// written over a shaped page keeps the shapes of its rows not written. A page at the same
    /// place in the last complete set keeps the shapes of its unchanged rows. A page where no row
    /// can reuse a shape is shaped whole. Otherwise each row reuses a shape made from the same
    /// geometry, or is left to shape.
    fn build(&self, want: &Want, source: &Table, column: &Column, depth: u8) -> (Column, Missing) {
        let made_pages: FxHashMap<PageId, &Page> = self
            .made
            .iter()
            .flat_map(|(_, field, derived)| field.pages().iter().map(|p| p.id).zip(derived.pages()))
            .collect();
        let depth = want.shaping.depth(depth);
        // Rows below `aligned` are at the same places as in the last complete set: since then they
        // were only written over, or rows were appended after them.
        let aligned = self.made.as_ref().map_or(0, |(table, ..)| aligned(source, table));
        // Whether row `row` may find a shape made before: it is aligned, or rows moved since the
        // last complete set (`aligned` is 0), so a lookup by id may find one.
        let found = |row: usize| row < aligned || self.made.is_some() && aligned == 0;
        let fresh = self.before.is_none() && self.landed.rows.is_empty() && want.shaping != Shaping::Path;
        let mut pages: Vec<Page> = Vec::with_capacity(column.pages().len());
        let mut missing = Missing::default();
        for (p, page) in column.pages().iter().enumerate() {
            if let Some(&kept) = made_pages.get(&page.id) {
                pages.push(kept.clone());
                continue;
            }
            if let Some(landed) = self.landed.pages.get(&page.id) {
                pages.push(landed.clone());
                continue;
            }
            let Some(geometry) = page.values.geometry() else {
                pages.push(Page::new(empty_shapes(depth, 0)));
                continue;
            };
            // A path page needing no bending is its own shape. Sharing it means no new upload.
            if want.shaping == Shaping::Path && !bends(geometry) {
                pages.push(page.clone());
                continue;
            }
            let start = p * PAGE_ROWS as usize;
            let len = page.values.len();
            let kept = self.over(page, &made_pages).or_else(|| {
                let (_, field, derived) = self.made.as_ref().filter(|_| start < aligned)?;
                let was = &field.pages().get(p)?.values;
                let same = (0..len).map(|i| start + i < aligned && page.values.same_row(i, was, i)).collect();
                Some((&derived.pages().get(p)?.values, same))
            });
            if fresh && kept.is_none() && !found(start) {
                // Every row needs shaping: shape the page whole. It draws nothing until then.
                pages.push(Page::new(empty_shapes(depth, len)));
                missing.pages.push((page.id, page.values.clone()));
                continue;
            }
            let mut shapes = GeometryBuilder::new(depth);
            for local in 0..len {
                if let Some((was, keep)) = &kept
                    && keep.get(local).copied().unwrap_or(false)
                    && let Some(was) = was.geometry()
                {
                    shapes.push_from(was, local);
                    continue;
                }
                let row = start + local;
                match source.ids.id(row).filter(|_| page.values.is_valid(local)) {
                    Some(id) => self.shape(want, &mut shapes, (&page.values, local), row, id, &mut missing.rows),
                    None => shapes.push_empty(),
                }
            }
            pages.push(Page::new(Values::of_geometry(shapes.finish())));
        }
        (Column::of_pages(pages, &empty_shapes(depth, 0)), missing)
    }

    /// The shapes of the page that `page` was written over, searching back through its recorded
    /// writes (a few at most), with whether each row keeps its shape (rows not written since do).
    fn over<'a>(&'a self, page: &Page, made: &FxHashMap<PageId, &'a Page>) -> Option<(&'a Values, Vec<bool>)> {
        let mut written: Vec<u32> = Vec::new();
        let mut at = page.written.as_deref();
        while let Some(w) = at {
            written.extend_from_slice(&w.rows);
            if let Some(shapes) = made.get(&w.from).copied().or_else(|| self.landed.pages.get(&w.from)) {
                let mut keep = vec![true; page.values.len()];
                for &row in &written {
                    if let Some(k) = keep.get_mut(row as usize) {
                        *k = false;
                    }
                }
                keep.truncate(shapes.values.len());
                return Some((&shapes.values, keep));
            }
            at = w.before.as_deref();
        }
        None
    }

    /// Shapes rows `rows` of `source` in that order, as [`shape`](Shaped::shape) does, and returns
    /// the rows left to shape.
    fn make_rows(&self, want: &Want, rows: &[u32], source: &Table, column: &Column, depth: u8) -> (Values, Rows) {
        let mut shapes = GeometryBuilder::new(want.shaping.depth(depth));
        let mut missing = Vec::new();
        for row in rows.iter().map(|&r| r as usize) {
            let found = column.at(row).filter(|&(values, i)| values.is_valid(i));
            match (found, source.ids.id(row)) {
                (Some(at), Some(id)) => self.shape(want, &mut shapes, at, row, id, &mut missing),
                _ => shapes.push_empty(),
            }
        }
        (Values::of_geometry(shapes.finish()), missing)
    }

    /// Writes the shape of row `row` (with `id`), whose geometry is value `i` of `values`. Reuses a
    /// shape that arrived or was made before from the same geometry. Bends a path at once.
    /// Otherwise writes an empty shape and adds the row to `missing`.
    fn shape(
        &self,
        want: &Want,
        shapes: &mut GeometryBuilder,
        (values, i): (&Values, usize),
        row: usize,
        id: Id,
        missing: &mut Rows,
    ) {
        let Some(geometry) = values.geometry() else {
            shapes.push_empty();
            return;
        };
        let digest = geometry.row_hash(i);
        if let Some((landed, at)) = self.landed.row(&id, digest).or_else(|| self.kept(&id, digest)) {
            shapes.push_from(landed, at);
        } else if want.shaping == Shaping::Path {
            // Bending is cheap, so it runs here. Rows needing none keep their geometry.
            match values.get(i).and_then(|v| want.shaping.shape(&v)) {
                Some(shape) => {
                    shapes.push_value(&shape);
                }
                None => shapes.push_from(geometry, i),
            }
        } else {
            missing.push((row, id, digest));
            shapes.push_empty();
        }
    }

    /// Where an earlier shape of the row with `id` lies, if made from geometry with digest
    /// `digest`: in the last complete set, or in a complete page of the previous paged order.
    fn kept(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        self.whole(id, digest).or_else(|| self.before.as_ref()?.held(id, digest))
    }

    /// Where the last complete set holds the shape of the row with `id`, if made from geometry with
    /// digest `digest`: the derived page's geometry and the row's index in it.
    fn whole(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        let (table, field, derived) = self.made.as_ref()?;
        let row = table.row(id.as_ref())?;
        let (page, at) = (row / PAGE_ROWS as usize, row % PAGE_ROWS as usize);
        let was = field.pages().get(page)?.values.geometry()?;
        if !field.pages()[page].values.is_valid(at) || was.row_hash(at) != digest {
            return None;
        }
        Some((derived.pages().get(page)?.values.geometry()?, at))
    }
}

/// How many leading rows of `now` are `then`'s rows at the same places: all of them if no rows came
/// or went, `then`'s rows if rows were only appended after them, else 0.
fn aligned(now: &Table, then: &Table) -> usize {
    if now.structure == then.structure {
        return now.len();
    }
    match (&now.ids, &then.ids) {
        (RowIds::Count(_), RowIds::Count(_)) => now.len().min(then.len()),
        (RowIds::Listed(ids), RowIds::Listed(was)) if ids.kept_below(was, was.len()) => was.len(),
        _ => 0,
    }
}

/// Whether any two consecutive coordinates of `geometry` lie farther apart than an earth path's
/// step. A page with none needs no bending.
fn bends(geometry: &Geometry) -> bool {
    let step = crate::geo::shapes::EARTH_STEP;
    let coords = geometry.coords();
    coords.windows(2).any(|w| (w[1][0] - w[0][0]).abs() > step || (w[1][1] - w[0][1]).abs() > step)
}

/// How many points row `row` of geometry column `column` holds.
fn points_of(column: &Column, row: usize) -> usize {
    column.at(row).and_then(|(values, i)| values.geometry().map(|g| g.row_coords(i).len())).unwrap_or(0)
}

/// The geometry of rows `rows` of geometry column `column`, in that order.
fn geometry_of(column: &Column, rows: &[usize]) -> Values {
    let depth = column.kind().depth().expect("a geometry column");
    Values::of_rows(
        depth,
        rows.iter().map(|&row| {
            let (values, i) = column.at(row).filter(|&(values, i)| values.is_valid(i))?;
            Some((values.geometry()?, i))
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::task::Waker;

    use super::*;
    use crate::derive::pyramid::Pyramid;
    use crate::derive::testing::Failing;
    use crate::gpu::work::Counters;
    use crate::{Areas, Data, Ids, Plane, Scene, Snapshot};

    type Ring = Vec<[f64; 2]>;

    /// A unit square at `x`.
    fn square(x: f64) -> Vec<Ring> {
        vec![vec![[x, 0.0], [x + 1.0, 0.0], [x + 1.0, 1.0], [x, 1.0], [x, 0.0]]]
    }

    /// The shaped pages of the one paged table in `shapes`, with their ids, by page.
    fn made(shapes: &Shapes) -> Vec<(u32, PageId)> {
        let paged = shapes.paged(&"map".into(), &"Zone".into());
        let mut pages: Vec<(u32, PageId)> = paged[0].1.pages.iter().map(|(&page, made)| (page, made.id)).collect();
        pages.sort_unstable_by_key(|&(page, _)| page);
        pages
    }

    /// The derived column of the one table drawn whole in `shapes`.
    fn derived(shapes: &Shapes) -> Column {
        match shapes.tables().get(&("map".into(), "Zone".into())).and_then(|t| t.field_named("geometry.triangles")) {
            Some(Field::Values(column, _)) => column.clone(),
            _ => panic!("triangles"),
        }
    }

    #[test]
    fn a_paged_table_shapes_only_the_pages_it_draws() {
        let n = 3 * PAGE_ROWS as usize;
        let data = Data::new("map");
        let squares: Vec<Vec<Ring>> = (0..n).map(|i| square(i as f64)).collect();
        data.apply(Table::new("Zone", Ids::count(n as u32)).field("geometry", squares)).expect("valid");
        let scene = Scene::new(Plane::default()).draw(Areas::of("map", "Zone"));
        // The order draws the rows backward.
        let pyramid = Arc::new(Pyramid::new((0..n as u32).rev().collect(), Vec::new()));
        let order = Order::Pyramid { pyramid, rows: n as u32 };
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut shapes = Shapes::default();
        let update = |shapes: &mut Shapes, data: &Snapshot, pages: Vec<u32>| {
            let mut paged = Keyed::default();
            paged.insert(("map".into(), "Zone".into()), Paged { order: order.clone(), pages, kept: Vec::new() });
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(data),
                host: None,
                dragging: false,
                paged: Some(&paged),
            };
            let mut jobs = Jobs::new(None, Waker::noop(), &counters, &errors, u32::MAX);
            shapes.update(&input, &TileSets::default(), &mut jobs);
        };
        update(&mut shapes, &data.snapshot(), vec![1]);
        let first = made(&shapes);
        assert_eq!(first.iter().map(|&(page, _)| page).collect::<Vec<_>>(), [1], "only the page drawn is shaped");
        let paged = shapes.paged(&"map".into(), &"Zone".into());
        let page = &paged[0].1.pages[&1];
        assert_eq!(page.shapes.len(), PAGE_ROWS as usize);
        let triangles = page.shapes.geometry().expect("triangles").row_coords(0).len();
        assert!(triangles >= 3, "its rows' triangles, in draw order: {triangles} points");
        // Drawing another page shapes it alone; the first keeps its shapes.
        update(&mut shapes, &data.snapshot(), vec![1, 2]);
        let second = made(&shapes);
        assert_eq!((second.len(), second[0]), (2, first[0]));
        // A write to a row on page 2 reshapes only that page.
        let row = u64::from(order.source(2 * PAGE_ROWS + 5));
        data.apply(Table::new("Zone", vec![row]).field("geometry", vec![square(-9.0)])).expect("valid");
        update(&mut shapes, &data.snapshot(), vec![1, 2]);
        let third = made(&shapes);
        assert_eq!(third[0], second[0], "page 1 has no written rows");
        assert_ne!(third[1].1, second[1].1, "page 2 is shaped again");
    }

    #[test]
    fn a_whole_table_shapes_in_a_job_and_reshapes_only_written_rows() {
        let n = 2 * PAGE_ROWS as usize + 10;
        let data = Data::new("map");
        let squares: Vec<Vec<Ring>> = (0..n).map(|i| square(i as f64)).collect();
        data.apply(Table::new("Zone", Ids::count(n as u32)).field("geometry", squares)).expect("valid");
        let scene = Scene::new(Plane::default()).draw(Areas::of("map", "Zone"));
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut shapes = Shapes::default();
        // No frame budget: every shape is made in a job, which finishes by the next update.
        let update = |shapes: &mut Shapes, data: &Data| {
            let data = data.snapshot();
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(&data),
                host: None,
                dragging: false,
                paged: None,
            };
            let mut jobs = Jobs::new(None, Waker::noop(), &counters, &errors, 0);
            shapes.update(&input, &TileSets::default(), &mut jobs)
        };
        let points = |column: &Column, row: usize| {
            column.at(row).map_or(0, |(values, i)| values.geometry().expect("triangles").row_coords(i).len())
        };
        assert!(update(&mut shapes, &data));
        assert!(shapes.busy(), "a job shapes them");
        assert_eq!(points(&derived(&shapes), 3), 0, "until the job finishes, rows draw nothing");
        assert!(update(&mut shapes, &data));
        let whole = derived(&shapes);
        assert!(!shapes.busy());
        assert_eq!(whole.pages().len(), 3);
        assert!((0..n).all(|row| points(&whole, row) >= 4), "every row holds its label point and triangles");
        // A write to one row reshapes only it: other pages keep their shapes, and its page keeps
        // those of the rows not written.
        let row = PAGE_ROWS as usize + 7;
        data.apply(Table::new("Zone", vec![row as u64]).field("geometry", vec![square(-9.0)])).expect("valid");
        assert!(update(&mut shapes, &data));
        let written = derived(&shapes);
        assert_eq!(written.pages()[0].id, whole.pages()[0].id);
        assert_eq!(written.pages()[2].id, whole.pages()[2].id);
        assert_eq!(points(&written, row), 0, "the written row draws nothing until its job finishes");
        assert!(points(&written, row + 1) >= 4, "the rest of its page keeps their shapes");
        assert!(update(&mut shapes, &data));
        assert!(points(&derived(&shapes), row) >= 4, "then its shapes arrive");
    }

    #[test]
    fn a_failed_shaping_job_draws_its_rows_empty_and_runs_once() {
        let data = Data::new("map");
        data.apply(Table::new("Zone", Ids::count(3)).field("geometry", vec![square(0.0), square(2.0), square(4.0)]))
            .expect("valid");
        let data = data.snapshot();
        let scene = Scene::new(Plane::default()).draw(Areas::of("map", "Zone"));
        let (host, counters, errors) = (Failing::default(), Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut shapes = Shapes::default();
        for _ in 0..5 {
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(&data),
                host: Some(&host),
                dragging: false,
                paged: None,
            };
            // No frame budget: the rows are shaped in a job.
            shapes.update(
                &input,
                &TileSets::default(),
                &mut Jobs::new(Some(&host), Waker::noop(), &counters, &errors, 0),
            );
        }
        assert_eq!(host.jobs(), 1, "one job, not one per frame");
        assert!(!shapes.busy(), "the failure finished the work");
        let column = derived(&shapes);
        assert!((0..3).all(|row| column.at(row).is_some()), "every row has a shape, drawing nothing");
    }
}
