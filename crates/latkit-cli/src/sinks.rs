//! Where pictures go: one output written whole or not at all, and the sinks a video's frames go to
//! besides the library's MP4: a PNG, a PNG a frame, raw RGBA, and YUV4MPEG2. Overlays are drawn over
//! frames on their way to any of them, decoded a frame ahead on a thread of their own.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs::File;
use std::future::{Future, ready};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::Duration;

use latkit::{Error, Gpu, Image, Mp4, Pixels, Sink};

use crate::Failure;
use crate::args::{is_stdio, pattern};

/// The longest a frame waits for its overlay to decode.
const DECODE: Duration = Duration::from_secs(30);
/// PNG frames waiting to be written at most.
const QUEUED: usize = 2;

fn written(error: &io::Error, path: &Path) -> Error {
    Error::Load(format!("{}: {error}", path.display()).into())
}

/// Bytes to stdout, or to a file that replaces `path` only once every byte is written.
pub(crate) enum Output {
    Stdout(BufWriter<io::Stdout>),
    File { path: PathBuf, file: BufWriter<File>, temporary: tempfile::TempPath },
}

impl Output {
    /// An output to `path`, or stdout for `-`.
    pub(crate) fn create(path: &Path) -> Result<Output, Failure> {
        if is_stdio(path) {
            return Ok(Output::Stdout(BufWriter::new(io::stdout())));
        }
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let suffix = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let temporary =
            tempfile::Builder::new().suffix(&suffix).tempfile_in(parent).map_err(|e| Failure::io(&e, path))?;
        let (file, temporary) = temporary.into_parts();
        Ok(Output::File { path: path.to_path_buf(), file: BufWriter::new(file), temporary })
    }

    /// Writes what is left and, for a file, replaces its destination.
    pub(crate) fn commit(self) -> Result<(), Failure> {
        match self {
            Output::Stdout(mut out) => out.flush().map_err(|e| Failure::io(&e, Path::new("-"))),
            Output::File { path, file, temporary } => {
                drop(file.into_inner().map_err(|e| Failure::io(e.error(), &path))?);
                temporary.persist(&path).map_err(|e| Failure::io(&e.error, &path))
            }
        }
    }

    fn path(&self) -> &Path {
        match self {
            Output::Stdout(_) => Path::new("-"),
            Output::File { path, .. } => path,
        }
    }
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Output::Stdout(out) => out.write(bytes),
            Output::File { file, .. } => file.write(bytes),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Output::Stdout(out) => out.flush(),
            Output::File { file, .. } => file.flush(),
        }
    }
}

/// What a sink leaves once its video is finished: its output, written and in place.
pub(crate) trait Commit {
    fn commit(self) -> Result<(), Failure>;
}

impl Commit for Mp4<Output> {
    fn commit(self) -> Result<(), Failure> {
        self.into_inner().commit()
    }
}

/// One PNG, of a video of one frame.
pub(crate) struct Png {
    out: Output,
    size: [u32; 2],
    image: Option<Image>,
}

impl Png {
    pub(crate) fn new(out: Output) -> Png {
        Png { out, size: [0, 0], image: None }
    }
}

impl Sink for Png {
    const PIXELS: Pixels = Pixels::Rgba;

    fn begin(&mut self, _: &Gpu, size: [u32; 2], _: f64) -> latkit::Result<()> {
        self.size = size;
        Ok(())
    }

    fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = latkit::Result<()>> {
        ready(match (index, pixels) {
            (0, Some(rgba)) => Image::new(self.size, rgba).map(|image| self.image = Some(image)),
            _ => Err(Error::invalid("a PNG is one frame; a %d pattern in the output writes one a frame")),
        })
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        ready(match &self.image {
            Some(image) => image.write_png(&mut self.out),
            None => Err(Error::invalid("the frames are empty")),
        })
    }
}

impl Commit for Png {
    fn commit(self) -> Result<(), Failure> {
        self.out.commit()
    }
}

/// A PNG a frame, its path the pattern's with the frame's index; each file is written whole on a
/// thread of its own, a held frame's bytes the frame before's.
pub(crate) struct Pngs {
    pattern: PathBuf,
    size: [u32; 2],
    last: Option<Arc<Image>>,
    work: Option<SyncSender<(PathBuf, Arc<Image>)>>,
    writer: Option<JoinHandle<latkit::Result<()>>>,
}

