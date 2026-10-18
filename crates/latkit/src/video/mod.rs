//! Videos: a shot's pictures over time, handed in order to a [`Sink`] while they are drawn. Three
//! stages overlap, so throughput is the slowest of them rather than their sum: the GPU draws and
//! composes one frame while another is read back and the sink takes a third. A frame where nothing
//! moved is neither drawn nor read back: the sink is told it is held, and shows the frame before.
//!
//! [`Mp4`] is the sink most videos take: H.264 from the host's
//! [`Encoder`](crate::host::Encoder), written as fragmented MP4.

mod mp4;

use std::collections::VecDeque;
use std::future::Future;
use std::io::Write;

use mp4::Muxer;
#[cfg(all(feature = "native", windows))]
pub(crate) use mp4::nals;

use crate::gpu::readback::Readback;
use crate::host::{Encoder, Host, TIMESCALE, Unit};
use crate::shot::{Borrowed, Drawing, Step, Views};
use crate::{Error, Gpu, Result, Shot, View};

/// Frames drawn and not yet taken at once: one drawing, one reading back, one in the sink.
const IN_FLIGHT: usize = 3;
/// Seconds of video between keyframes at most.
const KEYFRAMES: f64 = 2.0;
/// Bits a pixel of a frame takes by default: sharp lines and text stay sharp.
const BITS_PER_PIXEL: f64 = 0.15;

/// The bytes a picture is composed into.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pixels {
    /// RGBA rows, top to bottom, four bytes a pixel with straight alpha: an [`Image`](crate::Image)'s.
    Rgba,
    /// NV12: a plane of luma, then one of Cb and Cr interleaved at half the resolution, BT.709 in
    /// limited range. The picture's width is a multiple of 4 and its height of 2.
    Nv12,
}

/// What a video's frames go to, in order: an [`Mp4`] file, or whatever an application makes of the
/// pixels.
pub trait Sink {
    /// The bytes it takes.
    const PIXELS: Pixels;

    /// Readies it for the video `encoding` describes, before the first frame, with the services of
    /// the GPU's `host`: an MP4 asks it for an encoder.
    fn begin(&mut self, encoding: &Encoding, host: Option<&dyn Host>) -> Result<()> {
        let _ = (encoding, host);
        Ok(())
    }

    /// Takes frame `index`: its pixels, or `None` where nothing moved since the frame before, which it
    /// shows again. Resolves once there is room for another.
    fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = Result<()>>;

    /// Ends the video before frame `end`, every frame before it taken.
    fn finish(&mut self, end: u64) -> impl Future<Output = Result<()>>;
}

/// A video: its pictures' size in pixels, frames a second, and the bits a second an encoder spends.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Encoding {
    /// Width and height in pixels.
    pub size: [u32; 2],
    /// Frames a second.
    pub fps: f64,
    /// Bits a second.
    pub bitrate: u32,
}

impl Encoding {
    /// A video of `size` at `fps`, at about 0.15 bits a pixel a frame.
    pub fn new(size: [u32; 2], fps: f64) -> Encoding {
        let bits = f64::from(size[0]) * f64::from(size[1]) * fps * BITS_PER_PIXEL;
        Encoding { size, fps, bitrate: bits.clamp(1e5, 4e8) as u32 }
    }

    /// The frame rate as a ratio of whole numbers, as containers write it: 30000/1001 for 29.97.
    pub fn rate(&self) -> [u32; 2] {
        for den in [1_u32, 1001, 1000] {
            let num = (self.fps * f64::from(den)).round();
            if (num / f64::from(den) - self.fps).abs() < 1e-6 * self.fps {
                return [num as u32, den];
            }
        }
        [(self.fps * 1000.0).round() as u32, 1000]
    }
}

