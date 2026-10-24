//! Vector tiles: the tiles the camera asks for, fetched from a PMTiles archive or a URL template,
//! given or from a TileJSON document, decoded in jobs, and patched into the dataset a set draws. The
//! camera chooses the tiles that draw no larger than their own size where they lie nearest its
//! focus, nearest first. Tiles decode only the layers a set's marks draw, and again for a set whose
//! scene draws others; the job decoding a tile shapes its rows too, as their marks draw them, so a
//! tile lands with its triangles and paths. A set holds the rows with their shapes, and draws the
//! dataset of the rows as tiles wrote them.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::TileKey;
use super::tiling::{Decoding, Pieces, Requested, Tiling};
use crate::data::{Field, Id, Keyed, Name, Op, Patch, Snapshot, Table, Values};
use crate::derive::shapes::shapings;
use crate::derive::sight::{Domain, Sight, TILE_PX, meets};
use crate::derive::{Input, Jobs, stamp_of};
use crate::geo::mvt::Kind as Geometry;
use crate::geo::pmtiles::{self, Directory, Entry, Header};
use crate::geo::tiles::{Decoded, Template, shapes_field};
use crate::host::{Job, Request};
use crate::{Error, Kind, Mark, Pending, Scene};

/// Tiles drawn at once at most: past it, tiles stop splitting.
const MAX_TILES: usize = 256;

/// The tiles to draw within `zooms` and `bounds`: those meeting what the camera shows, each split
/// while it draws larger than its size, nearest the view's middle first.
fn wanted(sight: &Sight<'_>, zooms: [u8; 2], bounds: [f64; 4]) -> Vec<TileKey> {
    let limit = TILE_PX * 1.25;
    let region = sight.region();
    let focus = sight.focus();
    let mut out: Vec<(TileKey, f64)> = Vec::new();
    let mut queue = vec![TileKey { z: 0, x: 0, y: 0 }];
    while !queue.is_empty() {
        let mut next = Vec::new();
        for (k, &key) in queue.iter().enumerate() {
            let b = key.bounds();
            if b[0] > bounds[2] || b[2] < bounds[0] || b[1] > bounds[3] || b[3] < bounds[1] || !meets(&region, b) {
                continue;
            }
            let (size, distance) = sight.measure(&focus, &Domain::Earth, key);
            let room = out.len() + next.len() + (queue.len() - k) * 4 < MAX_TILES;
            if key.z < zooms[1] && (key.z < zooms[0] || size > limit) && room {
                next.extend(key.children());
            } else if key.z >= zooms[0] {
                out.push((key, distance));
            }
        }
        queue = next;
    }
    crate::order::by_key(&mut out, |a| crate::order::number(a.1));
    out.into_iter().map(|(key, _)| key).collect()
}

/// Where vector tiles come from once their source opens.
enum Opened {
    /// An archive whose root directory lies past the first bytes.
    Root(Header, Pending<Vec<u8>>),
    Template(Template),
    Archive(Header, Directory),
    /// The source could not be opened, and why.
    Failed(Error),
}

/// Vector tiles of one source, as every set drawing them shares them: where they lie, and what was
/// fetched and decoded of them.
pub(crate) struct Fetched {
    url: Arc<str>,
    opened: Opened,
    /// Leaf directories, and those being fetched.
    leaves: FxHashMap<(u64, u64), Directory>,
    leaf_fetches: FxHashMap<(u64, u64), Pending<Vec<u8>>>,
    tiling: Tiling<TileKey>,
}

impl Fetched {
    /// The tiles a URL template names, `{z}`, `{x}`, and `{y}` in it.
    pub(crate) fn template(url: &Arc<str>) -> Fetched {
        Fetched::opened(url, Opened::Template(Template::of(url)))
    }

    /// The tiles whose source's first `bytes` are a PMTiles archive's or a TileJSON document's; the
    /// archive's root directory is fetched when it lies past them.
    pub(crate) fn open(url: &Arc<str>, bytes: &[u8], jobs: &Jobs<'_>) -> Result<Fetched, String> {
        if !pmtiles::is_archive(bytes) {
            return Template::tilejson(bytes, url).map(|template| Fetched::opened(url, Opened::Template(template)));
        }
        let header = pmtiles::header(bytes)?;
        if !header.vector {
            return Err(format!("{url} holds image tiles; only vector tiles draw"));
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

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        self.tiling.under_way()
    }

    /// Lets go of what set `set` drew.
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

    /// Opens the archive once its root directory landed, and takes leaf directories that landed;
    /// why the source could not be opened, if it could not.
    fn settle(&mut self) -> Option<Error> {
        if let Opened::Root(header, pending) = &self.opened {
            let header = *header;
            if let Some(landed) = pending.take() {
                let opened = landed
                    .map_err(|error| error.to_string())
                    .and_then(|bytes| archive(header, &bytes).ok_or_else(|| corrupt(&self.url)));
                self.opened = opened.unwrap_or_else(|reason| Opened::Failed(Error::Io(reason.into())));
            }
        }
        let landed: Vec<_> =
            self.leaf_fetches.iter().filter_map(|(at, pending)| pending.take().map(|r| (*at, r.ok()))).collect();
        for (at, bytes) in landed {
            self.leaf_fetches.remove(&at);
            let gzip = matches!(self.opened, Opened::Archive(h, _) if h.gzip_directories);
            match bytes.and_then(|b| inflate(&b, gzip)).and_then(|b| Directory::decode(&b)) {
                Some(leaf) => {
                    self.leaves.insert(at, leaf);
                }
                None => self.tiling.fail(Error::Io("a tile directory could not be read".into())),
            }
        }
        match &self.opened {
            Opened::Failed(error) => Some(error.clone()),
            _ => None,
        }
    }
}

/// What one set draws of vector tiles: the tiles whose rows its dataset holds, with the rows of each
/// table, and those rows with the fields their shapes are written as too.
pub(crate) struct Drawing {
    drawn: FxHashMap<TileKey, Vec<(Name, Vec<Id>)>>,
    held: Snapshot,
}

impl Drawing {
    pub(crate) fn new() -> Drawing {
        Drawing { drawn: FxHashMap::default(), held: Snapshot::new("held") }
    }

