//! Vector tiles: the tiles the camera needs, fetched from a PMTiles archive or a URL template
//! (given directly or read from a TileJSON document). Jobs decode them, and their rows are
//! appended to the dataset a set draws. Near its focus, the camera picks tiles that draw no larger
//! than their own pixel size. It splits the tiles drawn largest first, and lists them nearest
//! first. Tiles decode only the layers a set's marks draw, and decode again for a set whose scene
//! draws other layers. The job decoding a tile also computes its rows' shapes for their marks, so a
//! tile arrives with its triangles and paths. A set holds the rows with their shapes, and draws a
//! dataset of the rows as the tiles wrote them.
//!
//! A set's tables hold the rows of the tiles it drew, in the order they arrived. A landing tile
//! appends its rows, and the pages earlier tiles filled stay as they are. Each table is paged in
//! table order, and its tiles are the vector tiles drawn, each the span of rows it wrote. A tile
//! that stops drawing keeps its rows, and draws them again if it returns. This lasts until the rows
//! that no drawn tile holds outnumber the rows drawn by at least a page. Then every table drops
//! them at once.

use std::collections::BinaryHeap;
use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::TileKey;
use super::tiling::{Decoding, Pieces, Requested, Tiling};
use crate::data::{Field, Id, Keyed, Name, Op, Patch, Snapshot, Table, Values};
use crate::derive::order::Order;
use crate::derive::shapes::shapings;
use crate::derive::sight::{Domain, SPLIT_PX, Sight, meets};
use crate::derive::tiled::Chosen;
use crate::derive::{Input, Jobs, stamp_of};
use crate::expr::cpu::Rows;
use crate::geo::mvt::Kind as Geometry;
use crate::geo::pmtiles::{self, Directory, Entry, Header};
use crate::geo::tiles::{Decoded, Template, shapes_field};
use crate::gpu::shaders::PAGE_ROWS;
use crate::host::{Job, Request};
use crate::{Error, Expr, Kind, Mark, Pending, Scene};

/// The most tiles drawn at once. Past this, tiles stop splitting. A view 4K CSS pixels wide, seen
/// from above, draws at most about 100 tiles of 320 to 640 pixels.
const MAX_TILES: usize = 128;

/// The tiles to draw within `zooms` and `bounds`, nearest the camera's focus first. These are the
/// tiles that meet the camera's view, split from the root while they draw larger than their pixel
/// size. The tile drawn largest splits first, so once [`MAX_TILES`] is reached, the smaller tiles
/// left stay as they are. Tiles coarser than the first zoom hold nothing. They split before any
/// other, and draw nothing if they cannot.
fn wanted(sight: &Sight<'_>, zooms: [u8; 2], bounds: [f64; 4]) -> Vec<TileKey> {
    let region = sight.region();
    let focus = sight.focus();
    let within = |key: TileKey| {
        let b = key.bounds();
        b[0] <= bounds[2] && b[2] >= bounds[0] && b[1] <= bounds[3] && b[3] >= bounds[1] && meets(&region, b)
    };
    // Each tile met, with its size and distance from the view's center, and a heap of those not yet
    // split or drawn, largest on top.
    let mut met: Vec<(TileKey, f64, f64)> = Vec::new();
    let mut heap: BinaryHeap<(u64, u32)> = BinaryHeap::new();
    let meet = |key: TileKey, met: &mut Vec<(TileKey, f64, f64)>, heap: &mut BinaryHeap<(u64, u32)>| {
        let (size, distance) = sight.measure(&focus, &Domain::Earth, key);
        let rank = if key.z < zooms[0] { f64::INFINITY } else { size };
        heap.push((crate::order::number(rank), met.len() as u32));
        met.push((key, size, distance));
    };
    let root = TileKey { z: 0, x: 0, y: 0 };
    if within(root) {
        meet(root, &mut met, &mut heap);
    }
    let mut drawn: Vec<(TileKey, f64)> = Vec::new();
    while let Some((_, i)) = heap.pop() {
        let (key, size, distance) = met[i as usize];
        if key.z >= zooms[1] || (key.z >= zooms[0] && size <= SPLIT_PX) {
            drawn.push((key, distance));
            continue;
        }
        let children: Vec<TileKey> = key.children().into_iter().filter(|&child| within(child)).collect();
        if drawn.len() + heap.len() + children.len() > MAX_TILES {
            // This tile and every smaller one draw as they are.
            drawn.push((key, distance));
            drawn.extend(heap.drain().map(|(_, i)| (met[i as usize].0, met[i as usize].2)));
            break;
        }
        for child in children {
            meet(child, &mut met, &mut heap);
        }
    }
    drawn.retain(|(key, _)| key.z >= zooms[0]);
    crate::order::by_key(&mut drawn, |a| crate::order::number(a.1));
    drawn.into_iter().map(|(key, _)| key).collect()
}

