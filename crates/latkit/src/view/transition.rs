//! Transitions: a mark whose description, static data, or rows change eases from what it showed.
//!
//! When one starts, what each row shows is frozen into the frozen buffer at the row's new place:
//! copied when the rows are the same, gathered by id when rows were added, removed, or reordered.
//! Rows that left are frozen past the new rows and fade out there. While the mark eases, its channels
//! store into the settled state, a second mirror of the state, once per change; each frame the clock
//! moves, the ease pass writes what every row shows from its frozen and settled state by the mark's
//! progress, and which rows fade, so draws, probes, bounds, and shadows read eased state without
//! knowing a transition runs, and no channel runs to ease. Where no row is the same as one shown
//! before, as when another dataset replaces the one drawn, every row enters, shows what it evaluated,
//! and only fades. The frozen and settled buffers mirror the state buffer's layout and exist only
//! while a transition does. A stroke's geometry column keeps the table it had as the transition
//! began, and its paths morph from it point by point.
//!
//! Without an ease, a flowing mark whose rows moved still begins a transition, of no length: it
//! shows the new state at once, and its comets carry their travel over to the rows' new places.

use std::sync::Arc;

use super::View;
use super::clock::Clock;
use super::drawing::{Drawing, Holds};
use super::marks::{Holding, Shown};
use crate::data::{PAGE_ROWS, RowIds, Table};
use crate::derive::order::PAGE;
use crate::gpu::Inner;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::MarkKind;

/// A mark easing from what it showed, begun at a time on the view's clock.
pub(crate) struct Transition {
    start: f64,
    seconds: f64,
}

/// A transition waiting for the frame that freezes it.
pub(crate) struct Begin {
    /// Each new row's old row, then each exit's, when rows moved; `None` when they kept their places.
    sources: Option<Vec<u32>>,
    /// Whether no row was shown before, so rows only fade in and out.
    fades: bool,
}

impl Transition {
    /// Eased progress on `clock`, `0..=1`; a transition of no length is done as it begins.
    pub(crate) fn motion(&self, clock: &Clock) -> f32 {
        if self.seconds <= 0.0 { 1.0 } else { clock.eased(self.start, self.seconds) as f32 }
    }

    fn done(&self, clock: &Clock) -> bool {
        clock.done(self.start, self.seconds)
    }
}

/// How rows moved from `old` to `new`: each new row's old row (`NONE` if it entered), and the old
/// rows that left. `None` when every row kept its place.
pub(crate) fn remap(old: &Table, new: &Table) -> Option<(Vec<u32>, Vec<u32>)> {
    if old.structure == new.structure && old.order == new.order {
        return None;
    }
    if old.order == new.order && new.len() >= old.len() {
        // Rows kept in place, those of pages rewritten aside: there a row whose id changed enters, and
        // the row it replaces leaves.
        let mut sources: Vec<u32> = (0..new.len()).map(|r| if r < old.len() { r as u32 } else { wgsl::NONE }).collect();
        let mut exits = Vec::new();
        for block in rewritten(old, new).unwrap_or_default() {
            let rows = block as usize * PAGE_ROWS..((block as usize + 1) * PAGE_ROWS).min(old.len());
            for r in rows.filter(|&r| old.ids.key(r) != new.ids.key(r)) {
                sources[r] = wgsl::NONE;
                if old.ids.key(r).is_some() {
                    exits.push(r as u32);
                }
            }
        }
        return Some((sources, exits));
    }
    // Each row is looked up by id in the other table, from the smaller side.
    let mut sources = vec![wgsl::NONE; new.len()];
    let mut exits = Vec::new();
    if old.len() <= new.len() {
        for o in 0..old.len() {
            match old.ids.key(o).and_then(|key| new.row(key)) {
                Some(r) => sources[r] = o as u32,
                None => exits.push(o as u32),
            }
        }
    } else {
        let mut kept = vec![false; old.len()];
        for (r, source) in sources.iter_mut().enumerate() {
            if let Some(o) = new.ids.key(r).and_then(|key| old.row(key)) {
                kept[o] = true;
                *source = o as u32;
            }
        }
        exits.extend((0..old.len()).filter(|&o| !kept[o]).map(|o| o as u32));
    }
    Some((sources, exits))
}

