//! The latkit command line. It renders scenes and datasets, given as the library's JSON or bytes,
//! natively into images, image sequences, raw frames, and videos.

mod args;
mod inputs;
mod render;
mod report;
mod sinks;

use std::future::Future;
use std::io;
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
use sinks::{Output, written};

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

/// A command's failure: the library's error, and the input file at fault, if any. An output that
/// fails to be written is named in the error's message instead.
#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) error: Error,
    pub(crate) source: Option<String>,
}

impl Failure {
    /// `error`, caused by the input file at `path`.
    pub(crate) fn at(error: Error, path: &Path) -> Failure {
        Failure { error, source: Some(path.to_string_lossy().into_owned()) }
    }

    /// An I/O `error` reading the input file at `path`.
    pub(crate) fn io(error: &io::Error, path: &Path) -> Failure {
        Failure::at(Error::Io(error.to_string().into()), path)
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Failure {
        Failure { error, source: None }
    }
}

/// Prints `value` to stdout as indented JSON.
fn print_json(value: &impl serde::Serialize) -> Result<(), Failure> {
    let mut out = Output::create(Path::new("-"))?;
    out.json(value, true)?;
    Ok(out.commit()?)
}

/// Prints every dataset's description as JSON to stdout: its name, axis and span, and each table's
/// rows and fields.
fn inspect(sources: &[Source], deadline: Duration) -> Result<(), Failure> {
    let host = latkit::host::Native::new();
    let mut all = Vec::with_capacity(sources.len());
    for source in sources {
        all.push(inputs::dataset(source, &host, deadline)?.snapshot().describe());
    }
    print_json(&all)
}

/// Prints the JSON Schema of every input to stdout. With `input`, the root `$ref` points to that
/// input's definition.
fn schema(input: Option<Input>) -> Result<(), Failure> {
    let mut schemas = latkit::schemas();
    let frames = latkit::schema::<inputs::Frame>();
    let defs = schemas["$defs"].as_object_mut().expect("the schemas have $defs");
    for (name, def) in frames["$defs"].as_object().into_iter().flatten() {
        defs.entry(name.clone()).or_insert_with(|| def.clone());
    }
    let mut frame = frames.clone();
    frame.as_object_mut().expect("a schema is an object").retain(|key, _| key != "$defs" && key != "$schema");
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
    print_json(&schemas)
}

/// Prints the rows `query` selects from the dataset as JSON Lines to stdout. Each line has `id`,
/// then each field. A reference prints as its target's id, and a missing value as `null`.
fn query(source: &Source, query: &str, deadline: Duration) -> Result<(), Failure> {
    let query: Query = inputs::json(query, "query")?;
    let rows = inputs::dataset(source, &latkit::host::Native::new(), deadline)?.snapshot().query(&query)?.table;
    let columns: Vec<(String, Values)> =
        rows.fields().map(|(name, _)| (name.to_string(), rows.values(name).expect("the field exists"))).collect();
    let mut out = Output::create(Path::new("-"))?;
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
        out.json(&line, false)?;
    }
    Ok(out.commit()?)
}

/// Writes the dataset as time tiles in directory `output`: the manifest, the dataset without its
/// sampled fields' histories, and those histories in spans of `chunk` entries.
fn tile(source: &Source, output: &Path, chunk: u32, deadline: Duration) -> Result<(), Failure> {
    let data = inputs::dataset(source, &latkit::host::Native::new(), deadline)?.snapshot();
    let tiled = data.to_tiles(chunk, |path, bytes| {
        let file = output.join(path);
        let wrote = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&file, bytes));
        wrote.map_err(|e| written(&e, &file))
    });
    Ok(tiled?)
}

/// Drives `future` on this thread and returns its result, or [`Error::Timeout`] at `deadline`.
pub(crate) fn block<T>(deadline: Duration, future: impl Future<Output = latkit::Result<T>>) -> latkit::Result<T> {
    until(deadline, future)?
}

/// Drives `future` on this thread, parking between polls, until it finishes or `deadline` passes.
/// The deadline is checked only between polls, so it cannot interrupt a blocking OS or driver call.
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
