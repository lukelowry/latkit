//! The native command-line adapter for latkit's existing scene, data, and shot APIs.

mod args;

use std::future::Future;
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use clap::Parser;
use latkit::{Data, Error, Fit, Gpu, Image, Scene, Shot, Step, View, host::Native};
use serde_json::{Value, json};

use args::{Cli, Command, Diagnostics, Input, Render, is_stdio};

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Err(error) = cli.check() {
        error.exit();
    }
    match execute(&cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            // A closed stderr must not turn an operational failure into a panic.
            let _ = report(io::stderr().lock(), cli.diagnostics, &error);
            ExitCode::FAILURE
        }
    }
}

struct Failure {
    error: Error,
    source: Option<String>,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self { error, source: None }
    }
}

fn source(error: Error, path: &Path) -> Failure {
    Failure { error, source: Some(path.to_string_lossy().into_owned()) }
}

fn io_error(error: &io::Error, path: &Path) -> Failure {
    source(Error::Load(error.to_string().into()), path)
}

fn read(path: &Path) -> Result<Vec<u8>, Failure> {
    if is_stdio(path) {
        let mut bytes = Vec::new();
        io::stdin().lock().read_to_end(&mut bytes).map_err(|error| io_error(&error, path))?;
        Ok(bytes)
    } else {
        std::fs::read(path).map_err(|error| io_error(&error, path))
    }
}

fn load(input: &Input) -> Result<(Scene, Vec<Data>), Failure> {
    let scene: Scene = serde_json::from_slice(&read(&input.scene)?)
        .map_err(|error| source(Error::invalid(error.to_string()), &input.scene))?;
    let data = input
        .data
        .iter()
        .map(|path| Data::from_bytes(&read(path)?).map_err(|error| source(error, path)))
        .collect::<Result<Vec<_>, _>>()?;
    scene.validate(&data).map_err(|error| source(error, &input.scene))?;
    Ok((scene, data))
}

fn execute(command: &Command) -> Result<(), Failure> {
    match command {
        Command::Validate(input) => {
            load(input)?;
            Ok(())
        }
        Command::Render(render) => {
            let (scene, data) = load(&render.input)?;
            let host = if render.font.is_empty() {
                Native::new()
            } else {
                let fonts = render
                    .font
                    .iter()
                    .map(|path| std::fs::read(path).map_err(|error| io_error(&error, path)))
                    .collect::<Result<Vec<_>, _>>()?;
                Native::from_fonts(fonts)?
            };
            let image = until(render.timeout, render_image(render, scene, data, host))??;
            write_image(&render.output, &image)
        }
    }
}

async fn render_image(options: &Render, scene: Scene, data: Vec<Data>, host: Native) -> latkit::Result<Image> {
    let started = Instant::now();
    let gpu = Gpu::new().await?;
    gpu.set_host(host);
    let mut view = View::new(&gpu, scene.ease(Duration::ZERO))?;
    for data in data {
        view.set_data(data);
    }
    if let Some(at) = options.at {
        view.set_at(at);
    }
    view.fit(Fit::All);
    let mut shot = Shot::new([options.width, options.height])
        .scale(options.pixel_ratio)
        .elapsed(options.elapsed)
        .deadline(options.timeout.saturating_sub(started.elapsed()));
    if options.transparent {
        shot = shot.transparent();
    }
    shot.image(&mut [&mut view]).await
}

fn write_image(path: &Path, image: &Image) -> Result<(), Failure> {
    if is_stdio(path) {
        let mut output = BufWriter::new(io::stdout().lock());
        image.write_png(&mut output).map_err(|error| source(error, path))?;
        output.flush().map_err(|error| io_error(&error, path))
    } else {
        let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| io_error(&error, path))?;
        {
            let mut output = BufWriter::new(file.as_file_mut());
            image.write_png(&mut output).map_err(|error| source(error, path))?;
            output.flush().map_err(|error| io_error(&error, path))?;
        }
        file.persist(path).map_err(|error| io_error(&error.error, path))?;
        Ok(())
    }
}

fn report(mut output: impl Write, diagnostics: Diagnostics, failure: &Failure) -> io::Result<()> {
    match diagnostics {
        Diagnostics::Human => match &failure.source {
            Some(source) => writeln!(output, "latkit: {source}: {}", failure.error),
            None => writeln!(output, "latkit: {}", failure.error),
        },
        Diagnostics::Json => {
            let path: Vec<Value> = match &failure.error {
                Error::Invalid { path, .. } => path
                    .0
                    .iter()
                    .map(|step| match step {
                        Step::Name(name) => json!(name.as_ref()),
                        Step::Index(index) => json!(index),
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let mut message =
                json!({ "code": failure.error.code(), "path": path, "message": failure.error.to_string() });
            if let Some(source) = &failure.source {
                message["source"] = json!(source);
            }
            writeln!(output, "{message}")
        }
    }
}

/// A synchronous CLI needs only one parked thread to drive its future, with a deadline. The future
/// must yield; like other async timeouts this cannot interrupt a synchronous OS/driver call.
fn until<T>(timeout: Duration, future: impl Future<Output = T>) -> latkit::Result<T> {
    struct Thread(std::thread::Thread);
    impl Wake for Thread {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let started = Instant::now();
    let waker = Waker::from(Arc::new(Thread(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if started.elapsed() >= timeout {
            return Err(Error::Timeout);
        }
        let result = future.as_mut().poll(&mut context);
        if started.elapsed() >= timeout {
            return Err(Error::Timeout);
        }
        if let Poll::Ready(result) = result {
            return Ok(result);
        }
        std::thread::park_timeout(timeout.saturating_sub(started.elapsed()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_handles_a_future_that_never_wakes() {
        assert_eq!(until(Duration::from_millis(5), std::future::pending::<()>()), Err(Error::Timeout));
        assert_eq!(until(Duration::from_secs(1), async { 42 }), Ok(42));
    }

    #[test]
    fn failed_encoding_keeps_the_destination_and_removes_the_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("out.png");
        std::fs::write(&path, b"original").unwrap();
        let invalid = Image { size: [2, 2], rgba: Arc::from([0_u8; 4]) };
        assert!(write_image(&path, &invalid).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
