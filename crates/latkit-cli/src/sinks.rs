//! Where pictures go: one output written whole or not at all, and the sinks a video's frames go to
//! besides the library's MP4: a PNG, a PNG a frame, raw RGBA, and YUV4MPEG2.

use std::collections::VecDeque;
use std::fs::File;
use std::future::{Future, ready};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use latkit::host::{Host, Job, Native};
use latkit::{Encoding, Error, Image, Mp4, Pending, Pixels, Sink};

use crate::Failure;
use crate::args::{is_stdio, pattern};

/// PNG frames encoding at once, on the host's workers.
const ENCODING: usize = 4;

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

    /// Writes `bytes`, naming the destination in its error.
    fn put(&mut self, bytes: &[u8]) -> latkit::Result<()> {
        self.write_all(bytes).map_err(|e| written(&e, self.path()))
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

    fn begin(&mut self, encoding: &Encoding, _: Option<&dyn Host>) -> latkit::Result<()> {
        self.size = encoding.size;
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

/// A PNG a frame, its path the pattern's with the frame's index. Frames encode as jobs on the
/// host's workers, a few at once, and their files are written whole, in order; a held frame's file
/// is the frame before's.
pub(crate) struct Pngs {
    pattern: PathBuf,
    host: Native,
    size: [u32; 2],
    /// Frames under way, oldest first: each file's path, and a drawn frame's PNG.
    writing: VecDeque<(PathBuf, Option<Pending<Vec<u8>>>)>,
    /// The last drawn frame's PNG.
    last: Vec<u8>,
}

impl Pngs {
    pub(crate) fn new(pattern: PathBuf, host: Native) -> Pngs {
        Pngs { pattern, host, size: [0, 0], writing: VecDeque::new(), last: Vec::new() }
    }

    /// The path of frame `index`.
    fn path(&self, index: u64) -> PathBuf {
        let text = self.pattern.to_string_lossy();
        let (range, width) = pattern(&self.pattern).expect("a pattern");
        format!("{}{index:0width$}{}", &text[..range.start], &text[range.end..]).into()
    }

    /// Writes the oldest frame's file once its PNG is encoded.
    async fn write_oldest(&mut self) -> latkit::Result<()> {
        let Some((path, png)) = self.writing.pop_front() else { return Ok(()) };
        if let Some(png) = png {
            self.last = png.await?;
        }
        let mut out = Output::create(&path).map_err(|f| f.error)?;
        out.put(&self.last)?;
        out.commit().map_err(|f| f.error)
    }
}

impl Sink for Pngs {
    const PIXELS: Pixels = Pixels::Rgba;

    fn begin(&mut self, encoding: &Encoding, _: Option<&dyn Host>) -> latkit::Result<()> {
        self.size = encoding.size;
        Ok(())
    }

    async fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> latkit::Result<()> {
        let png = match pixels {
            Some(rgba) => Some(self.host.spawn(Job::png(&Image::new(self.size, rgba)?))),
            None => None,
        };
        self.writing.push_back((self.path(index), png));
        while self.writing.len() > ENCODING {
            self.write_oldest().await?;
        }
        Ok(())
    }

    async fn finish(&mut self, _: u64) -> latkit::Result<()> {
        while !self.writing.is_empty() {
            self.write_oldest().await?;
        }
        Ok(())
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
        ready(self.out.put(&self.last))
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        ready(self.out.flush().map_err(|e| written(&e, self.out.path())))
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

    fn begin(&mut self, encoding: &Encoding, _: Option<&dyn Host>) -> latkit::Result<()> {
        self.size = encoding.size;
        let ([width, height], [num, den]) = (encoding.size, encoding.rate());
        // The GPU averages each 2×2 block's chroma: centered, as JPEG sites it.
        let header = format!("YUV4MPEG2 W{width} H{height} F{num}:{den} Ip A1:1 C420jpeg XCOLORRANGE=LIMITED\n");
        self.out.put(header.as_bytes())
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
        ready(self.out.put(&self.last))
    }

    fn finish(&mut self, _: u64) -> impl Future<Output = latkit::Result<()>> {
        ready(self.out.flush().map_err(|e| written(&e, self.out.path())))
    }
}

impl Commit for Y4m {
    fn commit(self) -> Result<(), Failure> {
        self.out.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_number_files() {
        let pngs = Pngs::new(PathBuf::from("out/frame-%04d.png"), Native::new());
        assert_eq!(pngs.path(7), PathBuf::from("out/frame-0007.png"));
        let pngs = Pngs::new(PathBuf::from("%d.png"), Native::new());
        assert_eq!(pngs.path(12), PathBuf::from("12.png"));
    }
}
