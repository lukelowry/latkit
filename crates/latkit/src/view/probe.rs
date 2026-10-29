//! Probes: the nearest row and the nearest drawn depth under a point.
//!
//! A compute pass runs over what the frame drew, and its result is read back a frame or two later.
//! One probe is in flight at a time, and a newer point waits for it. The answer is decoded against
//! the frame that drew it (its marks' held rows and its camera), regardless of changes since.

use std::sync::Arc;

use super::Projected;
use super::event::{Hit, Sample};
use super::gestures::Gesture;
use super::marks::{Holding, Shown};
use super::sync::Plan;
use super::{Device, View};
use crate::derive::Working;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Camera, Name, Row, wire};

/// A hit, with its depth (for dragging) and, for an edge, the nearer endpoint: 0 for the first,
/// 1 for the second.
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
    /// The nearest depth drawn around the point. 0 where nothing was drawn.
    pub(crate) under: f32,
}

/// A record of what a frame drew, for decoding answers about it: each mark's held rows, and the
/// frame's camera.
#[derive(Clone)]
pub(crate) struct Drew {
    marks: Arc<[Held]>,
    projected: Projected,
}

/// One mark as its frame drew it: its dataset, table, and name, whether its rows are vertices,
/// whether selection picks them, the rows its state held, its port names, and, for a line tracing a
/// field, the field and its trace plan.
struct Held {
    data: Name,
    table: Name,
    name: Option<Name>,
    vertices: bool,
    selects: bool,
    holding: Option<Holding>,
    ports: Vec<Name>,
    traced: Option<(Name, Plan)>,
}

impl Drew {
    /// The row at held row `held` of mark `i`, and its index in its table.
    pub(super) fn row(&self, i: usize, held: u32) -> Option<(Row, usize)> {
        let mark = self.marks.get(i)?;
        let holding = mark.holding.as_ref()?;
        let r = holding.source_row(held)?;
        let id = holding.table.ids.id(r as usize)?;
        Some((Row { data: mark.data.clone(), table: mark.table.clone(), id }, r as usize))
    }

    /// The hit at held row `held` of mark `i` as the frame drew it: at screen `point` and `depth`,
    /// `distance` 1/64 CSS pixels from where it was asked, on `part` (a port's number from 1, or a
    /// segment's index along its path). `None` when the frame held no such row.
    pub(super) fn hit(
        &self,
        i: usize,
        held: u32,
        point: [f32; 2],
        depth: f32,
        distance: u32,
        part: u32,
    ) -> Option<Hit> {
        let (row, at) = self.row(i, held)?;
        Some(Hit {
            row,
            mark: self.marks.get(i)?.name.clone(),
            index: i,
            point,
            position: self.projected.position(self.projected.unproject(point.map(f64::from), f64::from(depth))),
            distance: distance as f32 / 64.0,
            port: self.port(i, part),
            sample: self.sample(i, at, part),
        })
    }

    /// Whether a box's selection picks mark `i`'s rows.
    pub(super) fn selects(&self, i: usize) -> bool {
        self.marks.get(i).is_some_and(|m| m.selects)
    }

    /// The name of port `number` of vertex mark `i`, numbered from 1. `None` for 0, the marker.
    fn port(&self, i: usize, number: u32) -> Option<Name> {
        let mark = self.marks.get(i)?;
        if !mark.vertices || number == 0 {
            return None;
        }
        mark.ports.get(number as usize - 1).cloned()
    }

    /// The sample that point `point` of row `row`'s traced path shows, on mark `i` tracing a field.
    fn sample(&self, i: usize, row: usize, point: u32) -> Option<Sample> {
        let mark = self.marks.get(i)?;
        let (field, plan) = mark.traced.as_ref()?;
        let (level, index, side) = plan.entry(point)?;
        let table = &mark.holding.as_ref()?.table;
        let crate::data::Field::Sampled(samples, _) = table.field_named(field)? else { return None };
        // A bucket's two points show its middle frame, with its minimum or maximum value.
        let span = crate::data::bucket_frames(level);
        let frame = index * span + span / 2;
        let value = samples.entry(row, level, side, index)?;
        Some(Sample { frame, at: samples.drawn_at(level, index)?, value })
    }
}

#[derive(Default)]
pub(crate) struct Probing {
    /// The next point to probe.
    pub(crate) wanted: Option<[f32; 2]>,
    /// The probe being read back: the point it asked about, and what its frame drew.
    reading: Working<([f32; 2], Drew), Readback>,
    /// The latest answer and the point it was asked for.
    pub(crate) latest: Option<([f32; 2], Answer)>,
}

impl Probing {
    /// Whether a point is waiting for a frame to probe it. Never while a probe is being read back.
    pub(crate) fn due(&self) -> bool {
        self.wanted.is_some() && !self.reading.busy()
    }

    pub(crate) fn hovered(&self) -> Option<&Probed> {
        self.latest.as_ref().and_then(|(_, answer)| answer.hit.as_ref())
    }

