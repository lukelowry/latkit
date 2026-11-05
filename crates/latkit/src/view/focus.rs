//! Focus words: selection, hover, and the rows a fit measures, as bits in one word per held row of
//! every mark, kept in its focus word pages and written only where they change. Focus belongs to
//! the row, so every mark drawing a row shows it, whether or not the pointer reaches the mark.
//!
//! A selected or hovered row lights the rows one reference from it in every mark: the rows it
//! references, and the rows that reference it, through any reference field of the tables marks
//! draw. A selected bus lights its branches and machines, and a selected branch its two buses. The
//! selection and hover may name rows no mark here draws, so views share them and light the rows
//! related to each other's. Each mark's lit rows are listed by draw index for its focus draw, which
//! draws them again over everything. Selected and hovered rows glow, and rows lit only as related
//! stay bright while a selection dims the rest. Hover is always state that expressions can read.
//! The controls decide whether it glows.
//!
//! The words the selection and a fit set are kept, so a hover change rewrites only the words of the
//! rows it lit and lights, in O(degree) however large the selection.

use std::collections::BTreeMap;

use rustc_hash::FxHashMap;

use super::View;
use super::event::Event;
use super::sync::Source;
use super::words::Kept;
use crate::data::{Field, PAGE_ROWS};
use crate::expr::compile::Deps;
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Queue;
use crate::scene::mark::Primitive;
use crate::{Name, Row, Rows};

/// The row gap at which two changed words of a page are written separately. Closer ones share one
/// write, along with the unchanged words between them.
const GAP: u32 = 16;

/// A focus word's mark and held row.
type At = (usize, u32);

/// Where the pointer or keys hover: the row, and the frame of the traced sample.
pub(crate) type Spot = (Row, Option<u64>);

