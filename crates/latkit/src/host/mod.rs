//! What the platform does for latkit: set and measure text in its fonts, do jobs off the frame, fetch
//! bytes, and encode video. A [`Gpu`](crate::Gpu) is given its host with
//! [`Gpu::set_host`](crate::Gpu::set_host); without one, views draw no text, do their jobs at once,
//! fetch nothing, and encode no video. A browser's host is [`Browser`], with the `web` feature.

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod browser;
mod job;

use std::ops::Range;
use std::sync::Arc;

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use browser::Browser;
pub use job::Job;
pub(crate) use job::{Key, Placement, Shaping, Wiring};

use crate::video::{Encoder, Encoding};
use crate::{Error, Pending};

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

    /// Fetches `request`, resolving to its bytes; to no bytes where there is nothing at its URL, and
    /// to an error where it cannot be read. By default a host fetches nothing.
    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        let _ = request;
        Pending::ready(Err(Error::Unsupported("this host does not fetch".into())))
    }

    /// An H.264 encoder for pictures as `encoding` says, hardware where the platform has one: what a
    /// [`Video`](crate::Video) encodes with. By default a host encodes no video.
    fn encoder(&self, encoding: &Encoding) -> crate::Result<Box<dyn Encoder>> {
        let _ = encoding;
        Err(Error::Unsupported("this host encodes no video".into()))
    }
}

/// Bytes to fetch: a URL, and the range of its bytes, or all of them.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Request {
    /// The URL.
    pub url: Arc<str>,
    /// Bytes `start..end`; `None` fetches every byte.
    pub range: Option<Range<u64>>,
}

impl Request {
    /// Every byte at `url`.
    pub fn new(url: impl Into<Arc<str>>) -> Request {
        Request { url: url.into(), range: None }
    }

    /// Bytes `range` at `url`.
    pub fn range(url: impl Into<Arc<str>>, range: Range<u64>) -> Request {
        Request { url: url.into(), range: Some(range) }
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
