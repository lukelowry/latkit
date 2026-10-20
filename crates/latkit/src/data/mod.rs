//! Datasets: named tables of paged, immutable columns, changed only by patches.

mod bits;
mod buffer;
mod bytes;
mod column;
mod dataset;
mod describe;
mod forms;
mod geometry;
mod ids;
// JSON documents fetch their slices through a host.
#[cfg(feature = "gpu")]
mod json;
mod name;
mod ordered;
mod patch;
// Queries read rows back through the expressions marks draw with.
#[cfg(feature = "gpu")]
mod query;
mod samples;
mod table;
mod text;
mod values;

pub use dataset::Data;
pub use describe::{Description, Envelope, FieldDescription, TableDescription};
pub use ids::Ids;
pub use name::{Id, Name, Row, Rows};
pub use patch::Patch;
pub use table::Table;
pub use values::{Kind, Value, Values};
#[cfg(feature = "gpu")]
pub use {
    json::Patches,
    query::{Order, Query},
};

// What the GPU side reads of the data.
#[cfg(feature = "gpu")]
pub(crate) use {
    column::{Column, PAGE_ROWS, Page},
    geometry::{Geometry, GeometryBuilder},
    ids::RowIds,
    name::{PageId, Version},
    patch::Op,
    samples::{AxisPage, FramePage, LEVELS, Samples, bucket_frames},
    table::{Field, Inverse, Reference, UNWIRED},
};

#[cfg(test)]
mod tests;
