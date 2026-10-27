//! Fits: moving the camera to frame what is drawn.
//!
//! A box fits at once, as does anything whose extent the CPU already knows. A diagram's sheet has
//! every box and wire, and tiles have the bounds of every row they draw. Anything else is measured
//! on the GPU, read back, and framed a frame or two later. A plot without a value range measures
//! its traces whenever they or the camera change. It grows its range with headroom so the axes
//! stay still.

use super::View;
use super::camera::Bounds;
use super::event::Fit;
use super::marks::Shown;
use crate::derive::Working;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Camera, Space};

#[derive(Default)]
pub(crate) struct Fitting {
    /// A fit waiting for its frame.
    pub(crate) wanted: Option<Fit>,
    /// The extents being read back, and the fit they are measured for.
    reading: Working<Option<Fit>, Readback>,
    /// Whether a plot's traces changed since they were last measured.
    pub(crate) plot_due: bool,
}

impl Fitting {
    /// Whether extents are being read back.
    pub(crate) fn reading(&self) -> bool {
        self.reading.busy()
    }

    /// Whether a fit is waiting to be measured. Always false while extents are being read back.
    pub(crate) fn due(&self) -> bool {
        self.wanted.is_some() && !self.reading.busy()
    }

    /// Whether a fit is about to move the camera: one waiting, or its extents being read back.
    pub(crate) fn framing(&self) -> bool {
        self.wanted.is_some() || self.reading.context().is_some_and(Option::is_some)
    }
}

/// What this frame measures: whether only rows marked for a fit count, and the fit it serves.
pub(crate) struct Measure {
    pub(crate) rows: bool,
    pub(crate) fit: Option<Fit>,
}

impl View {
    /// Applies a box fit, a plot's fit to its traces' span, or measured extents that arrived.
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
        let Some((_, fit, bytes)) = self.fitting.reading.landed() else { return };
        if let Ok(bytes) = bytes {
            self.measured(&crate::wire::words(&bytes), fit.as_ref());
        }
        self.fitted();
    }

    /// Clears the rows marked for a fit once it framed them.
    fn fitted(&mut self) {
        if !self.focus.fitting.is_empty() {
            self.focus.fitting.clear();
            self.focus.dirty = true;
        }
    }

    /// What this frame measures, if anything: a fit whose marks are drawn, or a plot's traces.
    pub(super) fn measuring(&mut self) -> Option<Measure> {
        if self.fitting.reading.busy() || self.size[0] <= 0.0 {
            return None;
        }
        // A plot with traces fits everything to their whole span once their data is available.
        // Measuring instead would frame only what is drawn up to the coordinate shown.
        let plot = matches!(self.scene.space, Space::Plot(_));
        if plot && matches!(self.fitting.wanted, Some(Fit::All)) && self.traces() {
            return None;
        }
        // A fit waits until data has streamed, shapes are triangulated and bent, and any layout has
        // placed the rows. In a diagram it also waits until vertices reach where the sheet puts
        // them.
        let easing = matches!(self.scene.space, Space::Diagram(_))
            && self
                .marks
                .iter()
                .any(|m| m.kind() == MarkKind::Vertices && (m.transition.is_some() || m.begin.is_some()));
        let all = matches!(self.fitting.wanted, Some(Fit::All));
        // Fitting everything uses a tiled table's row bounds, regardless of what is drawn. A mark
        // with no rows has nothing to frame. It only delays a fit while no mark has rows.
        let compiled = || self.marks.iter().filter(|m| m.compiled.is_some());
        let staged = |m: &Shown| self.staged.get(&m.mark.style().data).is_some_and(|s| !s.is_empty());
        let drawn = |m: &Shown| (m.drawable() && !staged(m)) || (all && self.tiled_bounds(m).is_some());
        let empty = |m: &Shown| m.tables.synced() && m.held() == 0;
        let ready = compiled().any(&drawn)
            && compiled().all(|m| drawn(m) || empty(m))
            && !self.derived.placing()
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

    pub(super) fn measuring_started(&mut self, readback: Readback, fit: Option<Fit>) {
        self.fitting.reading.start(0, readback, fit);
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
                lo[k] = lo[k].min(f64::from(crate::order::from_number32(!e[k])));
                hi[k] = hi[k].max(f64::from(crate::order::from_number32(e[3 + k])));
            }
        }
        self.frame_fit(lo, hi, fit);
    }

    /// The box `fit` frames, if known without measuring, as `[min x, min y, max x, max y]`. In a
    /// diagram whose sheet is placed, it is the sheet's extent or the union of the fitted rows'
    /// boxes. Otherwise, for `Fit::All` once every mark is `ready` and only tiled tables are
    /// measured, it is their bounds.
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

    /// Frames `lo..hi` as `fit` asks. With no fit, fits a plot's value range. For `Fit::Reveal`,
    /// centers the camera on the row if it is out of view. Otherwise frames the box.
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

    /// The bounds of every row of `shown`'s tiled table, regardless of which tiles are drawn.
    fn tiled_bounds(&self, shown: &Shown) -> Option<[f64; 4]> {
        let style = shown.mark.style();
        self.derived.tiled.bounds(&style.data, &style.table)
    }

    /// Frames the box `min..max` at once, within the camera's zoom and pan limits. A fit to
    /// everything sets the box that narrows the limits. A fit to part of it grows that box and
    /// never shrinks it.
    fn frame_box(&mut self, min: [f64; 3], max: [f64; 3], everything: bool) {
        let camera = self.camera.framing(&self.scene.space, min, max, self.size, self.area());
        self.rig.hold();
        let framed = match camera {
            Camera::Map { zoom, .. } => Some(Bounds { min, max, zoom: [zoom; 2] }),
            Camera::Plot { .. } => None,
        };
        self.rig.bounds = match (self.rig.bounds, framed) {
            _ if everything => framed,
            (Some(bounds), Some(framed)) => Some(bounds.with(framed)),
            (bounds, _) => bounds,
        };
        self.move_camera(camera);
    }

    /// Grows the value range a plot shows to hold `lo..hi` with 12% headroom on each side, and
    /// shrinks it once the values fill less than a third of it.
    fn fit_values(&mut self, lo: f64, hi: f64) {
        let holds = self.plot_y.is_some_and(|[a, b]| lo >= a && hi <= b && (hi - lo) * 3.0 >= b - a);
        if !holds {
            let pad = if hi > lo { (hi - lo) * 0.12 } else { lo.abs().max(1.0) * 0.1 };
            self.plot_y = Some([lo - pad, hi + pad]);
            self.wake();
        }
    }

    /// Whether a mark traces a sampled field.
    fn traces(&self) -> bool {
        self.marks.iter().any(|shown| matches!(&shown.mark, crate::Mark::Lines(lines) if lines.trace.is_some()))
    }

    /// The axis range a plot's traces span, widened to a unit range around a single point.
    fn traced_span(&self) -> Option<[f64; 2]> {
        let spans = self.marks.iter().filter_map(|shown| {
            let crate::Mark::Lines(lines) = &shown.mark else { return None };
            let style = shown.mark.style();
            let table = self.snapshot(&style.data)?.table(&style.table)?;
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
    /// Whether fits frame this mark's extents, which depends on its kind.
    pub(crate) fn measured(&self) -> bool {
        self.kind().bounds().is_some()
    }
}