/// A [`Sink`] encoding H.264 with the host's encoder and writing it to `out` as fragmented MP4 while
/// frames are drawn. A frame lasts until the next one shows, so held frames cost nothing.
///
/// ```no_run
/// # async fn example(gpu: &latkit::Gpu, map: &mut latkit::View, plot: &mut latkit::View) -> latkit::Result<()> {
/// use latkit::{Mp4, Shot};
/// let shot = Shot::new([1920, 1080]).scale(1.5).panels([[0.0, 0.0, 1.0, 0.7], [0.0, 0.7, 1.0, 0.3]]);
/// let file = std::fs::File::create("film.mp4").expect("a file");
/// let mut video = shot.video(gpu, 60.0, Mp4::new(file))?;
/// while video.time() < 24.0 {
///     let at = video.time() * 3600.0; // a day in 24 seconds
///     map.set_at(at);
///     plot.set_at(at);
///     video.frame(&mut [map, plot]).await?;
/// }
/// video.finish().await?;
/// # Ok(()) }
/// ```
pub struct Mp4<W: Write> {
    out: W,
    bitrate: Option<u32>,
    /// The encoder, the muxer, and the frame rate, once the video began.
    began: Option<(Box<dyn Encoder>, Muxer, f64)>,
    /// When the last keyframe shows, in ticks.
    keyed: Option<u64>,
}

impl<W: Write> Mp4<W> {
    /// An MP4 written to `out`, at about 0.15 bits a pixel a frame.
    pub fn new(out: W) -> Mp4<W> {
        Mp4 { out, bitrate: None, began: None, keyed: None }
    }

    /// Encodes at `bitrate` bits a second.
    #[must_use]
    pub fn bitrate(mut self, bitrate: u32) -> Mp4<W> {
        self.bitrate = Some(bitrate);
        self
    }

    /// What it was written to.
    pub fn into_inner(self) -> W {
        self.out
    }

    fn write(&mut self, units: Vec<Unit>) -> Result<()> {
        let Some((_, muxer, _)) = &mut self.began else { return Ok(()) };
        for unit in units {
            let bytes = muxer.push(&unit).map_err(|reason| Error::Unsupported(reason.into()))?;
            self.out.write_all(&bytes).map_err(|e| written(&e))?;
        }
        Ok(())
    }
}

impl<W: Write> Sink for Mp4<W> {
    const PIXELS: Pixels = Pixels::Nv12;

    fn begin(&mut self, encoding: &Encoding, host: Option<&dyn Host>) -> Result<()> {
        let mut encoding = *encoding;
        if let Some(bitrate) = self.bitrate {
            if bitrate == 0 {
                return Err(Error::invalid("an MP4 takes a positive bitrate").at("bitrate"));
            }
            encoding.bitrate = bitrate;
        }
        let host = host.ok_or_else(|| Error::Unsupported("an MP4 is encoded by the Gpu's host; it has none".into()))?;
        self.began = Some((host.encoder(&encoding)?, Muxer::new(encoding.size, TIMESCALE), encoding.fps));
        Ok(())
    }

    async fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> Result<()> {
        let Some(nv12) = pixels else { return Ok(()) };
        let (encoder, _, fps) = self.began.as_mut().ok_or_else(|| Error::invalid("an MP4 begins before its frames"))?;
        let time = ticks(index, *fps);
        let key = self.keyed.is_none_or(|keyed| time - keyed >= (KEYFRAMES * f64::from(TIMESCALE)) as u64);
        if key {
            self.keyed = Some(time);
        }
        let units = encoder.encode(nv12, time, key).await?;
        self.write(units)
    }

    async fn finish(&mut self, end: u64) -> Result<()> {
        let (encoder, _, _) = self.began.as_mut().ok_or_else(|| Error::invalid("an MP4 begins before it ends"))?;
        let units = encoder.finish().await?;
        self.write(units)?;
        let (_, muxer, fps) = self.began.as_mut().expect("begun");
        let last = muxer.finish(ticks(end.max(1), *fps));
        self.out.write_all(&last).map_err(|e| written(&e))?;
        self.out.flush().map_err(|e| written(&e))
    }
}

/// A video of a shot's pictures, handed to its sink while they are drawn.
pub struct Video<S: Sink> {
    drawing: Drawing,
    sink: S,
    fps: f64,
    /// The next frame.
    index: u64,
    /// Frames drawn or held and not yet taken, oldest first: a held frame has nothing to read back.
    flight: VecDeque<(u64, Option<Readback>)>,
    /// Whether a frame was drawn: after one, a frame where nothing moved is held instead.
    drawn: bool,
}

