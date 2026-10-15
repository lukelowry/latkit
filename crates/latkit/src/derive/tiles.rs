//! Tiles: the vector tiles the camera asks for, fetched from their host, decoded in jobs, and patched
//! into datasets the view owns, which marks draw like any other. Tiles are the camera asking: the one
//! derivation that reads it, choosing the tiles that draw no larger than their own size where they
//! lie nearest the camera's focus, nearest first. A tile not loaded yet draws its nearest loaded
//! ancestor; fetched tiles stay, the least recently drawn going first past a budget of bytes; tiles
//! decode only the layers marks draw, and again when the scene draws others.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::sight::{Sight, TILE_PX, meets};
use super::{Input, Jobs};
use crate::data::{Data, Field, Id, Name, Op, Patch, Table, Values};
use crate::geo::Tiles;
use crate::geo::mvt::Kind as Geometry;
use crate::geo::pmtiles::{self, Directory, Entry, Header};
use crate::geo::tiles::{Decoded, Template, TileKey};
use crate::host::{Job, Request};
use crate::{Error, Kind, Mark, Pending, Scene};

/// Tiles drawn at once at most: past it, tiles stop splitting.
const MAX_TILES: usize = 256;
/// Fetches, and decodes, a source has under way at once.
const REQUESTS: usize = 8;
/// Bytes of fetched tiles a source keeps, past which the least recently drawn go.
const KEPT_BYTES: usize = 64 << 20;

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
            let (size, distance) = sight.measure(&focus, b);
            let room = out.len() + next.len() + (queue.len() - k) * 4 < MAX_TILES;
            if key.z < zooms[1] && (key.z < zooms[0] || size > limit) && room {
                next.extend(key.children());
            } else if key.z >= zooms[0] {
                out.push((key, distance));
            }
        }
        queue = next;
    }
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out.into_iter().map(|(key, _)| key).collect()
}

/// Where a source's tiles come from, as it opens.
enum Source {
    Unopened,
    /// The URL's first bytes, which say whether it is an archive or TileJSON.
    Opening(Pending<Vec<u8>>),
    /// An archive whose root directory lies past the first bytes.
    Root(Header, Pending<Vec<u8>>),
    Template(Template),
    Archive(Header, Directory),
    Failed,
}

/// A tile being fetched: its bytes, or for an archive the leaf directory naming where they are.
enum Fetching {
    Bytes(Pending<Vec<u8>>),
    Leaf((u64, u64)),
}

/// A source's tiles: where they come from, the dataset they make, and every tile's state.
struct TileSet {
    tiles: Tiles,
    source: Source,
    data: Data,
    /// Fetched tiles' bytes, as fetched, and when each was last drawn; empty where there is no tile.
    held: FxHashMap<TileKey, (Arc<Vec<u8>>, u64)>,
    fetching: FxHashMap<TileKey, Fetching>,
    /// Leaf directories, and those being fetched.
    leaves: FxHashMap<(u64, u64), Directory>,
    leaf_fetches: FxHashMap<(u64, u64), Pending<Vec<u8>>>,
    /// Decodes under way and done, each for the tables it was asked for.
    decoding: FxHashMap<TileKey, (u64, Pending<Vec<u8>>)>,
    decoded: FxHashMap<TileKey, (u64, Patch)>,
    /// The tiles whose rows the dataset holds, with the rows of each table.
    drawn: FxHashMap<TileKey, Vec<(Name, Vec<Id>)>>,
    /// Counts updates, for drawn tiles to note when they last drew.
    tick: u64,
    /// Whether the dataset changed since it was last taken.
    changed: bool,
    /// Whether a failure was told: a source that went away tells it once.
    told: bool,
}

impl TileSet {
    fn new(tiles: Tiles) -> TileSet {
        TileSet {
            data: Data::new(tiles.name.clone()),
            tiles,
            source: Source::Unopened,
            held: FxHashMap::default(),
            fetching: FxHashMap::default(),
            leaves: FxHashMap::default(),
            leaf_fetches: FxHashMap::default(),
            decoding: FxHashMap::default(),
            decoded: FxHashMap::default(),
            drawn: FxHashMap::default(),
            tick: 0,
            changed: false,
            told: false,
        }
    }
}

/// Every source of tiles a view was given.
#[derive(Default)]
pub(crate) struct TileSets {
    sets: Vec<TileSet>,
    /// Datasets the last update changed, for the view to take.
    changed: Vec<Data>,
    errors: Vec<Error>,
}

impl TileSets {
    /// Fetches tiles from `tiles` as the camera asks; tiles of the same name replace these.
    pub(crate) fn set(&mut self, tiles: Tiles) {
        if self.sets.iter().any(|s| s.tiles == tiles) {
            return;
        }
        self.sets.retain(|s| s.tiles.name != tiles.name);
        self.sets.push(TileSet::new(tiles));
    }

