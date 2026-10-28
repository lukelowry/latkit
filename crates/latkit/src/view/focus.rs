//! Focus words: selection, hover, and the rows a fit measures, as bits in one word per held row of
//! every mark, kept in its focus word pages and written only where they change.
//!
//! The selection keeps only rows a pickable mark shows. The endpoints of a selected or hovered edge
//! are lit too. Each mark's lit rows are listed by draw index for its focus draw, which draws them
//! again over everything with a glow. Hover is always state that expressions can read. The controls
//! decide whether it glows.

use rustc_hash::FxHashMap;

use super::View;
use super::event::{Event, Hit};
use super::sync::Source;
use super::words::Kept;
use crate::data::{Field, PAGE_ROWS, Reference};
use crate::expr::compile::Deps;
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Queue;
use crate::scene::mark::Primitive;
use crate::{Row, Rows};

/// The row gap at which two changed words of a page are written separately. Closer ones share one
/// write, along with the unchanged words between them.
const GAP: u32 = 16;

/// A focus word's mark and held row.
type At = (usize, u32);

#[derive(Default)]
pub(crate) struct Focus {
    pub(crate) selection: Vec<Row>,
    /// The hovered row, as hit.
    pub(crate) hovered: Option<Hit>,
    /// Rows a fit measures.
    pub(crate) fitting: Vec<Row>,
    /// The words last written, by mark and held row.
    written: FxHashMap<At, u32>,
    pub(crate) dirty: bool,
    /// Every mark's lit rows, if laid out since last taken.
    lit: Option<Vec<u32>>,
}

impl Focus {
    /// Takes the lit rows laid out since last taken, for writing to the lit buffer.
    pub(crate) fn take_lit(&mut self) -> Option<Vec<u32>> {
        self.lit.take()
    }

    /// Follows a scene change: the words written for each mark move with its pages to its new index
    /// in `moved` (old index to new), and those of dropped marks, whose pages went with them, go.
    pub(crate) fn renumber(&mut self, moved: &FxHashMap<usize, usize>) {
        self.written = std::mem::take(&mut self.written)
            .into_iter()
            .filter_map(|((mark, row), word)| Some(((*moved.get(&mark)?, row), word)))
            .collect();
        self.dirty = true;
    }
}

/// Where a mark's lit rows lie in the lit buffer, how many, and the instances each draws.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Lit {
    pub(crate) at: u32,
    pub(crate) rows: u32,
    pub(crate) pieces: u32,
}

impl View {
    /// Writes changed focus words into `pages`, or every word when `fresh` (focus word pages new or
    /// moved). Channels reading focus evaluate again where words changed, and every mark's lit rows
    /// are laid out again.
    pub(super) fn write_focus(&mut self, queue: &Queue, pages: &wgpu::Buffer, fresh: bool) {
        if fresh {
            self.focus.written.clear();
            self.focus.dirty = true;
        }
        if !std::mem::take(&mut self.focus.dirty) {
            return;
        }
        let mut words: FxHashMap<At, u32> = FxHashMap::default();
        let glows = self.scene.controls.hover;
        let hovered = self.focus.hovered.as_ref().map(|hit| hit.row.clone());
        let selection = self.focus_rows(&self.focus.selection, wgsl::SELECTED, true, true, &mut words);
        self.focus_rows(hovered.as_slice(), wgsl::HOVERED, true, glows, &mut words);
        self.focus_rows(&self.focus.fitting, wgsl::FIT, false, false, &mut words);
        // Rows the data no longer holds, or no mark shows, leave the selection.
        if selection.len() < self.focus.selection.len() {
            self.focus.selection.clone_from(&selection);
            self.events.tell(Event::Selection { rows: Rows::group(selection), trigger: None });
        }
        let cleared = self.focus.written.keys().filter(|at| !words.contains_key(at)).copied();
        let set = words.iter().filter(|(at, b)| self.focus.written.get(at) != Some(b)).map(|(&at, _)| at);
        let mut changes: Vec<At> = cleared.chain(set).collect();
        changes.sort_unstable();
        // Write each page's changed words in runs, unchanged words between them included.
        for run in changes.chunk_by(|a, b| a.0 == b.0 && a.1 >> wgsl::PAGE_BITS == b.1 >> wgsl::PAGE_BITS) {
            let (mark, page) = (run[0].0, run[0].1 >> wgsl::PAGE_BITS);
            let Some(&block) = self.marks[mark].words.pages(Kept::Focus).blocks.get(page as usize) else { continue };
            let mut start = 0;
            for end in 1..=run.len() {
                if end < run.len() && run[end].1 - run[end - 1].1 < GAP {
                    continue;
                }
                let (first, last) = (run[start].1, run[end - 1].1);
                let bits: Vec<u32> = (first..=last).map(|row| words.get(&(mark, row)).copied().unwrap_or(0)).collect();
                let at = block + (first & wgsl::PAGE_MASK);
                queue.write_buffer(pages, u64::from(at) * 4, bytemuck::cast_slice(&bits));
                start = end;
            }
        }
        if !changes.is_empty() {
            // Channels reading focus evaluate the pages of rows whose words changed, or every row
            // when the focus word pages are new.
            for (i, shown) in self.marks.iter_mut().enumerate() {
                let pages: Vec<u32> =
                    changes.iter().filter(|&&(mark, _)| mark == i).map(|&(_, row)| row / wgsl::PAGE_ROWS).collect();
                shown.dirty_rows(shown.channels_reading(Deps::FOCUS), (!fresh).then_some(&pages[..]));
            }
        }
        // When hover does not glow, rows lit only by hover are left out of the focus draw.
        self.lay_out_lit(&words, if glows { wgsl::LIT } else { wgsl::LIT & !wgsl::HOVERED });
        self.focus.written = words;
    }

