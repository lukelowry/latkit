//! Probes: what lies under a point, answered by a compute pass over what the frame drew and read back
//! a frame or two later: the nearest row, and the nearest depth drawn. One probe is in flight at a
//! time; a newer point waits for it. An answer decodes against what its frame drew, whatever changed
//! before it landed: the rows its marks held, and the camera it drew through.

use std::sync::Arc;

use super::Projected;
use super::event::{Hit, Sample};
use super::gestures::Gesture;
use super::marks::{Holding, Shown};
use super::sync::Plan;
use super::{Device, View};
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Camera, Name, Row};

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

/// What a frame drew, as an answer about it reads it: each mark's rows as it held them, and the camera
/// the frame drew through.
#[derive(Clone)]
pub(crate) struct Drew {
    marks: Arc<[Held]>,
    projected: Projected,
}

/// What a mark held as its frame drew it: its dataset, table, and name, whether its rows are vertices
/// and selection picks them, the rows its state held and how, its ports, and for a line tracing a
/// field, the field and what its trace drew.
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
    /// The row mark `i` held as held row `held`, and its place in its table.
    pub(super) fn row(&self, i: usize, held: u32) -> Option<(Row, usize)> {
        let mark = self.marks.get(i)?;
        let holding = mark.holding.as_ref()?;
        let r = match &holding.drawing {
            Some(drawing) => drawing.source(held)?,
            None => (held < holding.table.len() as u32).then_some(held)?,
        };
        let id = holding.table.ids.id(r as usize)?;
        Some((Row { data: mark.data.clone(), table: mark.table.clone(), id }, r as usize))
    }

    /// The name of mark `i`.
    pub(super) fn name(&self, i: usize) -> Option<Name> {
        self.marks.get(i)?.name.clone()
    }

    /// Whether a box's selection picks mark `i`'s rows.
    pub(super) fn selects(&self, i: usize) -> bool {
        self.marks.get(i).is_some_and(|m| m.selects)
    }

    /// The port of a vertex mark `i` its probe reached: its number from 1, or 0 for the marker.
    pub(super) fn port(&self, i: usize, number: u32) -> Option<Name> {
        let mark = self.marks.get(i)?;
        if !mark.vertices || number == 0 {
            return None;
        }
        mark.ports.get(number as usize - 1).cloned()
    }

    /// The sample point `point` of row `row`'s traced path stands for, on mark `i` tracing a field.
    pub(super) fn sample(&self, i: usize, row: usize, point: u32) -> Option<Sample> {
        let mark = self.marks.get(i)?;
        let (field, plan) = mark.traced.as_ref()?;
        let (level, index, side) = plan.entry(point)?;
        let table = &mark.holding.as_ref()?.table;
        let crate::data::Field::Sampled(samples, _) = table.field_named(field)? else { return None };
        // A bucket's points stand for its middle frame, its least or greatest value.
        let span = crate::data::bucket_frames(level);
        let frame = index * span + span / 2;
        let value = samples.entry(row, level, side, index)?;
        Some(Sample { frame, at: samples.drawn_at(level, index)?, value })
    }

    /// The position `point` on screen at `depth` stands for, as the frame's camera saw it.
    pub(super) fn position(&self, point: [f32; 2], depth: f64) -> [f64; 3] {
        self.projected.position(self.projected.unproject(point.map(f64::from), depth))
    }
}

#[derive(Default)]
pub(crate) struct Probing {
    /// The next point to probe.
    pub(crate) wanted: Option<[f32; 2]>,
    reading: Option<([f32; 2], Readback, Drew)>,
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
    /// The point this frame probes, when it `answers` probes: one waits and none is in flight. What
    /// the pointer rests on is probed again whenever the frame changed under it, so a moving frame
    /// costs a probe per readback and a still one nothing.
    pub(super) fn probe_point(&mut self, answers: bool) -> Option<[f32; 2]> {
        if (self.changed || self.easing())
            && matches!(self.gestures.now, Gesture::Idle)
            && self.gestures.keys.at.is_none()
            && let Some(pointer) = self.pointer
        {
            self.probing.wanted.get_or_insert(pointer.point);
        }
        if self.probing.reading.is_some() || !answers {
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
        self.probing.reading = Some((point, readback, self.drew()));
    }

    /// What this frame drew, as an answer about it reads it.
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

    /// Hands a landed probe's answer to hover and gestures.
    pub(super) fn settle_probe(&mut self) {
        let Some((point, readback, _)) = &self.probing.reading else { return };
        let Some(bytes) = readback.take() else { return };
        let point = *point;
        let (_, _, drew) = self.probing.reading.take().expect("reading");
        let answer = bytes.map_or_else(|_| Answer::default(), |bytes| answer(bytemuck::cast_slice(&bytes), &drew));
        self.landed(point, answer);
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

/// What a probe's words say of what its frame drew.
fn answer(words: &[u32], drew: &Drew) -> Answer {
    let word = |i: u32| words.get(i as usize).copied().unwrap_or(0);
    Answer { hit: hit(&word, drew), under: f32::from_bits(word(wgsl::PROBE_UNDER)) }
}

fn hit(word: &impl Fn(u32) -> u32, drew: &Drew) -> Option<Probed> {
    let key = word(wgsl::PROBE_KEY);
    if key == wgsl::NONE || word(wgsl::PROBE_INSTANCE) == 0 {
        return None;
    }
    let mark = 255 - (key & 255) as usize;
    // The probe names a held row: the row of its table it held.
    let (row, at) = drew.row(mark, word(wgsl::PROBE_ROW))?;
    let depth = f32::from_bits(word(wgsl::PROBE_DEPTH));
    let point = [f32::from_bits(word(wgsl::PROBE_X)), f32::from_bits(word(wgsl::PROBE_Y))];
    let hit = Hit {
        row,
        mark: drew.name(mark),
        index: mark,
        point,
        position: drew.position(point, f64::from(depth)),
        distance: (key >> 8) as f32 / 64.0,
        port: drew.port(mark, word(wgsl::PROBE_SEGMENT)),
        sample: drew.sample(mark, at, word(wgsl::PROBE_SEGMENT)),
    };
    Some(Probed { hit, depth, end: word(wgsl::PROBE_SEGMENT) })
}

impl super::marks::Shown {
    /// Whether probes reach this mark's rows.
    pub(crate) fn probed(&self) -> bool {
        self.drawable() && self.mark.picks() && self.rows > 0
    }
}
