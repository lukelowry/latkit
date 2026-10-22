//! Selection, hover, and the rows a fit measures, as focus words: one per row of every mark, written
//! only where they change. The selection keeps only rows a pickable mark shows. The ends of a selected
//! or hovered edge are lit too. Each mark's lit rows are listed for its focus draw, which draws them
//! again over everything, glowing. Hover is state either way, which expressions read; whether it
//! glows is the controls' to say.

use rustc_hash::FxHashMap;

use super::View;
use super::event::{Event, Hit};
use super::sync::{Source, table_of};
use crate::data::{Field, PAGE_ROWS, Reference};
use crate::expr::compile::Deps;
use crate::gpu::shaders as wgsl;
use crate::gpu::work::Queue;
use crate::scene::mark::Primitive;
use crate::{Row, Rows};

/// Changed words past which the whole buffer is written at once.
const WHOLE: usize = 512;

#[derive(Default)]
pub(crate) struct Focus {
    pub(crate) selection: Vec<Row>,
    /// What the user points at, as it was hit.
    pub(crate) hovered: Option<Hit>,
    /// Rows a fit measures.
    pub(crate) fitting: Vec<Row>,
    /// Words written, by index into the focus buffer.
    written: FxHashMap<u32, u32>,
    pub(crate) dirty: bool,
    /// Every mark's lit rows, laid out since they were last written.
    lit: Option<Vec<u32>>,
}

