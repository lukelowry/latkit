//! Probes: which row lies under a point, answered by a compute pass over what the frame drew and read
//! back a frame or two later. One probe is in flight at a time; a newer point waits for it.

use super::View;
use super::event::Hit;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::Row;

/// A hit, with the depth it lies at for dragging.
#[derive(Clone, Debug)]
pub(crate) struct Probed {
    pub(crate) hit: Hit,
    pub(crate) depth: f32,
}

#[derive(Default)]
pub(crate) struct Probing {
    /// The next point to probe.
    pub(crate) wanted: Option<[f32; 2]>,
    /// Whether the pointer probing is a finger, which reaches farther.
    pub(crate) touch: bool,
    reading: Option<([f32; 2], Readback)>,
    /// The latest answer and the point it was asked for.
    pub(crate) latest: Option<([f32; 2], Option<Probed>)>,
}

impl Probing {
    pub(crate) fn busy(&self) -> bool {
        self.wanted.is_some() || self.reading.is_some()
    }

    pub(crate) fn hovered(&self) -> Option<&Probed> {
        self.latest.as_ref().and_then(|(_, probed)| probed.as_ref())
    }

    /// The latest answer when it was asked within a pixel or two of `point`.
    pub(crate) fn at(&self, point: [f32; 2]) -> Option<Option<Probed>> {
        let (asked, probed) = self.latest.as_ref()?;
        (self.wanted.is_none() && self.reading.is_none() && near(*asked, point, 2.0)).then(|| probed.clone())
    }
}

pub(crate) fn near(a: [f32; 2], b: [f32; 2], within: f32) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) <= within
}

impl View {
    /// Whether any drawn mark answers probes.
    pub(super) fn pickable(&self) -> bool {
        self.marks.iter().any(|m| m.probed())
    }

    /// The point this frame probes: one waits and none is in flight.
    pub(super) fn probe_point(&mut self) -> Option<[f32; 2]> {
        if self.probing.reading.is_some() || !self.pickable() {
            return None;
        }
        self.probing.wanted.take()
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
        let probed = bytes.ok().and_then(|bytes| self.probed(bytemuck::cast_slice(&bytes)));
        self.landed(point, probed);
    }

    /// The hit the probe's words describe.
    fn probed(&self, words: &[u32]) -> Option<Probed> {
        let key = *words.get(wgsl::PROBE_KEY as usize)?;
        let row = words.get(wgsl::PROBE_ROW as usize)?.checked_sub(1)?;
        if key == wgsl::NONE {
            return None;
        }
        let mark = 255 - (key & 255) as usize;
        let shown = self.marks.get(mark)?;
        let style = shown.mark.style();
        let id = self.data(&style.data)?.table(&style.table)?.ids.id(row as usize)?;
        let depth = f32::from_bits(words[wgsl::PROBE_DEPTH as usize]);
        let point = [f32::from_bits(words[wgsl::PROBE_X as usize]), f32::from_bits(words[wgsl::PROBE_Y as usize])];
        let projected = self.projected();
        let position =
            projected.position(projected.unproject([f64::from(point[0]), f64::from(point[1])], f64::from(depth)));
        let hit = Hit {
            row: Row { data: style.data.clone(), table: style.table.clone(), id },
            mark,
            point,
            position,
            distance: (key >> 8) as f32 / 64.0,
        };
        Some(Probed { hit, depth })
    }
}

impl super::marks::Shown {
    /// Whether probes reach this mark's rows.
    pub(crate) fn probed(&self) -> bool {
        self.drawable()
            && self.mark.style().interaction.pick
            && matches!(self.kind(), MarkKind::Vertices | MarkKind::Edges | MarkKind::Faces)
    }
}