impl Pngs {
    pub(crate) fn new(pattern: PathBuf) -> Pngs {
        let (work, files) = mpsc::sync_channel::<(PathBuf, Arc<Image>)>(QUEUED);
        let writer = std::thread::spawn(move || {
            let mut encoded: Option<(Arc<Image>, Vec<u8>)> = None;
            for (path, image) in files {
                let bytes = match &encoded {
                    Some((last, bytes)) if Arc::ptr_eq(last, &image) => bytes.clone(),
                    _ => image.png(),
                };
                let mut out = Output::create(&path).map_err(|f| f.error)?;
                out.write_all(&bytes).map_err(|e| written(&e, &path))?;
                out.commit().map_err(|f| f.error)?;
                encoded = Some((image, bytes));
            }
            Ok(())
        });
        Pngs { pattern, size: [0, 0], last: None, work: Some(work), writer: Some(writer) }
    }

    /// The path of frame `index`.
    fn path(&self, index: u64) -> PathBuf {
        let text = self.pattern.to_string_lossy();
        let (range, width) = pattern(&self.pattern).expect("a pattern");
        format!("{}{index:0width$}{}", &text[..range.start], &text[range.end..]).into()
    }

    /// Stops the writer, with why it stopped early.
    fn stop(&mut self) -> latkit::Result<()> {
        drop(self.work.take());
        match self.writer.take().map(JoinHandle::join) {
            Some(Ok(result)) => result,
            Some(Err(_)) => Err(Error::Load("the PNG writer panicked".into())),
            None => Ok(()),
        }
    }
}

impl Sink for Pngs {
    const PIXELS: Pixels = Pixels::Rgba;

    fn begin(&mut self, _: &Gpu, size: [u32; 2], _: f64) -> latkit::Result<()> {
        self.size = size;
        Ok(())
    }

    fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = latkit::Result<()>> {
        let result = (|| {
            let image = match pixels {
                Some(rgba) => Arc::new(Image::new(self.size, rgba)?),
                None => self.last.clone().ok_or_else(|| Error::invalid("a held frame follows a drawn one"))?,
            };
            let path = self.path(index);
            let sent = self.work.as_ref().is_some_and(|work| work.send((path, image.clone())).is_ok());
            if !sent {
                return self.stop().and(Err(Error::Load("the PNG writer stopped".into())));
            }
            self.last = Some(image);
            Ok(())
        })();
        ready(result)
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        ready(self.stop())
    }
}

impl Commit for Pngs {
    fn commit(self) -> Result<(), Failure> {
        Ok(())
    }
}

/// Raw RGBA, straight alpha, frames back to back; a held frame is the frame before again.
pub(crate) struct Raw {
    out: Output,
    last: Vec<u8>,
}

impl Raw {
    pub(crate) fn new(out: Output) -> Raw {
        Raw { out, last: Vec::new() }
    }
}

impl Sink for Raw {
    const PIXELS: Pixels = Pixels::Rgba;

    fn frame(&mut self, _: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = latkit::Result<()>> {
        if let Some(rgba) = pixels {
            self.last = rgba;
        }
        let path = self.out.path().to_path_buf();
        ready(self.out.write_all(&self.last).map_err(|e| written(&e, &path)))
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        let path = self.out.path().to_path_buf();
        ready(self.out.flush().map_err(|e| written(&e, &path)))
    }
}

impl Commit for Raw {
    fn commit(self) -> Result<(), Failure> {
        self.out.commit()
    }
}

/// YUV4MPEG2: a header, then each frame's planes, 4:2:0 from the GPU's NV12. A held frame is the
/// frame before again.
pub(crate) struct Y4m {
    out: Output,
    size: [u32; 2],
    /// The last frame written, `FRAME` and planes.
    last: Vec<u8>,
}

impl Y4m {
    pub(crate) fn new(out: Output) -> Y4m {
        Y4m { out, size: [0, 0], last: Vec::new() }
    }
}

impl Sink for Y4m {
    const PIXELS: Pixels = Pixels::Nv12;

    fn begin(&mut self, _: &Gpu, size: [u32; 2], fps: f64) -> latkit::Result<()> {
        self.size = size;
        let (num, den) = rational(fps);
        // The GPU averages each 2×2 block's chroma: centered, as JPEG sites it.
        let header = format!("YUV4MPEG2 W{} H{} F{num}:{den} Ip A1:1 C420jpeg XCOLORRANGE=LIMITED\n", size[0], size[1]);
        let path = self.out.path().to_path_buf();
        self.out.write_all(header.as_bytes()).map_err(|e| written(&e, &path))
    }

