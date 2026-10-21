//! The command line: what `render`, `validate`, `inspect`, `query`, `tile`, and `schema` take, and the
//! checks that fail as usage errors before anything is read.

use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum, error::ErrorKind};
use latkit::{ImageFormat, Pixels, Shot};

#[derive(Parser)]
#[command(name = "latkit", version, about = "Render scenes of JSON or binary data to images and videos")]
pub(crate) struct Cli {
    /// Diagnostics on stderr: errors, and progress while rendering; JSON is one object a line
    #[arg(long, global = true, value_enum, default_value = "human")]
    pub(crate) diagnostics: Diagnostics,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum Diagnostics {
    Human,
    Json,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Draw scenes of datasets into an image, image sequence, raw frames, or a video
    Render(Job),
    /// Check everything render reads, frames included, without a GPU
    Validate(Job),
    /// Describe datasets as JSON: tables, rows, fields and their kinds, the axis and its span
    Inspect {
        /// Dataset files, each [NAME=]FILE; - reads stdin
        #[arg(required = true, value_name = "[NAME=]FILE")]
        data: Vec<Source>,
        /// The longest a dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
    /// Print the JSON Schema of what latkit reads: every input, or one of them
    Schema {
        /// One input's schema
        #[arg(value_enum)]
        input: Option<Input>,
    },
    /// Read rows back as JSON Lines, an object a row: those a query keeps, sorted and paged
    Query {
        /// The dataset, [NAME=]FILE; - reads stdin
        #[arg(value_name = "[NAME=]FILE")]
        data: Source,
        /// The query: JSON such as {"of":"Branch","filter":{"op":"gt","args":["loading",90]}}, or a
        /// file of it
        #[arg(value_name = "QUERY")]
        query: String,
        /// The longest the dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
    /// Write a dataset as time tiles: frames.json, which --tiles opens, the dataset without its
    /// sampled fields' histories, and their spans at every level of detail
    Tile {
        /// The dataset, [NAME=]FILE; - reads stdin
        #[arg(value_name = "[NAME=]FILE")]
        data: Source,
        /// The directory the tiles go in
        #[arg(short, long, value_name = "DIR")]
        output: PathBuf,
        /// Entries a span holds: frames, or buckets of a level of detail; a multiple of 8
        #[arg(long, default_value = "256")]
        chunk: u32,
        /// The longest the dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
}

/// What a render draws and where it goes.
#[derive(Args)]
pub(crate) struct Job {
    /// Scene JSON files, one per panel; - reads stdin
    #[arg(required = true, value_name = "SCENE")]
    pub(crate) scenes: Vec<PathBuf>,
    /// A dataset: JSON document, latkit bytes, or GeoJSON (which needs a NAME); NAME= renames it
    #[arg(short, long, value_name = "[NAME=]FILE")]
    pub(crate) data: Vec<Source>,
    /// Tiles every view fetches as dataset NAME: time tiles' frames.json, or vector tiles' PMTiles
    /// file, TileJSON, or {z}/{x}/{y} template
    #[arg(long, value_name = "NAME=FILE")]
    pub(crate) tiles: Vec<Source>,
    /// Image file, %d pattern for an image sequence, or - for stdout
    #[arg(short, long, value_name = "FILE")]
    pub(crate) output: Option<PathBuf>,
    /// What to write; otherwise the output's extension says, or PNG for stdout
    #[arg(long, value_enum)]
    pub(crate) format: Option<Format>,
    /// A JPEG's quality, from 1, smallest, to 100, sharpest
    #[arg(long, default_value = "90", value_parser = clap::value_parser!(u8).range(1..=100))]
    pub(crate) quality: u8,
    /// The picture's width and height in pixels, such as 1920x1080
    #[arg(long, default_value = "1600x900", value_parser = size)]
    pub(crate) size: [u32; 2],
    /// Pixels per CSS pixel: views lay out size / scale CSS pixels, so 2 draws twice as sharp
    #[arg(long, default_value = "1", value_parser = positive)]
    pub(crate) scale: f32,
    /// A scene's panel of the picture, X,Y,WIDTH,HEIGHT as fractions; one per scene, in order
    #[arg(long, value_name = "X,Y,W,H", value_parser = panel)]
    pub(crate) panel: Vec<[f32; 4]>,
    /// Keep alpha where the themes' backgrounds would be
    #[arg(long)]
    pub(crate) transparent: bool,
    /// The longest a picture, or a video frame, may take, in seconds
    #[arg(long, default_value = "30", value_parser = deadline)]
    pub(crate) deadline: Duration,
    /// TTF/OTF/TTC file; repeat for fallbacks; replaces system fonts
    #[arg(long, value_name = "FILE")]
    pub(crate) font: Vec<PathBuf>,
    /// Camera JSON for a scene, in scene order; a view without one fits
    #[arg(long, value_name = "FILE")]
    pub(crate) camera: Vec<PathBuf>,
    /// What a view without a camera frames: "all", or a fit as JSON
    #[arg(long, default_value = "all", value_name = "FIT")]
    pub(crate) fit: String,
    /// CSS pixels kept clear at the top, right, bottom, and left, T,R,B,L
    #[arg(long, value_name = "T,R,B,L", value_parser = insets)]
    pub(crate) insets: Option<[f32; 4]>,
    /// The axis coordinate shown; sampled fields read their last frame at or before it
    #[arg(long, value_parser = finite, allow_hyphen_values = true)]
    pub(crate) at: Option<f64>,
    /// A still's effect time in seconds, where elapsed time and flowing comets read it
    #[arg(long, value_parser = seconds, conflicts_with = "frames")]
    pub(crate) elapsed: Option<Duration>,
    /// Frames as JSON Lines, one per output frame, or - for stdin
    #[arg(long, value_name = "FILE")]
    pub(crate) frames: Option<PathBuf>,
    /// Output frames a second
    #[arg(long, default_value = "60", value_parser = fps)]
    pub(crate) fps: f64,
    /// MP4 bits a second; about 0.15 bits a pixel a frame otherwise
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub(crate) bitrate: Option<u32>,
}

/// An input `schema` describes.
#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub(crate) enum Input {
    /// A scene
    Scene,
    /// A dataset's JSON document
    Data,
    /// A patch's JSON
    Patch,
    /// A query of `latkit query`
    Query,
    /// A camera of `--camera`
    Camera,
    /// A fit of `--fit`
    Fit,
    /// A line of `--frames`
    Frames,
}

/// What an output is.
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum Format {
    /// PNG, lossless with alpha: one picture, or one a frame where the output has a %d pattern
    Png,
    /// JPEG at --quality, its alpha dropped: one picture, or one a frame
    Jpeg,
    /// WebP, lossless with alpha: one picture, or one a frame
    Webp,
    /// Raw RGBA, straight alpha, frames back to back
    Rgba,
    /// YUV4MPEG2: 4:2:0 BT.709 limited range, for any encoder
    Y4m,
    /// H.264 in fragmented MP4, from the platform's encoder
    Mp4,
}

/// A dataset or tiles argument: `[NAME=]FILE`.
#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub(crate) name: Option<String>,
    pub(crate) path: PathBuf,
}

impl std::str::FromStr for Source {
    type Err = String;
    fn from_str(value: &str) -> Result<Source, String> {
        let named = value.split_once('=').filter(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
        });
        Ok(match named {
            Some((name, path)) if !path.is_empty() => Source { name: Some(name.into()), path: path.into() },
            Some(_) => return Err("NAME= names a file".into()),
            None => Source { name: None, path: value.into() },
        })
    }
}

impl Format {
    /// The bytes its pictures compose into.
    pub(crate) fn pixels(self) -> Pixels {
        match self {
            Format::Mp4 | Format::Y4m => Pixels::Nv12,
            Format::Png | Format::Jpeg | Format::Webp | Format::Rgba => Pixels::Rgba,
        }
    }

