//! Output destinations: an output written whole or not at all, and the video sinks besides the
//! library's MP4: image files, raw RGBA, and YUV4MPEG2. An output's errors name it in their message,
//! whoever writes it, since they reach the command through the library's video.

use std::collections::VecDeque;
use std::fs::File;
use std::future::{Future, ready};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use latkit::host::{Host, Job, Native};
use latkit::{Encoding, Error, Image, ImageFormat, Mp4, Pending, Pixels, Sink};

use crate::args::{is_stdio, pattern};

/// The most image files encoding at once on the host's workers.
const ENCODING: usize = 4;

/// `error`, its message naming the output `path`: a file, or stdout for `-`.
fn named(error: &io::Error, path: &Path) -> io::Error {
    let name = if is_stdio(path) { "stdout".to_owned() } else { path.display().to_string() };
    io::Error::new(error.kind(), format!("{name}: {error}"))
}

/// The library's I/O error for failing to write the output `path`.
pub(crate) fn written(error: &io::Error, path: &Path) -> Error {
    Error::Io(named(error, path).to_string().into())
}

/// Bytes to stdout, or to a temporary file that replaces `path` only once every byte is written.
pub(crate) enum Output {
    Stdout(BufWriter<io::Stdout>),
    File { path: PathBuf, file: BufWriter<File>, temporary: tempfile::TempPath },
}

impl Output {
    /// An output to `path`, or stdout for `-`.
    pub(crate) fn create(path: &Path) -> latkit::Result<Output> {
        if is_stdio(path) {
            return Ok(Output::Stdout(BufWriter::new(io::stdout())));
        }
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let suffix = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        let temporary = tempfile::Builder::new().suffix(&suffix).tempfile_in(parent).map_err(|e| written(&e, path))?;
        let (file, temporary) = temporary.into_parts();
        Ok(Output::File { path: path.to_path_buf(), file: BufWriter::new(file), temporary })
    }

    /// Flushes the remaining bytes and, for a file, moves it into place at its destination.
    pub(crate) fn commit(self) -> latkit::Result<()> {
        match self {
            Output::Stdout(mut out) => out.flush().map_err(|e| written(&e, Path::new("-"))),
            Output::File { path, file, temporary } => {
                drop(file.into_inner().map_err(|e| written(e.error(), &path))?);
                temporary.persist(&path).map_err(|e| written(&e.error, &path))
            }
        }
    }

    fn path(&self) -> &Path {
        match self {
            Output::Stdout(_) => Path::new("-"),
            Output::File { path, .. } => path,
        }
    }

    /// Writes `bytes`.
    pub(crate) fn put(&mut self, bytes: &[u8]) -> latkit::Result<()> {
        self.write_all(bytes).map_err(|e| Error::Io(e.to_string().into()))
    }

    /// Writes `value` as JSON, indented if `pretty`, and a newline.
    pub(crate) fn json(&mut self, value: &impl serde::Serialize, pretty: bool) -> latkit::Result<()> {
        let wrote = if pretty {
            serde_json::to_writer_pretty(&mut *self, value)
        } else {
            serde_json::to_writer(&mut *self, value)
        };
        wrote.map_err(|e| Error::Io(e.to_string().into()))?;
        self.put(b"\n")
    }

    /// Flushes the bytes written so far.
    fn flushed(&mut self) -> latkit::Result<()> {
        self.flush().map_err(|e| Error::Io(e.to_string().into()))
    }
}

/// Writes whose errors name the output.
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let wrote = match self {
            Output::Stdout(out) => out.write(bytes),
            Output::File { file, .. } => file.write(bytes),
        };
        wrote.map_err(|e| named(&e, self.path()))
    }

    fn flush(&mut self) -> io::Result<()> {
        let flushed = match self {
            Output::Stdout(out) => out.flush(),
            Output::File { file, .. } => file.flush(),
        };
        flushed.map_err(|e| named(&e, self.path()))
    }
}

/// Finalizes a sink's output once its video is finished, leaving it written and in place.
pub(crate) trait Commit {
    fn commit(self) -> latkit::Result<()>;
}

impl Commit for Mp4<Output> {
    fn commit(self) -> latkit::Result<()> {
        self.into_inner().commit()
    }
}

