//! What the platform does for latkit: set and measure text in its fonts, do jobs off the frame, fetch
//! bytes (tiles, and the files JSON documents name), and encode video with its [`Encoder`]. A
//! [`Gpu`](crate::Gpu) is given its host with [`Gpu::set_host`](crate::Gpu::set_host); without one,
//! views draw no text, do their jobs at once, fetch nothing, and encode no video. A browser's host is
//! `Browser`, built with the `web` feature for `wasm32`. Natively, the `native` feature supplies
//! `Native`: lazy fonts, a worker pool doing jobs and reading files, and Media Foundation's H.264 on
//! Windows, without a window or network client.

#[cfg(all(feature = "web", target_arch = "wasm32"))]
mod browser;
mod job;
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
mod native;
#[cfg(any(test, all(feature = "web", target_arch = "wasm32")))]
mod queue;

use std::sync::Arc;

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use browser::Browser;
pub use job::Job;
pub(crate) use job::Placement;
pub(crate) use job::Wiring;
pub(crate) use job::{Key, Shaping};
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub use native::Native;

use crate::Encoding;
pub use crate::resource::Request;
use crate::{Error, Pending, Result};

/// Ticks of a second an encoder's times count.
pub const TIMESCALE: u32 = 90_000;

/// A platform's H.264 encoder: NV12 pictures (BT.709, limited range) in, Annex B units out, no
/// B-frames, so every platform's encoder fits and the muxer never reorders.
pub trait Encoder {
    /// Encodes one NV12 picture at `time` ticks, a keyframe when `key`; resolves, once it has room
    /// for another picture, to the units it finished since the last call, in order.
    fn encode(&mut self, nv12: Vec<u8>, time: u64, key: bool) -> Pending<Vec<Unit>>;

    /// Resolves to the units it still holds once every picture given is encoded.
    fn finish(&mut self) -> Pending<Vec<Unit>>;
}

/// One encoded access unit of H.264: Annex B bytes, at `time` ticks of [`TIMESCALE`], decode order
/// equal to display order.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Unit {
    /// Ticks at which this frame shows.
    pub time: u64,
    /// Whether it is a keyframe, which carries its parameter sets in band.
    pub key: bool,
    /// Its NAL units, each after a start code.
    pub annex_b: Vec<u8>,
}

/// The platform services a view uses.
pub trait Host: Send + Sync + 'static {
    /// Sets `run` as coverage, reporting unavailable fonts or failed rasterization.
    fn rasterize(&self, run: &TextRun) -> Result<Raster>;

    /// The width and height `run` takes once set, in pixels; by default what setting it takes.
    fn measure(&self, run: &TextRun) -> Result<[f32; 2]> {
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

    /// An H.264 encoder for pictures as `encoding` says, hardware where the platform has one: what an
    /// [`Mp4`](crate::Mp4) encodes with. By default a host encodes no video.
    fn encoder(&self, encoding: &Encoding) -> crate::Result<Box<dyn Encoder>> {
        let _ = encoding;
        Err(Error::Unsupported("this host encodes no video".into()))
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