/// Where a source's vector tiles come from once it opens.
enum Opened {
    /// An archive whose root directory lies past the first bytes and is being fetched.
    Root(Header, Pending<Vec<u8>>),
    Template(Template),
    Archive(Header, Directory),
    /// The source could not be opened, with the reason.
    Failed(Error),
}

/// One source's vector tiles, shared by every set drawing them: where they are, and what was
/// fetched and decoded.
pub(crate) struct Fetched {
    url: Arc<str>,
    opened: Opened,
    /// Leaf directories, and those being fetched.
    leaves: FxHashMap<(u64, u64), Directory>,
    leaf_fetches: FxHashMap<(u64, u64), Pending<Vec<u8>>>,
    tiling: Tiling<TileKey>,
}

impl Fetched {
    /// Tiles from URL template `url`, which contains `{z}`, `{x}`, and `{y}`.
    pub(crate) fn template(url: &Arc<str>) -> Fetched {
        Fetched::opened(url, Opened::Template(Template::of(url)))
    }

    /// Opens tiles from a source whose first `bytes` are a PMTiles archive or a TileJSON document.
    /// An archive's root directory is fetched if it lies past those bytes. Errors if the source
    /// holds image tiles or is malformed.
    pub(crate) fn open(url: &Arc<str>, bytes: &[u8], jobs: &Jobs<'_>) -> Result<Fetched, String> {
        if !pmtiles::is_archive(bytes) {
            return Template::tilejson(bytes, url).map(|template| Fetched::opened(url, Opened::Template(template)));
        }
        let header = pmtiles::header(bytes)?;
        if !header.vector {
            return Err(format!("{url} has image tiles; only vector tiles are supported"));
        }
        let (offset, length) = header.root;
        let opened = match bytes.get(offset as usize..(offset + length) as usize) {
            Some(root) => archive(header, root).ok_or_else(|| corrupt(url))?,
            None => Opened::Root(header, jobs.fetch(&Request::range(url.clone(), offset..offset + length))),
        };
        Ok(Fetched::opened(url, opened))
    }

    fn opened(url: &Arc<str>, opened: Opened) -> Fetched {
        Fetched {
            url: url.clone(),
            opened,
            leaves: FxHashMap::default(),
            leaf_fetches: FxHashMap::default(),
            tiling: Tiling::default(),
        }
    }

    /// Fetches and decodes in progress.
    pub(crate) fn under_way(&self) -> usize {
        self.tiling.under_way()
    }

    /// Releases what set `set` drew.
    pub(crate) fn release(&mut self, set: u64) {
        self.tiling.release(set);
    }

    /// The zooms and bounds of an open source.
    fn zooms(&self) -> Option<([u8; 2], [f64; 4])> {
        match &self.opened {
            Opened::Template(t) => Some(([t.min_zoom, t.max_zoom], t.bounds)),
            Opened::Archive(h, _) => Some(([h.min_zoom, h.max_zoom], h.bounds)),
            Opened::Root(..) | Opened::Failed(_) => None,
        }
    }

    /// Opens the archive once its root directory arrives, and takes leaf directories that arrived.
    /// Returns the reason the source could not be opened, if it could not.
    fn settle(&mut self) -> Option<Error> {
        if let Opened::Root(header, pending) = &self.opened {
            let header = *header;
            if let Some(landed) = pending.take() {
                let opened =
                    landed.and_then(|bytes| archive(header, &bytes).ok_or_else(|| Error::invalid(corrupt(&self.url))));
                self.opened = opened.unwrap_or_else(Opened::Failed);
            }
        }
        let landed: Vec<_> =
            self.leaf_fetches.iter().filter_map(|(at, pending)| pending.take().map(|r| (*at, r))).collect();
        for (at, bytes) in landed {
            self.leaf_fetches.remove(&at);
            let gzip = matches!(self.opened, Opened::Archive(h, _) if h.gzip_directories);
            let leaf = bytes.and_then(|b| {
                inflate(&b, gzip).and_then(|b| Directory::decode(&b)).ok_or_else(|| Error::invalid(corrupt(&self.url)))
            });
            match leaf {
                Ok(leaf) => {
                    self.leaves.insert(at, leaf);
                }
                Err(error) => self.tiling.fail(error),
            }
        }
        match &self.opened {
            Opened::Failed(error) => Some(error.clone()),
            _ => None,
        }
    }
}

