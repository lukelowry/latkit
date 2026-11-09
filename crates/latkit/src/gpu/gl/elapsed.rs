//! GPU time of the commands between two points of an encoder, with the `TIME_ELAPSED_EXT` queries
//! of `EXT_disjoint_timer_query_webgl2`. WebGL2 writes no timestamps on Direct3D, so this is how a
//! view times its frames in a browser. A result arrives a few browser tasks after its frame, and an
//! event that makes timing unreliable, such as a GPU reset, discards the results at hand.

use super::command::{Command, Encoder};
use std::cell::Cell;
use std::rc::Rc;
use web_sys::{WebGl2RenderingContext as Gl, WebGlQuery};

/// `TIME_ELAPSED_EXT`.
pub(super) const TIME_ELAPSED: u32 = 0x88BF;
/// `QUERY_COUNTER_BITS_EXT`.
const COUNTER_BITS: u32 = 0x8864;
/// `GPU_DISJOINT_EXT`.
const DISJOINT: u32 = 0x8FBB;

/// A query, and whether the commands that end it ran.
#[derive(Debug)]
pub(super) struct Query {
    pub(super) raw: WebGlQuery,
    pub(super) ended: Cell<bool>,
}

/// One query timing the commands between [`begin`](Elapsed::begin) and [`end`](Elapsed::end).
pub(crate) struct Elapsed {
    gl: Gl,
    query: Rc<Query>,
    /// Whether it was ended and its result not yet read.
    pending: bool,
}

impl Elapsed {
    /// A query on `device`, or `None` unless it is latkit's WebGL2 device and the browser times GPU
    /// work.
    pub(crate) fn new(device: &wgpu::Device) -> Option<Elapsed> {
        let gl = device.as_custom::<super::device::Device>()?.0.gl.clone();
        gl.get_extension("EXT_disjoint_timer_query_webgl2").ok()??;
        let bits = gl.get_query(TIME_ELAPSED, COUNTER_BITS).as_f64()?;
        if bits < 1.0 {
            return None;
        }
        let raw = gl.create_query()?;
        Some(Elapsed { gl, query: Rc::new(Query { raw, ended: Cell::new(false) }), pending: false })
    }

    /// Whether it can time another frame.
    pub(crate) fn free(&self) -> bool {
        !self.pending
    }

    /// Starts timing the commands `encoder` records next.
    pub(crate) fn begin(&mut self, encoder: &wgpu::CommandEncoder) {
        if let Some(encoder) = encoder.as_custom::<Encoder>() {
            self.query.ended.set(false);
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

    /// The milliseconds the timed commands took, once the browser has the result. It is freed then,
    /// and also once the result is discarded: when `disjoint` says timing was unreliable since the
    /// last check, which [`disjoint`] reads, or when the context is lost.
    pub(crate) fn take(&mut self, disjoint: bool) -> Option<f32> {
        if !self.pending || !self.query.ended.get() {
            return None;
        }
        let available = self.gl.get_query_parameter(&self.query.raw, Gl::QUERY_RESULT_AVAILABLE);
        if available.as_bool() != Some(true) {
            // A lost context answers null, and its query never completes.
            self.pending = !self.gl.is_context_lost();
            return None;
        }
        self.pending = false;
        let nanoseconds = self.gl.get_query_parameter(&self.query.raw, Gl::QUERY_RESULT).as_f64()?;
        (!disjoint).then_some((nanoseconds / 1e6) as f32)
    }
}

impl Drop for Elapsed {
    fn drop(&mut self) {
        self.gl.delete_query(Some(&self.query.raw));
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