#[derive(Default)]
pub(crate) struct Focus {
    pub(crate) selection: Vec<Row>,
    /// The hovered row: under the pointer, stepped to by the keys, or set by the application.
    pub(crate) hovered: Option<Row>,
    /// Where the pointer or keys hover it. `None` while they hover nothing.
    pub(crate) spot: Option<Spot>,
    /// Rows a fit measures.
    pub(crate) fitting: Vec<Row>,
    /// Whether the selection, the fit, or the rows under them changed, so every word is set again.
    pub(crate) dirty: bool,
    /// Whether the hovered row changed.
    pub(crate) hovering: bool,
    /// Whether the selection lights a row here, so the others dim.
    pub(crate) lighting: bool,
    /// The words the selection and the fit set, by mark and held row.
    standing: FxHashMap<At, u32>,
    /// The words the hovered row sets.
    passing: FxHashMap<At, u32>,
    /// The words last written. A word not here is 0.
    written: FxHashMap<At, u32>,
    /// Each mark's lit rows by draw index, with their held rows, and the instances each takes.
    lit_rows: Vec<(BTreeMap<u32, u32>, u32)>,
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
    /// moved). Channels reading focus evaluate again where words changed, and the lit rows of marks
    /// whose words changed are laid out again.
    pub(super) fn write_focus(&mut self, queue: &Queue, pages: &wgpu::Buffer, fresh: bool) {
        if fresh {
            self.focus.written.clear();
            self.focus.dirty = true;
        }
        let dirty = std::mem::take(&mut self.focus.dirty);
        if !dirty && !std::mem::take(&mut self.focus.hovering) {
            return;
        }
        self.focus.hovering = false;
        if dirty {
            let mut standing = FxHashMap::default();
            let selection = std::mem::take(&mut self.focus.selection);
            let kept = self.light(&selection, wgsl::SELECTED, wgsl::RELATED_SELECTED, &mut standing);
            self.light(&self.focus.fitting, wgsl::FIT, 0, &mut standing);
            // Rows the data no longer holds leave the selection.
            if kept.len() < selection.len() {
                self.events.tell(Event::Selection { rows: Rows::group(kept.iter().cloned()), trigger: None });
            }
            self.focus.selection = kept;
            self.focus.lighting = standing.values().any(|&w| w & (wgsl::SELECTED | wgsl::RELATED_SELECTED) != 0);
            self.focus.standing = standing;
        }
        let mut passing = FxHashMap::default();
        if let Some(row) = &self.focus.hovered {
            self.light(std::slice::from_ref(row), wgsl::HOVERED, wgsl::RELATED_HOVERED, &mut passing);
        }
        let before = std::mem::replace(&mut self.focus.passing, passing);
        // The words that may have changed: all of them after the selection or fit changed, else
        // those the hover set before or sets now.
        let mut ats: Vec<At> = if dirty {
            let focus = &self.focus;
            focus.written.keys().chain(focus.standing.keys()).chain(focus.passing.keys()).copied().collect()
        } else {
            before.keys().chain(self.focus.passing.keys()).copied().collect()
        };
        ats.sort_unstable();
        ats.dedup();
        let focus = &mut self.focus;
        let changes: Vec<(At, u32)> = ats
            .into_iter()
            .filter_map(|at| {
                let word = focus.standing.get(&at).copied().unwrap_or(0) | focus.passing.get(&at).copied().unwrap_or(0);
                (focus.written.get(&at).copied().unwrap_or(0) != word).then_some((at, word))
            })
            .collect();
        for &(at, word) in &changes {
            if word == 0 {
                focus.written.remove(&at);
            } else {
                focus.written.insert(at, word);
            }
        }
        // Write each page's changed words in runs, unchanged words between them included.
        for run in changes.chunk_by(|(a, _), (b, _)| a.0 == b.0 && a.1 >> wgsl::PAGE_BITS == b.1 >> wgsl::PAGE_BITS) {
            let (mark, page) = (run[0].0.0, run[0].0.1 >> wgsl::PAGE_BITS);
            let Some(&block) = self.marks[mark].words.pages(Kept::Focus).blocks.get(page as usize) else { continue };
            let mut start = 0;
            for end in 1..=run.len() {
                if end < run.len() && run[end].0.1 - run[end - 1].0.1 < GAP {
                    continue;
                }
                let (first, last) = (run[start].0.1, run[end - 1].0.1);
                let bits: Vec<u32> =
                    (first..=last).map(|row| self.focus.written.get(&(mark, row)).copied().unwrap_or(0)).collect();
                let at = block + (first & wgsl::PAGE_MASK);
                queue.write_buffer(pages, u64::from(at) * 4, bytemuck::cast_slice(&bits));
                start = end;
            }
        }
        if !changes.is_empty() {
            // Channels reading focus evaluate the pages of rows whose words changed, or every row
            // when the focus word pages are new.
            for (i, shown) in self.marks.iter_mut().enumerate() {
                let pages: Vec<u32> = changes
                    .iter()
                    .filter(|((mark, _), _)| *mark == i)
                    .map(|((_, row), _)| row / wgsl::PAGE_ROWS)
                    .collect();
                if fresh || !pages.is_empty() {
                    shown.dirty_rows(shown.channels_reading(Deps::FOCUS), (!fresh).then_some(&pages[..]));
                }
            }
        }
        // When hover does not glow, rows lit only by hover are left out of the focus draw.
        let hover = wgsl::HOVERED | wgsl::RELATED_HOVERED;
        let glowing = if self.scene.controls.hover { wgsl::LIT } else { wgsl::LIT & !hover };
        self.lay_out_lit(&changes, glowing, dirty);
    }