/// Each tile whose rows a set's tables hold, with the span of rows it wrote in each table.
type Spans = FxHashMap<TileKey, Vec<(Name, Range<u32>)>>;

/// What one set draws of vector tiles. It records the tiles whose rows its dataset holds, with
/// their spans, and the tiles drawn, nearest the camera's focus first. A stamp records what the
/// rows were made from: the stamp they were decoded for, and their tables' priorities. `held`
/// holds the same rows as the dataset, including their derived shape fields.
pub(crate) struct Drawing {
    spans: Spans,
    drawn: Vec<TileKey>,
    made: u64,
    held: Snapshot,
}

impl Drawing {
    pub(crate) fn new() -> Drawing {
        Drawing { spans: Spans::default(), drawn: Vec::new(), made: 0, held: Snapshot::new("held") }
    }

    /// The rows the dataset holds, including their derived shape fields.
    pub(crate) fn held(&self) -> &Snapshot {
        &self.held
    }

    /// Tiles drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.drawn.len()
    }

    /// What `table`, one of the dataset's tables, draws within `rows` rows. It draws the span of
    /// each tile drawn, as ranges of its table order, nearest the camera's focus first until the
    /// rows run out. The tile in which they run out draws its last rows, which have the highest
    /// priority. The ranges draw coarsest tile first, so finer tiles draw over the ancestors
    /// standing in for them. `capped` is set when the budget left out any rows.
    pub(crate) fn chosen(&self, table: &Table, rows: u32) -> Chosen {
        let len = table.len() as u32;
        let (mut left, mut capped) = (rows, false);
        let mut spans: Vec<(u8, Range<u32>)> = Vec::new();
        for key in &self.drawn {
            let Some(span) = self.span(key, &table.name).filter(|span| !span.is_empty() && span.end <= len) else {
                continue;
            };
            if left == 0 {
                capped = true;
                break;
            }
            let taken = (span.len() as u32).min(left);
            capped |= taken < span.len() as u32;
            spans.push((key.z, span.end - taken..span.end));
            left -= taken;
        }
        crate::order::by_key(&mut spans, |(z, span)| crate::order::pair(u32::from(*z), span.start));
        let ranges = spans.into_iter().map(|(_, span)| span).collect();
        Chosen { order: Order::Table { rows: len, order: table.order }, ranges, capped }
    }

    /// The span of rows tile `key` wrote in table `table`, while the tables hold them.
    fn span(&self, key: &TileKey, table: &Name) -> Option<&Range<u32>> {
        self.spans.get(key)?.iter().find(|(name, _)| name == table).map(|(_, span)| span)
    }

    /// Updates `data` to what `sight` shows and set `set`'s scene draws of dataset `name`, from
    /// what `fetched` holds. Returns whether it changed, whether any wanted tile still shows a
    /// placeholder, and a failure to report.
    #[expect(clippy::too_many_arguments, reason = "a set's update reads the view, the frame, and the source")]
    pub(crate) fn update(
        &mut self,
        set: u64,
        input: &Input<'_>,
        name: &Name,
        data: &mut Snapshot,
        sight: Option<&Sight<'_>>,
        fetched: &mut Fetched,
        jobs: &Jobs<'_>,
    ) -> (bool, bool, Option<Error>) {
        let tables = decoded_tables(input.scene, name);
        if tables.is_empty() {
            return (false, false, None);
        }
        let failure = fetched.settle();
        let Some((zooms, bounds)) = fetched.zooms() else {
            return (false, matches!(fetched.opened, Opened::Root(..)), failure);
        };
        let stamp = stamp_of(&tables);
        let wanted = sight.map(|s| wanted(s, zooms, bounds)).unwrap_or_default();
        let Fetched { url, opened, leaves, leaf_fetches, tiling } = fetched;
        let mut pieces = Find { url, opened, leaves, leaf_fetches, tables: &tables };
        let drawn = tiling.update(set, &wanted, stamp, &mut pieces, jobs);
        let changed = self.draw(&drawn.keys, stamp, tiling, input, data);
        (changed, drawn.standing_in, failure.or(drawn.failure))
    }

    /// Draws tiles `drawn`, decoded for `stamp`. A tile new to the tables appends its rows after
    /// every row they hold, as the tile wrote them but in its table's priority order. The rows go
    /// to `data`, and with their shapes to `held`. Rows of tiles not drawn stay until they
    /// outnumber the rows drawn by at least a page. Then each table drops them in one removal, and
    /// the spans after them move down. Every row goes when the stamp or a priority changes, since
    /// each tile then appends its rows anew, with the same ids. Returns whether `data` changed.
    fn draw(
        &mut self,
        drawn: &[TileKey],
        stamp: u64,
        tiling: &Tiling<TileKey>,
        input: &Input<'_>,
        data: &mut Snapshot,
    ) -> bool {
        let priorities = priorities(input.scene, data.name());
        let made = stamp_of((stamp, format!("{priorities:?}")));
        let renewed = made != self.made;
        let showing: FxHashSet<TileKey> = drawn.iter().copied().filter(|_| !renewed).collect();
        // A tile not drawn that wrote no rows has nothing to keep.
        self.spans.retain(|key, spans| showing.contains(key) || spans.iter().any(|(_, span)| !span.is_empty()));
        // Rows of the tiles drawn, and of the tiles not drawn.
        let (mut shown, mut idle) = (0_usize, 0_usize);
        for (key, spans) in &self.spans {
            let rows: usize = spans.iter().map(|(_, span)| span.len()).sum();
            if showing.contains(key) {
                shown += rows;
            } else {
                idle += rows;
            }
        }
        let compact = renewed || (idle > shown && idle >= PAGE_ROWS as usize);
        if !compact && drawn.iter().all(|key| self.spans.contains_key(key)) {
            (self.drawn, self.made) = (drawn.to_vec(), made);
            return false;
        }
        let mut spans = self.spans.clone();
        let mut patch = Patch::new();
        let mut changed: Vec<Name> = Vec::new();
        if compact {
            // One removal per table, so rows after the first removed row move only once.
            let mut gone: Keyed<Name, Vec<Id>> = Keyed::default();
            for (key, tile) in &spans {
                if showing.contains(key) {
                    continue;
                }
                for (name, span) in tile.iter().filter(|(_, span)| !span.is_empty()) {
                    let Some(table) = self.held.table(name) else { continue };
                    let ids = span.clone().filter_map(|row| table.ids.id(row as usize));
                    gone.entry(name.clone()).or_default().extend(ids);
                }
            }
            spans.retain(|key, _| showing.contains(key));
            pack(&mut spans);
            for (name, ids) in gone {
                changed.push(name.clone());
                patch = patch.remove(name, ids);
            }
        }
        // Each table's row count once the removals apply: where its last span ends.
        let mut ends: Keyed<Name, u32> = Keyed::default();
        for (name, span) in spans.values().flatten() {
            let end = ends.entry(name.clone()).or_default();
            *end = (*end).max(span.end);
        }
        let mut kinds = FxHashMap::default();
        for &key in drawn {
            if spans.contains_key(&key) {
                continue;
            }
            let Some(tile) = tiling.decoded(&key, stamp) else { continue };
            let mut wrote = Vec::new();
            for op in &tile.ops {
                let Op::Set(table) = op else { continue };
                let end = ends.entry(table.name.clone()).or_default();
                wrote.push((table.name.clone(), *end..*end + table.len() as u32));
                *end += table.len() as u32;
                if !changed.contains(&table.name) {
                    changed.push(table.name.clone());
                }
                let priority = priorities.iter().find(|(name, _)| *name == table.name).map(|(_, p)| p);
                patch = patch.set(harmonized(&ranked(table, priority, input.data), &self.held, &mut kinds));
            }
            spans.insert(key, wrote);
        }
        if patch.is_empty() {
            (self.spans, self.drawn, self.made) = (spans, drawn.to_vec(), made);
            return false;
        }
        let Ok(held) = self.held.applied(patch) else { return false };
        // The drawn dataset holds each changed table of `held` without its shape fields, sharing
        // everything else.
        let tables = changed.iter().filter_map(|name| held.table(name)).map(|table| {
            let mut table = table.clone();
            table.fields.retain(|(name, _)| !shapes_field(name));
            table
        });
        let Ok(next) = data.applied(tables.fold(Patch::new(), Patch::replace)) else { return false };
        (*data, self.held, self.spans, self.drawn, self.made) = (next, held, spans, drawn.to_vec(), made);
        true
    }
}