    /// Sets `bit` in the focus words of `rows` in every mark drawing their table (only pickable
    /// marks with `picked`), and with `ends` also lights the endpoints of each edge among them.
    /// Returns the rows some mark shows. A row in the data stays shown even while its paged table
    /// has no resident page for it.
    fn focus_rows(&self, rows: &[Row], bit: u32, picked: bool, ends: bool, words: &mut FxHashMap<At, u32>) -> Vec<Row> {
        let mut kept = Vec::new();
        for row in rows {
            let Some(table) = self.snapshot(&row.data).and_then(|d| d.table(&row.table)) else { continue };
            let Some(index) = table.row(row.id.as_ref()) else { continue };
            let mut shows = false;
            for (i, shown) in self.marks.iter().enumerate() {
                let style = shown.mark.style();
                if (picked && !shown.mark.picks()) || style.data != row.data || style.table != row.table {
                    continue;
                }
                shows = true;
                if let Some(held) = shown.held_row(index as u32) {
                    *words.entry((i, held)).or_default() |= bit;
                }
                let crate::Mark::Edges(edges) = &shown.mark else { continue };
                let Some((from, to)) = edges.ends.as_ref().filter(|_| ends) else { continue };
                for end in [from, to] {
                    let Some(Field::Reference(reference)) = table.field_named(end) else { continue };
                    self.light_end(&row.data, reference, index, words);
                }
            }
            if shows {
                kept.push(row.clone());
            }
        }
        kept
    }

    /// Sets the `END` bit of the vertex `reference` names for row `index`, in every vertex mark
    /// holding it.
    fn light_end(&self, data: &crate::Name, reference: &Reference, index: usize, words: &mut FxHashMap<At, u32>) {
        let Some(target) = reference.target(index) else { return };
        for (i, shown) in self.marks.iter().enumerate() {
            let style = shown.mark.style();
            if shown.kind() == crate::scene::mark::MarkKind::Vertices
                && style.data == *data
                && style.table == reference.to
                && let Some(held) = shown.held_row(target)
            {
                *words.entry((i, held)).or_default() |= wgsl::END;
            }
        }
    }

    /// Lists each mark's drawn rows with any `glowing` bit set, by draw index, for its focus draw,
    /// with the instances each takes.
    fn lay_out_lit(&mut self, words: &FxHashMap<At, u32>, glowing: u32) {
        let mut all = Vec::new();
        for i in 0..self.marks.len() {
            let shown = &self.marks[i];
            let live = shown.live();
            let mut lit: Vec<(u32, u32)> = words
                .iter()
                .filter(|&(&(mark, held), &bits)| mark == i && held < live && bits & glowing != 0)
                .filter_map(|(&(_, held), _)| Some((shown.item_of(held)?, held)))
                .collect();
            lit.sort_unstable();
            let held: Vec<u32> = lit.iter().map(|&(_, h)| h).collect();
            let pieces = if lit.is_empty() { 0 } else { self.pieces(i, &held) };
            let rows = if pieces == 0 { 0 } else { lit.len() as u32 };
            self.marks[i].lit = Lit { at: all.len() as u32, rows, pieces };
            if rows > 0 {
                all.extend(lit.into_iter().map(|(item, _)| item));
            }
        }
        self.focus.lit = Some(all);
    }

    /// Instances each lit row takes in mark `i`'s focus draw, for lit held rows `lit`. One for a
    /// point. For paths and areas, enough for the longest lit row's pieces (a shorter row's extra
    /// instances draw nothing). None for faces.
    fn pieces(&self, i: usize, lit: &[u32]) -> u32 {
        let shown = &self.marks[i];
        if shown.compiled.is_none() {
            return 0;
        }
        match shown.kind().primitive() {
            Primitive::Points => 1,
            Primitive::Strokes if !shown.listed() => shown.segments_per_row().max(1),
            Primitive::Strokes if shown.path() == wgsl::PATH_ENDS => (self.longest(i, lit) + 1).max(wgsl::MAX_PIECES),
            Primitive::Strokes => self.longest(i, lit).saturating_sub(1),
            Primitive::Triangles if shown.path() == wgsl::PATH_GEOMETRY => self.longest(i, lit).saturating_sub(1) / 3,
            Primitive::Triangles => 0,
        }
    }

    /// The most points any of mark `i`'s lit held rows `lit` has in its geometry column: path
    /// points, bends, or triangle corners.
    fn longest(&self, i: usize, lit: &[u32]) -> u32 {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return 0 };
        let Some(column) = compiled.program.columns.get(compiled.drawing.geometry as usize) else { return 0 };
        let Some(source) = Source::of(shown.mark.style(), &self.snapshots, &self.derived) else { return 0 };
        let Some((_, table)) = source.table_of(column, &self.snapshots) else { return 0 };
        let Some(Field::Values(values, _)) = table.field_named(&column.name) else { return 0 };
        let pages = values.pages();
        lit.iter()
            .filter_map(|&held| {
                let row = shown.source_row(held)? as usize;
                let page = pages.get(row / PAGE_ROWS)?;
                Some(page.values.geometry()?.row_coords(row % PAGE_ROWS).len() as u32)
            })
            .max()
            .unwrap_or(0)
    }
}