/// The row blocks of `new` whose rows `old` did not hold where `new` does, every other row kept in
/// place: those whose ids' pages changed, and those past `old`'s rows. `None` where that does not
/// tell, as between ids counted and ids listed.
pub(crate) fn rewritten(old: &Table, new: &Table) -> Option<Vec<u32>> {
    let blocks = |len: usize| len.div_ceil(PAGE_ROWS) as u32;
    match (&old.ids, &new.ids) {
        (RowIds::Count(a), RowIds::Count(b)) if b >= a => {
            Some(((*a as usize / PAGE_ROWS) as u32..blocks(*b as usize)).collect())
        }
        (RowIds::Listed(a), RowIds::Listed(b)) if b.len() >= a.len() => {
            let (a, b) = (a.pages(), b.pages());
            Some((0..b.len()).filter(|&p| a.get(p).is_none_or(|page| page.id != b[p].id)).map(|p| p as u32).collect())
        }
        _ => None,
    }
}

/// How rows moved from what `old` held to what `new` holds: each new held row's old held row
/// (`NONE` if it entered), and the old rows drawn that left. `None` when every row kept its place, as
/// a table drawn in part keeps its rows' places while its order serves, whatever the camera draws.
pub(crate) fn moved(old: &Holding, new: &Holding) -> Option<(Vec<u32>, Vec<u32>)> {
    if old.origin != new.origin {
        // Another dataset of the same name: every row enters, and every row drawn leaves.
        return Some((vec![wgsl::NONE; held(new) as usize], drawn(old)));
    }
    match (&old.drawing, &new.drawing) {
        (None, None) => remap(&old.table, &new.table),
        (Some(a), Some(b)) if a.order.id() == b.order.id() && old.table.order == new.table.order => None,
        _ => Some(follow(old, new)),
    }
}

/// Rows held by the table's own order or a drawing's.
fn held(holding: &Holding) -> u32 {
    holding.drawing.as_ref().map_or(holding.table.len() as u32, |d| d.live())
}

/// The held rows `holding` draws, but those fading out with their tiles.
fn drawn(holding: &Holding) -> Vec<u32> {
    match &holding.drawing {
        None => (0..holding.table.len() as u32).collect(),
        Some(drawing) => drawing
            .runs
            .iter()
            .filter(|run| run.fade != wgsl::FADE_OUT)
            .flat_map(|run| run.held..run.held + run.len)
            .collect(),
    }
}

/// How rows moved between holdings of different orders: each row followed to where `old` held it,
/// by id where rows came or went.
fn follow(old: &Holding, new: &Holding) -> (Vec<u32>, Vec<u32>) {
    let same = old.table.order == new.table.order;
    let source = |h: u32| match &new.drawing {
        Some(drawing) => drawing.source(h),
        None => (h < new.table.len() as u32).then_some(h),
    };
    let held_of = |r: usize| match &old.drawing {
        Some(drawing) => drawing.held_row(r as u32),
        None => (r < old.table.len()).then_some(r as u32),
    };
    let mut kept = vec![false; held(old) as usize];
    let sources: Vec<u32> = (0..held(new))
        .map(|h| {
            let Some(r) = source(h).map(|r| r as usize) else { return wgsl::NONE };
            let was = if same {
                (r < old.table.len()).then_some(r)
            } else {
                new.table.ids.key(r).and_then(|key| old.table.row(key))
            };
            let Some(at) = was.and_then(held_of) else { return wgsl::NONE };
            if let Some(k) = kept.get_mut(at as usize) {
                *k = true;
            }
            at
        })
        .collect();
    let exits = drawn(old).into_iter().filter(|&h| !kept.get(h as usize).copied().unwrap_or(false)).collect();
    (sources, exits)
}

/// Whether every new row is where it was, or entered.
pub(crate) fn in_place(sources: &[u32]) -> bool {
    sources.iter().enumerate().all(|(r, &s)| s == r as u32 || s == wgsl::NONE)
}

