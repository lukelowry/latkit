//! Shapes: what geometry fields become to draw. Every area's triangles, the point its label hangs from
//! first; and on the earth every line's path, unwrapped across the antimeridian and bent with the
//! globe. A table drawn whole is shaped a page of its field at a time, written beside it: a page keeps
//! the shapes made of it before, and a page written over one keeps those of its rows not written, so a
//! write shapes only the rows it wrote. A table drawn in part is shaped a page of its order at a time,
//! the first time the page is drawn: a row whose geometry did not change keeps its shape however its
//! pages come and go. Triangles that do not fit the frame's budget are made in a job, a page whole
//! where every row of it needs them, their rows drawing nothing until it lands; bending a path is
//! cheap, and done at once. Vector tiles bring their shapes, made in the job that decodes them.

use rustc_hash::{FxHashMap, FxHashSet};

use super::order::Order;
use super::tiles::TileSets;
use super::{Input, Jobs, Paged, Tables, beside, stamp_of};
use crate::data::{
    Column, Field, Geometry, GeometryBuilder, Id, Keyed, Name, Page, PageId, RowIds, Table, Values, Version,
};
use crate::gpu::shaders::PAGE_ROWS;
use crate::host::{Job, Shaping, shapes_answer};
use crate::{Mark, Pending, Scene, Space};

/// Microseconds a point takes to triangulate, by estimate.
const TRIANGULATE: f64 = 0.5;

/// Rows to shape one at a time: each row, its id, and the digest of its geometry.
type Rows = Vec<(usize, Id, u64)>;

/// What to shape: pages of the field every row of which needs shaping, by id with their values; and
/// rows one at a time.
#[derive(Default)]
struct Missing {
    pages: Vec<(PageId, Values)>,
    rows: Rows,
}

impl Missing {
    fn is_empty(&self) -> bool {
        self.pages.is_empty() && self.rows.is_empty()
    }

    /// How many points it shapes.
    fn points(&self, column: &Column) -> usize {
        let pages: usize = self.pages.iter().map(|(_, values)| values.geometry().map_or(0, Geometry::points)).sum();
        pages + self.rows.iter().map(|&(row, ..)| points_of(column, row)).sum::<usize>()
    }

    /// What it shapes as the parts of a job, each a geometry column: each page whole, then the rows;
    /// and what each part is.
    fn parts(self, column: &Column) -> (Vec<Values>, Vec<Asked>) {
        let (mut parts, mut asked) = (Vec::new(), Vec::new());
        for (id, values) in self.pages {
            parts.push(values);
            asked.push(Asked::Page(id));
        }
        if !self.rows.is_empty() {
            let rows: Vec<usize> = self.rows.iter().map(|&(row, ..)| row).collect();
            parts.push(geometry_of(column, &rows));
            asked.push(Asked::Rows(self.rows.into_iter().map(|(_, id, digest)| (id, digest)).collect()));
        }
        (parts, asked)
    }
}

/// What a part of a job shapes: a page of the field whole, by its id; or rows, by id, each with the
/// digest of its geometry.
enum Asked {
    Page(PageId),
    Rows(Vec<(Id, u64)>),
}

/// Shapes made since the last whole set: pages whole, by the id of the page of the field each was
/// made of; and rows, by id, with the digest of the geometry each was made from and where among the
/// parts its shape lies.
#[derive(Default)]
struct Landed {
    pages: FxHashMap<PageId, Page>,
    rows: FxHashMap<Id, (u64, u32, u32)>,
    parts: Vec<Values>,
}

