use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum, error::ErrorKind};

#[derive(Parser)]
#[command(name = "latkit", version, about = "Validate scenes and render them to PNG")]
pub(crate) struct Cli {
    /// Operational diagnostics on stderr; argument errors use standard CLI help
    #[arg(long, global = true, value_enum, default_value = "human")]
    pub(crate) diagnostics: Diagnostics,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Clone, Copy, ValueEnum)]
pub(crate) enum Diagnostics {
    Human,
    Json,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    /// Render a validated scene, fitting its data into the picture
    Render(Render),
    /// Check scene syntax, datasets, and expressions without creating a GPU
    Validate(Input),
}

#[derive(Args)]
pub(crate) struct Input {
    /// Scene JSON file, or - for stdin
    pub(crate) scene: PathBuf,
    /// Dataset in latkit binary format; repeat for multiple datasets; - reads stdin
    #[arg(short, long, value_name = "FILE")]
    pub(crate) data: Vec<PathBuf>,
}

#[derive(Args)]
pub(crate) struct Render {
    #[command(flatten)]
    pub(crate) input: Input,
    /// PNG file to replace on success, or - for binary stdout
    #[arg(short, long, value_name = "FILE")]
    pub(crate) output: PathBuf,
    /// Output width in physical pixels
    #[arg(long, default_value = "1600", value_parser = clap::value_parser!(u32).range(1..))]
    pub(crate) width: u32,
    /// Output height in physical pixels
    #[arg(long, default_value = "900", value_parser = clap::value_parser!(u32).range(1..))]
    pub(crate) height: u32,
    /// Physical pixels per logical pixel; does not multiply width or height
    #[arg(long, default_value = "1", value_parser = positive_scale)]
    pub(crate) pixel_ratio: f32,
    /// TTF/OTF/TTC file; repeat for fallbacks; replaces system font discovery
    #[arg(long, value_name = "FILE")]
    pub(crate) font: Vec<PathBuf>,
    /// Dataset sample coordinate; defaults to the latest sample
    #[arg(long, value_parser = finite, allow_hyphen_values = true)]
    pub(crate) at: Option<f64>,
    /// Fixed animation-effect time in seconds, independent of dataset samples
    #[arg(long, default_value = "0", value_parser = duration)]
    pub(crate) elapsed: Duration,
    /// GPU initialization and capture timeout in seconds
    #[arg(long, default_value = "30", value_parser = positive_duration)]
    pub(crate) timeout: Duration,
    /// Preserve alpha instead of compositing against the theme background
    #[arg(long)]
    pub(crate) transparent: bool,
}

impl Cli {
    pub(crate) fn check(&self) -> clap::error::Result<()> {
        let input = match &self.command {
            Command::Render(render) => &render.input,
            Command::Validate(input) => input,
        };
        if std::iter::once(&input.scene).chain(&input.data).filter(|path| is_stdio(path)).count() > 1 {
            return Err(Self::command().error(ErrorKind::ArgumentConflict, "only one scene or dataset can read stdin"));
        }
        if let Command::Render(render) = &self.command
            && !is_stdio(&render.output)
            && !render.output.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        {
            return Err(Self::command().error(ErrorKind::InvalidValue, "--output must have a .png extension or be -"));
        }
        Ok(())
    }
}

pub(crate) fn is_stdio(path: &Path) -> bool {
    path == Path::new("-")
}

fn finite(value: &str) -> Result<f64, String> {
    value.parse::<f64>().ok().filter(|number| number.is_finite()).ok_or_else(|| "expected a finite number".into())
}

fn positive_scale(value: &str) -> Result<f32, String> {
    let number = finite(value)? as f32;
    if number.is_finite() && number > 0.0 { Ok(number) } else { Err("expected a positive finite pixel ratio".into()) }
}

fn duration(value: &str) -> Result<Duration, String> {
    Duration::try_from_secs_f64(finite(value)?).map_err(|_| "expected nonnegative seconds within range".into())
}

fn positive_duration(value: &str) -> Result<Duration, String> {
    let duration = duration(value)?;
    if duration.is_zero() { Err("timeout must be greater than zero".into()) } else { Ok(duration) }
}
