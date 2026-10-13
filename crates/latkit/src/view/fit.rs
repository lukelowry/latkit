//! Framing what is drawn: a fit measures vertex extents on the GPU, reads them back, and moves the
//! camera when they arrive, a frame or two later.

use super::{Event, View};
use crate::gpu::readback::Readback;
use crate::scene::mark::MarkKind;

/// Padding around fitted extents, CSS pixels.
const PADDING: f64 = 24.0;

pub(crate) enum Fitting {
    Idle,
    /// Asked for; measures once its vertex marks are drawn.
    Requested,
    Measuring(Readback),
}

impl Fitting {
    pub(crate) fn busy(&self) -> bool {
        !matches!(self, Fitting::Idle)
    }
}

impl View {
    /// Whether this frame measures: a fit was asked for and every vertex mark with data is drawn.
    /// A fit with nothing to frame ends here.
    pub(super) fn measuring(&mut self) -> bool {
        if !matches!(self.fitting, Fitting::Requested) {
            return false;
        }
        let vertices: Vec<&_> =
            self.marks.iter().filter(|m| m.kind() == MarkKind::Vertices && m.compiled.is_some()).collect();
        if vertices.is_empty() {
            self.fitting = Fitting::Idle;
            return false;
        }
        vertices.iter().all(|m| m.drawable() && !m.tables.waiting())
    }

    /// Moves the camera onto the measured extents once they are read back.
    pub(super) fn settle_fit(&mut self, size: [f64; 2]) {
        let Fitting::Measuring(readback) = &self.fitting else { return };
        let Some(bytes) = readback.take() else { return };
        self.fitting = Fitting::Idle;
        let Ok(bytes) = bytes else { return };
        let words: &[u32] = bytemuck::cast_slice(&bytes);
        let mut bounds: Option<[f64; 4]> = None;
        for (i, shown) in self.marks.iter().enumerate() {
            let Some(e) = words.get(4 * i..4 * i + 4) else { break };
            if shown.kind() != MarkKind::Vertices || e[2] == 0 {
                continue;
            }
            let b = [unordered(!e[0]), unordered(!e[1]), unordered(e[2]), unordered(e[3])].map(f64::from);
            bounds = Some(bounds.map_or(b, |a| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]));
        }
        if let Some(bounds) = bounds {
            self.camera = self.camera.fit(&self.scene.space, bounds, size, PADDING);
            self.flight = None;
            self.events.push(Event::Camera);
        }
    }
}

/// The `f32` an ordered word stands for (see `lib/reduce.wesl`).
fn unordered(u: u32) -> f32 {
    f32::from_bits(if u & 0x8000_0000 != 0 { u & 0x7fff_ffff } else { !u })
}

#[cfg(test)]
mod tests {
    use super::unordered;

    /// The inverse of `lib/reduce.wesl`'s `ordered`.
    fn ordered(x: f32) -> u32 {
        let b = x.to_bits();
        if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 }
    }

    #[test]
    fn ordered_words_sort_like_their_values() {
        let values = [-1e9_f32, -2.5, -0.0, 0.0, 1e-9, 3.0, 1e9];
        for pair in values.windows(2) {
            assert!(ordered(pair[0]) <= ordered(pair[1]), "{pair:?}");
        }
        for v in values {
            assert_eq!(unordered(ordered(v)), v);
        }
    }
}
