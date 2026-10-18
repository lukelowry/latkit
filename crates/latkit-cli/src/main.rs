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
use latkit::Error;
use serde_json::{Value, json};

use args::{Cli, Command, Source};
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
        Failure::at(Error::Load(error.to_string().into()), path)
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Failure {
        Failure { error, source: None }
    }
}

/// Every dataset as JSON on stdout: its name, axis and span, and each table's rows and fields' kinds.
fn inspect(sources: &[Source], deadline: Duration) -> Result<(), Failure> {
    let host = latkit::host::Native::new();
    let mut all = Vec::with_capacity(sources.len());
    for source in sources {
        let data = inputs::dataset(source, &host, deadline)?;
        let tables: serde_json::Map<String, Value> = data
            .tables()
            .map(|table| {
                let fields: serde_json::Map<String, Value> = table
                    .fields()
                    .map(|(name, kind)| (name.to_string(), serde_json::to_value(kind).unwrap_or(Value::Null)))
                    .collect();
                (table.name().to_string(), json!({"rows": table.len(), "fields": fields}))
            })
            .collect();
        all.push(json!({"name": data.name().as_str(), "axis": data.axis(), "span": data.span(), "tables": tables}));
    }
    let mut out = io::stdout().lock();
    serde_json::to_writer_pretty(&mut out, &all).map_err(|e| Failure::from(Error::Load(e.to_string().into())))?;
    writeln!(out).map_err(|e| Failure::io(&e, Path::new("-")))
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