/// The priority each table of dataset `name` draws its rows by. It is the priority of the first
/// mark drawing the table that sets one.
fn priorities(scene: &Scene, name: &Name) -> Vec<(Name, Expr)> {
    let mut out: Vec<(Name, Expr)> = Vec::new();
    for mark in &scene.marks {
        let style = mark.style();
        let Some(priority) = &style.priority else { continue };
        if style.data == *name && !out.iter().any(|(table, _)| *table == style.table) {
            out.push((style.table.clone(), priority.clone()));
        }
    }
    out
}

/// `table` with its rows in `priority` order, highest last, so they draw on top. Rows of equal
/// priority keep their order, and a missing or NaN priority is lowest. Without a priority, returns
/// `table` unchanged.
fn ranked(table: &Table, priority: Option<&Expr>, all: &[Snapshot]) -> Table {
    let Some(priority) = priority else { return table.clone() };
    let lowest = |p: f64| if p.is_nan() { f64::NEG_INFINITY } else { p };
    let ranks = Rows::new(table, all).numbers(priority, |p| crate::order::number(lowest(p)));
    let mut rows: Vec<usize> = (0..table.len()).collect();
    crate::order::by_key(&mut rows, |&row| ranks[row]);
    table.rows(&rows)
}

/// Moves each table's spans in `spans` down to close the gaps that removed rows left between them,
/// keeping their order and lengths.
fn pack(spans: &mut Spans) {
    let mut tables: Keyed<Name, Vec<&mut Range<u32>>> = Keyed::default();
    for (name, span) in spans.values_mut().flatten() {
        tables.entry(name.clone()).or_default().push(span);
    }
    for (_, mut table) in tables {
        crate::order::by_key(&mut table, |span| u64::from(span.start));
        let mut at = 0;
        for span in table {
            let len = span.end - span.start;
            *span = at..at + len;
            at += len;
        }
    }
}