/// The slots of `new` holding rows `old` did not hold there: every slot holding a page without one
/// before, those whose page took rows appended since, and those of rows kept that changed.
pub(crate) fn bound(old: Option<&Drawing>, new: &Drawing) -> Vec<u32> {
    let grown = old.map_or(u32::MAX, |old| old.order.len() / PAGE);
    let appended = old.is_some_and(|o| o.order.len() != new.order.len());
    (0..new.slot_count())
        .filter(|&s| match new.holds(s) {
            Holds::Free => false,
            held => {
                let alike = old.is_some_and(|o| o.holds_alike(new, s));
                !alike || matches!(held, Holds::Page(page) if appended && page >= grown)
            }
        })
        .map(|s| s as u32)
        .collect()
}

/// Whether two holdings hold the same rows the same way: the same table's rows, laid out alike.
pub(crate) fn holds_alike(a: &Holding, b: &Holding) -> bool {
    let same_drawing = match (&a.drawing, &b.drawing) {
        (None, None) => true,
        (Some(x), Some(y)) => Arc::ptr_eq(x, y),
        _ => false,
    };
    a.origin == b.origin && a.table.structure == b.table.structure && a.table.order == b.table.order && same_drawing
}

impl Shown {
    /// Takes over the rows `before` holds, as a changed description of the same mark.
    pub(crate) fn inherit(&mut self, before: &Shown) {
        self.region = before.region;
        self.before = before.before;
        self.rows = before.rows;
        self.holding.clone_from(&before.holding);
        self.version = before.version + 1;
        self.place_version = before.place_version + 1;
    }

    /// Starts easing from what the mark shows: its rows moved as `moved` says, if they did.
    pub(crate) fn begin(&mut self, moved: Option<(Vec<u32>, Vec<u32>)>) {
        if self.before == 0 {
            return;
        }
        let fades = moved.as_ref().is_some_and(|(sources, _)| sources.iter().all(|&s| s == wgsl::NONE));
        let sources = moved.map(|(mut sources, exits)| {
            self.exits = exits.len() as u32;
            sources.extend(exits);
            sources
        });
        if sources.is_none() {
            self.exits = 0;
        }
        self.begin = Some(Begin { sources, fades });
        self.all_dirty();
    }

    /// Starts the running transition over from what the mark shows, as slots `bound` of held rows
    /// take pages of rows that enter: the rest ease on toward where they settle, which their channels
    /// evaluated already, and rows that left go on fading out past the live ones.
    pub(crate) fn restart(&mut self, bound: &[u32]) {
        let mut sources: Vec<u32> = (0..self.live()).collect();
        for &slot in bound {
            let rows = slot * PAGE..((slot + 1) * PAGE).min(sources.len() as u32);
            sources[rows.start as usize..rows.end as usize].fill(wgsl::NONE);
        }
        // The rows that left lay past the live rows when the frame began.
        sources.extend(self.before.saturating_sub(self.exits)..self.before);
        self.begin = Some(Begin { sources: Some(sources), fades: false });
    }
}

