//! Videos: a shot's pictures over time, encoded as H.264 by the host and written as MP4 while they
//! are drawn. Three stages overlap, so throughput is the slowest of them rather than their sum: the
//! GPU draws and composes one frame while another is read back and a third encodes. A frame where
//! nothing moved is neither drawn nor encoded; the frame before lasts until the next one's time.
//!
//! The host encodes behind one seam, [`Encoder`]: NV12 pictures in, Annex B units out. A browser's is
//! WebCodecs, on the GPU's video engine where the device has one.

mod mp4;

use std::collections::VecDeque;
use std::io::Write;

use mp4::Mp4;

use crate::gpu::readback::Readback;
use crate::shot::{Borrowed, Bytes, Drawing, Step, Views};
use crate::{Error, Gpu, Pending, Result, Shot, View};

/// Ticks of a second a video's times count.
pub const TIMESCALE: u32 = 90_000;
/// Frames under way at once: one drawing, one reading back, one encoding.
const IN_FLIGHT: usize = 3;
/// Seconds of video between keyframes at most.
const KEYFRAMES: f64 = 2.0;
/// Bits a pixel of a frame takes by default: sharp lines and text stay sharp.
const BITS_PER_PIXEL: f64 = 0.15;

/// What a video encodes: its size in pixels (width a multiple of 4, height of 2), frames a second,
/// and bits a second.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Encoding {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// Frames a second.
    pub fps: f64,
    /// Bits a second.
    pub bitrate: u32,
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

/// A platform's H.264 encoder: NV12 pictures (BT.709, limited range) in, Annex B units out, no
/// B-frames, so every platform's encoder fits and the muxer never reorders.
pub trait Encoder {
    /// Encodes one NV12 picture at `time` ticks, a keyframe when `key`; resolves, once it has room
    /// for another picture, to the units it finished since the last call, in order.
    fn encode(&mut self, nv12: &[u8], time: u64, key: bool) -> Pending<Vec<Unit>>;

    /// Resolves to the units it still holds once every picture given is encoded.
    fn finish(&mut self) -> Pending<Vec<Unit>>;
}

impl Encoding {
    /// An encoding of pictures of `size` at `fps`, at about 0.15 bits a pixel a frame.
    pub fn new(size: [u32; 2], fps: f64) -> Encoding {
        let bits = f64::from(size[0]) * f64::from(size[1]) * fps * BITS_PER_PIXEL;
        Encoding { size, fps, bitrate: bits.clamp(1e5, 4e8) as u32 }
    }
}

/// A video of a shot's pictures, written to `out` as MP4 while they are drawn.
///
/// ```no_run
/// # async fn example(gpu: &latkit::Gpu, map: &mut latkit::View, plot: &mut latkit::View) -> latkit::Result<()> {
/// use latkit::Shot;
/// let shot = Shot::new([1920, 1080]).scale(1.5).panel([0.0, 0.0, 1.0, 0.7]).panel([0.0, 0.7, 1.0, 0.3]);
/// let mut video = shot.video(gpu, 60.0, std::fs::File::create("film.mp4").expect("a file"))?;
/// while video.time() < 24.0 {
///     let at = video.time() * 3600.0; // a day in 24 seconds
///     map.set_at(at);
///     plot.set_at(at);
///     video.frame(&mut [map, plot]).await?;
/// }
/// video.finish().await?;
/// # Ok(()) }
/// ```
pub struct Video<W: Write> {
    drawing: Drawing,
    encoder: Box<dyn Encoder>,
    mp4: Mp4,
    out: W,
    fps: f64,
    /// The next frame.
    index: u64,
    /// Frames drawn and not yet encoded, oldest first.
    flight: VecDeque<(u64, Readback)>,
    /// When the last keyframe shows, in ticks.
    keyed: Option<u64>,
    /// Whether a frame was drawn: after one, a frame where nothing moved is held instead.
    drawn: bool,
}

impl Shot {
    /// A video of this shot's pictures at `fps` frames a second, encoded by `gpu`'s host and written
    /// to `out` as MP4, at about 0.15 bits a pixel a frame.
    pub fn video<W: Write>(&self, gpu: &Gpu, fps: f64, out: W) -> Result<Video<W>> {
        self.video_at(gpu, Encoding::new(self.size(), fps), out)
    }