    /// The latest answer, if it was for a point within 2 CSS pixels of `point` and no newer probe
    /// is pending.
    pub(crate) fn at(&self, point: [f32; 2]) -> Option<Answer> {
        let (asked, answer) = self.latest.as_ref()?;
        (self.wanted.is_none() && !self.reading.busy() && near(*asked, point, 2.0)).then(|| answer.clone())
    }
}

pub(crate) fn near(a: [f32; 2], b: [f32; 2], within: f32) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) <= within
}

impl View {
    /// The point this frame probes, if it `answers` probes, a point is waiting, and no probe is in
    /// flight. The point under a resting pointer is probed again whenever the frame changes under
    /// it, so a moving frame runs one probe per readback and a still frame runs none.
    pub(super) fn probe_point(&mut self, answers: bool) -> Option<[f32; 2]> {
        if (self.changed || self.easing())
            && matches!(self.gestures.now, Gesture::Idle)
            && self.gestures.keys.at.is_none()
            && let Some(pointer) = self.pointer
        {
            self.probing.wanted.get_or_insert(pointer.point);
        }
        if self.probing.reading.busy() || !answers {
            return None;
        }
        // Where nothing is drawn, nothing is under the point, so a press waiting on it goes ahead.
        let point = self.probing.wanted.take()?;
        if !self.marks.iter().any(Shown::drawable) {
            self.landed(point, Answer::default());
            return None;
        }
        Some(point)
    }

    /// The probe radius in CSS pixels: the scene's pick radius, plus 8 for touch.
    pub(super) fn probe_radius(&self) -> f32 {
        let touch = self.pointer.is_some_and(|pointer| pointer.device == Device::Touch);
        self.scene.controls.pick_radius + if touch { 8.0 } else { 0.0 }
    }

    pub(super) fn probing(&mut self, point: [f32; 2], readback: Readback) {
        let drew = self.drew();
        self.probing.reading.start(0, readback, (point, drew));
    }

    /// A record of what this frame drew, for decoding answers about it.
    pub(super) fn drew(&self) -> Drew {
        let marks: Vec<Held> = self
            .marks
            .iter()
            .map(|shown| {
                let style = shown.mark.style();
                let ports = shown.compiled.as_ref().map(|c| c.drawing.ports.iter().map(|(name, ..)| name.clone()));
                let traced = match &shown.mark {
                    crate::Mark::Lines(lines) => shown.tables.plan().map(|plan| (lines.traced(), plan.clone())),
                    _ => None,
                };
                Held {
                    data: style.data.clone(),
                    table: style.table.clone(),
                    name: style.name.clone(),
                    vertices: shown.kind() == MarkKind::Vertices,
                    selects: style.interaction.select,
                    holding: shown.holding.clone(),
                    ports: ports.map(Iterator::collect).unwrap_or_default(),
                    traced,
                }
            })
            .collect();
        Drew { marks: marks.into(), projected: self.projected() }
    }

    /// Hands a finished probe's answer to hover and gestures.
    pub(super) fn settle_probe(&mut self) {
        let Some((_, (point, drew), bytes)) = self.probing.reading.landed() else { return };
        let answer = bytes.map_or_else(|_| Answer::default(), |bytes| answer(&wire::words(&bytes), &drew));
        self.landed(point, answer);
    }

    /// The position gestures pivot on under screen point `point`: what the frame drew there, or
    /// else the ground level the camera looks at, or else a point as far away as the camera's
    /// center.
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
        let level = if view.globe >= 0.5 { view.ground(p) } else { view.on_plane(p, view.height(center[2])) };
        if let Some(w) = level.filter(|w| view.grazing(p) > 0.1 && (*w - view.eye).length() < reach) {
            view.position(w)
        } else {
            let depth = view.screen(view.world(center)).map_or(0.5, |s| s[2]);
            view.position(view.unproject(p, depth))
        }
    }
}

/// Decodes a probe's words against what its frame drew.
fn answer(words: &[u32], drew: &Drew) -> Answer {
    let word = |i: u32| words.get(i as usize).copied().unwrap_or(0);
    Answer { hit: hit(&word, drew), under: f32::from_bits(word(wgsl::PROBE_UNDER)) }
}

fn hit(word: &impl Fn(u32) -> u32, drew: &Drew) -> Option<Probed> {
    let key = word(wgsl::PROBE_KEY);
    if key == wgsl::NONE || word(wgsl::PROBE_INSTANCE) == 0 {
        return None;
    }
    let depth = f32::from_bits(word(wgsl::PROBE_DEPTH));
    let point = [f32::from_bits(word(wgsl::PROBE_X)), f32::from_bits(word(wgsl::PROBE_Y))];
    let part = word(wgsl::PROBE_SEGMENT);
    let hit = drew.hit(255 - (key & 255) as usize, word(wgsl::PROBE_ROW), point, depth, key >> 8, part)?;
    Some(Probed { hit, depth, end: part })
}

impl super::marks::Shown {
    /// Whether probes cover this mark's rows.
    pub(crate) fn probed(&self) -> bool {
        self.drawable() && self.mark.picks() && self.rows > 0
    }
}