    /// The rows the dataset holds, each table with the fields its shapes are written as too.
    pub(crate) fn held(&self) -> &Snapshot {
        &self.held
    }

    /// Tiles drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.drawn.len()
    }

    /// Brings `data` up to what `sight` shows and set `set`'s scene draws of dataset `name`, from
    /// what `fetched` holds: whether it changed, whether a tile stands in, and a failure to tell.
    #[expect(clippy::too_many_arguments, reason = "what a set draws, of what the source holds")]
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
        let changed = self.draw(&drawn.keys, stamp, tiling, data);
        (changed, drawn.standing_in, failure.or(drawn.failure))
    }

    /// Makes `data` hold the rows of `drawn` and no other tile's, as the tiles wrote them, and the
    /// rows held those with their shapes; whether it changed.
    fn draw(&mut self, drawn: &[TileKey], stamp: u64, tiling: &Tiling<TileKey>, data: &mut Snapshot) -> bool {
        let keep: FxHashSet<TileKey> = drawn.iter().copied().collect();
        let mut patch = Patch::new();
        // Tiles no longer drawn go, and so do those decoded for other tables, which come back
        // decoded again.
        let gone: Vec<TileKey> =
            self.drawn.keys().filter(|k| !keep.contains(k) || tiling.decoded(k, stamp).is_none()).copied().collect();
        // One removal a table, which moves the rows after the first gone once.
        let mut removed: Keyed<Name, Vec<Id>> = Keyed::default();
        for key in &gone {
            for (table, ids) in self.drawn.remove(key).unwrap_or_default() {
                removed.entry(table).or_default().extend(ids);
            }
        }
        for (table, ids) in removed {
            if self.held.table(&table).is_some() {
                patch = patch.remove(table, ids);
            }
        }
        for &key in drawn {
            if self.drawn.contains_key(&key) {
                continue;
            }
            let Some(tile) = tiling.decoded(&key, stamp) else { continue };
            let mut rows = Vec::new();
            for op in &tile.ops {
                if let Op::Set(table) = op {
                    rows.push((table.name.clone(), table.ids().collect()));
                    patch = patch.set(harmonized(table, &self.held));
                }
            }
            self.drawn.insert(key, rows);
        }
        if patch.is_empty() {
            return false;
        }
        let Ok(held) = self.held.applied(patch) else { return false };
        // The dataset drawn holds each table held without its shapes, sharing all else.
        let tables = held.tables().map(|table| {
            let mut table = table.clone();
            table.fields.retain(|(name, _)| !shapes_field(name));
            table
        });
        let Ok(next) = data.applied(tables.fold(Patch::new(), Patch::replace)) else { return false };
        (*data, self.held) = (next, held);
        true
    }
}

/// Where a source's tiles lie, and the tables a set's marks draw of them, which decoding writes.
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
                // The archive has no such tile: it draws nothing.
                Requested::Missing
            }
            Opened::Root(..) | Opened::Failed(_) => Requested::Wait,
        }
    }

    fn decode(&self, key: TileKey, bytes: &Arc<Vec<u8>>, jobs: &Jobs<'_>) -> Decoding {
        Decoding::Job(jobs.spawn(Job::tile(key, self.tables, bytes)))
    }
}

/// The archive at `header` with root directory `bytes`, or `None` where it is corrupt.
fn archive(header: Header, bytes: &[u8]) -> Option<Opened> {
    let root = inflate(bytes, header.gzip_directories).and_then(|b| Directory::decode(&b))?;
    Some(Opened::Archive(header, root))
}

fn corrupt(url: &str) -> String {
    format!("the archive at {url} has a corrupt directory")
}

/// The tables marks draw from dataset `name`: a table named after a layer holds the kind of feature
/// its marks draw, polygons first, then lines, then points; one named `layer:kind` holds that kind.
/// Each is shaped as the marks drawing its geometry shape it.
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

/// `table`'s fields made to hold what `data`'s table of its name holds where they differ: a field a
/// tile reads as numbers but the dataset holds as texts is written as text, and so on.
fn harmonized(table: &Table, data: &Snapshot) -> Table {
    let Some(existing) = data.table(&table.name) else { return table.clone() };
    let mut out = table.clone();
    for (name, field) in &table.fields {
        let (Some(want), Field::Values(column, _)) = (existing.kind(name), field) else { continue };
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

/// `bytes` inflated when `gzip`.
fn inflate(bytes: &[u8], gzip: bool) -> Option<Vec<u8>> {
    if !gzip {
        return Some(bytes.to_vec());
    }
    crate::geo::gunzipped(bytes).ok().map(std::borrow::Cow::into_owned)
}