    /// A video of this shot's pictures encoded as `encoding` says, its size the shot's.
    pub fn video_at<W: Write>(&self, gpu: &Gpu, encoding: Encoding, out: W) -> Result<Video<W>> {
        if !(encoding.fps.is_finite() && (1.0..=240.0).contains(&encoding.fps)) {
            return Err(Error::invalid("a video shows 1 to 240 frames a second").at("fps"));
        }
        let [width, height] = self.size();
        if width % 4 != 0 || height % 2 != 0 {
            let reason = format!("a video's width is a multiple of 4 and its height of 2, not {width}×{height}");
            return Err(Error::invalid(reason).at("size"));
        }
        let encoding = Encoding { size: self.size(), ..encoding };
        let host = gpu.0.lock().host.clone();
        let host =
            host.ok_or_else(|| Error::Unsupported("a video is encoded by the Gpu's host; it has none".into()))?;
        let encoder = host.encoder(&encoding)?;
        Ok(Video {
            drawing: Drawing::later(self.clone(), Bytes::Nv12),
            encoder,
            mp4: Mp4::new(encoding.size, TIMESCALE),
            out,
            fps: encoding.fps,
            index: 0,
            flight: VecDeque::with_capacity(IN_FLIGHT),
            keyed: None,
            drawn: false,
        })
    }
}

impl<W: Write> Video<W> {
    /// Seconds into the video the next frame shows at.
    pub fn time(&self) -> f64 {
        self.index as f64 / self.fps
    }

    /// Frames drawn or held so far.
    pub fn frames(&self) -> u64 {
        self.index
    }

    /// Draws the next frame of `views`, one per panel, at its time once they are complete, and hands
    /// it on to be encoded. It returns once there is room for another frame, not once this one is
    /// encoded. A frame where nothing moved is not drawn: the one before lasts longer.
    pub async fn frame(&mut self, views: &mut [&mut View]) -> Result<()> {
        self.frame_of(&mut Borrowed(views)).await
    }

    /// Draws the next frame of the views `views` lends.
    pub(crate) async fn frame_of(&mut self, views: &mut impl Views) -> Result<()> {
        let held = self.drawn && !views.lend(|views| views.iter().any(|v| v.needs_render()));
        if !held {
            while self.flight.len() >= IN_FLIGHT {
                self.encode_oldest().await?;
            }
            let time = self.time();
            views.lend(|views| self.drawing.begin(views))?;
            let readback = loop {
                match views.lend(|views| self.drawing.step(views, time, false))? {
                    Step::Done(readback) => break readback,
                    Step::Easing | Step::Waiting => self.drawing.wait().await,
                }
            };
            self.flight.push_back((self.index, readback));
            self.drawn = true;
        }
        self.index += 1;
        Ok(())
    }

    /// Encodes every frame under way, ends the video at the next frame's time, and gives back what it
    /// was written to.
    pub async fn finish(mut self) -> Result<W> {
        while !self.flight.is_empty() {
            self.encode_oldest().await?;
        }
        let units = self.encoder.finish().await?;
        self.write(units)?;
        let end = self.ticks(self.index.max(1));
        let last = self.mp4.finish(end);
        self.out.write_all(&last).map_err(|e| written(&e))?;
        self.out.flush().map_err(|e| written(&e))?;
        Ok(self.out)
    }

    /// Reads the oldest frame back and has it encoded, writing what the encoder finished.
    async fn encode_oldest(&mut self) -> Result<()> {
        let Some((index, readback)) = self.flight.pop_front() else { return Ok(()) };
        let nv12 = self.drawing.read(&readback).await?;
        drop(readback);
        let time = self.ticks(index);
        let key = self.keyed.is_none_or(|keyed| time - keyed >= ticks_of(KEYFRAMES));
        if key {
            self.keyed = Some(time);
        }
        let units = self.encoder.encode(&nv12, time, key).await?;
        self.write(units)
    }

    fn write(&mut self, units: Vec<Unit>) -> Result<()> {
        for unit in units {
            let bytes = self.mp4.push(&unit).map_err(|reason| Error::Unsupported(reason.into()))?;
            self.out.write_all(&bytes).map_err(|e| written(&e))?;
        }
        Ok(())
    }

    /// Frame `index`'s time in ticks, rounded from its exact time, so durations never drift.
    fn ticks(&self, index: u64) -> u64 {
        (index as f64 * f64::from(TIMESCALE) / self.fps).round() as u64
    }
}

/// `seconds` in ticks.
fn ticks_of(seconds: f64) -> u64 {
    (seconds * f64::from(TIMESCALE)).round() as u64
}

fn written(error: &std::io::Error) -> Error {
    Error::Load(format!("a video could not be written: {error}").into())
}
