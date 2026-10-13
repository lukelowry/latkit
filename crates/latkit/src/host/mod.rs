//! What the platform does for latkit: set text in its fonts. A [`Gpu`](crate::Gpu) is given its host
//! with [`Gpu::set_host`](crate::Gpu::set_host); without one, views draw no text.

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod browser;

use std::sync::Arc;

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use browser::Browser;

/// The platform services a view uses.
pub trait Host: Send + Sync + 'static {
    /// Sets `run` as coverage, or `None` when the platform cannot.
    fn rasterize(&self, run: &TextRun) -> Option<Raster>;
}

/// A line of text to set.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TextRun {
    /// The text.
    pub text: Arc<str>,
    /// A CSS font family list.
    pub font: Arc<str>,
    /// The size in physical pixels.
    pub size_px: u32,
}

/// Text set as coverage: one byte per physical pixel, rows top to bottom.
#[derive(Clone, PartialEq, Debug)]
pub struct Raster {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// `size[0] * size[1]` coverage bytes.
    pub coverage: Vec<u8>,
    /// Pixels from the top to the baseline.
    pub baseline: f32,
}
