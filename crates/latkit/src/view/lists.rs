//! Lists on the GPU: each item counts its entries, a scan turns the counts into start offsets, and
//! each item writes its entries there. The total goes into the list's header as indirect draw and
//! dispatch arguments, so nothing waits on a readback for it.
//!
//! After the segment lists lie the drawn-row words of each mark drawing a paged table: the held
//! row of each row drawn, expanded from the drawing's runs when they change, so every pass reads a
//! drawn row in one word.

use super::View;
use super::marks::Shown;
use super::passes::dispatch;
use crate::derive::{Derived, stamp_of};
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;

/// A listed mark's segment list (see `Shown::listed`), used when its rows have different numbers
/// of segments, or for areas, of triangles: where it lies, a stamp of its last build's inputs (the
/// list, the paths, and for great circles where the vertices are drawn), and its count. Each entry
/// is a segment's row and how far along its path it starts. A curved mark's count is read back,
/// one readback at a time, and its list grows to fit what was found.
#[derive(Default)]
pub(crate) struct Segments {
    pub(crate) list: Option<List>,
    pub(crate) built: u64,
    pub(crate) found: Derived<u32>,
}

/// Words a segment list keeps per segment: its row, and its distance along.
const SEGMENT_WORDS: u32 = 2;

/// Where a paged mark's drawn-row words lie in the lists buffer, `[start, room]` in words, and the
/// stamp of their last expansion's inputs: the drawing, their location, and the buffer.
#[derive(Default)]
pub(crate) struct DrawnRows {
    pub(crate) at: Option<[u32; 2]>,
    expanded: u64,
}

/// Where a list lies in the lists buffer, in words.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct List {
    pub(crate) header: u32,
    pub(crate) items: u32,
    pub(crate) entries: u32,
    /// The most entries it keeps, and words per entry.
    pub(crate) kept: u32,
    pub(crate) stride: u32,
    sums: u32,
    counts: u32,
}

impl List {
    /// A list of `items` items keeping `kept` entries of `stride` words: its header and entries at
    /// `front`, its block sums and counts at `back`.
    pub(crate) fn at(front: u32, back: u32, items: u32, kept: u32, stride: u32) -> List {
        let sums = back;
        let counts = sums + items.div_ceil(wgsl::SCAN_WORKGROUP).max(1);
        List { header: front, items, entries: front + wgsl::LIST_HEADER, kept, stride, sums, counts }
    }

    /// Words its header and entries take.
    pub(crate) fn front_words(kept: u32, stride: u32) -> u32 {
        wgsl::LIST_HEADER + kept * stride
    }

    /// Words its sums and counts take.
    pub(crate) fn back_words(items: u32) -> u32 {
        items.div_ceil(wgsl::SCAN_WORKGROUP).max(1) + items + 1
    }

    /// Where the scan writes the list's total, before it is capped at `kept`.
    pub(crate) fn total(&self) -> u32 {
        self.counts + self.items
    }

    /// The header's words, with draw arguments for `corners` vertices per instance.
    pub(crate) fn header_words(&self, corners: u32) -> [u32; wgsl::LIST_HEADER as usize] {
        let mut h = [0; wgsl::LIST_HEADER as usize];
        h[wgsl::LIST_ITEMS as usize] = self.items;
        h[wgsl::LIST_COUNTS as usize] = self.counts;
        h[wgsl::LIST_SUMS as usize] = self.sums;
        h[wgsl::LIST_ENTRIES as usize] = self.entries;
        h[wgsl::LIST_DRAW as usize] = corners;
        h[wgsl::LIST_DISPATCH as usize + 1] = 1;
        h[wgsl::LIST_DISPATCH as usize + 2] = 1;
        h[wgsl::LIST_KEPT as usize] = self.kept;
        h
    }
}

