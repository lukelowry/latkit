//! Geography: GeoJSON and vector tiles as data, and what their shapes become to draw.

mod earcut;
mod geojson;
pub(crate) mod mvt;
pub(crate) mod pmtiles;
pub(crate) mod shapes;
pub(crate) mod tiles;

use std::borrow::Cow;
use std::io::Read;

pub(crate) use geojson::geojson;
pub use tiles::Tiles;

use crate::{Error, Result};

/// `bytes` inflated where they are gzip-compressed, else as they are.
pub(crate) fn gunzipped(bytes: &[u8]) -> Result<Cow<'_, [u8]>> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Ok(Cow::Borrowed(bytes));
    }
    let mut out = Vec::with_capacity(bytes.len() * 4);
    flate2::read::MultiGzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| Error::invalid(format!("the gzip-compressed bytes are corrupt: {e}")))?;
    Ok(Cow::Owned(out))
}
