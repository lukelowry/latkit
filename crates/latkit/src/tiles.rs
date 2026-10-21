//! Tiles: data fetched in pieces, by key, as a view asks for them. A key is covered by its parent up to
//! a root: a tile of the earth by the tile a zoom out, a span of a sampled field's history by the span
//! a level of detail up. A piece not fetched yet draws its nearest fetched ancestor.

use std::fmt::Debug;
use std::hash::Hash;
#[cfg(feature = "gpu")]
use std::sync::Arc;

#[cfg(feature = "gpu")]
use crate::data::Name;

/// Data a view fetches in pieces as it asks for them, kept as a dataset the view owns. Give them to a
/// view with [`View::set_tiles`](crate::View::set_tiles); what the source's first bytes hold says
/// which they are.
///
/// **Time tiles**, a `frames.json` manifest as [`Data::to_tiles`](crate::Data::to_tiles) writes it:
/// a dataset whose sampled fields' histories are fetched in spans. A line tracing a field fetches the
/// level of detail its plot window draws at, a mark showing a field fetches the frames about the
/// view's coordinate, and a span still loading draws the coarser span above it.
///
/// **Vector tiles**, a PMTiles archive, a TileJSON document, or a URL template with `{z}`, `{x}`, and
/// `{y}`, fetched as the camera asks for them. Each layer is a table of its
/// features of the kind marks draw it as: polygons for [`Areas`](crate::Areas), lines for
/// [`Lines`](crate::Lines), points for [`Vertices`](crate::Vertices), polygons first where marks of
/// several kinds draw one layer. A table named `layer:polygons`, `layer:lines`, or `layer:points`
/// holds that kind whatever draws it. Every feature's properties are fields, and its row's id is
/// stable, made from its tile and its place in it, so a tile fetched again finds its rows selected as
/// they were.
///
/// ```
/// # use latkit::Tiles;
/// let base = Tiles::new("base", "https://tiles.openfreemap.org/planet");
/// let history = Tiles::new("grid", "history/frames.json");
/// ```
#[cfg(feature = "gpu")]
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Tiles {
    pub(crate) name: Name,
    pub(crate) url: Arc<str>,
}

#[cfg(feature = "gpu")]
impl Tiles {
    /// The tiles at `url`, drawn as dataset `name`.
    pub fn new(name: impl Into<Name>, url: impl Into<Arc<str>>) -> Tiles {
        Tiles { name: name.into(), url: url.into() }
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

/// Bytes read first of a source that is an archive, as a URL ending in `.pmtiles` names: its header,
/// and in most archives the root directory after it. Any other source is read whole.
pub(crate) const ARCHIVE_FIRST: u64 = 16_384;

/// A key of a tiling: a piece of what a source holds, covered by its parent up to a root.
pub(crate) trait Key: Copy + Eq + Hash + Ord + Debug {
    /// The key covering this one, one level up; `None` at the root.
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

/// A span of a sampled field's history: at level 0, `chunk` frames from `index × chunk`; at level `k`,
/// `chunk` buckets of `8^k` frames from `index × chunk`, each row's least and greatest over each. Eight
/// spans make the one a level up, as four tiles make the tile a zoom out.
#[cfg(feature = "gpu")]
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub(crate) struct Span {
    pub(crate) level: u8,
    pub(crate) index: u64,
}

#[cfg(feature = "gpu")]
impl Key for Span {
    fn parent(self) -> Option<Span> {
        (u32::from(self.level) < crate::data::MAX_LEVEL).then(|| Span { level: self.level + 1, index: self.index / 8 })
    }
}

/// A tile: its zoom, column, and row, rows counting from the north.
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
        let latitude = |t: f64| (std::f64::consts::PI * (1.0 - 2.0 * t)).sinh().atan().to_degrees();
        let (x, y) = (f64::from(self.x), f64::from(self.y));
        [x / n * 360.0 - 180.0, latitude((y + 1.0) / n), (x + 1.0) / n * 360.0 - 180.0, latitude(y / n)]
    }

    /// The tile `levels` zooms up that holds this one.
    pub(crate) fn ancestor(self, levels: u8) -> TileKey {
        TileKey { z: self.z - levels, x: self.x >> levels, y: self.y >> levels }
    }

    /// Its four children.
    pub(crate) fn children(self) -> [TileKey; 4] {
        let (z, x, y) = (self.z + 1, self.x * 2, self.y * 2);
        [TileKey { z, x, y }, TileKey { z, x: x + 1, y }, TileKey { z, x, y: y + 1 }, TileKey { z, x: x + 1, y: y + 1 }]
    }
}