impl Landed {
    /// Takes `shapes`, the shapes of what `asked` names, part by part.
    fn land(&mut self, asked: Vec<Asked>, shapes: Vec<Values>) {
        for (asked, shapes) in asked.into_iter().zip(shapes) {
            match asked {
                Asked::Page(id) => {
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

    /// Where the shape of the row with `id` lies, made from geometry whose digest is `digest`.
    fn row(&self, id: &Id, digest: u64) -> Option<(&Geometry, usize)> {
        let &(made, part, at) = self.rows.get(id)?;
        (made == digest).then_some(())?;
        Some((self.parts[part as usize].geometry()?, at as usize))
    }
}

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
        self.shaping.field_of(&self.field)
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
        let page = self.shapes.pages.get(&(d / PAGE_ROWS)).filter(|page| page.whole)?;
        Some((page.shapes.geometry()?, (d % PAGE_ROWS) as usize))
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
    /// Shapes made since the last whole set.
    landed: Landed,
    /// Drawn in part, its pages; and those of the order drawn before, whose rows alike pages made
    /// afresh take their shapes from.
    paging: Option<Paging>,
    before: Option<Paging>,
    /// A job under way, with what each of its parts shapes.
    working: Option<(Pending<Vec<u8>>, Vec<Asked>)>,
    /// Bumps whenever a job's answer lands.
    landings: u64,
}

#[derive(Default)]
pub(crate) struct Shapes {
    tables: Tables,
    shaped: FxHashMap<Want, Shaped>,
}

impl Shapes {
    /// Brings the shapes up to `input`, taking those `tiles` brought as they are and handing `jobs`
    /// what the frame cannot afford; whether its tables changed.
    pub(crate) fn update(&mut self, input: &Input<'_>, tiles: &TileSets, jobs: &mut Jobs<'_>) -> bool {
        let wants = wants(input);
        self.shaped.retain(|want, _| wants.contains(want));
        let mut changed = false;
        for want in &wants {
            let Some(source) = input.data(&want.data).and_then(|d| d.table(&want.table)) else { continue };
            let shaped = self.shaped.entry(want.clone()).or_default();
            // Vector tiles bring their shapes, row for row.
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

    /// Whether a job shapes rows: until it lands, they draw nothing.
    pub(crate) fn busy(&self) -> bool {
        self.shaped.values().any(|s| s.working.is_some())
    }

    /// Whether every row drawn holds its shape.
    pub(crate) fn complete(&self) -> bool {
        !self.busy()
    }

    /// The tables beside those drawn whole, each holding the fields shaped from it.
    pub(crate) fn tables(&self) -> &Tables {
        &self.tables
    }

    /// The shapes of table `table` of dataset `data` drawn in part, by the field each is written as.
    pub(crate) fn paged(&self, data: &Name, table: &Name) -> Vec<(Name, &PagedShapes)> {
        self.shaped
            .iter()
            .filter(|(want, _)| want.data == *data && want.table == *table)
            .filter_map(|(want, shaped)| Some((want.derived(), &shaped.paging.as_ref()?.shapes)))
            .collect()
    }
}

/// What mark `mark` shapes, and how: an area its polygons, and on the earth a line its paths.
fn shaping_of(mark: &Mark, earth: bool) -> Option<(Name, Shaping)> {
    match mark {
        Mark::Areas(areas) => Some((areas.field(), Shaping::Triangles { earth })),
        Mark::Lines(lines) if earth => Some((lines.traced(), Shaping::Path)),
        _ => None,
    }
}

/// The fields of table `table` of dataset `data` the scene's marks shape, and how, each once.
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
    /// Brings the shapes up to `source`, drawn in part as `paged` says or else whole; whether they
    /// changed.
    fn update(&mut self, want: &Want, source: &Table, paged: Option<&Paged>, jobs: &mut Jobs<'_>) -> bool {
        if let Some((pending, _)) = &self.working
            && let Some(answer) = pending.take()
        {
            let (_, asked) = self.working.take().expect("a job under way");
            let shapes = answer.ok().and_then(|bytes| shapes_answer(&bytes)).unwrap_or_default();
            if shapes.len() == asked.len() {
                self.landed.land(asked, shapes);
            }
            self.landings += 1;
        }
        let Some(Field::Values(column, version)) = source.field_named(&want.field) else { return self.forget() };
        let Some(depth) = column.kind().depth().filter(|&depth| want.shaping.takes(depth)) else {
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

    /// Takes `field` as its shapes, made elsewhere; whether they changed.
    fn take(&mut self, field: &Field) -> bool {
        let changed = self.field.as_ref().is_none_or(|f| f.version() != field.version());
        *self = Shaped { field: Some(field.clone()), ..Shaped::default() };
        changed
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
        let (mut derived, mut missing) = self.build(want, source, column, depth);
        // Shapes made on the frame land at once, and the column is made again with them.
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
        // Until the job lands, its rows draw nothing and the rest draw as they were.
        self.field = Some(Field::Values(derived, Version::next()));
        true
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
                paging.shapes.pages.remove(&(order.rank(row as u32) / PAGE_ROWS));
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
        let (mut made, mut kept, mut missing) = self.make_paged(want, order, &make, &keep, source, column, depth);
        // Shapes made on the frame land at once, and the pages are made again with them.
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
        // Every page drawn whole and no job under way: what landed is in its pages, and the order
        // before has served the pages made afresh.
        if self.working.is_none() && paging.shapes.pages.values().all(|page| page.whole) {
            self.landed = Landed::default();
            self.before = None;
        }
        true
    }

    /// Pages `make` of `order` shaped, each with whether it is whole; rows kept `keep`, by their place
    /// in the order, each shaped; and the rows left to shape.
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

    /// Shapes `missing` on the frame, if they fit what is left of its budget; else hands them back.
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

    /// Asks a job to shape `missing`, unless one is under way: what it leaves waits for the next.
    fn ask(&mut self, want: &Want, column: &Column, missing: Missing, jobs: &mut Jobs<'_>) {
        if self.working.is_some() {
            return;
        }
        let (parts, asked) = missing.parts(column);
        self.working = Some((jobs.spawn(Job::shapes(want.shaping, &parts)), asked));
    }

    /// The derived column for `column` of `source`, page by page, and what is left to shape. A page
    /// keeps the shapes made of it before, or landed for it; a page written over one shaped keeps
    /// those of its rows not written, as does a page at its place in the last whole set those of its
    /// rows holding the same. A page none of whose rows can keep a shape is shaped whole; the rows of
    /// others take a shape landed or made before while their geometry is the same, and are left to
    /// shape otherwise.
    fn build(&self, want: &Want, source: &Table, column: &Column, depth: u8) -> (Column, Missing) {
        let made_pages: FxHashMap<PageId, &Page> = self
            .made
            .iter()
            .flat_map(|(_, field, derived)| field.pages().iter().map(|p| p.id).zip(derived.pages()))
            .collect();
        let depth = want.shaping.depth(depth);
        // Rows below this many are the last whole set's, at the same places: rows since were only
        // written, or added after them.
        let aligned = self.made.as_ref().map_or(0, |(table, ..)| aligned(source, table));
        // Whether rows past them could take a shape made before only by being shaped.
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
                pages.push(Page::new(Values::of_geometry(GeometryBuilder::new(depth).finish())));
                continue;
            };
            // A path page that needs no bending is its own shape: shared, nothing uploads again.
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
                // Every row is shaped: the page whole, drawing nothing until it lands.
                let mut empty = GeometryBuilder::new(depth);
                (0..len).for_each(|_| empty.push_empty());
                pages.push(Page::new(Values::of_geometry(empty.finish())));
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
        let like = Values::of_geometry(GeometryBuilder::new(depth).finish());
        (Column::of_pages(pages, &like), missing)
    }

    /// The shapes made of a page `page` was written over, a few writes back at most, with whether
    /// each of its rows keeps its shape: those not written since.
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

    /// Rows `rows` of `source` shaped, in that order, as [`shape`](Shaped::shape) finds them; and the
    /// rows left to shape.
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
        let (page, at) = (row / PAGE_ROWS as usize, row % PAGE_ROWS as usize);
        let was = field.pages().get(page)?.values.geometry()?;
        if !field.pages()[page].values.is_valid(at) || was.row_hash(at) != digest {
            return None;
        }
        Some((derived.pages().get(page)?.values.geometry()?, at))
    }
}

/// How many leading rows of `now` are those of `then` at the same places: every row where none came
/// or went, those `then` held where rows were only added after them, else none.
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

/// Whether any two coordinates of a row of `geometry` lie farther apart than an earth path's step: a
/// page with none needs no bending.
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
    let mut geometry = GeometryBuilder::new(depth);
    for &row in rows {
        match column.at(row).filter(|&(values, i)| values.is_valid(i)) {
            Some((values, i)) if let Some(g) = values.geometry() => geometry.push_from(g, i),
            _ => geometry.push_empty(),
        }
    }
    Values::of_geometry(geometry.finish())
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

    /// The derived column of `shapes`' one table drawn whole.
    fn derived(shapes: &Shapes) -> Column {
        match shapes.tables().get(&("map".into(), "Zone".into())).and_then(|t| t.field_named("geometry.triangles")) {
            Some(Field::Values(column, _)) => column.clone(),
            _ => panic!("triangles"),
        }
    }

    #[test]
    fn a_table_drawn_in_part_is_shaped_a_page_drawn_at_a_time() {
        let n = 3 * PAGE_ROWS as usize;
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
            let mut jobs = Jobs::new(None, Waker::noop(), &counters, &errors, u32::MAX);
            shapes.update(&input, &TileSets::default(), &mut jobs);
        };
        update(&mut shapes, &data, vec![1]);
        let first = made(&shapes);
        assert_eq!(first.iter().map(|&(page, _)| page).collect::<Vec<_>>(), [1], "only the page drawn is shaped");
        let paged = shapes.paged(&"map".into(), &"Zone".into());
        let page = &paged[0].1.pages[&1];
        assert_eq!(page.shapes.len(), PAGE_ROWS as usize);
        let triangles = page.shapes.geometry().expect("triangles").row_coords(0).len();
        assert!(triangles >= 3, "its rows' triangles, in the order's order: {triangles} points");
        // Drawing another page shapes it alone; the first keeps its shapes.
        update(&mut shapes, &data, vec![1, 2]);
        let second = made(&shapes);
        assert_eq!((second.len(), second[0]), (2, first[0]));
        // A write to a row drawn in page 2 shapes that page again, and only it.
        let row = u64::from(order.source(2 * PAGE_ROWS + 5));
        data.apply(Table::new("Zone", vec![row]).field("geometry", vec![square(-9.0)])).expect("valid");
        update(&mut shapes, &data, vec![1, 2]);
        let third = made(&shapes);
        assert_eq!(third[0], second[0], "page 1 holds no row written");
        assert_ne!(third[1].1, second[1].1, "page 2 is shaped again");
    }

    #[test]
    fn a_table_drawn_whole_lands_its_shapes_a_page_at_a_time() {
        let n = 2 * PAGE_ROWS as usize + 10;
        let mut data = Data::new("map");
        let squares: Vec<Vec<Ring>> = (0..n).map(|i| square(i as f64)).collect();
        data.apply(Table::new("Zone", Ids::count(n as u32)).field("geometry", squares)).expect("valid");
        let scene = Scene::new(Plane::default()).draw(Areas::of("map", "Zone"));
        let (counters, errors) = (Counters::default(), Arc::new(Mutex::new(Vec::new())));
        let mut shapes = Shapes::default();
        // No budget on the frame: every shape is made in a job, which lands by the next update.
        let update = |shapes: &mut Shapes, data: &Data| {
            let input = Input {
                scene: &scene,
                scene_version: 1,
                data: std::slice::from_ref(data),
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
        assert_eq!(points(&derived(&shapes), 3), 0, "until it lands, rows draw nothing");
        assert!(update(&mut shapes, &data));
        let whole = derived(&shapes);
        assert!(!shapes.busy());
        assert_eq!(whole.pages().len(), 3);
        assert!((0..n).all(|row| points(&whole, row) >= 4), "every row holds its label point and triangles");
        // A write to one row shapes it alone: the other pages keep theirs, and its page the shapes of
        // the rows not written.
        let row = PAGE_ROWS as usize + 7;
        data.apply(Table::new("Zone", vec![row as u64]).field("geometry", vec![square(-9.0)])).expect("valid");
        assert!(update(&mut shapes, &data));
        let written = derived(&shapes);
        assert_eq!(written.pages()[0].id, whole.pages()[0].id);
        assert_eq!(written.pages()[2].id, whole.pages()[2].id);
        assert_eq!(points(&written, row), 0, "the row written waits for its job");
        assert!(points(&written, row + 1) >= 4, "the rest of its page keeps theirs");
        assert!(update(&mut shapes, &data));
        assert!(points(&derived(&shapes), row) >= 4, "and lands");
    }
}
