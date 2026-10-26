//! Command-line arguments of `render`, `validate`, `inspect`, `query`, `tile`, and `schema`, and
//! the checks that report usage errors before any input is read.

use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum, error::ErrorKind};
use latkit::{ImageFormat, Pixels, Shot};

#[derive(Parser)]
#[command(name = "latkit", version, about = "Render scenes of JSON or binary data to images and videos")]
pub(crate) struct Cli {
    /// Format of errors and render progress on stderr. JSON writes one object per line
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
    /// Check every input render reads, including frames, without a GPU
    Validate(Job),
    /// Describe datasets as JSON: tables, row counts, fields with kinds, and the axis and its span
    Inspect {
        /// Dataset files, each [NAME=]FILE (- reads stdin)
        #[arg(required = true, value_name = "[NAME=]FILE")]
        data: Vec<Source>,
        /// The longest a dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
    /// Print the JSON Schema of every input latkit reads, or of one input
    Schema {
        /// Print only this input's schema
        #[arg(value_enum)]
        input: Option<Input>,
    },
    /// Print the rows a query selects, sorted and paged, as JSON Lines with one object per row
    Query {
        /// The dataset, [NAME=]FILE (- reads stdin)
        #[arg(value_name = "[NAME=]FILE")]
        data: Source,
        /// The query as JSON, such as {"of":"Branch","filter":{"op":"gt","args":["loading",90]}},
        /// or a file containing it (- reads stdin)
        #[arg(value_name = "QUERY")]
        query: String,
        /// The longest the dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
    /// Write a dataset as time tiles: frames.json (which --tiles opens), the dataset without its
    /// sampled fields' histories, and those histories in spans at every level of detail
    Tile {
        /// The dataset, [NAME=]FILE (- reads stdin)
        #[arg(value_name = "[NAME=]FILE")]
        data: Source,
        /// Directory to write the tiles to
        #[arg(short, long, value_name = "DIR")]
        output: PathBuf,
        /// Entries per span: frames at full detail, buckets at coarser levels. A multiple of 8
        #[arg(long, default_value = "256")]
        chunk: u32,
        /// The longest the dataset may take to load, in seconds
        #[arg(long, default_value = "30", value_parser = deadline)]
        deadline: Duration,
    },
}

/// The inputs and output of `render` and `validate`.
#[derive(Args)]
pub(crate) struct Job {
    /// Scene JSON files, one per panel (- reads stdin)
    #[arg(required = true, value_name = "SCENE")]
    pub(crate) scenes: Vec<PathBuf>,
    /// A dataset file: a JSON document, latkit bytes, or GeoJSON. NAME= sets its name, which
    /// GeoJSON requires
    #[arg(short, long, value_name = "[NAME=]FILE")]
    pub(crate) data: Vec<Source>,
    /// Tiles every view fetches as dataset NAME: a time tiles frames.json, or a vector tiles
    /// PMTiles file, TileJSON, or {z}/{x}/{y} template
    #[arg(long, value_name = "NAME=FILE")]
    pub(crate) tiles: Vec<Source>,
    /// Output file, %d pattern for an image sequence, or - for stdout
    #[arg(short, long, value_name = "FILE")]
    pub(crate) output: Option<PathBuf>,
    /// Output format. Defaults to the one the output's extension names, else PNG
    #[arg(long, value_enum)]
    pub(crate) format: Option<Format>,
    /// JPEG quality, from 1 (smallest) to 100 (sharpest)
    #[arg(long, default_value = "90", value_parser = clap::value_parser!(u8).range(1..=100))]
    pub(crate) quality: u8,
    /// The picture's width and height in pixels, such as 1920x1080
    #[arg(long, default_value = "1600x900", value_parser = size)]
    pub(crate) size: [u32; 2],
    /// Pixels per CSS pixel. Views lay out size / scale CSS pixels, so 2 draws twice as sharp
    #[arg(long, default_value = "1", value_parser = positive)]
    pub(crate) scale: f32,
    /// A scene's panel of the picture, as X,Y,WIDTH,HEIGHT fractions. Give one per scene, in order
    #[arg(long, value_name = "X,Y,W,H", value_parser = panel)]
    pub(crate) panel: Vec<[f32; 4]>,
    /// Keep alpha where the themes' backgrounds would be
    #[arg(long)]
    pub(crate) transparent: bool,
    /// The longest a picture or video frame may take, in seconds
    #[arg(long, default_value = "30", value_parser = deadline)]
    pub(crate) deadline: Duration,
    /// A TTF, OTF, or TTC font file. Repeat for fallbacks. Replaces the system fonts
    #[arg(long, value_name = "FILE")]
    pub(crate) font: Vec<PathBuf>,
    /// A camera JSON file per scene, in scene order. Views without one use --fit
    #[arg(long, value_name = "FILE")]
    pub(crate) camera: Vec<PathBuf>,
    /// What views without a camera frame: "all", or a fit as JSON
    #[arg(long, default_value = "all", value_name = "FIT")]
    pub(crate) fit: String,
    /// CSS pixels to keep clear at the top, right, bottom, and left
    #[arg(long, value_name = "T,R,B,L", value_parser = insets)]
    pub(crate) insets: Option<[f32; 4]>,
    /// The axis coordinate to show. Sampled fields show their last frame at or before it
    #[arg(long, value_parser = finite, allow_hyphen_values = true)]
    pub(crate) at: Option<f64>,
    /// A still's fixed effect time in seconds, for elapsed-time expressions and flowing comets
    #[arg(long, value_parser = seconds, conflicts_with = "frames")]
    pub(crate) elapsed: Option<Duration>,
    /// Frames as JSON Lines, one line per output frame (- reads stdin)
    #[arg(long, value_name = "FILE")]
    pub(crate) frames: Option<PathBuf>,
    /// Output frames per second
    #[arg(long, default_value = "60", value_parser = fps)]
    pub(crate) fps: f64,
    /// MP4 bitrate in bits per second. Defaults to about 0.15 bits per pixel per frame
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub(crate) bitrate: Option<u32>,
}

/// An input whose schema `schema` prints.
#[derive(Clone, Copy, PartialEq, Eq, Debug, ValueEnum)]
pub(crate) enum Input {
    /// A scene
    Scene,
    /// A dataset's JSON document
    Data,
    /// A patch
    Patch,
    /// A query for `latkit query`
    Query,
    /// A camera for `--camera`
    Camera,
    /// A fit for `--fit`
    Fit,
    /// One line of a `--frames` file
    Frames,
}

/// An output format.
#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum Format {
    /// PNG, lossless with alpha. One picture, or one per frame with a %d output pattern
    Png,
    /// JPEG at --quality, without alpha. One picture, or one per frame
    Jpeg,
    /// Lossless WebP with alpha. One picture, or one per frame
    Webp,
    /// Raw RGBA with straight alpha, frames back to back
    Rgba,
    /// YUV4MPEG2 (4:2:0, BT.709 limited range), which any encoder reads
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
            Some(_) => return Err("expected a file after NAME=".into()),
            None => Source { name: None, path: value.into() },
        })
    }
}

