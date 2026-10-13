//! Framing what is drawn. A box frames at once; anything else is measured on the GPU, read back, and
//! framed a frame or two later. A plot without a value range measures its traces whenever they or
//! the camera change, and grows its range with headroom so the axes stay still.

use super::event::Fit;
use super::View;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Camera, Space};

#[derive(Default)]
pub(crate) struct Fitting {
    /// A fit waiting for its frame.
    pub(crate) wanted: Option<Fit>,
    /// Extents in flight, and the fit they were measured for.
    reading: Option<(Readback, Option<Fit>)>,
    /// Whether a plot's traces changed since they were last measured.
    pub(crate) plot_due: bool,
}

impl Fitting {
    pub(crate) fn busy(&self) -> bool {
        self.wanted.is_some() || self.reading.is_some()
    }
}

/// What this frame measures: whether only rows marked for a fit count, and the fit it serves.
pub(crate) struct Measure {
    pub(crate) rows: bool,
    pub(crate) fit: Option<Fit>,
}

impl View {
    /// Applies a box fit, a plot's fit, or measured extents that landed.
    pub(super) fn settle_fit(&mut self) {
        if self.size[0] <= 0.0 {
            return;
        }
        match &self.fitting.wanted {
            Some(Fit::Bounds { min, max }) => {
                let camera = self.camera.framing(&self.scene.space, *min, *max, self.size, self.area());
                self.fitting.wanted = None;
                self.flight = None;
                self.move_camera(camera);
            }
            Some(Fit::All) if matches!(self.scene.space, Space::Plot(_)) => {
                if let Some(span) = self.traced_span() {
                    self.fitting.wanted = None;
                    self.plot_y = None;
                    self.move_camera(Camera::Plot { x: span, y: None });
                }
            }
            _ => {}
        }
        let Some((readback, _)) = &self.fitting.reading else { return };
        let Some(bytes) = readback.take() else { return };
        let fit = self.fitting.reading.take().and_then(|(_, fit)| fit);
        if let Ok(bytes) = bytes {
            self.measured(bytemuck::cast_slice(&bytes), fit);
        }
        if !self.focus.fitting.is_empty() {
            self.focus.fitting.clear();
            self.focus.dirty = true;
        }
    }

    /// What this frame measures, if anything: a fit whose marks are drawn, or a plot's traces.
    pub(super) fn measuring(&mut self) -> Option<Measure> {
        if self.fitting.reading.is_some() || self.size[0] <= 0.0 {
            return None;
        }
        let ready = self.marks.iter().filter(|m| m.compiled.is_some()).all(|m| m.drawable() && !m.tables.waiting());
        if matches!(self.fitting.wanted, Some(Fit::All | Fit::Rows(_) | Fit::Reveal(_))) {
            let measurable = self.marks.iter().any(|m| m.compiled.is_some() && m.measured());
            if !measurable {
                self.fitting.wanted = None;
                return None;
            }
            if !ready {
                return None;
            }
            let fit = self.fitting.wanted.take();
            return Some(Measure { rows: !matches!(fit, Some(Fit::All)), fit });
        }
        let auto = matches!(self.camera, Camera::Plot { y: None, .. });
        if auto && self.fitting.plot_due && ready && self.marks.iter().any(|m| m.kind() == MarkKind::Lines) {
            self.fitting.plot_due = false;
            return Some(Measure { rows: false, fit: None });
        }
        None
    }

    pub(super) fn measuring_started(&mut self, readback: Readback, fit: Option<Fit>) {
        self.fitting.reading = Some((readback, fit));
    }

    /// Frames the extents measured for `fit`, or fits a plot's value range to its traces.
    fn measured(&mut self, words: &[u32], fit: Option<Fit>) {
        let stride = wgsl::EXTENT_WORDS as usize;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for (i, shown) in self.marks.iter().enumerate() {
            let Some(e) = words.get(stride * i..stride * (i + 1)) else { break };
            if !shown.measured() || e[3] == 0 {
                continue;
            }
            for k in 0..3 {
                lo[k] = lo[k].min(f64::from(unordered(!e[k])));
                hi[k] = hi[k].max(f64::from(unordered(e[3 + k])));
            }
        }
        if !(lo[0] <= hi[0]) {
            return;
        }
        match fit {
            None => self.fit_values(lo[1], hi[1]),
            Some(Fit::Reveal(_)) => {
                let middle = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1]), lo[2].midpoint(hi[2])];
                let view = self.projected();
                let area = self.area();
                let inside = view.screen(view.world(middle)).is_some_and(|s| {
                    s[0] >= area[0] && s[0] <= area[2] && s[1] >= area[1] && s[1] <= area[3]
                });
                if !inside {
                    let camera = self.camera.centered(middle);
                    self.fly(camera);
                }
            }
            Some(_) => {
                let camera = self.camera.framing(&self.scene.space, lo, hi, self.size, self.area());
                if let Camera::Plot { y: None, .. } = self.camera {
                    self.plot_y = None;
                }
                self.flight = None;
                self.move_camera(camera);
            }
        }
    }

    /// Grows the value range a plot shows to hold `lo..hi` with headroom, and shrinks it once the
    /// values fill less than a third of it.
    fn fit_values(&mut self, lo: f64, hi: f64) {
        let holds = self.plot_y.is_some_and(|[a, b]| lo >= a && hi <= b && (hi - lo) * 3.0 >= b - a);
        if !holds {
            let pad = if hi > lo { (hi - lo) * 0.12 } else { lo.abs().max(1.0) * 0.1 };
            self.plot_y = Some([lo - pad, hi + pad]);
            self.wake();
        }
    }

    /// The coordinates a plot's traces span.
    fn traced_span(&self) -> Option<[f64; 2]> {
        let spans = self.marks.iter().filter_map(|shown| {
            let crate::Mark::Lines(lines) = &shown.mark else { return None };
            let style = shown.mark.style();
            let table = self.data(&style.data)?.table(&style.table)?;
            match table.field_named(lines.samples.as_ref()?)? {
                crate::data::Field::Sampled(samples, _) => samples.span(),
                _ => None,
            }
        });
        spans.reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])]).map(|[a, b]| if b > a { [a, b] } else { [a - 0.5, a + 0.5] })
    }
}

impl super::marks::Shown {
    /// Whether this mark's extents frame a fit: vertices, and the traces of lines.
    pub(crate) fn measured(&self) -> bool {
        matches!(self.kind(), MarkKind::Vertices | MarkKind::Lines)
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
