//! A tile source's index: what its first bytes say it holds. The cache opens a source from its
//! index, and [`Tiles::describe`] reads the same index to say what the source holds.

use std::sync::Arc;

use super::Tiles;
use crate::data::{FieldDescription, Kind, Manifest, Name};
use crate::geo::pmtiles::{self, Header};
use crate::geo::tiles::{Metadata, Template};
use crate::host::{Host, Request};
use crate::{Error, Result};

/// Bytes first read from an archive source (a URL ending in `.pmtiles`). They hold its header and,
/// in most archives, the root directory and the metadata after it. Other sources are read whole.
const ARCHIVE_FIRST: u64 = 16_384;

/// What a tile source holds, by its index.
pub(crate) enum Index {
    /// Time tiles, listed by a manifest.
    Frames(Manifest),
    /// Vector tiles at a URL template, given directly or read from a TileJSON document, with what
    /// the document says of them.
    Template(Template, Metadata),
    /// Vector tiles in a PMTiles archive, with its header.
    Archive(Header),
}

impl Index {
    /// The index of the source at `url` when it is one without a fetch: a URL template.
    pub(crate) fn given(url: &str) -> Option<Index> {
        url.contains("{z}").then(|| Index::Template(Template::of(url), Metadata::default()))
    }

    /// The request for the first bytes of the source at `url`: the start of an archive, which is
    /// read in ranges, or the whole of a document.
    pub(crate) fn request(url: &Arc<str>) -> Request {
        let archive = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".pmtiles"));
        if archive { Request::range(url.clone(), 0..ARCHIVE_FIRST) } else { Request::new(url.clone()) }
    }

    /// Reads the index in the first `bytes` fetched from `url`: a manifest of time tiles, else a
    /// PMTiles header, else a TileJSON document. Errors with `Io` if there is none (no bytes, as
    /// for a 404), and with `Invalid` if they are none of these, are malformed, or hold image tiles.
    pub(crate) fn read(url: &str, bytes: &[u8]) -> Result<Index> {
        if bytes.is_empty() {
            return Err(Error::Io(format!("{url} was not found").into()));
        }
        match Manifest::from_bytes(bytes) {
            Some(manifest) => manifest.map(Index::Frames),
            None if pmtiles::is_archive(bytes) => {
                let header = pmtiles::header(bytes).map_err(Error::invalid)?;
                if !header.vector {
                    return Err(Error::invalid(format!("{url} has image tiles; only vector tiles are supported")));
                }
                Ok(Index::Archive(header))
            }
            // The bytes arrived, but they are not a tile index.
            None => Template::tilejson(bytes, url)
                .map(|(template, said)| Index::Template(template, said))
                .map_err(Error::invalid),
        }
    }
}

/// What a tile source holds, as its index says. See [`Tiles::describe`].
#[derive(Clone, PartialEq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TilesDescription {
    /// The credit the source asks to be shown with its tiles, as the source writes it, which may
    /// be HTML. `None` when it asks for none.
    pub attribution: Option<String>,
    /// The lowest and highest zoom the source has tiles for. `None` for time tiles.
    pub zooms: Option<[u8; 2]>,
    /// The area its tiles cover: west, south, east, and north, in degrees. `None` for time tiles.
    pub bounds: Option<[f64; 4]>,
    /// The layers a vector source lists, each a table that marks can draw. Empty when it lists
    /// none, as a URL template and time tiles do.
    pub layers: Vec<LayerDescription>,
}

/// A summary of one layer of a vector tile source.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescription {
    /// The layer's name, which names its table.
    pub name: Name,
    /// What the source says the layer holds, if anything.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The lowest and highest zoom whose tiles have the layer, when the source states them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zooms: Option<[u8; 2]>,
    /// The properties of its features, each a field of its table, sorted by name.
    pub fields: Vec<FieldDescription>,
}

impl TilesDescription {
    /// The description of tiles covering `zooms` and `bounds`, with what the source `said` of
    /// them.
    fn of(zooms: [u8; 2], bounds: [f64; 4], said: Metadata) -> TilesDescription {
        let layers = said.vector_layers.iter().map(|layer| LayerDescription {
            name: layer.id.as_str().into(),
            description: layer.description.clone().filter(|text| !text.is_empty()),
            zooms: layer.zooms(),
            fields: layer.fields.iter().map(|(name, stated)| field(name, stated)).collect(),
        });
        TilesDescription {
            attribution: said.attribution.filter(|text| !text.is_empty()),
            zooms: Some(zooms),
            bounds: Some(bounds),
            layers: layers.collect(),
        }
    }
}

/// The field a layer's property `name` becomes. A source states each property's kind as `Number`,
/// `Boolean`, or `String`, or describes it in words, which reads as text.
fn field(name: &str, stated: &serde_json::Value) -> FieldDescription {
    let kind = match stated.as_str().map(str::to_ascii_lowercase).as_deref() {
        Some("number") => Kind::Number,
        Some("boolean") => Kind::Bool,
        _ => Kind::Text,
    };
    FieldDescription { name: name.into(), kind, to: None, span: None }
}

impl Tiles {
    /// Resolves to what the source holds, read from its index: the credit it asks for, the zooms
    /// and area it covers, and its layers with their fields. A PMTiles archive and a TileJSON
    /// document say these. A URL template says only the default zooms, and time tiles say none.
    /// The tiles' own fetch reads the index if they have one, else `host` does. Errors if the
    /// index can't be fetched or read.
    ///
    /// ```no_run
    /// # async fn credit(host: &dyn latkit::host::Host) -> latkit::Result<()> {
    /// let base = latkit::Tiles::new("base", "https://tiles.openfreemap.org/planet");
    /// let described = base.describe(host).await?;
    /// println!("{:?}: {} layers", described.attribution, described.layers.len());
    /// # Ok(())
    /// # }
    /// ```
    pub async fn describe(&self, host: &dyn Host) -> Result<TilesDescription> {
        let fetch = |request: &Request| match &self.fetch {
            Some(fetch) => fetch(request),
            None => host.fetch(request),
        };
        let (index, first) = if let Some(index) = Index::given(&self.url) {
            (index, Vec::new())
        } else {
            let first = fetch(&Index::request(&self.url)).await?;
            (Index::read(&self.url, &first)?, first)
        };
        match index {
            Index::Frames(_) => Ok(TilesDescription::default()),
            Index::Template(template, said) => {
                Ok(TilesDescription::of([template.min_zoom, template.max_zoom], template.bounds, said))
            }
            Index::Archive(header) => {
                let (offset, length) = header.metadata;
                // The metadata often lies in the bytes already read, after the root directory.
                let stored = match first.get(offset as usize..(offset + length) as usize) {
                    Some(stored) => stored.to_vec(),
                    None => fetch(&Request::range(self.url.clone(), offset..offset + length)).await?,
                };
                let said = pmtiles::inflated(&stored, header.gzip_directories).map(|json| Metadata::read(&json));
                Ok(TilesDescription::of([header.min_zoom, header.max_zoom], header.bounds, said.unwrap_or_default()))
            }
        }
    }
}
