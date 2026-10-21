//! Framing what is drawn. A box frames at once, and so does what the CPU already knows: a diagram's
//! sheet holds every box and wire, and tiles hold the bounds of every row they draw. Anything else is
//! measured on the GPU, read back, and framed a frame or two later. A plot without a value range
//! measures its traces whenever they or the camera change, and grows its range with headroom so the
//! axes stay still.

use super::View;
use super::camera::Bounds;
use super::event::Fit;
use super::marks::Shown;
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
    /// Whether extents are being read back.
    pub(crate) fn reading(&self) -> bool {
        self.reading.is_some()
    }

    /// Whether a fit waits for a frame to measure it: none while extents are being read back.
    pub(crate) fn due(&self) -> bool {
        self.wanted.is_some() && self.reading.is_none()
    }

    /// Whether a fit is about to move the camera: one waiting, or its extents being read back.
    pub(crate) fn framing(&self) -> bool {
        self.wanted.is_some() || self.reading.as_ref().is_some_and(|(_, fit)| fit.is_some())
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
            &Some(Fit::Bounds { min, max }) => {
                self.fitting.wanted = None;
                self.frame_box(min, max, false);
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
            self.measured(bytemuck::cast_slice(&bytes), fit.as_ref());
        }
        self.fitted();
    }

    /// Lets go of the rows marked for a fit, once it framed them.
    fn fitted(&mut self) {
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
        // A plot that traces frames everything by its traces' whole span, which settles once their
        // data is drawn; measuring them first would frame only what shows up to the coordinate shown.
        let plot = matches!(self.scene.space, Space::Plot(_));
        if plot && matches!(self.fitting.wanted, Some(Fit::All)) && self.traces() {
            return None;
        }
        // A fit frames what shows once data has streamed, its shapes are triangulated and bent, and any
        // layout has placed it; in a diagram, once vertices stand where their sheet puts them.
        let easing = matches!(self.scene.space, Space::Diagram(_))
            && self
                .marks
                .iter()
                .any(|m| m.kind() == MarkKind::Vertices && (m.transition.is_some() || m.begin.is_some()));
        let all = matches!(self.fitting.wanted, Some(Fit::All));
        // Everything a table drawn through tiles holds frames by its rows' bounds, whatever is drawn. A
        // mark with no rows has nothing to frame: it holds a fit only while no mark has rows.
        let compiled = || self.marks.iter().filter(|m| m.compiled.is_some());
        let drawn = |m: &Shown| (m.drawable() && !m.tables.waiting()) || (all && self.tiled_bounds(m).is_some());
        let empty = |m: &Shown| m.tables.synced() && m.rows + m.exits == 0;
        let ready = compiled().any(&drawn)
            && compiled().all(|m| drawn(m) || empty(m))
            && !self.derived.sheet.placing()
            && !self.derived.shaping()
            && !easing;
        if let Some(fit) = self.fitting.wanted.clone().filter(|f| matches!(f, Fit::All | Fit::Rows(_) | Fit::Reveal(_)))
        {
            let measurable = self.marks.iter().any(|m| m.compiled.is_some() && m.measured());
            if !measurable {
                self.fitting.wanted = None;
                return None;
            }
            if let Some(b) = self.known(&fit, ready) {
                self.fitting.wanted = None;
                self.frame_fit([b[0], b[1], 0.0], [b[2], b[3], 0.0], Some(&fit));
                self.fitted();
                return None;
            }
            if !ready {
                return None;
            }
            self.fitting.wanted = None;
            return Some(Measure { rows: !matches!(fit, Fit::All), fit: Some(fit) });
        }
        let auto = matches!(self.camera, Camera::Plot { y: None, .. });
        if auto && self.fitting.plot_due && ready && self.marks.iter().any(|m| m.kind() == MarkKind::Lines) {
            self.fitting.plot_due = false;
            return Some(Measure { rows: false, fit: None });
        }
        None
    }

    /// Whether the only fit under way is a plot measuring its traces again for a value range it has,
    /// as streaming data has it do every frame: what no opening waits for.
    pub(super) fn refitting(&self) -> bool {
        self.plot_y.is_some() && !self.fitting.framing()
    }

    pub(super) fn measuring_started(&mut self, readback: Readback, fit: Option<Fit>) {
        self.fitting.reading = Some((readback, fit));
    }

    /// Frames the extents measured for `fit`, or fits a plot's value range to its traces.
    fn measured(&mut self, words: &[u32], fit: Option<&Fit>) {
        let stride = wgsl::EXTENT_WORDS as usize;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for (i, shown) in self.marks.iter().enumerate() {
            if !shown.measured() {
                continue;
            }
            if let Some([w, s, e, n]) = self.tiled_bounds(shown).filter(|_| matches!(fit, Some(Fit::All))) {
                lo = [lo[0].min(w), lo[1].min(s), lo[2].min(0.0)];
                hi = [hi[0].max(e), hi[1].max(n), hi[2].max(0.0)];
                continue;
            }
            let Some(e) = words.get(stride * i..stride * (i + 1)) else { break };
            if e[3] == 0 {
                continue;
            }
            for k in 0..3 {
                lo[k] = lo[k].min(f64::from(unordered(!e[k])));
                hi[k] = hi[k].max(f64::from(unordered(e[3 + k])));
            }
        }
        self.frame_fit(lo, hi, fit);
    }

    /// The box `fit` frames when it is known without measuring, least x and y then greatest: in a
    /// diagram once its sheet stands, its vertices and wires, or the boxes of the rows fitted; else,
    /// with every mark `ready`, where only tables drawn through tiles are measured, their bounds.
    fn known(&self, fit: &Fit, ready: bool) -> Option<[f64; 4]> {
        let union = |a: [f64; 4], b: [f64; 4]| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])];
        let sheet = &self.derived.sheet;
        if matches!(self.scene.space, Space::Diagram(_)) && !sheet.placing() {
            return match fit {
                Fit::All => sheet.extent(),
                _ => self.focus.fitting.iter().map(|row| sheet.bounds(row)).reduce(|a, b| Some(union(a?, b?)))?,
            };
        }
        let measured = || self.marks.iter().filter(|m| m.measured());
        let gpu = measured().any(|m| m.drawable() && self.tiled_bounds(m).is_none());
        if !ready || gpu || !matches!(fit, Fit::All) {
            return None;
        }
        measured().filter_map(|m| self.tiled_bounds(m)).reduce(union)
    }

    /// Frames `lo..hi` as `fit` asks: without one, a plot's value range; to reveal a row, the camera
    /// brought to it where it lies out of view; else the box.
    fn frame_fit(&mut self, lo: [f64; 3], hi: [f64; 3], fit: Option<&Fit>) {
        if lo[0] > hi[0] {
            return;
        }
        match fit {
            None => self.fit_values(lo[1], hi[1]),
            Some(Fit::Reveal(_)) => {
                let middle = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1]), lo[2].midpoint(hi[2])];
                let view = self.projected();
                let area = self.area();
                let inside = view
                    .screen(view.world(middle))
                    .is_some_and(|s| s[0] >= area[0] && s[0] <= area[2] && s[1] >= area[1] && s[1] <= area[3]);
                if !inside {
                    let camera = self.camera.centered(middle);
                    self.fly(camera);
                }
            }
            Some(fit) => {
                if let Camera::Plot { y: None, .. } = self.camera {
                    self.plot_y = None;
                }
                self.frame_box(lo, hi, matches!(fit, Fit::All));
            }
        }
    }

    /// The bounds of every row `shown` draws through tiles, whatever tiles are drawn.
    fn tiled_bounds(&self, shown: &Shown) -> Option<[f64; 4]> {
        let style = shown.mark.style();
        self.derived.tiled.bounds(&style.data, &style.table)
    }

    /// Frames the box `min..max` at once. Framing everything sets how far the camera can go from it;
    /// framing part of it widens that reach, never narrows it.
    fn frame_box(&mut self, min: [f64; 3], max: [f64; 3], everything: bool) {
        let camera = self.camera.framing(&self.scene.space, min, max, self.size, self.area());
        self.rig.hold();
        let framed = match camera {
            Camera::Map { zoom, .. } => Some(Bounds { min, max, zoom: [zoom; 2] }),
            Camera::Plot { .. } => None,
        };
        self.rig.bounds = match (self.rig.bounds, framed) {
            _ if everything => framed,
            (Some(reach), Some(framed)) => Some(reach.with(framed)),
            (reach, _) => reach,
        };
        self.move_camera(camera);
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
    /// Whether a mark traces a sampled field.
    fn traces(&self) -> bool {
        self.marks.iter().any(|shown| matches!(&shown.mark, crate::Mark::Lines(lines) if lines.trace.is_some()))
    }

    fn traced_span(&self) -> Option<[f64; 2]> {
        let spans = self.marks.iter().filter_map(|shown| {
            let crate::Mark::Lines(lines) = &shown.mark else { return None };
            let style = shown.mark.style();
            let table = self.drawn(&style.data)?.table(&style.table)?;
            match table.field_named(&lines.traced())? {
                crate::data::Field::Sampled(samples, _) => samples.span(),
                _ => None,
            }
        });
        spans
            .reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])])
            .map(|[a, b]| if b > a { [a, b] } else { [a - 0.5, a + 0.5] })
    }
}

impl super::marks::Shown {
    /// Whether this mark's extents frame a fit: vertices, lines, and areas.
    pub(crate) fn measured(&self) -> bool {
        matches!(self.kind(), MarkKind::Vertices | MarkKind::Lines | MarkKind::Areas)
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
