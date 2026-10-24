//! The end table: where each end of an edge or face row is held. A row's ends name places in the
//! order the vertices' table draws in, which stay put as the camera moves; the vertex mark drawing
//! that table holds its pages, and the rows it keeps whose pages it does not hold, where its drawing
//! lays them out, which moves as the camera does, a row at a time where the vertices the edges end at
//! lie sparse. So no channel stores where an end is held: a step of the expression machine
//! (`lib/ends.wesl`) finds it for the rows whose ends changed, and for every row once the vertices
//! moved, and writes it into the row's kind word of the end's number, where draws, probes, and
//! normals read it in one step.

use std::sync::Arc;

use super::View;
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

/// Where the rows an end of a mark's rows names are held: the vertex mark drawing their table, the
/// pages of its rows' words and how many words a row has, and the pages of the normals faces sum at
/// them; and where it holds each page of the order it draws that table in, and each row it keeps whose
/// page it does not hold, by its place in the order, and what tells where it holds the rows edges end
/// at.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct End {
    pub(crate) mark: Option<usize>,
    pub(crate) state: Arc<[u32]>,
    pub(crate) stride: u32,
    pub(crate) normals: Option<Arc<[u32]>>,
    pub(crate) order: u64,
    pub(crate) pages: Option<Arc<[u32]>>,
    pub(crate) kept: Option<Arc<[[u32; 2]]>>,
    pub(crate) held_ends: Option<Version>,
}

impl End {
    /// An end no vertex mark draws the table of.
    pub(crate) fn unattached() -> End {
        End {
            mark: None,
            state: Arc::new([]),
            stride: 0,
            normals: None,
            order: 0,
            pages: None,
            kept: None,
            held_ends: None,
        }
    }

    /// Whether the vertices it names are held elsewhere than `before` holds them: by another mark, in
    /// another order, or where the rows edges end at moved. Where only the vertex mark's pages of words
    /// or rows no edge ends at moved, every end is held where it was.
    fn moved(&self, before: &End) -> bool {
        self.mark != before.mark || self.order != before.order || self.held_ends != before.held_ends
    }

    /// Words it takes in a mark's program past its `END_WORDS`: its page table, where pages and rows
    /// kept are held, and its page table of normals.
    fn tables(&self) -> usize {
        self.state.len()
            + self.pages.as_ref().map_or(0, |p| 2 + p.len() + 2 * self.kept.as_ref().map_or(0, |k| k.len()))
            + self.normals.as_ref().map_or(0, |n| n.len())
    }
}

/// The end before end `c` of `ends` that holds its rows where it does, whose tables it shares: as the
/// two ends of an edge between vertices of one mark do.
fn shared(ends: &[End], c: usize) -> Option<usize> {
    ends[..c].iter().position(|e| *e == ends[c])
}

/// Words a mark's `ends` take in its program.
pub(super) fn words(ends: &[End]) -> usize {
    (0..ends.len())
        .map(|c| wgsl::END_WORDS as usize + if shared(ends, c).is_some() { 0 } else { ends[c].tables() })
        .sum()
}

/// Appends the words of a mark's `ends`, which the program's `uses` name, starting at word `at` of
/// the program buffer: `END_WORDS` an end, then each end's tables: the page table of its vertex mark's
/// words; its pages, how many, then each one's slot, and the rows it keeps, how many, then each one's
/// place and held row; and the page table of normals. Ends holding their rows alike share tables.
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
            let slots = end
                .pages
                .as_ref()
                .map_or(wgsl::NONE, |p| take(2 + p.len() + 2 * end.kept.as_ref().map_or(0, |k| k.len())));
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
            let kept = end.kept.as_deref().unwrap_or_default();
            out.push(kept.len() as u32);
            out.extend(kept.iter().flatten());
        }
        if let Some(normals) = &end.normals {
            out.extend(normals.iter());
        }
    }
}

impl View {
    /// Points every edge and face mark's ends at the vertex marks drawing their tables. Where the
    /// vertices an end names are held elsewhere, every row finds its ends again; where only a vertex
    /// mark's pages of words moved, the ends read them where they are, and nothing runs.
    pub(super) fn attach_ends(&mut self) {
        for i in 0..self.marks.len() {
            let ends = ends(&self.marks, i);
            let was = &self.marks[i].ends;
            if ends == *was {
                continue;
            }
            let moved = ends.len() != was.len() || ends.iter().zip(was).any(|(end, before)| end.moved(before));
            self.marks[i].ends = ends;
            self.marks[i].packed = false;
            if moved {
                self.marks[i].unresolved = Blocks::All;
            }
        }
    }

    /// Finds where the ends of `marks`' rows whose ends changed are held, each over the row blocks it
    /// lists for them, with the expression machine each mark's channels run on; `group` is its group.
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
            pass.set_pipeline(&inner.pipelines.compute_pipeline(device, Variant::channels(shown.reads())));
            pass.set_bind_group(1, mark, &[offset(i)]);
            dispatch_blocks(pass, rows, shown.end_block_count);
            let blocks = shown.unresolved.of(rows);
            let resolved = blocks.iter().map(|&b| u64::from((rows - b * wgsl::PAGE_ROWS).min(wgsl::PAGE_ROWS)));
            self.gpu.0.counters.add(Count::Resolved, resolved.sum());
            shown.unresolved = Blocks::default();
            // Its state changed where its ends did, and what its rows' ends place with it.
            shown.version += 1;
            shown.place_version += 1;
        }
        pass.set_bind_group(2, group, &[step(wgsl::STEP_CHANNELS)]);
    }
}

/// Where each of mark `i`'s ends finds its vertices: the vertex mark it attaches to, the pages of
/// that mark's rows' words and of the normals faces sum at them, and where it holds the pages of the
/// order it draws its table in, if in part. An end attaches to the unnamed vertex mark drawing its
/// table, else to the first one, while that mark has pages for the rows it holds.
fn ends(marks: &[Shown], i: usize) -> Vec<End> {
    let Some(compiled) = &marks[i].compiled else { return Vec::new() };
    let data = &marks[i].mark.style().data;
    compiled
        .program
        .ends
        .iter()
        .map(|end| match super::graph::end_mark(marks, data, &end.table) {
            // A vertex mark without pages for its rows draws nothing, and nothing ends at it.
            Some(m) if marks[m].pages_held() => {
                let (state, normals) = (marks[m].words.pages(Kept::State), marks[m].words.pages(Kept::Normals));
                End {
                    mark: Some(m),
                    state: state.blocks.clone(),
                    stride: state.width,
                    normals: (normals.width > 0).then(|| normals.blocks.clone()),
                    order: marks[m].drawing().map_or(0, |d| d.order.id()),
                    pages: marks[m].drawing().map(|d| d.pages.clone()),
                    kept: marks[m].drawing().map(|d| d.kept_rows.clone()),
                    held_ends: marks[m].drawing().map(|d| d.held_ends),
                }
            }
            _ => End::unattached(),
        })
        .collect()
}
