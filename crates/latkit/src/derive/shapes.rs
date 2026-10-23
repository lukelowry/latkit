//! Shapes: what geometry fields become to draw. Every area's triangles, the point its label hangs from
//! first; and on the earth every line's path, unwrapped across the antimeridian and bent with the
//! globe. A table drawn whole is shaped a page of its field at a time, written beside it, and a page
//! written again keeps the shapes of its rows whose geometry did not change, so a tile landing shapes
//! only its own rows. A table drawn in part is shaped a page of its order at a time, the first time
//! the page is drawn: a row whose geometry did not change keeps its shape however its pages come and
//! go. Triangles that do not fit the frame's budget are made in a job, their rows drawing nothing
//! until it lands; bending a path is cheap, and done at once.

use rustc_hash::{FxHashMap, FxHashSet};

use super::order::{Order, PAGE};
use super::{Derive, Input, Jobs, Paged, Tables, answers, beside, stamp_of};
use crate::data::{
    Column, Field, Geometry, GeometryBuilder, Id, Keyed, Name, PAGE_ROWS, Page, PageId, Table, Value, Values, Version,
};
use crate::host::{Job, Shaping};
use crate::scene::areas::triangles_of;
use crate::scene::lines::path_of;
use crate::{Mark, Pending, Space};

/// Microseconds a point takes to triangulate, by estimate.
const TRIANGULATE: f64 = 0.5;

/// Rows by id, each with the digest of the geometry it was shaped from.
type Digests = FxHashMap<Id, u64>;

/// Rows to shape: each row, its id, and the digest of its geometry.
type Missing = Vec<(usize, Id, u64)>;

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

/// The shapes of a table drawn in part, a page of its order at a time: each page the shapes of the
/// rows of one page of the order, in its order, with an id of its own; and the shapes of the rows kept
/// whose pages are not drawn, a row at a time, by their place in the order.
pub(crate) struct PagedShapes {
    /// The order whose pages these are.
    pub(crate) order: u64,
    /// Bumps whenever a page or a row kept is shaped.
    pub(crate) version: Version,
    pub(crate) pages: FxHashMap<u32, ShapedPage>,
    pub(crate) kept: FxHashMap<u32, Values>,
    /// How deep the shapes' geometry is.
    pub(crate) depth: u8,
}

/// One page of an order, shaped.
pub(crate) struct ShapedPage {
    pub(crate) id: PageId,
    pub(crate) shapes: Values,
    /// Whether every row holds its shape: none waits for a job.
    whole: bool,
}

/// What a table drawn in part was shaped from: the order, the table and the field its pages were made
/// from, and the pages made.
struct Paging {
    order: Order,
    source: Table,
    column: Column,
    shapes: PagedShapes,
}

impl Paging {
    /// Where a page made whole holds the shape of the row with `id`, when its geometry's digest was
    /// `digest`: the page's geometry and the row's place in it.
    fn held(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        let row = self.source.row(id.as_ref())?;
        let (values, i) = self.column.at(row).filter(|&(values, i)| values.is_valid(i))?;
        if row >= self.order.len() as usize || values.geometry()?.row_hash(i) != digest {
            return None;
        }
        let d = self.order.rank(row as u32);
        let page = self.shapes.pages.get(&(d / PAGE)).filter(|page| page.whole)?;
        Some((page.shapes.geometry()?, (d % PAGE) as usize))
    }
}

