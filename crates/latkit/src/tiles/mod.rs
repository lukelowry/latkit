//! Tiles: data fetched in pieces, by key, as views need them. Each key is covered by its parent,
//! up to a root. An earth tile's parent is the tile one zoom out. A span of a sampled field's
//! history has the span one level of detail up. Until a piece is fetched, its nearest fetched
//! ancestor is drawn as a placeholder.
//!
//! A GPU fetches and decodes each source's pieces once for all the views drawing them (`cache`,
//! `tiling`). Each view draws the pieces its camera needs as a dataset of its own (`sets`).

mod cache;
mod frames;
mod sets;
mod tiling;
mod vector;

use std::fmt::Debug;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) use cache::Cache;
pub(crate) use sets::{Asked, Reading, TileSets};

use crate::Pending;
use crate::data::Name;
use crate::host::Request;
use crate::pending::Watchers;

/// A dataset fetched in pieces as views need them. Each view draws this
/// [`Source`](crate::Source) as a dataset of its own, holding the pieces its camera needs. Views on
/// one GPU that draw tiles from the same URL share what is fetched. The source's first bytes
/// determine the kind of tiles.
///
/// **Time tiles**: a `frames.json` manifest, as
/// [`Snapshot::to_tiles`](crate::Snapshot::to_tiles) writes it. The history of each sampled field
/// is fetched in spans. A line tracing a field fetches the level of detail the plot window draws
/// at. A mark showing a field fetches the frames around the view's coordinate. While a span loads,
/// the coarser span above it is drawn.
///
/// **Vector tiles**: a PMTiles archive, a TileJSON document, or a URL template with `{z}`, `{x}`,
/// and `{y}`. Tiles are fetched as the camera needs them. Each layer becomes a table of the
/// layer's features that have the geometry type its marks draw: polygons for
/// [`Areas`](crate::Areas), lines for [`Lines`](crate::Lines), and points for
/// [`Vertices`](crate::Vertices). When marks of several kinds draw one layer, polygons come first.
/// A table named `layer:polygons`, `layer:lines`, or `layer:points` holds that geometry type
/// whatever its marks. Each feature's properties become fields. Row ids are stable, derived from
/// the tile and the feature's index in it, so a refetched tile keeps its rows' selection. An
/// arriving tile appends its rows to the view's dataset. The dataset keeps the rows of tiles it no
/// longer draws until they outnumber the rows it draws.
///
/// ```
/// # use latkit::Tiles;
/// let base = Tiles::new("base", "https://tiles.openfreemap.org/planet");
/// let history = Tiles::new("grid", "history/frames.json");
/// ```
#[derive(Clone)]
pub struct Tiles {
    pub(crate) name: Name,
    pub(crate) url: Arc<str>,
    pub(crate) fetch: Option<Fetch>,
    pub(crate) refreshes: Arc<Refreshes>,
}

/// Fetches a tile source's files in place of the host.
pub(crate) type Fetch = Arc<dyn Fn(&Request) -> Pending<Vec<u8>> + Send + Sync>;

/// How many times a tile source was refreshed, and the views drawing it, which each refresh wakes.
#[derive(Default)]
pub(crate) struct Refreshes {
    count: AtomicU64,
    pub(crate) views: Watchers,
}

impl Tiles {
    /// The tiles at `url`, drawn as dataset `name`.
    pub fn new(name: impl Into<Name>, url: impl Into<Arc<str>>) -> Tiles {
        Tiles { name: name.into(), url: url.into(), fetch: None, refreshes: Arc::default() }
    }

    /// The same tiles, with their files fetched by `fetch` instead of the host: the index at
    /// `url`, then the pieces at URLs resolved against it, and byte ranges of an archive.
    #[must_use]
    pub fn fetch(mut self, fetch: impl Fn(&Request) -> Pending<Vec<u8>> + Send + Sync + 'static) -> Tiles {
        self.fetch = Some(Arc::new(fetch));
        self
    }