impl Format {
    /// The pixel layout its pictures compose into.
    pub(crate) fn pixels(self) -> Pixels {
        match self {
            Format::Mp4 | Format::Y4m => Pixels::Nv12,
            Format::Png | Format::Jpeg | Format::Webp | Format::Rgba => Pixels::Rgba,
        }
    }

    /// The image format it writes, with `quality` for JPEG. `None` for raw frames and video.
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
    /// The output format: `--format`, else the one the output's extension names, else PNG.
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

    /// The job's shot: its size, scale, panels, transparency, and deadline.
    pub(crate) fn shot(&self) -> Shot {
        let shot = Shot::new(self.size).scale(self.scale).deadline(Some(self.deadline)).panels(self.panel.clone());
        if self.transparent { shot.transparent() } else { shot }
    }

    /// Whether the output is a `%d` or `%0Nd` pattern that names one file per frame.
    pub(crate) fn sequence(&self) -> bool {
        self.output.as_deref().is_some_and(|p| pattern(p).is_some())
    }
}

/// The byte range of the `%d` or `%0Nd` at the last `%` in `path`, and its zero-padded width (0
/// for `%d`).
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
    /// Checks clap cannot express, reported as usage errors: at most one input reads stdin, the
    /// output is one a render can write, and each scene has a panel.
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
            return Err(invalid("several scenes need one --panel each"));
        }
        if job.scenes.len() == 1 && job.panel.len() > 1 {
            return Err(invalid("one scene takes at most one --panel"));
        }
        if job.camera.len() > job.scenes.len() {
            return Err(invalid("at most one --camera per scene"));
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
                "--output must end in .png, .jpg, .webp, .mp4, .y4m, or .rgba, unless --format is set",
            ));
        }
        let video = matches!(format, Format::Mp4 | Format::Y4m);
        if (video || job.sequence()) && job.frames.is_none() {
            return Err(invalid("a video or an image sequence takes --frames"));
        }
        if job.sequence() && (format.image(job.quality).is_none() || is_stdio(output)) {
            return Err(invalid("a %d pattern needs an image format: png, jpeg, or webp"));
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
    seconds(value).and_then(|d| if d.is_zero() { Err("expected more than zero seconds".into()) } else { Ok(d) })
}

fn fps(value: &str) -> Result<f64, String> {
    finite(value).and_then(|f| if (1.0..=240.0).contains(&f) { Ok(f) } else { Err("expected 1 to 240 fps".into()) })
}

fn size(value: &str) -> Result<[u32; 2], String> {
    let (w, h) = value.split_once(['x', 'X']).ok_or("expected WIDTHxHEIGHT")?;
    let side = |v: &str| v.trim().parse::<u32>().ok().filter(|n| *n > 0).ok_or("expected positive whole numbers");
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
        .and_then(|n| if n.iter().all(|v| *v >= 0.0) { Ok(n) } else { Err("expected nonnegative insets".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_reference_matches_help() {
        use std::fmt::Write as _;

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        // This checks repository documentation, which is not part of the published CLI crate.
        if !root.join(".readthedocs.yaml").exists() {
            return;
        }
        let mut cli = Cli::command();
        let mut text = format!(
            "# Command reference\n\nGenerated from Clap. See the [CLI guide](../cli.md) for examples.\n\n## latkit\n\n```text\n{}```\n",
            cli.render_long_help()
        );
        for command in cli.get_subcommands_mut() {
            let name = command.get_name().to_owned();
            let command = command.clone().bin_name(format!("latkit {name}"));
            let mut command = command;
            write!(text, "\n## {name}\n\n```text\n{}```\n", command.render_long_help()).unwrap();
        }
        let text = text.lines().map(str::trim_end).collect::<Vec<_>>().join("\n") + "\n";
        let path = root.join("docs/reference/cli.md");
        if std::env::var_os("LATKIT_BLESS").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap().replace("\r\n", "\n"), text);
    }

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