/// One field's shapes: drawn whole, the last whole set made, the derived field written, and the shapes
/// made but not yet written; drawn in part, its pages, and those of the order drawn before; and a job
/// under way.
#[derive(Default)]
struct Shaped {
    /// The source table, its field, and the derived column the shapes were last wholly made from.
    made: Option<(Table, Column, Column)>,
    /// The derived field written last, and the stamp of what it was written from.
    field: Option<Field>,
    stamp: u64,
    /// Shapes made since, by row id: the digest of the geometry each was made from, and the shape.
    landed: FxHashMap<Id, (u64, Value)>,
    /// Drawn in part, its pages; and those of the order drawn before, whose rows alike pages made
    /// afresh take their shapes from.
    paging: Option<Paging>,
    before: Option<Paging>,
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
            let paged = input.paged.and_then(|paged| paged.get(&(want.data.clone(), want.table.clone())));
            let shaped = self.shaped.entry(want.clone()).or_default();
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

impl Shapes {
    /// The shapes of table `table` of dataset `data` drawn in part, by the field each is written as.
    pub(crate) fn paged(&self, data: &Name, table: &Name) -> Vec<(Name, &PagedShapes)> {
        self.shaped
            .iter()
            .filter(|(want, _)| want.data == *data && want.table == *table)
            .filter_map(|(want, shaped)| Some((want.derived(), &shaped.paging.as_ref()?.shapes)))
            .collect()
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
    /// Brings the shapes up to `source`, drawn in part as `paged` says or else whole; whether they
    /// changed.
    fn update(&mut self, want: &Want, source: &Table, paged: Option<&Paged>, jobs: &mut Jobs<'_>) -> bool {
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
        let Some(Field::Values(column, version)) = source.field_named(&want.field) else { return self.forget() };
        let ((Some(depth @ (2 | 3)), Shaping::Triangles { .. }) | (Some(depth @ 1..), Shaping::Path)) =
            (column.kind().depth(), want.shaping)
        else {
            return self.forget();
        };
        if let Some(paged) = paged {
            // Should it draw whole again, its field is written afresh.
            let had = self.field.take().is_some();
            self.stamp = 0;
            return self.update_paged(want, source, column, depth, paged, jobs) || had;
        }
        // Drawn whole again: rows alike take their shapes from the pages drawn in part.
        let had = self.paging.is_some();
        if had {
            self.before = self.paging.take();
        }
        self.update_whole(want, source, column, *version, depth, jobs) || had
    }

    /// Forgets what it shaped, its field no longer shapes; whether it had shaped anything.
    fn forget(&mut self) -> bool {
        let had = self.field.is_some() || self.paging.is_some();
        (self.field, self.paging, self.before, self.stamp) = (None, None, None, 0);
        had
    }

    /// Brings the shapes of a table drawn whole up to `source`; whether the derived field changed.
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
        // Rows shaped on the frame land at once; a second pass writes them.
        for _ in 0..2 {
            let (derived, missing) = self.build(want, source, column, depth);
            if missing.is_empty() {
                self.field = Some(Field::Values(derived.clone(), Version::next()));
                self.made = Some((source.clone(), column.clone(), derived));
                self.landed.clear();
                self.before = None;
                return true;
            }
            if self.shape_now(want, column, &missing, jobs) {
                continue;
            }
            self.ask(want, source, column, missing, jobs);
            // Until the job lands, its rows draw nothing and the rest draw as they were.
            self.field = Some(Field::Values(derived, Version::next()));
            return true;
        }
        false
    }

    /// Brings the shapes of a table drawn in part up to `source`, making each page `paged` draws the
    /// first time it is drawn, and again once rows it waited on land; whether a page was made.
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
        // Another order: its pages are made afresh, rows alike taking their shapes from the last one's.
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
        // The pages rows written since draw in are made again, and those rows kept shaped again.
        if !paging.column.shares(column) {
            let written = column.written_since(&paging.column);
            for &row in written.iter().filter(|&&row| row < order.len() as usize) {
                paging.shapes.pages.remove(&(order.rank(row as u32) / PAGE));
            }
            if !paging.shapes.kept.is_empty() {
                let written: FxHashSet<u32> = written.into_iter().map(|row| row as u32).collect();
                paging.shapes.kept.retain(|&d, _| !written.contains(&order.source(d)));
            }
            (paging.source, paging.column) = (source.clone(), column.clone());
        }
        paging.shapes.kept.retain(|d, _| paged.kept.binary_search(d).is_ok());
        // Pages drawn that were not made, or that wait on rows no job is shaping now; and rows kept
        // not shaped yet, while no job is.
        let running = self.working.is_some();
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
        // Rows shaped on the frame land at once; a second pass makes their pages.
        let mut made: Vec<(u32, Values, bool)> = Vec::with_capacity(make.len());
        let mut kept: Vec<(u32, Values)> = Vec::with_capacity(keep.len());
        let mut missing: Missing = Vec::new();
        for _ in 0..2 {
            made.clear();
            kept.clear();
            missing.clear();
            for &page in &make {
                let (shapes, rows) = self.make_page(want, order, page, source, column, depth);
                made.push((page, shapes, rows.is_empty()));
                missing.extend(rows);
            }
            for &d in &keep {
                let (shape, rows) = self.make_rows(want, &[order.source(d)], source, column, depth);
                if rows.is_empty() {
                    kept.push((d, shape));
                }
                missing.extend(rows);
            }
            if missing.is_empty() || !self.shape_now(want, column, &missing, jobs) {
                break;
            }
        }
        if !missing.is_empty() {
            self.ask(want, source, column, missing, jobs);
        }
        let paging = self.paging.as_mut().expect("paged");
        for (page, shapes, whole) in made {
            paging.shapes.pages.insert(page, ShapedPage { id: PageId::next(), shapes, whole });
        }
        paging.shapes.kept.extend(kept);
        paging.shapes.version = Version::next();
        // Every page drawn whole and no job under way: what landed is in its pages, and the order
        // before has served the pages made afresh.
        if self.working.is_none() && paging.shapes.pages.values().all(|page| page.whole) {
            self.landed.clear();
            self.before = None;
        }
        true
    }

