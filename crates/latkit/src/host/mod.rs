//! The host: platform services latkit uses. A host rasterizes and measures text in the platform's
//! fonts, runs jobs in the background, fetches bytes (tiles, and files that JSON documents name),
//! and encodes video with an [`Encoder`].
//!
//! A [`Gpu`](crate::Gpu) gets its host from [`Gpu::set_host`](crate::Gpu::set_host). Without one,
//! views draw no text, run jobs immediately, fetch nothing, and encode no video. In a browser the
//! host is `Browser` (the `web` feature on `wasm32`). Natively, the `native` feature supplies
//! `Native`. It loads fonts on first use, runs jobs and reads files on a worker pool, and encodes
//! H.264 with Media Foundation on Windows. It needs no window or network client.

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
pub(crate) use job::{Key, Shaping, shapes_answer};
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub use native::Native;

use crate::Encoding;
pub use crate::resource::Request;
use crate::{Error, Pending, Result};

/// Ticks per second of encoder times.
pub const TIMESCALE: u32 = 90_000;

/// A platform's H.264 encoder: NV12 pictures (BT.709, limited range) in, Annex B units out. It uses
/// no B-frames, so every platform's encoder can comply and the muxer never reorders frames.
pub trait Encoder {
    /// Encodes one NV12 picture at `time` ticks, as a keyframe when `key`. Once the encoder can
    /// take another picture, resolves to the units finished since the last call, in order.
    fn encode(&mut self, nv12: Vec<u8>, time: u64, key: bool) -> Pending<Vec<Unit>>;

    /// Resolves to the remaining units once every picture given has been encoded.
    fn finish(&mut self) -> Pending<Vec<Unit>>;
}

/// One encoded H.264 access unit: Annex B bytes at `time` ticks of [`TIMESCALE`]. Decode order
/// equals display order.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Unit {
    /// Presentation time in ticks of [`TIMESCALE`].
    pub time: u64,
    /// Whether this is a keyframe. Keyframes carry their parameter sets in band.
    pub key: bool,
    /// NAL units, each preceded by a start code.
    pub annex_b: Vec<u8>,
}

/// Platform services for text, background jobs, fetching, and video encoding.
pub trait Host: Send + Sync + 'static {
    /// Rasterizes `run` to a coverage mask. Errors if its font is unavailable or rasterization
    /// fails.
    fn rasterize(&self, run: &TextRun) -> Result<Raster>;

    /// The width and height of `run` once rasterized, in pixels. The default implementation
    /// rasterizes it.
    fn measure(&self, run: &TextRun) -> Result<[f32; 2]> {
        self.rasterize(run).map(|raster| raster.size.map(|v| v as f32))
    }

    /// Runs `job` in the background, resolving to the result of [`Job::run`]. The default
    /// implementation runs it immediately on the calling thread.
    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        Pending::ready(Ok(job.run()))
    }

    /// Fetches `request`, resolving to its bytes. Resolves to no bytes if nothing exists at the
    /// URL, and to an error if it cannot be read. The default implementation fails as unsupported.
    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        let _ = request;
        Pending::ready(Err(Error::Unsupported("this host cannot fetch".into())))
    }

    /// An H.264 encoder for `encoding`, in hardware where the platform has one. [`Mp4`](crate::Mp4)
    /// encodes with it. The default implementation fails as unsupported.
    fn encoder(&self, encoding: &Encoding) -> crate::Result<Box<dyn Encoder>> {
        let _ = encoding;
        Err(Error::Unsupported("this host cannot encode video".into()))
    }
}

/// Text to rasterize: one line, or a paragraph wrapped at `max_width`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TextRun {
    /// The text.
    pub text: Arc<str>,
    /// A CSS font family list.
    pub font: Arc<str>,
    /// Font size in pixels.
    pub size_px: u32,
    /// Width in pixels at which lines wrap at a space. `None` keeps a single line.
    pub max_width: Option<u32>,
}

/// Rasterized text as a coverage mask: one byte per pixel, rows top to bottom.
#[derive(Clone, PartialEq, Debug)]
pub struct Raster {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// `size[0] * size[1]` coverage bytes.
    pub coverage: Vec<u8>,
    /// Pixels from the top to the baseline.
    pub baseline: f32,
}
