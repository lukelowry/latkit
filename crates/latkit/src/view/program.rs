//! The program buffer: each mark's column descriptors and tables, ranges, code, constants, end
//! tables, and ports, in a region of its own.
//!
//! When a mark changes, only its region is rewritten, and only the words that differ. A region that
//! outgrows its room moves to the end of the buffer. If the buffer is too small, it grows and the
//! GPU copies its contents over, so no other region is rewritten. Once moved regions leave more of
//! the buffer unused than the regions take, every region is laid out again from the start, each
//! writing only its own words.

use super::{Event, View};
use crate::gpu::Inner;

/// Where the next region starts, and whether every region must be laid out again.
#[derive(Default)]
pub(crate) struct Regions {
    pub(crate) end: u32,
    pub(crate) relayout: bool,
}

/// Changed words separated by fewer unchanged words than this are written in one span.
const GAP: usize = 16;

/// The room given to a region of `len` words, with slack to grow in place.
fn room(len: u32) -> u32 {
    len + len / 4 + 16
}

/// The spans of `words` that differ from `was` (the words last written there), as `[start, end)`.
/// Spans closer than `GAP` words merge.
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
    /// Writes every changed mark's words into its region of the program buffer. When the buffer
    /// grows, `encoder` copies the old contents over, and later writes are ordered after the copy.
    pub(super) fn pack(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let font = self.scene.theme.text.font.clone();
        for shown in self.marks.iter_mut().filter(|m| !m.packed) {
            shown.write_ports(&font, inner);
            let Some(compiled) = &mut shown.compiled else { continue };
            let markers = &mut compiled.drawing.markers;
            if !markers.icons.is_empty() {
                match inner.icons.of(&gpu.0.device, &gpu.0.queue, &markers.icons) {
                    Ok(layers) => markers.palette = std::iter::once(layers.len() as u32).chain(layers).collect(),
                    Err(error) => self.events.tell(Event::Error(error)),
                }
            }
            for (at, colormap) in &compiled.program.colormaps {
                match inner.colormaps.colormap(&gpu.0.device, &gpu.0.queue, colormap) {
                    Ok(layer) => shown.code[*at as usize][1] = layer | colormap.kind().code() << 16,
                    Err(error) => self.events.tell(Event::Error(error)),
                }
            }
        }
        let resources = self.resources.as_mut().expect("created before packing");
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        // Whether `encoder` copied words this frame. Writes after a copy must be ordered after it.
        let mut ordered = false;
        let write =
            |encoder: &mut wgpu::CommandEncoder, ordered: bool, buffer: &wgpu::Buffer, at: u32, words: &[u32]| {
                let (at, bytes) = (u64::from(at) * 4, bytemuck::cast_slice(words));
                if ordered {
                    queue.write_buffer_in(device, encoder, buffer, at, bytes);
                } else {
                    queue.write_buffer(buffer, at, bytes);
                }
            };
        if !self.regions.relayout {
            // The room the regions take. Moved regions left the rest of the buffer, up to `end`.
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
                            ordered |= resources.grow_program(device, encoder, u64::from(end), kept);
                        }
                        // The GPU copies the region's words to the new place, so only changed words
                        // are written.
                        match region {
                            Some([from, _]) if !shown.written.is_empty() => {
                                let words = shown.written.len() as u32;
                                resources.move_program(device, encoder, from, start, words);
                                ordered = true;
                            }
                            _ => shown.written.clear(),
                        }
                        shown.region = Some([start, room(len)]);
                        self.regions.end = end;
                        start
                    }
                };
                let mut words = Vec::with_capacity(len as usize);
                shown.pack(start, &mut words);
                for [from, to] in changed(&shown.written, &words) {
                    write(encoder, ordered, resources.program(), start + from as u32, &words[from..to]);
                }
                shown.written = words;
                shown.packed = true;
            }
        }
        if std::mem::take(&mut self.regions.relayout) {
            let total: u64 = self.marks.iter().map(|m| u64::from(room(m.packed_len()))).sum();
            resources.fit_program(device, total);
            // Write each region's words at the start of its room. The slack after them is not
            // written: nothing reads it until the region grows into it and writes it.
            let mut start = 0;
            for shown in self.marks.iter_mut().filter(|m| m.compiled.is_some()) {
                let len = shown.packed_len();
                let mut words = Vec::with_capacity(len as usize);
                shown.pack(start, &mut words);
                write(encoder, ordered, resources.program(), start, &words);
                shown.written = words;
                shown.region = Some([start, room(len)]);
                shown.packed = true;
                start += room(len);
            }
            self.regions.end = start;
        }
    }
}