    /// Shapes `missing` on the frame, if they fit what is left of its budget; whether they did.
    fn shape_now(&mut self, want: &Want, column: &Column, missing: &Missing, jobs: &mut Jobs<'_>) -> bool {
        let points: usize = missing.iter().map(|&(row, ..)| points_of(column, row)).sum();
        if !jobs.fits((points as f64 * TRIANGULATE).ceil() as u64) {
            return false;
        }
        for (row, id, digest) in missing {
            let Some(value) = column.get(*row) else { continue };
            let shape = want.shaping.shape(&value).unwrap_or(value);
            self.landed.insert(id.clone(), (*digest, shape));
        }
        true
    }

    /// Asks a job to shape `missing`, unless one is under way: the rows it leaves wait for the next.
    fn ask(&mut self, want: &Want, source: &Table, column: &Column, missing: Missing, jobs: &mut Jobs<'_>) {
        if self.working.is_some() {
            return;
        }
        let rows: Vec<usize> = missing.iter().map(|&(row, ..)| row).collect();
        let job = Job::shapes(want.shaping, rows_of(source, column, &rows));
        let asked = missing.into_iter().map(|(_, id, digest)| (id, digest)).collect();
        self.working = Some((jobs.spawn(job), asked));
    }

    /// The derived column for `column` of `source`, page by page: a page whose source page is the
    /// one shaped last keeps its shapes; others are assembled row by row from shapes landed, or kept
    /// from the last set where a row's geometry did not change. Rows with neither are missing.
    fn build(&self, want: &Want, source: &Table, column: &Column, depth: u8) -> (Column, Missing) {
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
                match source.ids.id(row).filter(|_| page.values.is_valid(local)) {
                    Some(id) => self.shape(want, &mut shapes, (&page.values, local), row, id, &mut missing),
                    None => shapes.push_empty(),
                }
            }
            pages.push(Page::new(Values::of_geometry(shapes.finish())));
        }
        let like = Values::of_geometry(GeometryBuilder::new(depth).finish());
        (Column::of_pages(pages, &like), missing)
    }

    /// Page `page` of `order` shaped: the shapes of its rows, in its order, as [`shape`](Shaped::shape)
    /// finds them; and the rows left to shape.
    fn make_page(
        &self,
        want: &Want,
        order: &Order,
        page: u32,
        source: &Table,
        column: &Column,
        depth: u8,
    ) -> (Values, Missing) {
        self.make_rows(want, &order.page(page), source, column, depth)
    }

    /// Rows `rows` of `source` shaped, in that order, as [`shape`](Shaped::shape) finds them; and the
    /// rows left to shape.
    fn make_rows(&self, want: &Want, rows: &[u32], source: &Table, column: &Column, depth: u8) -> (Values, Missing) {
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

    /// Writes the shape of row `row`, with `id`, whose geometry is value `at.1` of `at.0`: one landed
    /// or made before while its geometry is the same, bent at once for a path, or else empty and the
    /// row left to shape in `missing`.
    fn shape(
        &self,
        want: &Want,
        shapes: &mut GeometryBuilder,
        (values, i): (&Values, usize),
        row: usize,
        id: Id,
        missing: &mut Missing,
    ) {
        let Some(geometry) = values.geometry() else {
            shapes.push_empty();
            return;
        };
        let digest = geometry.row_hash(i);
        if let Some((d, shape)) = self.landed.get(&id)
            && *d == digest
        {
            shapes.push_value(shape);
        } else if let Some((page, at)) = self.kept(&id, digest) {
            shapes.push_from(page, at);
        } else if want.shaping == Shaping::Path {
            // Bending is cheap, so done here; rows that need none keep their geometry.
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

    /// Where a shape made before holds the row with `id`, when its geometry's digest was `digest`: in
    /// the last whole set, or in a page made whole of the order drawn in part before.
    fn kept(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        self.whole(id, digest).or_else(|| self.before.as_ref()?.held(id, digest))
    }

    /// Where the last whole set holds the shape of the row with `id`, when its geometry's digest was
    /// `digest`: the derived page's geometry and the row's place in it.
    fn whole(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
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
    column.at(row).and_then(|(values, i)| values.geometry().map(|g| g.row_coords(i).len())).unwrap_or(0)
}

/// Rows `rows` of `source`, by id, with their geometry from `column` as field `geometry`: what a
/// shapes job reads.
fn rows_of(source: &Table, column: &Column, rows: &[usize]) -> Table {
    let ids: Vec<Id> = rows.iter().filter_map(|&row| source.ids.id(row)).collect();
    let depth = column.kind().depth().expect("a geometry column");
    let mut geometry = GeometryBuilder::new(depth);
    for &row in rows {
        match column.at(row).filter(|&(values, i)| values.is_valid(i)) {
            Some((values, i)) if let Some(g) = values.geometry() => geometry.push_from(g, i),
            _ => geometry.push_empty(),
        }
    }
    Table::new(source.name.clone(), ids).field("geometry", Values::of_geometry(geometry.finish()))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::task::Waker;

    use super::*;
    use crate::derive::pyramid::Pyramid;
    use crate::gpu::work::Counters;
    use crate::{Areas, Data, Ids, Plane, Scene};

    type Ring = Vec<[f64; 2]>;

    /// A square a unit across at `x`.
    fn square(x: f64) -> Vec<Ring> {
        vec![vec![[x, 0.0], [x + 1.0, 0.0], [x + 1.0, 1.0], [x, 1.0], [x, 0.0]]]
    }

    /// The pages made of the shapes of `shapes`' one table drawn in part, and their ids.
    fn made(shapes: &Shapes) -> Vec<(u32, PageId)> {
        let paged = shapes.paged(&"map".into(), &"Zone".into());
        let mut pages: Vec<(u32, PageId)> = paged[0].1.pages.iter().map(|(&page, made)| (page, made.id)).collect();
        pages.sort_unstable_by_key(|&(page, _)| page);
        pages
    }

    #[test]
    fn a_table_drawn_in_part_is_shaped_a_page_drawn_at_a_time() {
        let n = 3 * PAGE as usize;
        let mut data = Data::new("map");
        let squares: Vec<Vec<Ring>> = (0..n).map(|i| square(i as f64)).collect();
        data.apply(Table::new("Zone", Ids::count(n as u32)).field("geometry", squares)).expect("valid");
        let scene = Scene::new(Plane::default()).draw(Areas::of("map", "Zone"));
        // The order draws the rows backward.
        let pyramid = Arc::new(Pyramid::new((0..n as u32).rev().collect(), Vec::new()));
        let order = Order::Pyramid { pyramid, rows: n as u32 };
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut shapes = Shapes::default();
        let update = |shapes: &mut Shapes, data: &Data, pages: Vec<u32>| {
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
            shapes.update(&input, &mut Jobs::new(None, Waker::noop(), &counters, &errors, u32::MAX));
        };
        update(&mut shapes, &data, vec![1]);
        let first = made(&shapes);
        assert_eq!(first.iter().map(|&(page, _)| page).collect::<Vec<_>>(), [1], "only the page drawn is shaped");
        let paged = shapes.paged(&"map".into(), &"Zone".into());
        let page = &paged[0].1.pages[&1];
        assert_eq!(page.shapes.len(), PAGE as usize);
        let triangles = page.shapes.geometry().expect("triangles").row_coords(0).len();
        assert!(triangles >= 3, "its rows' triangles, in the order's order: {triangles} points");
        // Drawing another page shapes it alone; the first keeps its shapes.
        update(&mut shapes, &data, vec![1, 2]);
        let second = made(&shapes);
        assert_eq!((second.len(), second[0]), (2, first[0]));
        // A write to a row drawn in page 2 shapes that page again, and only it.
        let row = u64::from(order.source(2 * PAGE + 5));
        data.apply(Table::new("Zone", vec![row]).field("geometry", vec![square(-9.0)])).expect("valid");
        update(&mut shapes, &data, vec![1, 2]);
        let third = made(&shapes);
        assert_eq!(third[0], second[0], "page 1 holds no row written");
        assert_ne!(third[1].1, second[1].1, "page 2 is shaped again");
    }
}
