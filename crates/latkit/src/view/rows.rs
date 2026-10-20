//! Row regions: each mark's rows in every per-row buffer (kind words, extra words, and focus words),
//! laid out from one capacity per mark with room to grow. When a mark outgrows its room, every region
//! is laid out again into new buffers and each mark's rows move by copy, so what they hold survives:
//! eased state, a transition's frozen rows.
//!
//! Vertex marks come first, so a vertex's slot (its kind words' offset over `VERTEX_WORDS`) counts
//! every vertex mark's rows.

use super::View;
use crate::scene::mark::MarkKind;

/// Where a mark's rows sit in each per-row buffer, in words.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Region {
    /// Rows the region holds.
    pub(crate) capacity: u32,
    pub(crate) stride: u32,
    pub(crate) extras: u32,
    pub(crate) state: u32,
    pub(crate) extra: u32,
    pub(crate) focus: u32,
}

impl Region {
    pub(crate) const EMPTY: Region = Region { capacity: 0, stride: 0, extras: 0, state: 0, extra: 0, focus: 0 };
}

/// Room for `rows` rows and some to spare, so streaming rows in rarely lays regions out again.
fn room(rows: u32) -> u32 {
    rows + rows / 4 + 64
}

/// Totals of a layout: words in each buffer.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Sizes {
    pub(crate) state: u64,
    pub(crate) focus: u64,
}

impl View {
    /// Fits every mark's rows and exits into its region. When one outgrows its room, or a mark's row
    /// shape changed, lays every region out again into new buffers, copying each mark's rows over in
    /// `encoder`. True when regions moved: vertex slots changed and focus words are written again.
    pub(super) fn fit_rows(&mut self, encoder: &mut wgpu::CommandEncoder) -> bool {
        let shape = |m: &super::marks::Shown| (m.stride(), m.extras());
        let fits = self.marks.iter().all(|m| {
            let r = &m.region;
            m.rows + m.exits <= r.capacity && (r.stride, r.extras) == shape(m)
        });
        if fits && !self.regions_dirty {
            return false;
        }
        self.regions_dirty = false;
        let order: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].kind() == MarkKind::Vertices)
            .chain((0..self.marks.len()).filter(|&i| self.marks[i].kind() != MarkKind::Vertices))
            .collect();
        let mut sizes = Sizes::default();
        let mut regions = vec![Region::EMPTY; self.marks.len()];
        for &i in &order {
            let m = &self.marks[i];
            let (stride, extras) = shape(m);
            let need = m.rows + m.exits;
            let capacity = if need <= m.region.capacity && (m.region.stride, m.region.extras) == (stride, extras) {
                m.region.capacity
            } else {
                room(need)
            };
            regions[i] =
                Region { capacity, stride, extras, state: sizes.state as u32, extra: 0, focus: sizes.focus as u32 };
            sizes.state += u64::from(capacity) * u64::from(stride);
            sizes.focus += u64::from(capacity);
        }
        // Extra words follow every mark's kind words.
        for &i in &order {
            regions[i].extra = sizes.state as u32;
            sizes.state += u64::from(regions[i].capacity) * u64::from(regions[i].extras);
        }
        let device = self.gpu.0.device.clone();
        let resources = self.resources.as_mut().expect("created before rows");
        let old = resources.replace_rows(&device, sizes);
        for (shown, new) in self.marks.iter_mut().zip(regions) {
            let was = shown.region;
            let kept = was.capacity.min(new.capacity).min(shown.held);
            let copy = |encoder: &mut wgpu::CommandEncoder,
                        from: &wgpu::Buffer,
                        to: &wgpu::Buffer,
                        a: u32,
                        b: u32,
                        words: u32| {
                if words > 0 {
                    encoder.copy_buffer_to_buffer(from, u64::from(a) * 4, to, u64::from(b) * 4, u64::from(words) * 4);
                }
            };
            if was.stride == new.stride {
                copy(encoder, &old.state, resources.state(), was.state, new.state, kept * new.stride);
            }
            if was.extras == new.extras {
                copy(encoder, &old.state, resources.state(), was.extra, new.extra, kept * new.extras);
            }
            // A running transition's frozen and settled rows move with its rows.
            if shown.transition.is_some() && (was.stride, was.extras) == (new.stride, new.extras) {
                let rows = was.capacity.min(new.capacity).min(shown.rows + shown.exits);
                for (from, to) in [(&old.frozen, resources.frozen()), (&old.settled, resources.settled())] {
                    if let (Some(from), Some(to)) = (from, to) {
                        copy(encoder, from, to, was.state, new.state, rows * new.stride);
                        copy(encoder, from, to, was.extra, new.extra, rows * new.extras);
                    }
                }
            }
            shown.moved = Some(was);
            shown.region = new;
        }
        resources.retire(old);
        true
    }
}
