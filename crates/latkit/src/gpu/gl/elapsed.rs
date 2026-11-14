//! GPU time of the commands between two points of an encoder, with the `TIME_ELAPSED_EXT` queries
//! of `EXT_disjoint_timer_query_webgl2`. WebGL2 writes no timestamps on Direct3D, so this is how a
//! view times its frames in a browser. Each command that gives the GPU work runs inside a query of
//! its own, and the time is their sum: what the GPU spent on the commands. One query around them all
//! would also count the time the browser takes to issue them, which leaves the GPU idle. A result
//! arrives a few browser tasks after its frame, and an event that makes timing unreliable, such as a
//! GPU reset, discards the results at hand.

use super::command::{Command, Encoder};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use web_sys::{WebGl2RenderingContext as Gl, WebGlQuery};

/// `TIME_ELAPSED_EXT`.
const TIME_ELAPSED: u32 = 0x88BF;
/// `QUERY_COUNTER_BITS_EXT`.
const COUNTER_BITS: u32 = 0x8864;
/// `GPU_DISJOINT_EXT`.
const DISJOINT: u32 = 0x8FBB;

/// The queries timing one frame's commands, one per command, kept from frame to frame, and whether
/// the commands that end the frame ran.
#[derive(Debug, Default)]
pub(super) struct Query {
    parts: RefCell<Vec<WebGlQuery>>,
    /// How many parts the frame used.
    used: Cell<usize>,
    pub(super) ended: Cell<bool>,
}

impl Query {
    /// Starts timing a frame.
    pub(super) fn start(&self) {
        self.used.set(0);
        self.ended.set(false);
    }

    /// Runs `command` inside a query of its own. A browser that makes no more queries runs it
    /// untimed.
    pub(super) fn time(&self, gl: &Gl, command: impl FnOnce()) {
        let at = self.used.get();
        let part = {
            let mut parts = self.parts.borrow_mut();
            if at == parts.len()
                && let Some(made) = gl.create_query()
            {
                parts.push(made);
            }
            parts.get(at).cloned()
        };
        let Some(part) = part else { return command() };
        gl.begin_query(TIME_ELAPSED, &part);
        command();
        gl.end_query(TIME_ELAPSED);
        self.used.set(at + 1);
    }
}

/// Times the commands between [`begin`](Elapsed::begin) and [`end`](Elapsed::end).
pub(crate) struct Elapsed {
    gl: Gl,
    query: Rc<Query>,
    /// Whether it was ended and its result not yet read.
    pending: bool,
}

impl Elapsed {
    /// A timer on `device`, or `None` unless it is latkit's WebGL2 device and the browser times GPU
    /// work.
    pub(crate) fn new(device: &wgpu::Device) -> Option<Elapsed> {
        let gl = device.as_custom::<super::device::Device>()?.0.gl.clone();
        gl.get_extension("EXT_disjoint_timer_query_webgl2").ok()??;
        let bits = gl.get_query(TIME_ELAPSED, COUNTER_BITS).as_f64()?;
        if bits < 1.0 {
            return None;
        }
        Some(Elapsed { gl, query: Rc::default(), pending: false })
    }

    /// Whether it can time another frame.
    pub(crate) fn free(&self) -> bool {
        !self.pending
    }

    /// Starts timing the commands `encoder` records next.
    pub(crate) fn begin(&mut self, encoder: &wgpu::CommandEncoder) {
        if let Some(encoder) = encoder.as_custom::<Encoder>() {
            encoder.commands.borrow_mut().push(Command::Begin(self.query.clone()));
        }
    }

    /// Stops timing once the commands `encoder` recorded so far run.
    pub(crate) fn end(&mut self, encoder: &wgpu::CommandEncoder) {
        if let Some(encoder) = encoder.as_custom::<Encoder>() {
            encoder.commands.borrow_mut().push(Command::End(self.query.clone()));
            self.pending = true;
        }
    }

    /// The milliseconds the GPU spent on the timed commands, once the browser has every result. It
    /// is freed then, and also once the results are discarded: when `disjoint` says timing was
    /// unreliable since the last check, which [`disjoint`] reads, or when the context is lost.
    pub(crate) fn take(&mut self, disjoint: bool) -> Option<f32> {
        if !self.pending || !self.query.ended.get() {
            return None;
        }
        let parts = self.query.parts.borrow();
        let used = &parts[..self.query.used.get().min(parts.len())];
        let available = |part| self.gl.get_query_parameter(part, Gl::QUERY_RESULT_AVAILABLE).as_bool() == Some(true);
        if !used.iter().all(available) {
            // A lost context answers null, and its queries never complete.
            self.pending = !self.gl.is_context_lost();
            return None;
        }
        self.pending = false;
        let nanoseconds: f64 =
            used.iter().filter_map(|part| self.gl.get_query_parameter(part, Gl::QUERY_RESULT).as_f64()).sum();
        (!disjoint).then_some((nanoseconds / 1e6) as f32)
    }
}

impl Drop for Elapsed {
    fn drop(&mut self) {
        for part in self.query.parts.borrow().iter() {
            self.gl.delete_query(Some(part));
        }
    }
}

/// Whether timing on `device` was unreliable since the last call, as after a GPU reset. Reading it
/// clears it, so a frame reads it once for all its queries.
pub(crate) fn disjoint(device: &wgpu::Device) -> bool {
    device
        .as_custom::<super::device::Device>()
        .and_then(|device| device.0.gl.get_parameter(DISJOINT).ok())
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}