    /// Whether a fetch or decode is under way.
    pub(crate) fn busy(&self) -> bool {
        self.sets.iter().any(|s| {
            matches!(s.source, Source::Opening(_) | Source::Root(..))
                || !s.fetching.is_empty()
                || !s.decoding.is_empty()
                || !s.leaf_fetches.is_empty()
        })
    }

    /// Whether the view owns dataset `name`: tiles fetched as the camera asks, drawn as they are.
    pub(crate) fn owns(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.tiles.name == *name)
    }

    /// Stops fetching the tiles drawn as dataset `name`.
    pub(crate) fn remove(&mut self, name: &str) -> bool {
        let before = self.sets.len();
        self.sets.retain(|s| s.tiles.name != name);
        self.sets.len() != before
    }

    /// The datasets the last update changed.
    pub(crate) fn take_changed(&mut self) -> Vec<Data> {
        std::mem::take(&mut self.changed)
    }

    /// Failures since last asked.
    pub(crate) fn take_errors(&mut self) -> Vec<Error> {
        std::mem::take(&mut self.errors)
    }

    /// Brings every source up to what the camera asks and the scene draws.
    pub(crate) fn update(&mut self, input: &Input<'_>, sight: Option<&Sight<'_>>, jobs: &Jobs<'_>) {
        for set in &mut self.sets {
            let tables = decoded_tables(input.scene, &set.tiles.name);
            if tables.is_empty() {
                continue;
            }
            if let Some(error) = set.update(&tables, sight, jobs)
                && !set.told
            {
                set.told = true;
                self.errors.push(Error::Load(format!("tiles {}: {error}", set.tiles.name).into()));
            }
            if std::mem::take(&mut set.changed) {
                self.changed.push(set.data.clone());
            }
        }
    }
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
    tables.sort_by(|a, b| a.table.cmp(&b.table));
    tables
}

impl TileSet {
    /// Brings the tiles up to `tables` and what `sight` shows; a failure to tell, if any.
    fn update(&mut self, tables: &[Decoded], sight: Option<&Sight<'_>>, jobs: &Jobs<'_>) -> Option<Error> {
        self.tick += 1;
        let mut failure = self.open(jobs);
        let Some((zooms, bounds)) = self.zooms() else { return failure };
        let stamp = super::stamp_of(tables);
        let wanted = sight.map(|s| wanted(s, zooms, bounds)).unwrap_or_default();
        failure = failure.or_else(|| self.land(stamp));
        // What draws: each wanted tile decoded for these tables, or its nearest such ancestor.
        let mut drawn: Vec<TileKey> = Vec::new();
        let mut needed: Vec<TileKey> = Vec::new();
        for &key in &wanted {
            let stands = (0..=key.z).map(|up| key.ancestor(up)).find(|k| ready(&self.decoded, k, stamp));
            if let Some(stand) = stands
                && !drawn.contains(&stand)
            {
                drawn.push(stand);
            }
            if stands != Some(key) {
                needed.push(key);
            }
        }
        // Held ancestors of tiles still loading decode too, to stand in for them.
        let mut decode: Vec<TileKey> = Vec::new();
        for &key in &needed {
            let held_up = (0..=key.z).map(|up| key.ancestor(up)).find(|k| self.held.contains_key(k));
            if let Some(k) = held_up
                && !ready(&self.decoded, &k, stamp)
                && !decode.contains(&k)
            {
                decode.push(k);
            }
            if !self.held.contains_key(&key) && !decode.contains(&key) {
                self.fetch(key, jobs);
            }
        }
        for key in decode {
            self.decode(key, stamp, tables, jobs);
        }
        self.draw(&drawn, stamp);
        let tick = self.tick;
        for key in &drawn {
            if let Some((_, used)) = self.held.get_mut(key) {
                *used = tick;
            }
        }
        self.evict(&drawn, &wanted);
        failure
    }

    /// The zooms and bounds of an open source.
    fn zooms(&self) -> Option<([u8; 2], [f64; 4])> {
        match &self.source {
            Source::Template(t) => Some(([t.min_zoom, t.max_zoom], t.bounds)),
            Source::Archive(h, _) => Some(([h.min_zoom, h.max_zoom], h.bounds)),
            _ => None,
        }
    }