    fn frame(&mut self, _: u64, pixels: Option<Vec<u8>>) -> impl Future<Output = latkit::Result<()>> {
        if let Some(nv12) = pixels {
            let luma = (self.size[0] * self.size[1]) as usize;
            self.last.clear();
            self.last.extend_from_slice(b"FRAME\n");
            self.last.extend_from_slice(&nv12[..luma]);
            let chroma = &nv12[luma..];
            self.last.extend(chroma.iter().step_by(2));
            self.last.extend(chroma.iter().skip(1).step_by(2));
        }
        let path = self.out.path().to_path_buf();
        ready(self.out.write_all(&self.last).map_err(|e| written(&e, &path)))
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        let path = self.out.path().to_path_buf();
        ready(self.out.flush().map_err(|e| written(&e, &path)))
    }
}

impl Commit for Y4m {
    fn commit(self) -> Result<(), Failure> {
        self.out.commit()
    }
}

/// `fps` as a ratio of whole numbers: 30000/1001 for 29.97.
fn rational(fps: f64) -> (u32, u32) {
    for den in [1_u32, 1001, 1000] {
        let num = (fps * f64::from(den)).round();
        if (num / f64::from(den) - fps).abs() < 1e-6 * fps {
            return (num as u32, den);
        }
    }
    ((fps * 1000.0).round() as u32, 1000)
}

/// Overlays asked for by frame, decoded in order on a thread of their own; one decoded image stands
/// for every frame in a row that names the same file.
pub(crate) struct Overlays {
    asks: Sender<(u64, PathBuf)>,
    answers: Receiver<(u64, latkit::Result<Arc<Image>>)>,
    asked: VecDeque<u64>,
}

impl Overlays {
    pub(crate) fn new(size: [u32; 2]) -> Overlays {
        let (asks, wanted) = mpsc::channel::<(u64, PathBuf)>();
        let (answer, answers) = mpsc::channel();
        std::thread::spawn(move || {
            let mut last: Option<(PathBuf, Arc<Image>)> = None;
            for (index, path) in wanted {
                let image = match &last {
                    Some((p, image)) if *p == path => Ok(image.clone()),
                    _ => decode(&path, size).map(Arc::new),
                };
                if let Ok(image) = &image {
                    last = Some((path, image.clone()));
                }
                if answer.send((index, image)).is_err() {
                    break;
                }
            }
        });
        Overlays { asks, answers, asked: VecDeque::new() }
    }

    /// Asks for frame `index`'s overlay at `path`.
    pub(crate) fn ask(&mut self, index: u64, path: PathBuf) {
        if self.asks.send((index, path)).is_ok() {
            self.asked.push_back(index);
        }
    }

    /// Frame `index`'s overlay, once decoded; `None` where it has none.
    fn take(&mut self, index: u64) -> latkit::Result<Option<Arc<Image>>> {
        if self.asked.front() != Some(&index) {
            return Ok(None);
        }
        self.asked.pop_front();
        let (answered, image) = self.answers.recv_timeout(DECODE).map_err(|_| Error::Timeout)?;
        debug_assert_eq!(answered, index, "overlays answer in order");
        image.map(Some)
    }
}

/// The overlay at `path`: a PNG of the picture's `size`.
fn decode(path: &Path, size: [u32; 2]) -> latkit::Result<Image> {
    let bytes = std::fs::read(path).map_err(|e| written(&e, path))?;
    let image = Image::from_png(&bytes).map_err(|e| Error::invalid(format!("{}: {e}", path.display())))?;
    if image.size != size {
        let [w, h] = image.size;
        return Err(Error::invalid(format!("{}: an overlay is the picture's size, not {w}×{h}", path.display())));
    }
    Ok(image)
}

/// A sink whose frames have their overlays drawn over them first. A held frame whose overlay
/// changed is drawn again from the frame before, under its own.
pub(crate) struct Overlaid<S> {
    inner: S,
    overlays: Rc<RefCell<Overlays>>,
    /// The last frame's pixels without their overlay.
    under: Vec<u8>,
    /// The overlay the last frame shows.
    shown: Option<Arc<Image>>,
    size: [u32; 2],
}

impl<S: Sink> Overlaid<S> {
    pub(crate) fn new(inner: S, overlays: Rc<RefCell<Overlays>>) -> Overlaid<S> {
        Overlaid { inner, overlays, under: Vec::new(), shown: None, size: [0, 0] }
    }

    pub(crate) fn into_inner(self) -> S {
        self.inner
    }
}

impl<S: Sink> Sink for Overlaid<S> {
    const PIXELS: Pixels = S::PIXELS;

    fn begin(&mut self, gpu: &Gpu, size: [u32; 2], fps: f64) -> latkit::Result<()> {
        self.size = size;
        self.inner.begin(gpu, size, fps)
    }

