//! The end table: where each endpoint of an edge or face row is held on the GPU.
//!
//! A row's ends reference places in the vertex table's order, which do not change as the camera
//! moves. The held row of a place does change: the vertex mark's drawing assigns resident pages to
//! slots and keeps sparse endpoints individually. So no channel stores held rows. Instead an
//! expression-machine step (`lib/ends.wesl`) resolves them and writes each into the row's kind
//! word for that end, where draws, probes, and normals read it directly. The step runs for rows
//! whose ends changed, for rows that reference vertices the drawing moved, and for every row when
//! another mark or another order holds the vertices.

use std::sync::Arc;

use super::View;
use super::kept::KeptTable;
use super::marks::{Blocks, Shown};
use super::passes::{dispatch_blocks, offset};
use super::resources::step;
use super::words::Kept;
use crate::data::Version;
use crate::expr::compile::EndUse;
use crate::gpu::Inner;
use crate::gpu::pipelines::Variant;
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Count;

/// Where the vertices that one end of a mark's rows references are held: the vertex mark drawing
/// their table (`mark`), its state pages and words per row (`state`, `stride`), and its pages of
/// the normals faces sum into (`normals`). For a paged vertex table, also its order's id, each
/// page's slot (`pages`), the kept rows by order place (`kept`), and the places its drawing moved.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct End {
    pub(crate) mark: Option<usize>,
    pub(crate) state: Arc<[u32]>,
    pub(crate) stride: u32,
    pub(crate) normals: Option<Arc<[u32]>>,
    pub(crate) order: u64,
    pub(crate) pages: Option<Arc<[u32]>>,
    pub(crate) kept: Option<KeptTable>,
    pub(crate) moved: Option<(Version, Arc<[u32]>)>,
}

impl End {
    /// An end whose table no vertex mark draws.
    pub(crate) fn unattached() -> End {
        End {
            mark: None,
            state: Arc::new([]),
            stride: 0,
            normals: None,
            order: 0,
            pages: None,
            kept: None,
            moved: None,
        }
    }

    /// Whether every referenced vertex may be held elsewhere than in `before`: another mark or
    /// another order holds them. If only the vertex mark's word pages or its drawing's moved places
    /// changed, the other vertices stay where they were.
    fn moved_whole(&self, before: &End) -> bool {
        self.mark != before.mark || self.order != before.order
    }

    /// The places its drawing moved since `before` was attached. Empty if none moved.
    fn moved_since(&self, before: &End) -> &[u32] {
        match (&self.moved, &before.moved) {
            (Some((version, places)), Some((was, _))) if version != was => places,
            _ => &[],
        }
    }

    /// Words its tables take in a mark's program beyond its `END_WORDS`: the state page table, the
    /// page slots and kept-row table, and the normals page table.
    fn tables(&self) -> usize {
        let kept = |k: &KeptTable| 2 * k.buckets().len();
        self.state.len()
            + self.pages.as_ref().map_or(0, |p| 2 + p.len() + self.kept.as_ref().map_or(0, kept))
            + self.normals.as_ref().map_or(0, |n| n.len())
    }
}

/// An earlier end of `ends` equal to end `c`, whose tables `c` shares, as both ends of an edge
/// between vertices of one mark do.
fn shared(ends: &[End], c: usize) -> Option<usize> {
    ends[..c].iter().position(|e| *e == ends[c])
}

/// Words a mark's `ends` take in its program.
pub(super) fn words(ends: &[End]) -> usize {
    (0..ends.len())
        .map(|c| wgsl::END_WORDS as usize + if shared(ends, c).is_some() { 0 } else { ends[c].tables() })
        .sum()
}

/// Appends the words of a mark's `ends`, whose columns `uses` gives, starting at word `at` of the
/// program buffer. First `END_WORDS` per end, then each end's tables: the state page table of its
/// vertex mark; the page count, then each page's slot; the kept-row bucket count, then each
/// bucket's place and held row; and the normals page table. Equal ends share tables.
pub(super) fn pack(ends: &[End], uses: &[EndUse], at: u32, out: &mut Vec<u32>) {
    let mut heads: Vec<[u32; wgsl::END_WORDS as usize]> = Vec::with_capacity(ends.len());
    let mut table = at + wgsl::END_WORDS * ends.len() as u32;
    let mut take = |len: usize| {
        let at = table;
        table += len as u32;
        at
    };
    for (c, (end, used)) in ends.iter().zip(uses).enumerate() {
        let mut head = if let Some(earlier) = shared(ends, c) {
            heads[earlier]
        } else {
            let state = if end.mark.is_some() { take(end.state.len()) } else { wgsl::NONE };
            let kept = end.kept.as_ref().map_or(0, |k| 2 * k.buckets().len());
            let slots = end.pages.as_ref().map_or(wgsl::NONE, |p| take(2 + p.len() + kept));
            let normals = end.normals.as_ref().map_or(wgsl::NONE, |n| take(n.len()));
            [state, end.stride, slots, normals, wgsl::NONE]
        };
        head[wgsl::END_COLUMN as usize] = used.column;
        heads.push(head);
        out.extend(head);
    }
    for (c, end) in ends.iter().enumerate() {
        if shared(ends, c).is_some() {
            continue;
        }
        if end.mark.is_some() {
            out.extend(end.state.iter());
        }
        if let Some(pages) = &end.pages {
            out.push(pages.len() as u32);
            out.extend(pages.iter());
            let kept = end.kept.as_ref().map_or(&[][..], KeptTable::buckets);
            out.push(kept.len() as u32);
            out.extend(kept.iter().flatten());
        }
        if let Some(normals) = &end.normals {
            out.extend(normals.iter());
        }
    }
}

