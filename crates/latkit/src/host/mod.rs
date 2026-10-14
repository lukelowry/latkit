//! What the platform does for latkit: set and measure text in its fonts, and do jobs off the frame.
//! A [`Gpu`](crate::Gpu) is given its host with [`Gpu::set_host`](crate::Gpu::set_host); without one,
//! views draw no text and do their jobs at once.

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod browser;
mod job;

use std::sync::Arc;

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use browser::Browser;
pub use job::Job;
pub(crate) use job::{Key, Placement, Wiring};

use crate::Pending;

/// The platform services a view uses.
pub trait Host: Send + Sync + 'static {
    /// Sets `run` as coverage, or `None` when the platform cannot.
    fn rasterize(&self, run: &TextRun) -> Option<Raster>;

    /// The width and height `run` takes once set, in pixels; by default what setting it takes.
    fn measure(&self, run: &TextRun) -> Option<[f32; 2]> {
        self.rasterize(run).map(|raster| raster.size.map(|v| v as f32))
    }

    /// Does `job` off the frame, resolving to what [`Job::run`] answers; by default at once, on the
    /// calling thread.
    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        Pending::ready(Ok(job.run()))
    }
}

/// A line of text to set.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TextRun {
    /// The text.
    pub text: Arc<str>,
    /// A CSS font family list.
    pub font: Arc<str>,
    /// The size in pixels.
    pub size_px: u32,
    /// Pixels a line runs to before it wraps at a space; `None` keeps one line.
    pub max_width: Option<u32>,
}

/// Text set as coverage: one byte per pixel, rows top to bottom.
#[derive(Clone, PartialEq, Debug)]
pub struct Raster {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// `size[0] * size[1]` coverage bytes.
    pub coverage: Vec<u8>,
    /// Pixels from the top to the baseline.
    pub baseline: f32,
}