impl Shot {
    /// A video of this shot's pictures at `fps` frames a second, each frame handed to `sink`.
    pub fn video<S: Sink>(&self, gpu: &Gpu, fps: f64, mut sink: S) -> Result<Video<S>> {
        if !(fps.is_finite() && (1.0..=240.0).contains(&fps)) {
            return Err(Error::invalid("a video shows 1 to 240 frames a second").at("fps"));
        }
        self.check(S::PIXELS)?;
        let host = gpu.0.lock().host.clone();
        sink.begin(&Encoding::new(self.size(), fps), host.as_deref())?;
        Ok(Video {
            drawing: Drawing::later(self.clone(), S::PIXELS),
            sink,
            fps,
            index: 0,
            flight: VecDeque::with_capacity(IN_FLIGHT * 2),
            drawn: false,
        })
    }
}

impl<S: Sink> Video<S> {
    /// Seconds into the video the next frame shows at.
    pub fn time(&self) -> f64 {
        self.index as f64 / self.fps
    }

    /// Frames drawn or held so far.
    pub fn frames(&self) -> u64 {
        self.index
    }

    /// Draws the next frame of `views`, one per panel, at its time once they are complete, and hands
    /// it on to the sink. It returns once there is room for another frame, not once the sink took
    /// this one. A frame where nothing moved is not drawn: the sink shows the one before again.
    pub async fn frame(&mut self, views: &mut [&mut View]) -> Result<()> {
        self.frame_of(&mut Borrowed(views)).await
    }

    /// Draws the next frame of the views `views` lends.
    pub(crate) async fn frame_of(&mut self, views: &mut impl Views) -> Result<()> {
        let held = self.drawn && !views.lend(|views| views.iter().any(|v| v.needs_render()));
        if held {
            self.flight.push_back((self.index, None));
        } else {
            while self.flight.iter().filter(|(_, readback)| readback.is_some()).count() >= IN_FLIGHT {
                self.hand_on().await?;
            }
            let time = self.time();
            views.lend(|views| self.drawing.begin(views))?;
            let readback = loop {
                match views.lend(|views| self.drawing.step(views, time, false))? {
                    Step::Done(readback) => break readback,
                    Step::Easing => {}
                    Step::Waiting => self.drawing.wait().await,
                }
            };
            self.flight.push_back((self.index, Some(readback)));
            self.drawn = true;
        }
        self.index += 1;
        // Held frames first in line wait on nothing.
        while matches!(self.flight.front(), Some((_, None))) {
            self.hand_on().await?;
        }
        Ok(())
    }

    /// Hands every frame under way to the sink, ends the video at the next frame's time, and gives
    /// the sink back.
    pub async fn finish(mut self) -> Result<S> {
        while !self.flight.is_empty() {
            self.hand_on().await?;
        }
        self.sink.finish(self.index).await?;
        Ok(self.sink)
    }

    /// Reads the oldest frame back, when it was drawn, and hands it to the sink.
    async fn hand_on(&mut self) -> Result<()> {
        let Some((index, readback)) = self.flight.pop_front() else { return Ok(()) };
        let pixels = match readback {
            Some(readback) => Some(self.drawing.read(&readback).await?),
            None => None,
        };
        self.sink.frame(index, pixels).await
    }
}

/// Frame `index`'s time in ticks at `fps`, rounded from its exact time, so durations never drift.
fn ticks(index: u64, fps: f64) -> u64 {
    (index as f64 * f64::from(TIMESCALE) / fps).round() as u64
}

fn written(error: &std::io::Error) -> Error {
    Error::Load(format!("a video could not be written: {error}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rates_are_ratios() {
        let rate = |fps| Encoding::new([16, 16], fps).rate();
        assert_eq!(rate(60.0), [60, 1]);
        assert_eq!(rate(30_000.0 / 1001.0), [30_000, 1001]);
        assert_eq!(rate(12.5), [12_500, 1000]);
    }
}