impl View {
    /// Points every edge and face mark's ends at the vertex marks drawing their tables. If another
    /// mark or order now holds an end's vertices, every row resolves its endpoints again. If the
    /// vertex drawing moved some vertices, only the rows that reference them do. If only the vertex
    /// mark's word pages moved, the ends read the new pages and nothing is resolved.
    pub(super) fn attach_ends(&mut self) {
        for i in 0..self.marks.len() {
            let ends = ends(&self.marks, i);
            let was = &self.marks[i].ends;
            if ends == *was {
                continue;
            }
            let whole = ends.len() != was.len() || ends.iter().zip(was).any(|(end, before)| end.moved_whole(before));
            let mut places: Vec<u32> =
                ends.iter().zip(was).flat_map(|(end, before)| end.moved_since(before).iter().copied()).collect();
            places.sort_unstable();
            places.dedup();
            let blocks = match (whole, places.is_empty()) {
                (true, _) => None,
                (false, true) => Some(Vec::new()),
                (false, false) => self.naming(i, &places),
            };
            let shown = &mut self.marks[i];
            match blocks {
                Some(blocks) => shown.unresolved.add(Some(&blocks)),
                None => shown.unresolved = Blocks::All,
            }
            shown.ends = ends;
            shown.packed = false;
        }
    }

    /// The row blocks of mark `i` whose rows end at any of `places` in the attached vertex table,
    /// ascending: the slots of its drawing whose endpoints include them. `None` for a fully drawn
    /// table, which keeps no per-page endpoints, so every block resolves.
    fn naming(&self, i: usize, places: &[u32]) -> Option<Vec<u32>> {
        let shown = &self.marks[i];
        let style = shown.mark.style();
        let drawn = self.drawings.get(&(style.data.clone(), style.table.clone()))?;
        Some(drawn.naming(shown.drawing()?, places))
    }

    /// Resolves the held rows of the ends of `marks`' unresolved rows, over the row blocks each
    /// lists, by running the end step on the pipeline each mark's channels use. `group` is the
    /// expression machine's step group, left set to the channel step.
    pub(super) fn resolve_ends(
        &mut self,
        pass: &mut wgpu::ComputePass<'_>,
        inner: &mut Inner,
        mark: &wgpu::BindGroup,
        group: &wgpu::BindGroup,
        marks: &[usize],
    ) {
        if marks.is_empty() {
            return;
        }
        let device = &self.gpu.0.device;
        pass.set_bind_group(2, group, &[step(wgsl::STEP_ENDS)]);
        for &i in marks {
            let shown = &mut self.marks[i];
            let rows = shown.live();
            pass.set_pipeline(&inner.pipelines.compute(device, Variant::channels(shown.reads())));
            pass.set_bind_group(1, mark, &[offset(i)]);
            dispatch_blocks(pass, rows, shown.end_block_count);
            let blocks = shown.unresolved.of(rows);
            let resolved = blocks.iter().map(|&b| u64::from((rows - b * wgsl::PAGE_ROWS).min(wgsl::PAGE_ROWS)));
            self.gpu.0.counters.add(Count::Resolved, resolved.sum());
            shown.unresolved = Blocks::default();
            // Resolving writes its state and can move where its rows stand, which places labels.
            shown.version += 1;
            shown.place_version += 1;
        }
        pass.set_bind_group(2, group, &[step(wgsl::STEP_CHANNELS)]);
    }
}

/// Where each of mark `i`'s ends finds its vertices: the vertex mark it attaches to, that mark's
/// state and normals pages, and for a paged table, its drawing's page slots and kept rows. An end
/// attaches to the unnamed vertex mark drawing its table, otherwise the first one, but only while
/// that mark has word pages for all its held rows.
fn ends(marks: &[Shown], i: usize) -> Vec<End> {
    let Some(compiled) = &marks[i].compiled else { return Vec::new() };
    let data = &marks[i].mark.style().data;
    compiled
        .program
        .ends
        .iter()
        .map(|end| match super::graph::end_mark(marks, data, &end.table) {
            // A vertex mark without word pages for its rows draws nothing. Nothing attaches to it.
            Some(m) if marks[m].pages_held() => {
                let (state, normals) = (marks[m].words.pages(Kept::State), marks[m].words.pages(Kept::Normals));
                End {
                    mark: Some(m),
                    state: state.blocks.clone(),
                    stride: state.width,
                    normals: (normals.width > 0).then(|| normals.blocks.clone()),
                    order: marks[m].drawing().map_or(0, |d| d.order.id()),
                    pages: marks[m].drawing().map(|d| d.pages.clone()),
                    kept: marks[m].drawing().map(|d| d.kept_table.clone()),
                    moved: marks[m].drawing().map(|d| d.moved.clone()),
                }
            }
            _ => End::unattached(),
        })
        .collect()
}
