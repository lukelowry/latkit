//! Datasets: named tables of immutable, paged columns. Only patches change a dataset, and each
//! version is a snapshot.

mod bits;
mod buffer;
mod bytes;
mod column;
mod describe;
mod forms;
mod frames;
mod geometry;
mod ids;
mod json;
mod name;
mod ordered;
mod patch;
mod query;
mod samples;
mod snapshot;
mod source;
mod table;
mod text;
mod values;

pub use bytes::DecodeLimits;
pub use describe::{Description, Envelope, EnvelopeRequest, FieldDescription, TableDescription};
pub use ids::Ids;
pub use json::{Patches, Reading};
pub use name::{Id, Name, Row, Rows};
#[cfg(feature = "gpu")]
pub(crate) use name::{Keyed, Named};
pub use patch::Patch;
pub use query::{Order, Query, QueryResult};
pub use snapshot::Snapshot;
pub use source::Data;
#[cfg(feature = "gpu")]
pub use source::Source;
pub use table::Table;
pub use values::{Kind, Value, Values};

pub(crate) use {geometry::Geometry, table::Field};

// Data internals the GPU side uses.
#[cfg(feature = "gpu")]
pub(crate) use {
    bytes::{read_values, values_bytes},
    column::{Column, PAGE_ROWS, Page},
    frames::{Listed, Manifest},
    geometry::GeometryBuilder,
    ids::RowIds,
    json::geojson,
    name::{PageId, Version},
    patch::Op,
    samples::{AxisPage, FRAME_PAGE_WORDS, FramePage, MAX_LEVEL, Run, Samples, bucket_frames, detail, sides},
    table::{Inverse, Reference, UNWIRED},
};

#[cfg(test)]
mod tests;