impl View {
    /// Freezes every transition starting this frame and advances the running ones; true while any
    /// runs.
    pub(super) fn transitions(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> bool {
        // A drag moves rows at once.
        let seconds = if self.dragging() { 0.0 } else { self.ease().as_secs_f64() };
        let mut starting: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].begin.is_some()).collect();
        if seconds == 0.0 {
            // Without an ease only a flowing mark whose rows moved begins one, for its comets.
            starting.retain(|&i| {
                let shown = &mut self.marks[i];
                let carries =
                    shown.mark.flows() && shown.begin.as_ref().is_some_and(|b| b.sources.is_some() && !b.fades);
                if !carries {
                    shown.begin = None;
                    shown.exits = 0;
                }
                carries
            });
        }
        if !starting.is_empty() {
            self.freeze(encoder, inner, &starting);
            let start = self.clock.now();
            for &i in &starting {
                self.marks[i].transition = Some(Transition { start, seconds });
            }
        }
        let mut running = false;
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(transition) = &shown.transition else { continue };
            // One that begins this frame runs through it, as one of no length must for its comets.
            if transition.done(&self.clock) && !starting.contains(&i) {
                // One more evaluation writes every row's settled state.
                shown.transition = None;
                shown.exits = 0;
                shown.all_dirty();
                if shown.tables.frozen().is_some() {
                    shown.tables.thaw(inner);
                    shown.packed = false;
                }
            } else {
                running = true;
                // Rows ease as the clock moves, and only then: their channels evaluated once.
                shown.easing = self.clock.moved();
            }
        }
        if !running && self.marks.iter().all(|m| m.transition.is_none()) {
            let resources = self.resources.as_mut().expect("created");
            resources.drop_frozen();
            resources.drop_settled();
        }
        running
    }

    /// Records what each starting mark shows into the frozen buffer.
    fn freeze(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, starting: &[usize]) {
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let slots = self.slot_table(starting);
        let resources = self.resources.as_mut().expect("created before transitions");
        resources.ensure_frozen(device);
        resources.ensure_settled(device);
        let mut words: Vec<u32> = Vec::new();
        let table = slots.map(|table| {
            words.extend(table);
            0
        });
        let mut gathers = Vec::new();
        for &i in starting {
            let shown = &mut self.marks[i];
            let begin = shown.begin.take().expect("starting");
            let was = shown.moved.unwrap_or(shown.region);
            let now = shown.region;
            match begin.sources {
                None => {
                    let source = if shown.moved.is_some() { resources.retired_state() } else { None };
                    let rows = shown.before.min(shown.live());
                    resources.copy_frozen(encoder, source, was, now, rows);
                }
                Some(sources) => {
                    let at = words.len() as u32;
                    let slot_words = match shown.kind() {
                        MarkKind::Edges => (1 << wgsl::EDGE_FROM) | (1 << wgsl::EDGE_TO),
                        MarkKind::Faces => (1 << wgsl::FACE_A) | (1 << wgsl::FACE_B) | (1 << wgsl::FACE_C),
                        _ => 0,
                    };
                    words.extend([was.state, was.extra, slot_words, table.unwrap_or(wgsl::NONE)]);
                    words.extend(sources);
                    shown.remap = at;
                    shown.carry = true;
                    gathers.push(i);
                }
            }
        }
        if gathers.is_empty() {
            return;
        }
        resources.write_remap(device, queue, &words);
        let moved = gathers.iter().any(|&i| self.marks[i].moved.is_some());
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.freeze_group(device, inner, moved);
        let pipeline = inner.pipelines.compute(device, Shader::Freeze, "gather");
        // The marks' uniforms this frame writes before it submits hold each mark's remap offset.
        let mut pass = encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("latkit freeze"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &groups.view, &[0]);
        pass.set_bind_group(2, &group, &[]);
        for &i in &gathers {
            let shown = &self.marks[i];
            pass.set_bind_group(1, &groups.mark, &[super::passes::offset(i)]);
            super::passes::dispatch(&mut pass, shown.held());
        }
    }

    /// Where each old vertex slot moved, for the ends of rows easing out; `None` when no mark with
    /// ends gathers.
    fn slot_table(&self, starting: &[usize]) -> Option<Vec<u32>> {
        let needed = starting.iter().any(|&i| {
            let m = &self.marks[i];
            m.kind() != MarkKind::Vertices && m.begin.as_ref().is_some_and(|b| b.sources.is_some())
        });
        if !needed {
            return None;
        }
        let vertices = self.marks.iter().filter(|m| m.kind() == MarkKind::Vertices);
        let old_slot = |m: &Shown| m.moved.unwrap_or(m.region).state / wgsl::VERTEX_WORDS;
        let size = vertices.clone().map(|m| old_slot(m) + m.before).max().unwrap_or(0);
        let mut table = vec![wgsl::NONE; size as usize];
        for m in vertices {
            let (from, to) = (old_slot(m), m.region.state / wgsl::VERTEX_WORDS);
            match m.begin.as_ref().and_then(|b| b.sources.as_ref()) {
                Some(sources) => {
                    for (new_row, &old_row) in sources.iter().enumerate() {
                        if old_row != wgsl::NONE && old_row < m.before {
                            table[(from + old_row) as usize] = to + new_row as u32;
                        }
                    }
                }
                None => {
                    for row in 0..m.before.min(m.live()) {
                        table[(from + row) as usize] = to + row;
                    }
                }
            }
        }
        Some(table)
    }
}
