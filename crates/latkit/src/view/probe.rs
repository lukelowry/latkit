//! Probes: the nearest row and the nearest drawn depth under a point.
//!
//! Raster passes run over what the frame drew, and its result is read back a frame or two later.
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

/// One mark as its frame drew it: its dataset, table, and name, whether selection picks its rows,
/// the rows its state held, and, for a line tracing a field, the field and its trace plan.
struct Held {
    data: Name,
    table: Name,
    name: Option<Name>,
    selects: bool,
    holding: Option<Holding>,
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
    /// `distance` 1/64 CSS pixels from where it was asked, on `part` (a segment's index along its
    /// path). `None` when the frame held no such row.
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
            sample: self.sample(i, at, part),
        })
    }

    /// Whether a box's selection picks mark `i`'s rows.
    pub(super) fn selects(&self, i: usize) -> bool {
        self.marks.get(i).is_some_and(|m| m.selects)
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

/// What a probe asks: the row under the hover's point, or the row a keys' step finds.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Probe {
    Hover([f32; 2]),
    Step(Step),
}

/// A keys' step: the row nearest `start` toward `way` within 45° (any way when zero), anywhere
/// in view and off the corners' backdrops, passing over held row `skip[1]` of mark `skip[0]`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Step {
    pub(crate) start: [f32; 2],
    pub(crate) way: [f32; 2],
    pub(crate) skip: [u32; 2],
}

#[derive(Default)]
pub(crate) struct Probing {
    /// The next point to probe.
    pub(crate) wanted: Option<[f32; 2]>,
    /// The keys' step to probe next, before any point.
    pub(crate) step: Option<Step>,
    /// The probe being read back: what it asked, and what its frame drew.
    reading: Working<(Probe, Drew), Readback>,
    /// The latest answer and the point it was asked for.
    pub(crate) latest: Option<([f32; 2], Answer)>,
}

impl Probing {
    /// Whether a point or a keys' step is waiting for a frame to probe it. Never while a probe is
    /// being read back.
    pub(crate) fn due(&self) -> bool {
        (self.wanted.is_some() || self.step.is_some()) && !self.reading.busy()
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
    /// What this frame probes, if it `answers` probes, a keys' step or a point is waiting, and no
    /// probe is in flight. The point under a resting pointer is probed again whenever the frame
    /// changes under it, so a moving frame runs one probe per readback and a still frame runs none.
    pub(super) fn probe_point(&mut self, answers: bool) -> Option<Probe> {
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
        let drawn = self.marks.iter().any(Shown::drawable);
        if let Some(step) = self.probing.step.take() {
            if drawn {
                return Some(Probe::Step(step));
            }
            self.stepped(None);
        }
        // Where nothing is drawn, nothing is under the point, so a press waiting on it goes ahead.
        let point = self.probing.wanted.take()?;
        if !drawn || !self.marks_show_at(point) {
            self.landed(point, Answer::default());
            return None;
        }
        Some(Probe::Hover(point))
    }

    /// Writes what this frame probes into `frame`: the hover's point and radius, or a keys' step,
    /// which reaches every row in view.
    pub(super) fn probe_uniform(&self, frame: &mut wgsl::Frame, probe: &Probe) {
        match probe {
            Probe::Hover(point) => {
                frame.probe = *point;
                frame.probe_radius = self.probe_radius();
            }
            Probe::Step(step) => {
                let [w, h] = self.size;
                frame.probe = step.start;
                // The step may start off screen, where the row it starts from now lies.
                frame.probe_radius = (2.0 * w.hypot(h)) as f32;
                frame.probe_way = step.way;
                frame.probe_skip = step.skip;
                frame.probe_area = self.drawn_area().unwrap_or([0.0, 0.0, w, h]).map(|v| v as f32);
                frame.probe_covers = 0;
                for (cover, backdrop) in frame.probe_cover.iter_mut().zip(self.guides.backdrops()) {
                    *cover = backdrop.map(|v| v as f32);
                    frame.probe_covers += 1;
                }
            }
        }
    }

    /// The probe radius in CSS pixels: the scene's pick radius, plus 8 for touch.
    pub(super) fn probe_radius(&self) -> f32 {
        let touch = self.pointer.is_some_and(|pointer| pointer.device == Device::Touch);
        self.scene.controls.pick_radius + if touch { 8.0 } else { 0.0 }
    }

    /// Reads back `probe`, stamped with the gesture session it was asked in.
    pub(super) fn probing(&mut self, probe: Probe, readback: Readback) {
        let drew = self.drew();
        self.probing.reading.start(self.gestures.session, readback, (probe, drew));
    }

    /// A record of what this frame drew, for decoding answers about it.
    pub(super) fn drew(&self) -> Drew {
        let marks: Vec<Held> = self
            .marks
            .iter()
            .map(|shown| {
                let style = shown.mark.style();
                let traced = match &shown.mark {
                    crate::Mark::Lines(lines) => shown.tables.plan().map(|plan| (lines.traced(), plan.clone())),
                    _ => None,
                };
                Held {
                    data: style.data.clone(),
                    table: style.table.clone(),
                    name: style.name.clone(),
                    selects: style.interaction.select,
                    holding: shown.holding.clone(),
                    traced,
                }
            })
            .collect();
        Drew { marks: marks.into(), projected: self.projected() }
    }

    /// Hands a finished probe's answer to hover and gestures, unless a cancel or the pointer leaving
    /// started a new session since it was asked. A keys' step goes to the keys, which a cancel
    /// already stopped waiting for it.
    pub(super) fn settle_probe(&mut self) {
        let Some((session, (probe, drew), bytes)) = self.probing.reading.landed() else { return };
        let answer = bytes.map_or_else(|_| Answer::default(), |bytes| answer(&wire::words(&bytes), &drew));
        match probe {
            Probe::Step(_) => self.stepped(answer.hit.map(|probed| probed.hit)),
            Probe::Hover(point) if session == self.gestures.session => self.landed(point, answer),
            Probe::Hover(_) => {}
        }
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
    let hit = drew.hit(word(wgsl::PROBE_MARK) as usize, word(wgsl::PROBE_ROW), point, depth, key, part)?;
    Some(Probed { hit, depth, end: part })
}

impl super::marks::Shown {
    /// Whether probes cover this mark's rows.
    pub(crate) fn probed(&self) -> bool {
        self.drawable() && self.mark.picks() && self.rows > 0
    }
}
