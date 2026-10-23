//! Vector tiles: the tiles the camera asks for, fetched from a PMTiles archive or a URL
//! template, given or from a TileJSON document, decoded in jobs, and patched into the dataset the view
//! owns. The camera chooses the tiles that draw no larger than their own size where they lie nearest
//! its focus, nearest first. Tiles decode only the layers marks draw, and again when the scene draws
//! others.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::super::sight::{Domain, Sight, TILE_PX, meets};
use super::super::tiling::{Decoding, Requested, Source, Tiling};
use super::super::{Input, Jobs, stamp_of};
use crate::data::{Data, Field, Id, Name, Op, Patch, Table, Values};
use crate::geo::mvt::Kind as Geometry;
use crate::geo::pmtiles::{self, Directory, Entry, Header};
use crate::geo::tiles::{Decoded, Template};
use crate::host::{Job, Request};
use crate::tiles::TileKey;
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
    Failed,
}

/// An archive's or a template's tiles, as a tiling fetches and decodes them.
struct Tiles {
    url: Arc<str>,
    opened: Opened,
    /// Leaf directories, and those being fetched.
    leaves: FxHashMap<(u64, u64), Directory>,
    leaf_fetches: FxHashMap<(u64, u64), Pending<Vec<u8>>>,
    /// The tables marks draw from the tiles, which decoding writes.
    tables: Vec<Decoded>,
}

/// Vector tiles drawn as a dataset the view owns.
pub(crate) struct Vector {
    tiles: Tiles,
    tiling: Tiling<TileKey>,
    /// The tiles whose rows the dataset holds, with the rows of each table.
    drawn: FxHashMap<TileKey, Vec<(Name, Vec<Id>)>>,
}

impl Vector {
    /// The tiles a URL template names, `{z}`, `{x}`, and `{y}` in it.
    pub(crate) fn template(url: &Arc<str>) -> Vector {
        Vector::opened(url, Opened::Template(Template::of(url)))
    }

    /// The tiles whose source's first `bytes` are a PMTiles archive's or a TileJSON document's; the
    /// archive's root directory is fetched when it lies past them.
    pub(crate) fn open(url: &Arc<str>, bytes: &[u8], jobs: &Jobs<'_>) -> Result<Vector, String> {
        if !pmtiles::is_archive(bytes) {
            return Template::tilejson(bytes, url).map(|template| Vector::opened(url, Opened::Template(template)));
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
        Ok(Vector::opened(url, opened))
    }

    fn opened(url: &Arc<str>, opened: Opened) -> Vector {
        let tiles = Tiles {
            url: url.clone(),
            opened,
            leaves: FxHashMap::default(),
            leaf_fetches: FxHashMap::default(),
            tables: Vec::new(),
        };
        Vector { tiles, tiling: Tiling::default(), drawn: FxHashMap::default() }
    }

    /// Whether the source is still opening, its root directory not landed.
    pub(crate) fn opening(&self) -> bool {
        matches!(self.tiles.opened, Opened::Root(..))
    }

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        self.tiling.under_way()
    }

