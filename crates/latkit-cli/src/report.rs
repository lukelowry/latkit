//! Diagnostics on stderr. As JSON, one `{ "type", "detail" }` object per line, the shape of a
//! view's events in JavaScript: `progress` after each frame, `stats` when done, and `error` with
//! the library's `{ code, message, path }` and the source file. For people, one line per error,
//! and on a terminal a progress line that rewrites itself.

use std::io::{self, IsTerminal, Write};
use std::time::Instant;

use latkit::{Gpu, View};
use serde_json::{Value, json};

use crate::Failure;
use crate::args::Diagnostics;

pub(crate) struct Report {
    json: bool,
    /// Whether stderr is a terminal, where progress is shown.
    terminal: bool,
    started: Instant,
    /// Whether a progress line is on screen.
    showing: bool,
}

impl Report {
    pub(crate) fn new(diagnostics: Diagnostics) -> Report {
        Report {
            json: diagnostics == Diagnostics::Json,
            terminal: io::stderr().is_terminal(),
            started: Instant::now(),
            showing: false,
        }
    }

    /// Reports `frames` drawn, with the next at `time` seconds of video.
    pub(crate) fn progress(&mut self, frames: u64, time: f64) {
        if self.json {
            Report::line(&json!({"type": "progress", "detail": {"frames": frames, "time": time}}));
        } else if self.terminal {
            let seconds = self.started.elapsed().as_secs_f64();
            let _ = write!(io::stderr().lock(), "\rlatkit: {frames} frames, {time:.2} s of video, in {seconds:.1} s");
            self.showing = true;
        }
    }

    /// Reports the frames drawn and the time, stats, and GPU work they took.
    pub(crate) fn done(&mut self, frames: u64, views: &[View], gpu: &Gpu) {
        let seconds = self.started.elapsed().as_secs_f64();
        if self.json {
            let views: Vec<Value> =
                views.iter().map(|v| serde_json::to_value(v.stats()).unwrap_or(Value::Null)).collect();
            let work = serde_json::to_value(gpu.work()).unwrap_or(Value::Null);
            let detail = json!({"frames": frames, "seconds": seconds, "views": views, "work": work});
            Report::line(&json!({"type": "stats", "detail": detail}));
        } else if self.terminal {
            let rate = frames as f64 / seconds.max(1e-9);
            let _ =
                writeln!(io::stderr().lock(), "\rlatkit: {frames} frames in {seconds:.1} s, {rate:.1} a second    ");
            self.showing = false;
        }
    }

    /// Reports why the command failed.
    pub(crate) fn error(&mut self, failure: &Failure) {
        if self.json {
            let mut detail = serde_json::to_value(&failure.error).unwrap_or(Value::Null);
            if let (Some(source), Value::Object(map)) = (&failure.source, &mut detail) {
                map.insert("source".into(), json!(source));
            }
            Report::line(&json!({"type": "error", "detail": detail}));
            return;
        }
        let mut err = io::stderr().lock();
        if self.showing {
            let _ = writeln!(err);
        }
        // A closed stderr must not turn a failure into a panic.
        let _ = match &failure.source {
            Some(source) => writeln!(err, "latkit: {source}: {}", failure.error),
            None => writeln!(err, "latkit: {}", failure.error),
        };
    }

    fn line(value: &Value) {
        let _ = writeln!(io::stderr().lock(), "{value}");
    }
}