impl Focus {
    /// The lit rows laid out since they were last taken, to write.
    pub(crate) fn take_lit(&mut self) -> Option<Vec<u32>> {
        self.lit.take()
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
    /// Writes the focus words that changed; after `fresh`, a new buffer, every word. Channels reading
    /// selection or hover evaluate again, and every mark's lit rows are laid out again.
    pub(super) fn write_focus(&mut self, queue: &Queue, buffer: &wgpu::Buffer, capacity: u64, fresh: bool) {
        if fresh {
            self.focus.written.clear();
            self.focus.dirty = true;
        }
        if !std::mem::take(&mut self.focus.dirty) {
            return;
        }
        let mut words: FxHashMap<u32, u32> = FxHashMap::default();
        let glows = self.scene.controls.hover;
        let hovered = self.focus.hovered.as_ref().map(|hit| hit.row.clone());
        let selection = self.focus_rows(&self.focus.selection, wgsl::SELECTED, true, true, &mut words);
        self.focus_rows(hovered.as_slice(), wgsl::HOVERED, true, glows, &mut words);
        self.focus_rows(&self.focus.fitting, wgsl::FIT, false, false, &mut words);
        // Rows the data no longer holds, or no mark shows, leave the selection.
        if selection.len() < self.focus.selection.len() {
            self.focus.selection.clone_from(&selection);
            self.events.tell(Event::Select { rows: Rows::group(selection), trigger: None });
        }
        let cleared = self.focus.written.keys().filter(|w| !words.contains_key(w)).map(|&w| (w, 0));
        let set = words.iter().filter(|(w, b)| self.focus.written.get(w) != Some(b)).map(|(&w, &b)| (w, b));
        let changes: Vec<(u32, u32)> = cleared.chain(set).filter(|&(w, _)| u64::from(w) < capacity).collect();
        if changes.len() > WHOLE {
            let mut all = vec![0_u32; capacity as usize];
            for (&w, &b) in &words {
                if let Some(word) = all.get_mut(w as usize) {
                    *word = b;
                }
            }
            queue.write_buffer(buffer, 0, bytemuck::cast_slice(&all));
        } else {
            for &(w, b) in &changes {
                queue.write_buffer(buffer, u64::from(w) * 4, &b.to_le_bytes());
            }
        }
        if !changes.is_empty() {
            // Channels reading focus evaluate the blocks of the rows whose words changed; every row
            // after the words were laid out again.
            for shown in &mut self.marks {
                let (focus, rows) = (shown.region.focus, shown.rows + shown.exits);
                let blocks: Vec<u32> = changes
                    .iter()
                    .filter(|&&(w, _)| w >= focus && w - focus < rows)
                    .map(|&(w, _)| (w - focus) / wgsl::BLOCK_ROWS)
                    .collect();
                shown.dirty_rows(shown.channels_reading(Deps::FOCUS), (!fresh).then_some(&blocks[..]));
            }
        }
        // Rows lit only by hover draw no glow when it does not glow.
        self.lay_out_lit(&words, if glows { wgsl::LIT } else { wgsl::LIT & !wgsl::HOVERED });
        self.focus.written = words;
    }

    /// Sets `bit` in the focus words of `rows` in every mark showing them (with `picked`, every
    /// pickable one), and with `ends` lights the ends of each edge among them; returns the rows some
    /// mark shows. A row its data holds stays shown while a table drawn in part does not draw it.
    fn focus_rows(
        &self,
        rows: &[Row],
        bit: u32,
        picked: bool,
        ends: bool,
        words: &mut FxHashMap<u32, u32>,
    ) -> Vec<Row> {
        let mut kept = Vec::new();
        for row in rows {
            let held = self.data(&row.data).and_then(|d| d.table(&row.table)).and_then(|t| t.row(row.id.as_ref()));
            if held.is_none() {
                continue;
            }
            let table = self.drawn(&row.data).and_then(|d| d.table(&row.table));
            let index = table.and_then(|t| t.row(row.id.as_ref()));
            let mut shows = false;
            for shown in &self.marks {
                let style = shown.mark.style();
                if (picked && !shown.mark.picks()) || style.data != row.data || style.table != row.table {
                    continue;
                }
                shows = true;
                let (Some(table), Some(index)) = (table, index) else { continue };
                if (index as u32) < shown.rows {
                    *words.entry(shown.region.focus + index as u32).or_default() |= bit;
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

    /// Lights the row `reference` names for row `index` in every vertex mark drawing its table.
    fn light_end(&self, data: &crate::Name, reference: &Reference, index: usize, words: &mut FxHashMap<u32, u32>) {
        let Some(target) = reference.target(index) else { return };
        for shown in &self.marks {
            let style = shown.mark.style();
            if shown.kind() == crate::scene::mark::MarkKind::Vertices
                && style.data == *data
                && style.table == reference.to
                && target < shown.rows
            {
                *words.entry(shown.region.focus + target).or_default() |= wgsl::END;
            }
        }
    }

    /// Lists every mark's rows with a bit of `glowing` set for its focus draw, with the instances
    /// each takes.
    fn lay_out_lit(&mut self, words: &FxHashMap<u32, u32>, glowing: u32) {
        let mut all = Vec::new();
        for i in 0..self.marks.len() {
            let (focus, rows) = (self.marks[i].region.focus, self.marks[i].rows);
            let mut lit: Vec<u32> = words
                .iter()
                .filter(|&(&w, &bits)| w >= focus && w - focus < rows && bits & glowing != 0)
                .map(|(&w, _)| w - focus)
                .collect();
            lit.sort_unstable();
            let pieces = if lit.is_empty() { 0 } else { self.pieces(i, &lit) };
            let rows = if pieces == 0 { 0 } else { lit.len() as u32 };
            self.marks[i].lit = Lit { at: all.len() as u32, rows, pieces };
            if rows > 0 {
                all.extend(lit);
            }
        }
        self.focus.lit = Some(all);
    }

    /// Instances mark `i`'s focus draw takes for each of its `lit` rows: a point one; a path as many
    /// as the longest of theirs has pieces, past which a row's own draw nothing; none for faces.
    fn pieces(&self, i: usize, lit: &[u32]) -> u32 {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return 0 };
        match compiled.drawing.primitive {
            Primitive::Points => 1,
            Primitive::Strokes if !shown.listed() => shown.segments_per_row().max(1),
            Primitive::Strokes if shown.path() == wgsl::PATH_ENDS => (self.longest(i, lit) + 1).max(wgsl::MAX_PIECES),
            Primitive::Strokes => self.longest(i, lit).saturating_sub(1),
            Primitive::Triangles if shown.path() == wgsl::PATH_GEOMETRY => self.longest(i, lit).saturating_sub(1) / 3,
            Primitive::Triangles => 0,
        }
    }

    /// The most points any of mark `i`'s `lit` rows has in its geometry column: its path, its bends,
    /// or its triangles.
    fn longest(&self, i: usize, lit: &[u32]) -> u32 {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return 0 };
        let Some(column) = compiled.program.columns.get(compiled.drawing.geometry as usize) else { return 0 };
        let style = shown.mark.style();
        let Some(data) = self.drawn(&style.data) else { return 0 };
        let Some(table) = data.table(&style.table) else { return 0 };
        let source = Source { data, table, derived: self.derived.beside(&style.data, &style.table) };
        let Some((_, table)) = table_of(column, &source, &self.data) else { return 0 };
        let Some(Field::Values(values, _)) = table.field_named(&column.name) else { return 0 };
        let pages = values.pages();
        lit.iter()
            .filter_map(|&row| {
                let page = pages.get(row as usize / PAGE_ROWS)?;
                Some(page.values.geometry()?.row_coords(row as usize % PAGE_ROWS).len() as u32)
            })
            .max()
            .unwrap_or(0)
    }
}
