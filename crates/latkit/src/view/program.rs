//! The program buffer: each mark's descriptors, tables, ranges, code, constants, ends, and ports in a
//! region of its own, rewritten alone when only that mark changed, and then only where its words
//! changed. A region that outgrows its room moves to the end of the buffer; a buffer too small for it
//! grows, what it holds copied into the new one on the GPU, so no other region is written again. Once
//! regions that moved leave more of the buffer behind than regions take, every region is laid out
//! again, each writing only its own words.

use super::{Event, View};
use crate::gpu::Inner;

/// Where the next region starts, and whether every region must be laid out again.
#[derive(Default)]
pub(crate) struct Regions {
    pub(crate) end: u32,
    pub(crate) relayout: bool,
}

/// Words alike between two that changed, past which they are written apart.
const GAP: usize = 16;

/// The room a region of `len` words gets, so it can grow a little in place.
fn room(len: u32) -> u32 {
    len + len / 4 + 16
}

/// The spans of `words` that differ from `was`, what the same place held, as `[start, end)`: those
/// closer than `GAP` words written as one.
fn changed(was: &[u32], words: &[u32]) -> Vec<[usize; 2]> {
    let mut spans: Vec<[usize; 2]> = Vec::new();
    for i in (0..words.len()).filter(|&i| was.get(i) != Some(&words[i])) {
        match spans.last_mut() {
            Some(span) if i - span[1] < GAP => span[1] = i + 1,
            _ => spans.push([i, i + 1]),
        }
    }
    spans
}

impl View {
    /// Writes every mark whose words changed into its region of the program buffer; a buffer grown
    /// has what it held copied over in `encoder`, and what is written after follows the copy there.
    pub(super) fn pack(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let font = self.scene.theme.text.font.clone();
        for shown in self.marks.iter_mut().filter(|m| !m.packed) {
            shown.write_ports(&font, inner);
            let Some(compiled) = &mut shown.compiled else { continue };
            let markers = &mut compiled.drawing.markers;
            if !markers.icons.is_empty() {
                let layers = inner.icons.layers(&gpu.0.device, &gpu.0.queue, &markers.icons);
                markers.palette = std::iter::once(layers.len() as u32).chain(layers).collect();
            }
            for (at, colormap) in &compiled.program.colormaps {
                match inner.colormaps.layer(&gpu.0.device, &gpu.0.queue, colormap) {
                    Ok(layer) => shown.code[*at as usize][1] = layer | colormap.kind().code() << 16,
                    Err(error) => self.events.tell(Event::Error(error)),
                }
            }
        }
        let resources = self.resources.as_mut().expect("created before packing");
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        // Whether the buffer grew this frame: its words are copied in `encoder`, so writes follow there.
        let mut grown = false;
        let write = |encoder: &mut wgpu::CommandEncoder, grown: bool, buffer: &wgpu::Buffer, at: u32, words: &[u32]| {
            let (at, bytes) = (u64::from(at) * 4, bytemuck::cast_slice(words));
            if grown {
                queue.write_buffer_in(device, encoder, buffer, at, bytes);
            } else {
                queue.write_buffer(buffer, at, bytes);
            }
        };
        if !self.regions.relayout {
            // The room regions take; the rest of the buffer up to its end, regions that moved left.
            let mut live: u32 = self.marks.iter().filter_map(|m| m.region).map(|[_, room]| room).sum();
            for shown in self.marks.iter_mut().filter(|m| !m.packed && m.compiled.is_some()) {
                let len = shown.packed_len();
                let start = match shown.region {
                    Some([start, room]) if len <= room => start,
                    region => {
                        let (start, end) = (self.regions.end, self.regions.end + room(len));
                        live = live - region.map_or(0, |[_, room]| room) + room(len);
                        if end > 2 * live {
                            self.regions.relayout = true;
                            break;
                        }
                        if u64::from(end) > resources.program_words() {
                            let kept = u64::from(self.regions.end);
                            grown |= resources.grow_program(device, encoder, u64::from(end), kept);
                        }
                        shown.region = Some([start, room(len)]);
                        shown.written.clear();
                        self.regions.end = end;
                        start
                    }
                };
                let mut words = Vec::with_capacity(len as usize);
                shown.pack(start, &mut words);
                for [from, to] in changed(&shown.written, &words) {
                    write(encoder, grown, resources.program(), start + from as u32, &words[from..to]);
                }
                shown.written = words;
                shown.packed = true;
            }
        }
        if std::mem::take(&mut self.regions.relayout) {
            let total: u64 = self.marks.iter().map(|m| u64::from(room(m.packed_len()))).sum();
            resources.fit_program(device, total);
            // Each region's own words, at the start of its room: the room past them, which nothing reads
            // until the region grows into it and writes it, is not written.
            let mut start = 0;
            for shown in self.marks.iter_mut().filter(|m| m.compiled.is_some()) {
                let len = shown.packed_len();
                let mut words = Vec::with_capacity(len as usize);
                shown.pack(start, &mut words);
                write(encoder, grown, resources.program(), start, &words);
                shown.written = words;
                shown.region = Some([start, room(len)]);
                shown.packed = true;
                start += room(len);
            }
            self.regions.end = start;
        }
    }
}