    /// Tiles drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.drawn.len()
    }

    /// Brings `data` up to what `sight` shows and the scene draws of dataset `name`: whether it
    /// changed, whether a tile stands in, and a failure to tell.
    pub(crate) fn update(
        &mut self,
        input: &Input<'_>,
        name: &Name,
        data: &mut Data,
        sight: Option<&Sight<'_>>,
        jobs: &Jobs<'_>,
    ) -> (bool, bool, Option<Error>) {
        let tables = decoded_tables(input.scene, name);
        if tables.is_empty() {
            return (false, false, None);
        }
        let mut failure = self.tiles.open_root();
        failure = failure.or_else(|| self.tiles.land_leaves());
        let Some((zooms, bounds)) = self.tiles.zooms() else { return (false, self.opening(), failure) };
        let stamp = stamp_of(&tables);
        self.tiles.tables = tables;
        let wanted = sight.map(|s| wanted(s, zooms, bounds)).unwrap_or_default();
        let drawn = self.tiling.update(&wanted, stamp, &mut self.tiles, jobs);
        let changed = self.draw(&drawn.keys, stamp, data);
        (changed, drawn.standing_in, failure.or(drawn.failure))
    }

    /// Makes `data` hold the rows of `drawn` and no other tile's; whether it changed.
    fn draw(&mut self, drawn: &[TileKey], stamp: u64, data: &mut Data) -> bool {
        let keep: FxHashSet<TileKey> = drawn.iter().copied().collect();
        let mut patch = Patch::new();
        // Tiles no longer drawn go, and so do those decoded for other tables, which come back
        // decoded again.
        let gone: Vec<TileKey> = self
            .drawn
            .keys()
            .filter(|k| !keep.contains(k) || self.tiling.decoded(k, stamp).is_none())
            .copied()
            .collect();
        for key in &gone {
            for (table, ids) in self.drawn.remove(key).unwrap_or_default() {
                if data.table(&table).is_some() {
                    patch = patch.remove(table, ids);
                }
            }
        }
        for &key in drawn {
            if self.drawn.contains_key(&key) {
                continue;
            }
            let Some(tile) = self.tiling.decoded(&key, stamp) else { continue };
            let mut rows = Vec::new();
            for op in &tile.ops {
                if let Op::Set(table) = op {
                    rows.push((table.name.clone(), table.ids().collect()));
                    patch = patch.set(harmonized(table, data));
                }
            }
            self.drawn.insert(key, rows);
        }
        if patch.is_empty() {
            return false;
        }
        let mut next = data.clone();
        if next.apply(patch).is_ok() {
            *data = next;
            return true;
        }
        false
    }
}

impl Tiles {
    /// The zooms and bounds of an open source.
    fn zooms(&self) -> Option<([u8; 2], [f64; 4])> {
        match &self.opened {
            Opened::Template(t) => Some(([t.min_zoom, t.max_zoom], t.bounds)),
            Opened::Archive(h, _) => Some(([h.min_zoom, h.max_zoom], h.bounds)),
            Opened::Root(..) | Opened::Failed => None,
        }
    }

    /// Opens the archive once its root directory landed; a failure to tell, if any.
    fn open_root(&mut self) -> Option<Error> {
        let Opened::Root(header, pending) = &self.opened else { return None };
        let header = *header;
        let landed = pending.take()?;
        let opened = landed
            .map_err(|error| error.to_string())
            .and_then(|bytes| archive(header, &bytes).ok_or_else(|| corrupt(&self.url)));
        match opened {
            Ok(opened) => {
                self.opened = opened;
                None
            }
            Err(reason) => {
                self.opened = Opened::Failed;
                Some(Error::Io(reason.into()))
            }
        }
    }

    /// Takes leaf directories that landed; a failure to tell, if any.
    fn land_leaves(&mut self) -> Option<Error> {
        let mut failure = None;
        let landed: Vec<_> =
            self.leaf_fetches.iter().filter_map(|(at, pending)| pending.take().map(|r| (*at, r.ok()))).collect();
        for (at, bytes) in landed {
            self.leaf_fetches.remove(&at);
            let gzip = matches!(self.opened, Opened::Archive(h, _) if h.gzip_directories);
            match bytes.and_then(|b| inflate(&b, gzip)).and_then(|b| Directory::decode(&b)) {
                Some(leaf) => {
                    self.leaves.insert(at, leaf);
                }
                None => failure = Some(Error::Io("a tile directory could not be read".into())),
            }
        }
        failure
    }
}

impl Source<TileKey> for Tiles {
    fn request(&mut self, key: TileKey, jobs: &Jobs<'_>) -> Requested {
        match &self.opened {
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
            Opened::Root(..) | Opened::Failed => Requested::Wait,
        }
    }

    fn decode(&self, key: TileKey, bytes: &Arc<Vec<u8>>, jobs: &Jobs<'_>) -> Decoding {
        Decoding::Job(jobs.spawn(Job::tile(key, &self.tables, bytes)))
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
            None => tables.push(Decoded { layer, kind, table }),
        }
    }
    crate::order::by_name(&mut tables, |t| t.table.as_str());
    tables
}

/// `table`'s fields made to hold what `data`'s table of its name holds where they differ: a field a
/// tile reads as numbers but the dataset holds as texts is written as text, and so on.
fn harmonized(table: &Table, data: &Data) -> Table {
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