    /// The image file it writes, at `quality` for a JPEG; `None` for raw frames and video.
    pub(crate) fn image(self, quality: u8) -> Option<ImageFormat> {
        match self {
            Format::Png => Some(ImageFormat::Png),
            Format::Jpeg => Some(ImageFormat::Jpeg { quality }),
            Format::Webp => Some(ImageFormat::WebP),
            Format::Rgba | Format::Y4m | Format::Mp4 => None,
        }
    }
}

impl Job {
    /// What the output is: `--format`, else its extension, else PNG.
    pub(crate) fn format(&self) -> Format {
        self.format.unwrap_or_else(|| {
            let extension = self.output.as_deref().and_then(Path::extension).and_then(|e| e.to_str());
            match extension.map(str::to_ascii_lowercase).as_deref() {
                Some("mp4") => Format::Mp4,
                Some("y4m") => Format::Y4m,
                Some("rgba") => Format::Rgba,
                Some("jpg" | "jpeg") => Format::Jpeg,
                Some("webp") => Format::Webp,
                _ => Format::Png,
            }
        })
    }

    /// The picture the job takes: its size, scale, panels, alpha, and deadline.
    pub(crate) fn shot(&self) -> Shot {
        let shot = Shot::new(self.size).scale(self.scale).deadline(self.deadline).panels(self.panel.clone());
        if self.transparent { shot.transparent() } else { shot }
    }