    async fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> latkit::Result<()> {
        let overlay = self.overlays.borrow_mut().take(index)?;
        let changed = match (&overlay, &self.shown) {
            (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
            (a, b) => a.is_some() != b.is_some(),
        };
        let pixels = match pixels {
            Some(pixels) => {
                self.under.clone_from(&pixels);
                Some(pixels)
            }
            None if changed => Some(self.under.clone()),
            None => None,
        };
        let pixels = pixels.map(|mut p| {
            if let Some(overlay) = &overlay {
                match S::PIXELS {
                    Pixels::Rgba => over_rgba(&mut p, &overlay.rgba),
                    Pixels::Nv12 => over_nv12(&mut p, &overlay.rgba, self.size),
                }
            }
            p
        });
        self.shown = overlay;
        self.inner.frame(index, pixels).await
    }

    fn finish(&mut self, end: u64) -> impl Future<Output = latkit::Result<()>> {
        self.inner.finish(end)
    }
}

/// Straight-alpha `overlay` over straight-alpha RGBA `rgba`, in sRGB as a canvas draws.
fn over_rgba(rgba: &mut [u8], overlay: &[u8]) {
    for (to, from) in rgba.as_chunks_mut::<4>().0.iter_mut().zip(overlay.as_chunks::<4>().0) {
        let a = u32::from(from[3]);
        if a == 0 {
            continue;
        }
        let b = u32::from(to[3]);
        let alpha = a * 255 + b * (255 - a);
        for i in 0..3 {
            to[i] = ((u32::from(from[i]) * a * 255 + u32::from(to[i]) * b * (255 - a) + alpha / 2) / alpha) as u8;
        }
        to[3] = ((alpha + 127) / 255) as u8;
    }
}

/// Straight-alpha `overlay` over NV12 `nv12` of `size`: luma pixel by pixel, chroma by 2×2 block,
/// BT.709 in limited range as the GPU composes it.
fn over_nv12(nv12: &mut [u8], overlay: &[u8], [width, height]: [u32; 2]) {
    let (w, h) = (width as usize, height as usize);
    let (luma, chroma) = nv12.split_at_mut(w * h);
    let yuv = |p: &[u8; 4]| {
        let [r, g, b] = [p[0], p[1], p[2]].map(|c| f32::from(c) / 255.0);
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        [16.0 + 219.0 * y, 128.0 + 224.0 * (b - y) / 1.8556, 128.0 + 224.0 * (r - y) / 1.5748]
    };
    let pixels = overlay.as_chunks::<4>().0;
    for by in 0..h / 2 {
        for bx in 0..w / 2 {
            let mut weight = 0.0;
            let mut sum = [0.0_f32; 2];
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (x, y) = (bx * 2 + dx, by * 2 + dy);
                let p = &pixels[y * w + x];
                if p[3] == 0 {
                    continue;
                }
                let a = f32::from(p[3]) / 255.0;
                let [py, pu, pv] = yuv(p);
                let l = &mut luma[y * w + x];
                *l = (f32::from(*l) * (1.0 - a) + py * a).round() as u8;
                weight += a;
                sum[0] += pu * a;
                sum[1] += pv * a;
            }
            if weight > 0.0 {
                let at = by * w + bx * 2;
                let mean = weight / 4.0;
                for (c, s) in sum.iter().enumerate() {
                    let old = f32::from(chroma[at + c]);
                    chroma[at + c] = (old * (1.0 - mean) + s / 4.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlays_compose_in_rgba_and_nv12() {
        let mut rgba = vec![0, 0, 255, 255];
        over_rgba(&mut rgba, &[255, 0, 0, 128]);
        assert_eq!(rgba, [128, 0, 127, 255]);
        let mut clear = vec![0; 4];
        over_rgba(&mut clear, &[255, 0, 0, 128]);
        assert_eq!(clear, [255, 0, 0, 128]);
        // Black NV12, 2×2, under opaque white: luma 235, chroma neutral.
        let mut nv12 = vec![16, 16, 16, 16, 128, 128];
        over_nv12(&mut nv12, &[255; 16], [2, 2]);
        assert_eq!(nv12, [235, 235, 235, 235, 128, 128]);
        // Half the block under opaque red: half its chroma red's.
        let mut nv12 = vec![16, 16, 16, 16, 128, 128];
        let red = [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0];
        over_nv12(&mut nv12, &red, [2, 2]);
        assert_eq!(&nv12[..4], [63, 63, 16, 16]);
        assert_eq!(&nv12[4..], [115, 184]);
    }

    #[test]
    fn frame_rates_are_ratios_and_patterns_number_files() {
        assert_eq!(rational(30_000.0 / 1001.0), (30_000, 1001));
        assert_eq!(rational(60.0), (60, 1));
        let pngs = Pngs::new(PathBuf::from("out/frame-%04d.png"));
        assert_eq!(pngs.path(7), PathBuf::from("out/frame-0007.png"));
        let pngs = Pngs::new(PathBuf::from("%d.png"));
        assert_eq!(pngs.path(12), PathBuf::from("12.png"));
    }
}
