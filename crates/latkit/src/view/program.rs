//! The program buffer: each mark's descriptors, tables, ranges, code, constants, ends, and ports in a
//! region of its own, rewritten alone when only that mark changed, and then only where its words
//! changed. A region that outgrows its room moves to the end of the buffer; when the end passes the
//! buffer, every region is laid out again.

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
    /// Writes every mark whose words changed into its region of the program buffer.
    pub(super) fn pack(&mut self, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let font = self.scene.theme.font.clone();
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
        let capacity = resources.program_words() as u32;
        if !self.regions.relayout {
            for shown in self.marks.iter_mut().filter(|m| !m.packed && m.compiled.is_some()) {
                let len = shown.packed_len();
                let start = match shown.region {
                    Some([start, room]) if len <= room => start,
                    _ if self.regions.end + room(len) <= capacity => {
                        let start = self.regions.end;
                        shown.region = Some([start, room(len)]);
                        shown.written.clear();
                        self.regions.end += room(len);
                        start
                    }
                    _ => {
                        self.regions.relayout = true;
                        break;
                    }
                };
                let mut words = Vec::with_capacity(len as usize);
                shown.pack(start, &mut words);
                for [from, to] in changed(&shown.written, &words) {
                    let at = u64::from(start) * 4 + from as u64 * 4;
                    gpu.0.queue.write_buffer(resources.program(), at, bytemuck::cast_slice(&words[from..to]));
                }
                shown.written = words;
                shown.packed = true;
            }
        }
        if std::mem::take(&mut self.regions.relayout) {
            let total: u64 = self.marks.iter().map(|m| u64::from(room(m.packed_len()))).sum();
            resources.fit_program(&gpu.0.device, total);
            let mut words = Vec::with_capacity(total as usize);
            for shown in self.marks.iter_mut().filter(|m| m.compiled.is_some()) {
                let start = words.len() as u32;
                let len = shown.packed_len();
                shown.pack(start, &mut words);
                shown.written = words[start as usize..].to_vec();
                words.resize((start + room(len)) as usize, 0);
                shown.region = Some([start, room(len)]);
                shown.packed = true;
            }
            self.regions.end = words.len() as u32;
            gpu.0.queue.write_buffer(resources.program(), 0, bytemuck::cast_slice(&words));
        }
    }
}
