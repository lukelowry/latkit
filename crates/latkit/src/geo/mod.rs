//! Geography: GeoJSON and vector tiles read as data, polygon triangulation, lines given extra
//! points so they follow the globe, and Web Mercator.

#[cfg(feature = "gpu")]
mod earcut;
mod geojson;
#[cfg(feature = "gpu")]
pub(crate) mod mercator;
#[cfg(feature = "gpu")]
pub(crate) mod mvt;
#[cfg(feature = "gpu")]
pub(crate) mod pmtiles;
#[cfg(feature = "gpu")]
pub(crate) mod shapes;
#[cfg(feature = "gpu")]
pub(crate) mod tiles;

use std::borrow::Cow;
use std::io::Read;

pub(crate) use geojson::geojson;

use crate::{Error, Result};

/// Decompresses `bytes` if they start with the gzip magic number, else returns them unchanged.
/// Errors if the gzip stream is corrupt.
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
