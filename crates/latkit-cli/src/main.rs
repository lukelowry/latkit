//! The latkit command line: scenes and datasets in the library's JSON (or its bytes), drawn by the
//! library natively into images, image sequences, raw frames, and videos.

mod args;
mod inputs;
mod render;
mod report;
mod sinks;

use std::future::Future;
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use clap::Parser;
use latkit::{Error, Kind, Query, Values};
use serde_json::{Value, json};

use args::{Cli, Command, Input, Source};
use report::Report;

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Err(error) = cli.check() {
        error.exit();
    }
    let mut report = Report::new(cli.diagnostics);
    let result = match &cli.command {
        Command::Render(job) => render::render(job, &mut report),
        Command::Validate(job) => render::validate(job),
        Command::Inspect { data, deadline } => inspect(data, *deadline),
        Command::Query { data, query, deadline } => self::query(data, query, *deadline),
        Command::Tile { data, output, chunk, deadline } => tile(data, output, *chunk, *deadline),
        Command::Schema { input } => schema(*input),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            report.error(&failure);
            ExitCode::FAILURE
        }
    }
}

/// Why a command failed: the library's error, and the file it came from.
#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) error: Error,
    pub(crate) source: Option<String>,
}

impl Failure {
    /// `error`, from the file at `path`.
    pub(crate) fn at(error: Error, path: &Path) -> Failure {
        Failure { error, source: Some(path.to_string_lossy().into_owned()) }
    }

    /// An I/O `error` with the file at `path`.
    pub(crate) fn io(error: &io::Error, path: &Path) -> Failure {
        Failure::at(Error::Io(error.to_string().into()), path)
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Failure {
        Failure { error, source: None }
    }
}

/// Every dataset's description as JSON on stdout: its name, axis and span, and each table's rows and
/// fields.
fn inspect(sources: &[Source], deadline: Duration) -> Result<(), Failure> {
    let host = latkit::host::Native::new();
    let mut all = Vec::with_capacity(sources.len());
    for source in sources {
        all.push(inputs::dataset(source, &host, deadline)?.snapshot().describe());
    }
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &all).map_err(|e| Failure::from(Error::Io(e.to_string().into())))?;
    writeln!(out).map_err(|e| Failure::io(&e, Path::new("-")))
}

/// The JSON Schema of every input on stdout, or of `input`: its definition, with every definition
/// it is built of.
fn schema(input: Option<Input>) -> Result<(), Failure> {
    let mut schemas = latkit::schemas();
    let frames = latkit::schema::<inputs::Frame>();
    let defs = schemas["$defs"].as_object_mut().expect("definitions");
    for (name, def) in frames["$defs"].as_object().into_iter().flatten() {
        defs.entry(name.clone()).or_insert_with(|| def.clone());
    }
    let mut frame = frames.clone();
    frame.as_object_mut().expect("a schema").retain(|key, _| key != "$defs" && key != "$schema");
    defs.insert("Frame".into(), frame);
    if let Some(input) = input {
        let name = match input {
            Input::Scene => "Scene",
            Input::Data => "Data",
            Input::Patch => "Patch",
            Input::Query => "Query",
            Input::Camera => "Camera",
            Input::Fit => "Fit",
            Input::Frames => "Frame",
        };
        schemas["$ref"] = json!(format!("#/$defs/{name}"));
    }
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &schemas).map_err(|e| Failure::from(Error::Io(e.to_string().into())))?;
    writeln!(out).map_err(|e| Failure::io(&e, Path::new("-")))
}

/// The rows `query` reads from the dataset as JSON Lines on stdout: `id`, then each field, a
/// reference as its target's id and a missing value as `null`.
fn query(source: &Source, query: &str, deadline: Duration) -> Result<(), Failure> {
    let text =
        if query.trim_start().starts_with('{') { query.as_bytes().to_vec() } else { inputs::read(Path::new(query))? };
    let text = std::str::from_utf8(&text).map_err(|_| Failure::from(Error::invalid("not UTF-8 text").at("query")))?;
    let query: Query = latkit::from_json(text).map_err(|e| Failure::from(e.at("query")))?;
    let rows = inputs::dataset(source, &latkit::host::Native::new(), deadline)?.snapshot().query(&query)?.table;
    let columns: Vec<(String, Values)> =
        rows.fields().map(|(name, _)| (name.to_string(), rows.values(name).expect("a field the table has"))).collect();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for (row, id) in rows.ids().enumerate() {
        let mut line = serde_json::Map::with_capacity(columns.len() + 1);
        line.insert("id".into(), json!(id));
        for (name, values) in &columns {
            let value = match rows.kind(name) {
                Some(Kind::Reference) => values.id(row).map_or(Value::Null, |id| json!(id)),
                _ => values.get(row).map_or(Value::Null, |v| json!(v)),
            };
            line.insert(name.clone(), value);
        }
        serde_json::to_writer(&mut out, &line).map_err(|e| Failure::from(Error::Io(e.to_string().into())))?;
        writeln!(out).map_err(|e| Failure::io(&e, Path::new("-")))?;
    }
    out.flush().map_err(|e| Failure::io(&e, Path::new("-")))
}

/// The dataset as time tiles in directory `output`: its manifest, the dataset without its sampled
/// fields' histories, and their spans of `chunk` entries.
fn tile(source: &Source, output: &Path, chunk: u32, deadline: Duration) -> Result<(), Failure> {
    let data = inputs::dataset(source, &latkit::host::Native::new(), deadline)?.snapshot();
    let mut failure = None;
    let written = data.to_tiles(chunk, |path, bytes| {
        let file = output.join(path);
        let wrote = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&file, bytes));
        wrote.map_err(|e| {
            failure = Some(Failure::io(&e, &file));
            Error::Io(e.to_string().into())
        })
    });
    match (written, failure) {
        (Ok(()), _) => Ok(()),
        (Err(_), Some(failure)) => Err(failure),
        (Err(error), None) => Err(Failure::from(error)),
    }
}

/// `future`'s result, driven on this thread and given up at `deadline`.
pub(crate) fn block<T>(deadline: Duration, future: impl Future<Output = latkit::Result<T>>) -> latkit::Result<T> {
    until(deadline, future)?
}

/// A synchronous command needs only one parked thread to drive its future, with a deadline. The
/// future must yield; like other async timeouts this cannot interrupt a synchronous OS or driver call.
fn until<T>(deadline: Duration, future: impl Future<Output = T>) -> latkit::Result<T> {
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
        if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
            return Ok(result);
        }
        if started.elapsed() >= deadline {
            return Err(Error::Timeout);
        }
        std::thread::park_timeout(deadline.saturating_sub(started.elapsed()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deadline_ends_a_future_that_never_wakes() {
        assert_eq!(until(Duration::from_millis(5), std::future::pending::<()>()), Err(Error::Timeout));
        assert_eq!(until(Duration::from_secs(1), async { 42 }), Ok(42));
    }
}