/// Pictures as image files, encoded a few at a time on the host's workers. Either one file per
/// frame, numbered by the output's pattern and each written whole and in order, or one file for a
/// single frame. A held frame (where nothing moved) repeats the previous frame's file.
pub(crate) struct Images {
    to: To,
    format: ImageFormat,
    host: Native,
    size: [u32; 2],
    /// Frames in progress, oldest first: each frame's index and, if drawn, its file being encoded.
    writing: VecDeque<(u64, Option<Pending<Vec<u8>>>)>,
    /// The last drawn frame's file.
    last: Vec<u8>,
}

/// Where image files are written.
enum To {
    Numbered(PathBuf),
    One(Output),
}

impl Images {
    /// One file per frame, at the paths `pattern` numbers.
    pub(crate) fn numbered(pattern: PathBuf, format: ImageFormat, host: Native) -> Images {
        Images::new(To::Numbered(pattern), format, host)
    }

    /// A single file, written to `out`.
    pub(crate) fn one(out: Output, format: ImageFormat, host: Native) -> Images {
        Images::new(To::One(out), format, host)
    }

    fn new(to: To, format: ImageFormat, host: Native) -> Images {
        Images { to, format, host, size: [0, 0], writing: VecDeque::new(), last: Vec::new() }
    }

    /// The path of frame `index`, from the numbered pattern `names`.
    fn path(names: &Path, index: u64) -> PathBuf {
        let text = names.to_string_lossy();
        let (range, width) = pattern(names).expect("the output is a %d pattern");
        format!("{}{index:0width$}{}", &text[..range.start], &text[range.end..]).into()
    }

    /// Writes the oldest frame's file once it is encoded.
    async fn write_oldest(&mut self) -> latkit::Result<()> {
        let Some((index, file)) = self.writing.pop_front() else { return Ok(()) };
        if let Some(file) = file {
            self.last = file.await?;
            if self.last.is_empty() {
                return Err(Error::invalid(format!("the picture could not be encoded as {}", self.format)));
            }
        }
        match &mut self.to {
            To::Numbered(names) => {
                let mut out = Output::create(&Images::path(names, index))?;
                out.put(&self.last)?;
                out.commit()
            }
            To::One(out) => out.put(&self.last),
        }
    }
}

impl Sink for Images {
    const PIXELS: Pixels = Pixels::Rgba;

    fn begin(&mut self, encoding: &Encoding, _: Option<&dyn Host>) -> latkit::Result<()> {
        self.size = encoding.size;
        Ok(())
    }

    async fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> latkit::Result<()> {
        if index > 0 && matches!(self.to, To::One(_)) {
            return Err(Error::invalid("an image file holds one frame; use a %d pattern to write one per frame"));
        }
        let file = match pixels {
            Some(rgba) => Some(self.host.spawn(Job::encode(&Image::new(self.size, rgba)?, self.format))),
            None => None,
        };
        self.writing.push_back((index, file));
        while self.writing.len() > ENCODING {
            self.write_oldest().await?;
        }
        Ok(())
    }

    async fn finish(&mut self, end: u64) -> latkit::Result<()> {
        if end == 0 {
            return Err(Error::invalid("no frames to write"));
        }
        while !self.writing.is_empty() {
            self.write_oldest().await?;
        }
        Ok(())
    }
}

impl Commit for Images {
    fn commit(self) -> latkit::Result<()> {
        match self.to {
            To::Numbered(_) => Ok(()),
            To::One(out) => out.commit(),
        }
    }
}

/// Raw RGBA with straight alpha, frames back to back. A held frame repeats the previous frame.
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
        ready(self.out.flushed())
    }
}

impl Commit for Raw {
    fn commit(self) -> latkit::Result<()> {
        self.out.commit()
    }
}

/// YUV4MPEG2: a header, then each frame's 4:2:0 planes, converted from the GPU's NV12. A held frame
/// repeats the previous frame.
pub(crate) struct Y4m {
    out: Output,
    size: [u32; 2],
    /// The last frame written: its `FRAME` marker and planes.
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
        // The GPU averages each 2×2 block's chroma, so samples are centered, as `C420jpeg` says.
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
        ready(self.out.flushed())
    }
}

impl Commit for Y4m {
    fn commit(self) -> latkit::Result<()> {
        self.out.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_number_files() {
        assert_eq!(Images::path(Path::new("out/frame-%04d.png"), 7), PathBuf::from("out/frame-0007.png"));
        assert_eq!(Images::path(Path::new("%d.jpg"), 12), PathBuf::from("12.jpg"));
    }
}
