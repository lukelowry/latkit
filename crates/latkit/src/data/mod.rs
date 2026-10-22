//! Datasets: named tables of paged, immutable columns, changed only by patches.

mod bits;
mod buffer;
mod bytes;
mod column;
mod dataset;
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
mod table;
mod text;
mod values;

pub use bytes::DecodeLimits;
pub use dataset::Data;
pub use describe::{Description, Envelope, FieldDescription, TableDescription};
pub use ids::Ids;
pub use name::{Id, Name, Row, Rows};
#[cfg(feature = "gpu")]
pub(crate) use name::{Keyed, Named};
pub use patch::Patch;
pub use table::Table;
pub use values::{Kind, Value, Values};
pub use {
    json::Patches,
    query::{Order, Query},
};

pub(crate) use {geometry::Geometry, table::Field};

// What the GPU side reads of the data.
#[cfg(feature = "gpu")]
pub(crate) use {
    column::{Column, PAGE_ROWS, Page},
    frames::{Listed, Manifest},
    geometry::GeometryBuilder,
    ids::RowIds,
    name::{PageId, Version},
    patch::Op,
    samples::{AxisPage, FRAME_PAGE_WORDS, FramePage, MAX_LEVEL, Run, Samples, bucket_frames, detail, sides},
    table::{Inverse, Reference, UNWIRED},
    values::HOLE,
};

#[cfg(test)]
mod tests;
