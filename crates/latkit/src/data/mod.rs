//! Datasets: named tables of paged, immutable columns, changed only by patches.

mod bits;
mod buffer;
mod bytes;
mod column;
#[allow(clippy::module_inception)]
mod data;
mod geometry;
mod ids;
mod name;
mod patch;
mod samples;
mod table;
mod text;
mod values;

pub use data::Data;
pub use ids::Ids;
pub use name::{Id, Name, Row};
pub use patch::Patch;
pub use table::Table;
pub use values::{Kind, Value, Values};

// What the GPU side reads of the data.
#[cfg(feature = "gpu")]
pub(crate) use {
    column::{Column, PAGE_ROWS, Page},
    geometry::Geometry,
    name::{PageId, Version},
    patch::Op,
    samples::{AxisPage, FramePage, LEVELS, Samples, bucket_frames},
    table::{Field, Inverse, Reference},
};

#[cfg(test)]
mod tests;