/// Locates a source's tiles, with the tables a set's marks draw from them, which decoding writes.
struct Find<'a> {
    url: &'a Arc<str>,
    opened: &'a Opened,
    leaves: &'a FxHashMap<(u64, u64), Directory>,
    leaf_fetches: &'a mut FxHashMap<(u64, u64), Pending<Vec<u8>>>,
    tables: &'a [Decoded],
}

impl Pieces<TileKey> for Find<'_> {
    fn request(&mut self, key: TileKey, jobs: &Jobs<'_>) -> Requested {
        match self.opened {
            Opened::Template(template) => Requested::Fetch(Request::new(template.url_of(key))),
            Opened::Archive(header, root) => {
                let id = pmtiles::tile_id(key);
                let mut directory = root;
                for _ in 0..pmtiles::DEPTH {
                    match directory.find(id) {
                        Some(Entry::Leaf(offset, length)) => {
                            let at = (header.leaves + offset, length);
                            let Some(leaf) = self.leaves.get(&at) else {
                                let url = self.url.clone();
                                self.leaf_fetches
                                    .entry(at)
                                    .or_insert_with(|| jobs.fetch(&Request::range(url, at.0..at.0 + at.1)));
                                return Requested::Wait;
                            };
                            directory = leaf;
                        }
                        Some(Entry::Tile(offset, length)) => {
                            let start = header.data + offset;
                            return Requested::Fetch(Request::range(self.url.clone(), start..start + length));
                        }
                        None => break,
                    }
                }
                // The archive has no such tile, so it draws nothing.
                Requested::Missing
            }
            Opened::Root(..) | Opened::Failed(_) => Requested::Wait,
        }
    }

    fn decode(&self, key: TileKey, bytes: &Arc<Vec<u8>>, jobs: &Jobs<'_>) -> Decoding {
        Decoding::Job(jobs.spawn(Job::tile(key, self.tables, bytes)))
    }
}

/// The archive with `header` and root directory `bytes`, or `None` if the directory is corrupt.
fn archive(header: Header, bytes: &[u8]) -> Option<Opened> {
    let root = inflate(bytes, header.gzip_directories).and_then(|b| Directory::decode(&b))?;
    Some(Opened::Archive(header, root))
}

