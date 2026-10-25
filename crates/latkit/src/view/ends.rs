//! The end table: where each end of an edge or face row is held. A row's ends name places in the
//! order the vertices' table draws in, which stay put as the camera moves; the vertex mark drawing
//! that table holds its pages, and the rows it keeps whose pages it does not hold, where its drawing
//! lays them out, which moves as the camera does, a row at a time where the vertices the edges end at
//! lie sparse. So no channel stores where an end is held: a step of the expression machine
//! (`lib/ends.wesl`) finds it for the rows whose ends changed and the rows naming the vertices the
//! vertex mark's drawing says moved, and for every row once another mark or order holds them, and
//! writes it into the row's kind word of the end's number, where draws, probes, and normals read it
//! in one step.

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

/// Where the rows an end of a mark's rows names are held: the vertex mark drawing their table, the
/// pages of its rows' words and how many words a row has, and the pages of the normals faces sum at
/// them; and where it holds each page of the order it draws that table in, and each row it keeps whose
/// page it does not hold, by its place in the order, and the places its drawing moved.
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
            moved: None,
        }
    }

    /// Whether every vertex it names is held elsewhere than `before` holds it: by another mark, or in
    /// another order. Where only the vertex mark's pages of words, or the rows its drawing moved,
    /// changed, the rest are held where they were.
    fn moved_whole(&self, before: &End) -> bool {
        self.mark != before.mark || self.order != before.order
    }

    /// The places its drawing moved since `before` was attached, if any; where it moved none, none.
    fn moved_since(&self, before: &End) -> &[u32] {
        match (&self.moved, &before.moved) {
            (Some((version, places)), Some((was, _))) if version != was => places,
            _ => &[],
        }
    }

    /// Words it takes in a mark's program past its `END_WORDS`: its page table, where pages and rows
    /// kept are held, and its page table of normals.
    fn tables(&self) -> usize {
        let kept = |k: &KeptTable| 2 * k.buckets().len();
        self.state.len()
            + self.pages.as_ref().map_or(0, |p| 2 + p.len() + self.kept.as_ref().map_or(0, kept))
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
/// words; its pages, how many, then each one's slot, and the table of the rows it keeps, how many
/// buckets, then each one's place and held row; and the page table of normals. Ends holding their rows
/// alike share tables.
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
    /// Points every edge and face mark's ends at the vertex marks drawing their tables. Where another
    /// mark or another order holds the vertices an end names, every row finds its ends again; where
    /// the vertex mark's drawing moved some, the rows naming them; where only a vertex mark's pages of
    /// words moved, the ends read them where they are, and nothing runs.
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

    /// The row blocks of mark `i` whose rows end at any of `places` of the vertices its ends attach
    /// to, ascending: its drawing's pages whose ends lie there; `None` for a table drawn whole, whose
    /// rows end wherever.
    fn naming(&self, i: usize, places: &[u32]) -> Option<Vec<u32>> {
        let shown = &self.marks[i];
        let style = shown.mark.style();
        let drawn = self.drawings.get(&(style.data.clone(), style.table.clone()))?;
        Some(drawn.naming(shown.drawing()?, places))
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
                    kept: marks[m].drawing().map(|d| d.kept_table.clone()),
                    moved: marks[m].drawing().map(|d| d.moved.clone()),
                }
            }
            _ => End::unattached(),
        })
        .collect()
}
