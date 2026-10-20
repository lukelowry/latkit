//! Probes: what lies under a point, answered by a compute pass over what the frame drew and read back
//! a frame or two later: the nearest row, and the nearest depth drawn. One probe is in flight at a
//! time; a newer point waits for it.

use super::event::{Hit, Sample};
use super::gestures::Gesture;
use super::marks::Shown;
use super::{Device, View};
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::{Camera, Row};

/// A hit, with the depth it lies at for dragging, and for an edge which end it is nearer: 0 its
/// first, 1 its second.
#[derive(Clone, Debug)]
pub(crate) struct Probed {
    pub(crate) hit: Hit,
    pub(crate) depth: f32,
    pub(crate) end: u32,
}

/// What a probe found under its point.
#[derive(Clone, Debug, Default)]
pub(crate) struct Answer {
    pub(crate) hit: Option<Probed>,
    /// The nearest depth drawn around the point; 0 where nothing was drawn.
    pub(crate) under: f32,
}

#[derive(Default)]
pub(crate) struct Probing {
    /// The next point to probe.
    pub(crate) wanted: Option<[f32; 2]>,
    reading: Option<([f32; 2], Readback)>,
    /// The latest answer and the point it was asked for.
    pub(crate) latest: Option<([f32; 2], Answer)>,
}

impl Probing {
    /// Whether a point waits for a frame to probe it: none while a probe is being read back.
    pub(crate) fn due(&self) -> bool {
        self.wanted.is_some() && self.reading.is_none()
    }

    pub(crate) fn hovered(&self) -> Option<&Probed> {
        self.latest.as_ref().and_then(|(_, answer)| answer.hit.as_ref())
    }

    /// The latest answer when it was asked within a pixel or two of `point` and nothing newer waits.
    pub(crate) fn at(&self, point: [f32; 2]) -> Option<Answer> {
        let (asked, answer) = self.latest.as_ref()?;
        (self.wanted.is_none() && self.reading.is_none() && near(*asked, point, 2.0)).then(|| answer.clone())
    }
}

pub(crate) fn near(a: [f32; 2], b: [f32; 2], within: f32) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) <= within
}

impl View {
    /// The point this frame probes: one waits and none is in flight. What the pointer rests on is
    /// probed again whenever the frame changed under it, so a moving frame costs a probe per readback
    /// and a still one nothing.
    pub(super) fn probe_point(&mut self) -> Option<[f32; 2]> {
        if (self.changed || self.easing())
            && matches!(self.gestures.now, Gesture::Idle)
            && self.gestures.keys.at.is_none()
            && let Some(pointer) = self.pointer
        {
            self.probing.wanted.get_or_insert(pointer.point);
        }
        if self.probing.reading.is_some() {
            return None;
        }
        // Where nothing is drawn, there is nothing to probe.
        let point = self.probing.wanted.take();
        point.filter(|_| self.marks.iter().any(Shown::drawable))
    }

    /// CSS pixels a probe reaches around its point: a finger reaches farther.
    pub(super) fn probe_radius(&self) -> f32 {
        let touch = self.pointer.is_some_and(|pointer| pointer.device == Device::Touch);
        self.scene.controls.pick_radius + if touch { 8.0 } else { 0.0 }
    }

    pub(super) fn probing(&mut self, point: [f32; 2], readback: Readback) {
        self.probing.reading = Some((point, readback));
    }

    /// Hands a landed probe's answer to hover and gestures.
    pub(super) fn settle_probe(&mut self) {
        let Some((point, readback)) = &self.probing.reading else { return };
        let Some(bytes) = readback.take() else { return };
        let point = *point;
        self.probing.reading = None;
        let answer = bytes.map_or_else(|_| Answer::default(), |bytes| self.answer(bytemuck::cast_slice(&bytes)));
        self.landed(point, answer);
    }

    /// What the probe's words say.
    fn answer(&self, words: &[u32]) -> Answer {
        let word = |i: u32| words.get(i as usize).copied().unwrap_or(0);
        Answer { hit: self.hit(&word), under: f32::from_bits(word(wgsl::PROBE_UNDER)) }
    }