impl View {
    /// Lays out every listed mark's segment list at the front of the lists buffer, using counts
    /// read back. A list smaller than its rows need grows, with a quarter to spare.
    pub(super) fn lay_out_segments(&mut self) {
        let mut at = 0;
        for shown in &mut self.marks {
            if let Some((stamp, bytes)) = shown.segments.found.landed() {
                let found = crate::wire::In::new(&bytes).u32().unwrap_or(0);
                let kept = shown.segments.list.map_or(0, |l| l.kept);
                let room = if found > kept { found + found / 4 } else { shown.segments.found.value };
                shown.segments.found.make(stamp, room);
            }
            if !shown.listed() {
                shown.segments.list = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let kept = shown.segment_capacity();
            let list = match shown.segments.list {
                Some(list) if list.header == at && list.items == items && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    List::at(at, at + List::front_words(kept, SEGMENT_WORDS), items, kept, SEGMENT_WORDS)
                }
            };
            at += List::front_words(list.kept, SEGMENT_WORDS) + List::back_words(items);
            shown.segments.list = Some(list);
        }
        // Then one word per row each paged mark draws, rows that left included.
        for shown in &mut self.marks {
            if shown.drawing().is_none() {
                shown.drawn_rows.at = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let region = match shown.drawn_rows.at {
                Some([start, room]) if start == at && room >= items => [start, room],
                _ => [at, items + items / 4],
            };
            at += region[1];
            shown.drawn_rows.at = Some(region);
        }
        self.list_words = at;
    }

    /// The marks whose drawn-row words are rewritten this frame: those whose drawing, rows, word
    /// location, or lists buffer changed.
    pub(super) fn drawn_rows_due(&mut self) -> Vec<usize> {
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(at) = shown.drawn_rows.at.filter(|_| shown.drawable()) else { continue };
            let drawn = shown.drawing().map(|d| d.made);
            let stamp = stamp_of((at, shown.rows, shown.exits, drawn, generation));
            if stamp != shown.drawn_rows.expanded {
                shown.drawn_rows.expanded = stamp;
                due.push(i);
            }
        }
        due
    }

    /// The marks whose segment lists rebuild this frame: those whose list, lists buffer, paths, or
    /// drawing changed, or, along great circles or lanes, where the vertices their rows join are
    /// drawn. A color changing every frame rebuilds none.
    pub(super) fn segments_due(&mut self) -> Vec<usize> {
        let vertices: Vec<(bool, u64)> =
            self.marks.iter().filter(|m| m.kind() == MarkKind::Vertices).map(Shown::places_drawn).collect();
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        // Lanes are laid out on screen, so they count again whenever the camera moves.
        let projected = self.projected();
        let sight = (projected.clip_from_world.to_cols_array().map(f64::to_bits), self.size.map(f64::to_bits));
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(list) = shown.segments.list.filter(|_| shown.drawable()) else { continue };
            let laned = shown.laned().then_some(sight);
            let arcs = (shown.geodesic || laned.is_some()).then(|| (&vertices, shown.places_drawn(), laned));
            let tables = shown.tables.generation();
            let drawn = shown.drawing().map(|d| d.made);
            let stamp = stamp_of((list.header, list.items, list.kept, tables, generation, arcs, drawn));
            if stamp != shown.segments.built {
                shown.segments.built = stamp;
                due.push(i);
            }
        }
        due
    }

    /// Reads back how many segments each great-circle mark needs, so a list too small grows. Each
    /// mark has one readback at a time: a newer list does not cancel it, and is counted after it
    /// arrives. A mark only bowed into lanes always has space for every piece of every lane, so it
    /// reads back nothing.
    pub(super) fn count_found(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let gpu = self.gpu.clone();
        let Some(resources) = &self.resources else { return };
        for shown in &mut self.marks {
            let geodesic = shown.curved() && shown.geodesic;
            let Some(list) = shown.segments.list.filter(|_| geodesic && shown.drawable()) else { continue };
            let built = shown.segments.built;
            if shown.segments.found.busy() || !shown.segments.found.due(built) {
                continue;
            }
            let at = u64::from(list.total()) * 4;
            let readback =
                Readback::new(&inner.readbacks, &gpu.0.device, encoder, resources.lists(), at, 4, &self.waker);
            shown.segments.found.start(built, readback);
        }
    }
}

impl Shown {
    /// Whether its segment count is being read back, or is due to be.
    pub(crate) fn counting(&self) -> bool {
        let found = &self.segments.found;
        found.busy() || (self.curved() && self.geodesic && self.drawable() && found.due(self.segments.built))
    }
}

/// Records the scan of the list the bound mark's uniform names.
pub(super) fn scan(
    pass: &mut wgpu::ComputePass<'_>,
    pipelines: &mut crate::gpu::pipelines::Pipelines,
    device: &wgpu::Device,
    items: u32,
) {
    let [blocks, sums, add] = super::variants::SCAN;
    pass.set_pipeline(&pipelines.compute(device, blocks));
    dispatch(pass, items.max(1));
    pass.set_pipeline(&pipelines.compute(device, sums));
    pass.dispatch_workgroups(1, 1, 1);
    pass.set_pipeline(&pipelines.compute(device, add));
    dispatch(pass, items);
}