    /// Whether the output names one file a frame: a `%d` or `%0Nd` pattern.
    pub(crate) fn sequence(&self) -> bool {
        self.output.as_deref().is_some_and(|p| pattern(p).is_some())
    }
}

/// The `%d` or `%0Nd` of a path's file name, and its width.
pub(crate) fn pattern(path: &Path) -> Option<(std::ops::Range<usize>, usize)> {
    let text = path.to_str()?;
    let at = text.rfind('%')?;
    let rest = &text[at + 1..];
    let digits = rest.find('d')?;
    let width = &rest[..digits];
    if !width.chars().all(|c| c.is_ascii_digit()) || width.len() > 2 {
        return None;
    }
    Some((at..at + digits + 2, width.parse().unwrap_or(0)))
}

impl Cli {
    /// The checks clap cannot make, failing as usage errors: one reader of stdin, an output a render
    /// can write, and a panel for each scene.
    pub(crate) fn check(&self) -> clap::error::Result<()> {
        let invalid = |message: &str| Self::command().error(ErrorKind::InvalidValue, message);
        let job = match &self.command {
            Command::Render(job) | Command::Validate(job) => job,
            Command::Inspect { data, .. } => {
                if data.iter().filter(|s| is_stdio(&s.path)).count() > 1 {
                    return Err(Self::command().error(ErrorKind::ArgumentConflict, "only one input can read stdin"));
                }
                return Ok(());
            }
            Command::Schema { .. } | Command::Tile { .. } => return Ok(()),
            Command::Query { data, query, .. } => {
                if is_stdio(&data.path) && query == "-" {
                    return Err(Self::command().error(ErrorKind::ArgumentConflict, "only one input can read stdin"));
                }
                return Ok(());
            }
        };
        let stdin = job.scenes.iter().chain(job.data.iter().map(|s| &s.path)).chain(&job.frames).chain(&job.camera);
        if stdin.filter(|path| is_stdio(path)).count() > 1 {
            return Err(Self::command().error(ErrorKind::ArgumentConflict, "only one input can read stdin"));
        }
        if job.tiles.iter().any(|t| t.name.is_none()) {
            return Err(invalid("--tiles takes NAME=FILE"));
        }
        if job.scenes.len() > 1 && job.panel.len() != job.scenes.len() {
            return Err(invalid("a shot of several scenes takes a --panel for each"));
        }
        if job.scenes.len() == 1 && job.panel.len() > 1 {
            return Err(invalid("one scene fills one panel"));
        }
        if job.camera.len() > job.scenes.len() {
            return Err(invalid("--camera is one per scene"));
        }
        let Some(output) = &job.output else {
            if matches!(self.command, Command::Render(_)) {
                return Err(Self::command().error(ErrorKind::MissingRequiredArgument, "render takes --output"));
            }
            return Ok(());
        };
        let format = job.format();
        let extension = output.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        let known = matches!(extension.as_deref(), Some("png" | "jpg" | "jpeg" | "webp" | "mp4" | "y4m" | "rgba"));
        if job.format.is_none() && !is_stdio(output) && !known {
            return Err(invalid(
                "--output ends in .png, .jpg, .webp, .mp4, .y4m, or .rgba, or --format says what it is",
            ));
        }
        let video = matches!(format, Format::Mp4 | Format::Y4m);
        if (video || job.sequence()) && job.frames.is_none() {
            return Err(invalid("a video or an image sequence takes --frames"));
        }
        if job.sequence() && (format.image(job.quality).is_none() || is_stdio(output)) {
            return Err(invalid("a %d pattern names an image file a frame"));
        }
        job.shot().check(format.pixels()).map_err(|e| invalid(&e.to_string()))
    }
}

pub(crate) fn is_stdio(path: &Path) -> bool {
    path == Path::new("-")
}

fn finite(value: &str) -> Result<f64, String> {
    value.parse::<f64>().ok().filter(|n| n.is_finite()).ok_or_else(|| "expected a finite number".into())
}

fn positive(value: &str) -> Result<f32, String> {
    let n = finite(value)? as f32;
    if n.is_finite() && n > 0.0 { Ok(n) } else { Err("expected a positive number".into()) }
}

fn seconds(value: &str) -> Result<Duration, String> {
    Duration::try_from_secs_f64(finite(value)?).map_err(|_| "expected nonnegative seconds".into())
}

fn deadline(value: &str) -> Result<Duration, String> {
    seconds(value).and_then(|d| if d.is_zero() { Err("a deadline is longer than zero".into()) } else { Ok(d) })
}

fn fps(value: &str) -> Result<f64, String> {
    finite(value).and_then(|f| if (1.0..=240.0).contains(&f) { Ok(f) } else { Err("1 to 240 frames a second".into()) })
}

fn size(value: &str) -> Result<[u32; 2], String> {
    let (w, h) = value.split_once(['x', 'X']).ok_or("expected WIDTHxHEIGHT")?;
    let side = |v: &str| v.trim().parse::<u32>().ok().filter(|n| *n > 0).ok_or("a side is a positive whole number");
    Ok([side(w)?, side(h)?])
}

fn numbers<const N: usize>(value: &str) -> Result<[f32; N], String> {
    let parts: Vec<f32> = value.split(',').map(|v| finite(v.trim()).map(|n| n as f32)).collect::<Result<_, _>>()?;
    parts.try_into().map_err(|_| format!("expected {N} numbers separated by commas"))
}

fn panel(value: &str) -> Result<[f32; 4], String> {
    numbers::<4>(value)
}

fn insets(value: &str) -> Result<[f32; 4], String> {
    numbers::<4>(value)
        .and_then(|n| if n.iter().all(|v| *v >= 0.0) { Ok(n) } else { Err("insets are not negative".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_patterns_and_sizes_parse() {
        let named: Source = "states=data/usa.geojson".parse().unwrap();
        assert_eq!((named.name.as_deref(), named.path), (Some("states"), PathBuf::from("data/usa.geojson")));
        let plain: Source = "C:\\data\\a=b.json".parse().unwrap();
        assert_eq!((plain.name, plain.path), (None, PathBuf::from("C:\\data\\a=b.json")));
        assert_eq!(pattern(Path::new("out/frame-%04d.png")), Some((10..14, 4)));
        assert_eq!(pattern(Path::new("out/%d.png")), Some((4..6, 0)));
        assert_eq!(pattern(Path::new("out/100%.png")), None);
        assert_eq!(size("1920x1080"), Ok([1920, 1080]));
        assert!(size("0x10").is_err());
        assert_eq!(panel("0,0.5,1,0.5"), Ok([0.0, 0.5, 1.0, 0.5]));
        assert!(insets("1,2,3").is_err());
    }
}