    /// Fetches the index again, as when a running simulation records more frames, and redraws what
    /// changed in every view drawing the tiles. Time tiles keep the spans that the frames they held
    /// cover, and fetch the rest again as views need them. Vector tiles start over.
    pub fn refresh(&self) {
        self.refreshes.count.fetch_add(1, Ordering::Relaxed);
        self.refreshes.views.wake_all();
    }

    /// How many times the tiles were refreshed.
    pub(crate) fn refreshed(&self) -> u64 {
        self.refreshes.count.load(Ordering::Relaxed)
    }

    /// The dataset the tiles are drawn as.
    pub fn name(&self) -> &Name {
        &self.name
    }

    /// Where the tiles come from.
    pub fn url(&self) -> &str {
        &self.url
    }
}

/// Tiles are equal when they draw the same URL as the same dataset, fetched the same way.
impl PartialEq for Tiles {
    fn eq(&self, other: &Tiles) -> bool {
        let fetch = match (&self.fetch, &other.fetch) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (a, b) => a.is_none() && b.is_none(),
        };
        self.name == other.name && self.url == other.url && fetch
    }
}

impl Eq for Tiles {}

impl std::fmt::Debug for Tiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tiles").field("name", &self.name).field("url", &self.url).finish_non_exhaustive()
    }
}

/// A tiling key: one piece of a source, covered by its parent up to a root.
pub(crate) trait Key: Copy + Eq + Hash + Ord + Debug {
    /// The key covering this one, one level up, or `None` at the root.
    fn parent(self) -> Option<Self>;
}

/// `key`, then each key covering it, to the root.
pub(crate) fn ancestry<K: Key>(key: K) -> impl Iterator<Item = K> {
    std::iter::successors(Some(key), |k| k.parent())
}

impl Key for TileKey {
    fn parent(self) -> Option<TileKey> {
        (self.z > 0).then(|| self.ancestor(1))
    }
}

/// A span of a sampled field's history. At level 0 it is `chunk` frames starting at frame
/// `index × chunk`. At level `k` it is `chunk` buckets of `8^k` frames starting at bucket
/// `index × chunk`, each bucket holding every row's minimum and maximum over its frames. Eight
/// spans make the span one level up, as four tiles make the tile one zoom out.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub(crate) struct Span {
    pub(crate) level: u8,
    pub(crate) index: u64,
}

impl Key for Span {
    fn parent(self) -> Option<Span> {
        (u32::from(self.level) < crate::data::MAX_LEVEL).then(|| Span { level: self.level + 1, index: self.index / 8 })
    }
}

/// A web mercator tile: its zoom, column, and row, with rows counted from the north.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub(crate) struct TileKey {
    pub(crate) z: u8,
    pub(crate) x: u32,
    pub(crate) y: u32,
}

impl TileKey {
    /// West, south, east, and north, in degrees.
    pub(crate) fn bounds(self) -> [f64; 4] {
        let n = f64::from(1_u32 << self.z);
        let latitude = crate::geo::mercator::latitude_down;
        let (x, y) = (f64::from(self.x), f64::from(self.y));
        [x / n * 360.0 - 180.0, latitude((y + 1.0) / n), (x + 1.0) / n * 360.0 - 180.0, latitude(y / n)]
    }

    /// The tile `levels` zooms out that contains this one.
    pub(crate) fn ancestor(self, levels: u8) -> TileKey {
        TileKey { z: self.z - levels, x: self.x >> levels, y: self.y >> levels }
    }

    /// Its four children.
    pub(crate) fn children(self) -> [TileKey; 4] {
        let (z, x, y) = (self.z + 1, self.x * 2, self.y * 2);
        [TileKey { z, x, y }, TileKey { z, x: x + 1, y }, TileKey { z, x, y: y + 1 }, TileKey { z, x: x + 1, y: y + 1 }]
    }
}