    fn hit(&self, word: &impl Fn(u32) -> u32) -> Option<Probed> {
        let key = word(wgsl::PROBE_KEY);
        if key == wgsl::NONE || word(wgsl::PROBE_INSTANCE) == 0 {
            return None;
        }
        let row = word(wgsl::PROBE_ROW);
        let mark = 255 - (key & 255) as usize;
        let shown = self.marks.get(mark)?;
        let style = shown.mark.style();
        let id = self.drawn(&style.data)?.table(&style.table)?.ids.id(row as usize)?;
        let depth = f32::from_bits(word(wgsl::PROBE_DEPTH));
        let point = [f32::from_bits(word(wgsl::PROBE_X)), f32::from_bits(word(wgsl::PROBE_Y))];
        let view = self.projected();
        let position = view.position(view.unproject(point.map(f64::from), f64::from(depth)));
        let hit = Hit {
            row: Row { data: style.data.clone(), table: style.table.clone(), id },
            mark: style.name.clone(),
            index: mark,
            point,
            position,
            distance: (key >> 8) as f32 / 64.0,
            port: self.port(mark, word(wgsl::PROBE_SEGMENT)),
            sample: self.sample(mark, row, word(wgsl::PROBE_SEGMENT)),
        };
        Some(Probed { hit, depth, end: word(wgsl::PROBE_SEGMENT) })
    }

    /// The port a vertex mark's probe reached: its number from 1, or 0 for the marker.
    pub(super) fn port(&self, mark: usize, number: u32) -> Option<crate::Name> {
        let shown = self.marks.get(mark)?;
        if shown.kind() != crate::scene::mark::MarkKind::Vertices || number == 0 {
            return None;
        }
        let compiled = shown.compiled.as_ref()?;
        compiled.drawing.ports.get(number as usize - 1).map(|(name, ..)| name.clone())
    }

    /// The sample point `point` of a traced row's path stands for, on a mark tracing a field.
    pub(super) fn sample(&self, mark: usize, row: u32, point: u32) -> Option<Sample> {
        let shown = self.marks.get(mark)?;
        let crate::Mark::Lines(lines) = &shown.mark else { return None };
        let (level, index, side) = shown.tables.plan()?.entry(point)?;
        let style = shown.mark.style();
        let table = self.drawn(&style.data)?.table(&style.table)?;
        let crate::data::Field::Sampled(samples, _) = table.field_named(&lines.traced())? else { return None };
        // A bucket's points stand for its middle frame, its least or greatest value.
        let span = crate::data::bucket_frames(level);
        let frame = index * span + span / 2;
        let value = samples.entry(row as usize, level, side, index)?;
        Some(Sample { frame, at: samples.drawn_at(level, index)?, value })
    }

    /// The point gestures move about under `point`: what the frame drew there, else the level the
    /// camera looks at, else a point as far away as the camera's center.
    pub(super) fn anchor(&self, point: [f32; 2], answer: Option<&Answer>) -> [f64; 3] {
        let view = self.projected();
        let p = point.map(f64::from);
        let drawn = answer.and_then(|a| if a.under > 0.0 { Some(a.under) } else { a.hit.as_ref().map(|h| h.depth) });
        if let Some(depth) = drawn {
            return view.position(view.unproject(p, f64::from(depth)));
        }
        let Camera::Map { center, .. } = self.camera else {
            return view.on_plane(p, 0.0).map_or([0.0; 3], |w| view.position(w));
        };
        let reach = 50.0 * (view.eye - view.world(center)).length();
        let level = if view.globe >= 0.5 { view.surface(p) } else { view.on_plane(p, center[2]) };
        if let Some(w) = level.filter(|w| view.grazing(p) > 0.1 && (*w - view.eye).length() < reach) {
            view.position(w)
        } else {
            let depth = view.screen(view.world(center)).map_or(0.5, |s| s[2]);
            view.position(view.unproject(p, depth))
        }
    }
}

impl super::marks::Shown {
    /// Whether probes reach this mark's rows.
    pub(crate) fn probed(&self) -> bool {
        self.drawable() && self.mark.style().interaction.pick && self.rows > 0
    }
}
