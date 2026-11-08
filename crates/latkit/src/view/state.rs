//! Records changed row pages through the shared raster evaluator. Arena addresses and retained
//! endpoint state stay stable; only the pages written by this step are gathered from scratch, one
//! pass per batch.

use super::{View, marks::Blocks, passes::offset, words::Kept};
use crate::gpu::work::Count;
use crate::gpu::{Inner, raster::Raster, shaders as w, state::BATCH};

impl View {
    pub(super) fn state_rows(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        entry: &'static str,
        marks: &[usize],
    ) {
        if marks.is_empty() {
            return;
        }
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let resources = self.resources.as_mut().expect("frame resources");
        let groups = resources.groups(&gpu.0, inner);
        for &index in marks {
            let shown = &mut self.marks[index];
            let Some(compiled) = &shown.compiled else { continue };
            let (kernel, planes) = (compiled.kernel.clone(), compiled.planes.clone());
            let rows = if matches!(entry, "evaluate" | "ends") { shown.live() } else { shown.held() };
            let (blocks, first) = match entry {
                "evaluate" => (shown.blocks.of(rows), shown.block),
                "ends" => (shown.unresolved.of(rows), shown.end_block),
                _ => ((0..rows.div_ceil(w::PAGE_ROWS)).collect(), w::NONE),
            };
            let kept = match entry {
                "freeze" => Kept::Frozen,
                "evaluate" if shown.transition.is_some() => Kept::Settled,
                _ => Kept::State,
            };
            let width = shown.width();
            let input = resources.state_inputs(inner.arena.words(), &groups, offset(index), shown.reads());
            if entry == "evaluate" && shown.reduce && !shown.fits_data() {
                let mut raster = Raster { device, queue, pipelines: &mut inner.pipelines, encoder };
                inner.state.domains(&mut raster, &input, &kernel, rows, shown.reductions(), shown.domains * 2);
            }
            let filled: Vec<_> =
                blocks.iter().map(|&page| shown.filled(page).min(rows - page * w::PAGE_ROWS)).collect();
            for (batch, count) in batches(&filled) {
                let pages = &blocks[batch.clone()];
                if entry == "evaluate" && shown.transition.is_some() {
                    for &page in pages.iter().filter(|page| shown.fresh.contains(page)) {
                        let at = shown.words.pages(Kept::State).blocks[page as usize];
                        inner.arena.clear_words(
                            queue,
                            encoder,
                            at,
                            (shown.filled(page).min(rows - page * w::PAGE_ROWS) * width).next_multiple_of(4),
                        );
                    }
                }
                let mut raster = Raster { device, queue, pipelines: &mut inner.pipelines, encoder };
                let packed = inner.state.record(
                    &mut raster,
                    &input,
                    entry,
                    (entry == "evaluate").then_some((&kernel, &*planes)),
                    w::StateStep {
                        first: batch.start as u32 * w::PAGE_ROWS,
                        rows: count,
                        block: first,
                        word: 0,
                        ..bytemuck::Zeroable::zeroed()
                    },
                    width,
                );
                let copies: Vec<[u32; 3]> = pages
                    .iter()
                    .enumerate()
                    .map(|(local, &page)| {
                        let count = filled[batch.start + local];
                        [
                            local as u32 * w::PAGE_ROWS * width,
                            shown.words.pages(kept).blocks[page as usize],
                            (count * width).next_multiple_of(4),
                        ]
                    })
                    .collect();
                raster.gather(packed, inner.arena.words(), &copies);
            }
            let changed: u64 = filled.iter().map(|&count| u64::from(count)).sum();
            match entry {
                "evaluate" => {
                    gpu.0.counters.add(Count::Evaluated, changed);
                    shown.dirty = 0;
                    shown.blocks = Blocks::default();
                    shown.reduce = false;
                    shown.fresh.clear();
                }
                "ends" => {
                    gpu.0.counters.add(Count::Resolved, changed);
                    shown.unresolved = Blocks::default();
                    shown.version += 1;
                    shown.place_version += 1;
                }
                _ => {}
            }
        }
    }
}

/// A short page ends a batch so no fragment evaluates its padding. Empty slots are skipped;
/// the range still indexes the original block table, including its freshness flags.
fn batches(filled: &[u32]) -> impl Iterator<Item = (std::ops::Range<usize>, u32)> + '_ {
    let mut next = 0;
    std::iter::from_fn(move || {
        while filled.get(next) == Some(&0) {
            next += 1;
        }
        let first = next;
        let mut count = 0;
        while let Some(&rows) = filled.get(next).filter(|&&rows| rows > 0) {
            count += rows;
            next += 1;
            if rows < w::PAGE_ROWS || next - first == (BATCH / w::PAGE_ROWS) as usize {
                break;
            }
        }
        (next > first).then_some((first..next, count))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn sparse_batches_keep_block_offsets_and_omit_padding() {
        let page = super::w::PAGE_ROWS;
        let mut rows = vec![0, 5, page, page, 17, 0, 3];
        rows.extend([page; 17]);
        assert_eq!(
            super::batches(&rows).collect::<Vec<_>>(),
            vec![(1..2, 5), (2..5, 2 * page + 17), (6..7, 3), (7..23, 16 * page), (23..24, page)]
        );
        assert_eq!(super::batches(&[0, 0]).next(), None);
        assert_eq!(super::batches(&[]).next(), None);
    }
}