    /// Sets `bit` in the words of `rows` in every mark drawing their tables, and `related` in those
    /// of the rows one reference from them. Returns the rows the data still holds. A row of a table
    /// the data has, but without that row, is dropped. A row of a dataset or table this view lacks
    /// is kept.
    fn light(&self, rows: &[Row], bit: u32, related: u32, words: &mut FxHashMap<At, u32>) -> Vec<Row> {
        let mut kept = Vec::with_capacity(rows.len());
        // The rows of each table, found in the data, in the order the tables first appear.
        let mut tables: Vec<((&Name, &Name), Vec<usize>)> = Vec::new();
        for row in rows {
            let Some(table) = self.snapshot(&row.data).and_then(|d| d.table(&row.table)) else {
                kept.push(row.clone());
                continue;
            };
            let Some(index) = table.row(row.id.as_ref()) else { continue };
            kept.push(row.clone());
            let key = (&row.data, &row.table);
            match tables.iter_mut().find(|(k, _)| *k == key) {
                Some((_, indices)) => indices.push(index),
                None => tables.push((key, vec![index])),
            }
        }
        for ((data_name, table_name), indices) in tables {
            let Some(data) = self.snapshot(data_name) else { continue };
            let Some(table) = data.table(table_name) else { continue };
            for (i, shown) in self.marks.iter().enumerate() {
                let style = shown.mark.style();
                if style.data != *data_name {
                    continue;
                }
                let mut light = |r: u32, bit: u32| {
                    if let Some(held) = shown.held_row(r) {
                        *words.entry((i, held)).or_default() |= bit;
                    }
                };
                if style.table == *table_name {
                    for &index in &indices {
                        light(index as u32, bit);
                    }
                }
                if related == 0 {
                    continue;
                }
                let Some(drawn) = data.table(&style.table) else { continue };
                // Rows of the drawn table that reference these rows: a bus's branches and machines.
                for reference in drawn.references().filter(|r| r.to == *table_name) {
                    let inverse = reference.inverse();
                    for &index in &indices {
                        inverse.of(index).iter().for_each(|&r| light(r, related));
                    }
                }
                // Rows of the drawn table these rows reference: a branch's buses, a machine's bus.
                for reference in table.references().filter(|r| r.to == style.table) {
                    indices.iter().filter_map(|&index| reference.target(index)).for_each(|r| light(r, related));
                }
            }
        }
        kept
    }

    /// Lists each mark's drawn rows with any `glowing` bit set, by draw index, for its focus draw,
    /// with the instances each takes. Updates the lists from `changes`, or makes every list again
    /// when `all`.
    fn lay_out_lit(&mut self, changes: &[(At, u32)], glowing: u32, all: bool) {
        let count = self.marks.len();
        let mut touched = vec![all; count];
        if all || self.focus.lit_rows.len() != count {
            let mut lists = vec![(BTreeMap::new(), 0); count];
            for (&(mark, held), &bits) in &self.focus.written {
                if bits & glowing != 0
                    && let Some(shown) = self.marks.get(mark)
                    && held < shown.live()
                    && let Some(item) = shown.item_of(held)
                {
                    lists[mark].0.insert(item, held);
                }
            }
            self.focus.lit_rows = lists;
            touched.fill(true);
        } else {
            for &((mark, held), bits) in changes {
                let shown = &self.marks[mark];
                let Some(item) = shown.item_of(held) else { continue };
                let rows = &mut self.focus.lit_rows[mark].0;
                if bits & glowing != 0 && held < shown.live() {
                    rows.insert(item, held);
                } else {
                    rows.remove(&item);
                }
                touched[mark] = true;
            }
        }
        for (i, &touched) in touched.iter().enumerate() {
            if touched {
                let held: Vec<u32> = self.focus.lit_rows[i].0.values().copied().collect();
                self.focus.lit_rows[i].1 = if held.is_empty() { 0 } else { self.pieces(i, &held) };
            }
        }
        let mut lit = Vec::new();
        for (i, (rows, pieces)) in self.focus.lit_rows.iter().enumerate() {
            let shown_rows = if *pieces == 0 { 0 } else { rows.len() as u32 };
            self.marks[i].lit = Lit { at: lit.len() as u32, rows: shown_rows, pieces: *pieces };
            if shown_rows > 0 {
                lit.extend(rows.keys().copied());
            }
        }
        self.focus.lit = Some(lit);
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