    /// Opens the source as far as what landed allows.
    fn open(&mut self, jobs: &Jobs<'_>) -> Option<Error> {
        let url = self.tiles.url.clone();
        if matches!(self.source, Source::Unopened) {
            // An archive is read in ranges, from its header; TileJSON whole.
            let archive = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".pmtiles"));
            self.source = if url.contains("{z}") {
                Source::Template(Template::of(&url))
            } else if archive {
                Source::Opening(jobs.fetch(&Request::range(url.clone(), 0..pmtiles::FIRST)))
            } else {
                Source::Opening(jobs.fetch(&Request::new(url.clone())))
            };
        }
        let failed = |reason: String| Some(Error::Load(reason.into()));
        match &self.source {
            Source::Opening(pending) => {
                let bytes = match pending.take()? {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        self.source = Source::Failed;
                        return Some(error);
                    }
                };
                if !pmtiles::is_archive(&bytes) {
                    return match Template::tilejson(&bytes, &url) {
                        Ok(template) => {
                            self.source = Source::Template(template);
                            None
                        }
                        Err(reason) => {
                            self.source = Source::Failed;
                            failed(reason)
                        }
                    };
                }
                let header = match pmtiles::header(&bytes) {
                    Ok(header) => header,
                    Err(reason) => {
                        self.source = Source::Failed;
                        return failed(reason);
                    }
                };
                if !header.vector {
                    self.source = Source::Failed;
                    return failed(format!("{url} holds image tiles; only vector tiles draw"));
                }
                let (offset, length) = header.root;
                if let Some(root) = bytes.get(offset as usize..(offset + length) as usize) {
                    self.root(header, root)
                } else {
                    let pending = jobs.fetch(&Request::range(url, offset..offset + length));
                    self.source = Source::Root(header, pending);
                    None
                }
            }
            Source::Root(header, pending) => {
                let header = *header;
                match pending.take()? {
                    Ok(bytes) => self.root(header, &bytes),
                    Err(error) => {
                        self.source = Source::Failed;
                        Some(error)
                    }
                }
            }
            _ => None,
        }
    }

    /// Opens the archive at `header` with root directory `bytes`.
    fn root(&mut self, header: Header, bytes: &[u8]) -> Option<Error> {
        let directory = inflate(bytes, header.gzip_directories).and_then(|b| Directory::decode(&b));
        if let Some(root) = directory {
            self.source = Source::Archive(header, root);
            None
        } else {
            self.source = Source::Failed;
            Some(Error::Load(format!("the archive at {} has a corrupt directory", self.tiles.url).into()))
        }
    }

    /// Takes fetches and decodes that landed; a failure to tell, if any.
    fn land(&mut self, stamp: u64) -> Option<Error> {
        let mut failure = None;
        let landed: Vec<_> =
            self.leaf_fetches.iter().filter_map(|(at, pending)| pending.take().map(|r| (*at, r.ok()))).collect();
        for (at, bytes) in landed {
            self.leaf_fetches.remove(&at);
            let gzip = matches!(self.source, Source::Archive(h, _) if h.gzip_directories);
            match bytes.and_then(|b| inflate(&b, gzip)).and_then(|b| Directory::decode(&b)) {
                Some(leaf) => {
                    self.leaves.insert(at, leaf);
                }
                None => failure = Some(Error::Load("a tile directory could not be read".into())),
            }
        }
        let mut fetched = Vec::new();
        for (key, fetching) in &self.fetching {
            if let Fetching::Bytes(pending) = fetching
                && let Some(result) = pending.take()
            {
                fetched.push((*key, result));
            }
        }
        for (key, result) in fetched {
            self.fetching.remove(&key);
            let bytes = result.unwrap_or_else(|error| {
                failure.get_or_insert(error);
                Vec::new()
            });
            self.held.insert(key, (Arc::new(bytes), self.tick));
        }
        let mut decoded = Vec::new();
        for (key, (s, pending)) in &self.decoding {
            if let Some(result) = pending.take() {
                decoded.push((*key, *s, result));
            }
        }
        for (key, s, result) in decoded {
            self.decoding.remove(&key);
            let patch = result.ok().and_then(|bytes| Patch::from_bytes(&bytes).ok()).unwrap_or_default();
            if s == stamp {
                self.decoded.insert(key, (s, patch));
            }
        }
        failure
    }

    /// Starts fetching tile `key`, within the source's requests at once.
    fn fetch(&mut self, key: TileKey, jobs: &Jobs<'_>) {
        if self.fetching.contains_key(&key) {
            // A tile waiting on a leaf fetches once the leaf lands.
            if let Some(Fetching::Leaf(at)) = self.fetching.get(&key)
                && self.leaves.contains_key(at)
            {
                self.fetching.remove(&key);
            } else {
                return;
            }
        }
        if self.fetching.len() >= REQUESTS {
            return;
        }
        let url = self.tiles.url.clone();
        let fetching = match &self.source {
            Source::Template(template) => Fetching::Bytes(jobs.fetch(&Request::new(template.url_of(key)))),
            Source::Archive(header, root) => {
                let id = pmtiles::tile_id(key);
                let mut directory = root;
                let mut entry = None;
                for _ in 0..pmtiles::DEPTH {
                    match directory.find(id) {
                        Some(Entry::Leaf(offset, length)) => {
                            let at = (header.leaves + offset, length);
                            if let Some(leaf) = self.leaves.get(&at) {
                                directory = leaf;
                            } else {
                                self.leaf_fetches
                                    .entry(at)
                                    .or_insert_with(|| jobs.fetch(&Request::range(url.clone(), at.0..at.0 + at.1)));
                                entry = Some(Fetching::Leaf(at));
                                break;
                            }
                        }
                        Some(Entry::Tile(offset, length)) => {
                            let start = header.data + offset;
                            entry =
                                Some(Fetching::Bytes(jobs.fetch(&Request::range(url.clone(), start..start + length))));
                            break;
                        }
                        None => break,
                    }
                }
                let Some(entry) = entry else {
                    // The archive has no such tile: it draws nothing.
                    self.held.insert(key, (Arc::new(Vec::new()), self.tick));
                    return;
                };
                entry
            }
            _ => return,
        };
        self.fetching.insert(key, fetching);
    }

    /// Starts decoding tile `key` into `tables` in a job, within the source's decodes at once.
    fn decode(&mut self, key: TileKey, stamp: u64, tables: &[Decoded], jobs: &Jobs<'_>) {
        if self.decoding.get(&key).is_some_and(|(s, _)| *s == stamp) || self.decoding.len() >= REQUESTS {
            return;
        }
        let Some((bytes, _)) = self.held.get(&key) else { return };
        if bytes.is_empty() {
            self.decoded.insert(key, (stamp, Patch::new()));
            return;
        }
        let pending = jobs.spawn(Job::tile(key, tables, bytes));
        self.decoding.insert(key, (stamp, pending));
    }

    /// Makes the dataset hold the rows of `drawn` and no other tile's.
    fn draw(&mut self, drawn: &[TileKey], stamp: u64) {
        let keep: FxHashSet<TileKey> = drawn.iter().copied().collect();
        let mut patch = Patch::new();
        // Tiles no longer drawn go, and so do those decoded for other tables, which come back
        // decoded again.
        let gone: Vec<TileKey> = self
            .drawn
            .keys()
            .filter(|k| !keep.contains(k) || self.decoded.get(k).is_none_or(|(s, _)| *s != stamp))
            .copied()
            .collect();
        for key in &gone {
            for (table, ids) in self.drawn.remove(key).unwrap_or_default() {
                if self.data.table(&table).is_some() {
                    patch = patch.remove(table, ids);
                }
            }
        }
        for &key in drawn {
            if self.drawn.contains_key(&key) {
                continue;
            }
            let Some((_, tile)) = self.decoded.get(&key) else { continue };
            let mut rows = Vec::new();
            for op in &tile.ops {
                if let Op::Set(table) = op {
                    rows.push((table.name.clone(), table.ids().collect()));
                    patch = patch.set(harmonized(table, &self.data));
                }
            }
            self.drawn.insert(key, rows);
        }
        if patch.is_empty() {
            return;
        }
        let mut next = self.data.clone();
        if next.apply(patch).is_ok() {
            self.data = next;
            self.changed = true;
        }
    }

    /// Lets go of the least recently drawn tiles' bytes past the budget, and of decodes of tiles no
    /// longer drawn or wanted.
    fn evict(&mut self, drawn: &[TileKey], wanted: &[TileKey]) {
        let kept = |k: &TileKey| drawn.contains(k) || wanted.contains(k);
        let mut bytes: usize = self.held.values().map(|(b, _)| b.len()).sum();
        if bytes > KEPT_BYTES {
            let mut old: Vec<(u64, TileKey)> =
                self.held.iter().filter(|(k, _)| !kept(k)).map(|(k, (_, used))| (*used, *k)).collect();
            old.sort_unstable();
            for (_, key) in old {
                if bytes <= KEPT_BYTES {
                    break;
                }
                if let Some((b, _)) = self.held.remove(&key) {
                    bytes -= b.len();
                }
            }
        }
        self.decoded.retain(|k, _| kept(k) || wanted.iter().any(|w| w.z > k.z && w.ancestor(w.z - k.z) == *k));
    }
}

/// Whether tile `key` is decoded for the tables of `stamp`.
fn ready(decoded: &FxHashMap<TileKey, (u64, Patch)>, key: &TileKey, stamp: u64) -> bool {
    decoded.get(key).is_some_and(|(s, _)| *s == stamp)
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