fn corrupt(url: &str) -> String {
    format!("the archive at {url} has a corrupt directory")
}

/// The tables marks draw from dataset `name`. A table named after a layer holds the geometry type
/// its marks draw, preferring polygons, then lines, then points. A table named `layer:kind` holds
/// that kind. Each table gets the shapes its marks derive from its geometry.
fn decoded_tables(scene: &Scene, name: &Name) -> Vec<Decoded> {
    let mut tables: Vec<Decoded> = Vec::new();
    for mark in &scene.marks {
        let style = mark.style();
        if style.data != *name {
            continue;
        }
        let drawn = match mark {
            Mark::Areas(_) => Geometry::Polygons,
            Mark::Lines(_) => Geometry::Lines,
            Mark::Vertices(_) => Geometry::Points,
            Mark::Edges(_) | Mark::Faces(_) => continue,
        };
        let table = style.table.clone();
        let (layer, kind) = match table.split_once(':') {
            Some((layer, "polygons")) => (layer.to_owned(), Geometry::Polygons),
            Some((layer, "lines")) => (layer.to_owned(), Geometry::Lines),
            Some((layer, "points")) => (layer.to_owned(), Geometry::Points),
            _ => (table.to_string(), drawn),
        };
        let rank = |k: Geometry| match k {
            Geometry::Polygons => 0,
            Geometry::Lines => 1,
            Geometry::Points => 2,
        };
        match tables.iter_mut().find(|d| d.table == table) {
            Some(d) if rank(kind) < rank(d.kind) => d.kind = kind,
            Some(_) => {}
            None => {
                let shapes = shapings(scene, name, &table)
                    .into_iter()
                    .filter_map(|(field, shaping)| (field == "geometry").then_some(shaping))
                    .collect();
                tables.push(Decoded { layer, kind, table, shapes });
            }
        }
    }
    crate::order::by_name(&mut tables, |t| t.table.as_str());
    tables
}

/// Converts `table`'s fields to the kinds the same-named fields have, where they differ. Those
/// fields are in the same-named table of `data`, or else in a table set before it in the same
/// patch, as `kinds` records by table and field. For example, a field a tile reads as numbers but
/// the dataset holds as text is written as text. Records the kinds of fields new to both.
fn harmonized(table: &Table, data: &Snapshot, kinds: &mut FxHashMap<(Name, Name), Kind>) -> Table {
    let existing = data.table(&table.name);
    let mut out = table.clone();
    for (name, field) in &table.fields {
        let Field::Values(column, _) = field else { continue };
        let key = (table.name.clone(), name.clone());
        let Some(want) = existing.and_then(|t| t.kind(name)).or_else(|| kinds.get(&key).copied()) else {
            kinds.insert(key, column.kind());
            continue;
        };
        if column.kind() == want {
            continue;
        }
        let values: Vec<Option<crate::Value>> = (0..column.len()).map(|r| column.get(r)).collect();
        let converted: Option<Values> = match want {
            Kind::Text => Some(values.iter().map(|v| v.as_ref().map(text_of)).collect::<Vec<Option<String>>>().into()),
            Kind::Number => Some(values.iter().map(|v| v.as_ref().and_then(number_of)).collect::<Vec<_>>().into()),
            Kind::Bool => {
                Some(values.iter().map(|v| v.as_ref().and_then(number_of).map(|n| n != 0.0)).collect::<Vec<_>>().into())
            }
            _ => None,
        };
        if let Some(values) = converted {
            out = out.field(name.clone(), values);
        }
    }
    out
}

fn text_of(value: &crate::Value) -> String {
    match value {
        crate::Value::Text(t) => t.to_string(),
        crate::Value::Number(n) => n.to_string(),
        crate::Value::Bool(b) => b.to_string(),
        other => format!("{other:?}"),
    }
}

fn number_of(value: &crate::Value) -> Option<f64> {
    match value {
        crate::Value::Number(n) => Some(*n),
        crate::Value::Bool(b) => Some(f64::from(u8::from(*b))),
        crate::Value::Text(t) => t.parse().ok(),
        _ => None,
    }
}

/// Decompresses `bytes` when `gzip`, else copies them. `None` if decompression fails.
fn inflate(bytes: &[u8], gzip: bool) -> Option<Vec<u8>> {
    if !gzip {
        return Some(bytes.to_vec());
    }
    crate::geo::gunzipped(bytes).ok().map(std::borrow::Cow::into_owned)
}
