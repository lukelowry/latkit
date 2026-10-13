//! Lists on the GPU: each item counts its entries, a scan turns the counts into where each item's
//! entries start, and each item writes its entries there. The total lands in the list's header as
//! indirect draw and dispatch arguments, so nothing waits on a readback to know it.

use super::View;
use super::passes::dispatch;
use crate::gpu::Inner;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::MarkKind;

/// Where a list lies in the lists buffer, in words.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct List {
    pub(crate) header: u32,
    pub(crate) items: u32,
    pub(crate) entries: u32,
    /// Entries kept, and words per entry.
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

    /// Where the scan leaves the list's total, before it is held to what the list keeps.
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
    /// Lays out every listed stroke mark's segment list at the front of the lists buffer; a mark
    /// whose list moved or grew counts its segments again.
    pub(super) fn lay_out_segments(&mut self) {
        let mut at = 0;
        for shown in &mut self.marks {
            if let Some(reading) = &shown.segments_reading
                && let Some(bytes) = reading.take()
            {
                shown.segments_reading = None;
                let found = bytes.ok().and_then(|b| b.get(..4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])));
                if let Some(found) = found.filter(|&f| shown.segments.is_some_and(|l| f > l.kept)) {
                    shown.segments_found = found + found / 4;
                }
            }
            if !shown.listed() {
                shown.segments = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let kept = shown.segment_capacity();
            let list = match shown.segments {
                Some(list) if list.header == at && list.items == items && list.kept >= kept => list,
                _ => {
                    shown.segments_due = true;
                    let kept = kept + kept / 4;
                    List::at(at, at + List::front_words(kept, 1), items, kept, 1)
                }
            };
            at += List::front_words(list.kept, 1) + List::back_words(items);
            shown.segments = Some(list);
        }
        self.segment_words = at;
    }

    /// The marks whose segments must be counted this frame: their list was laid out again, or the
    /// arcs of a geodesic mark's rows may have changed with the vertices they join.
    pub(super) fn segments_due(&mut self) -> Vec<usize> {
        let vertices: u64 = self.marks.iter().filter(|m| m.kind() == MarkKind::Vertices).map(|m| m.version).sum();
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            if shown.segments.is_none() || !shown.drawable() {
                continue;
            }
            let stamp = if shown.geodesic { vertices.wrapping_add(shown.version) } else { 0 };
            if shown.segments_due || stamp != shown.segments_counted {
                due.push(i);
            }
            shown.segments_due = false;
            shown.segments_counted = stamp;
        }
        due
    }

    /// Reads back how many segments each geodesic mark counted, so a list too small grows.
    pub(super) fn count_found(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner, counted: &[usize]) {
        let gpu = self.gpu.clone();
        let Some(resources) = &self.resources else { return };
        for &i in counted {
            let shown = &mut self.marks[i];
            let Some(list) = shown.segments.filter(|_| shown.geodesic && shown.segments_reading.is_none()) else {
                continue;
            };
            let at = u64::from(list.total()) * 4;
            shown.segments_reading =
                Some(Readback::new(&inner.readbacks, &gpu.0.device, encoder, resources.lists(), at, 4));
        }
    }
}

/// Records the scan of the list the bound mark's uniform names: `query` scans its query's list.
pub(super) fn scan(
    pass: &mut wgpu::ComputePass<'_>,
    pipelines: &mut crate::gpu::pipelines::Pipelines,
    device: &wgpu::Device,
    items: u32,
    query: bool,
) {
    let shader = if query { Shader::ListsQuery } else { Shader::Lists };
    pass.set_pipeline(&pipelines.compute(device, shader, "scan_blocks"));
    dispatch(pass, items.max(1));
    pass.set_pipeline(&pipelines.compute(device, shader, "scan_sums"));
    pass.dispatch_workgroups(1, 1, 1);
    pass.set_pipeline(&pipelines.compute(device, shader, "add_sums"));
    dispatch(pass, items);
}
