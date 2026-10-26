//! Transitions: a mark whose description, static data, or rows change eases from what it showed.
//!
//! When a transition starts, each row's shown state is frozen into the mark's frozen words at the
//! row's new index: from the same index when no row moved, or gathered by id when rows were added,
//! removed, or reordered. Rows that left are frozen after the new rows and fade out there.
//!
//! While the mark eases, its channels write its settled words, once per change. Each frame the
//! clock moves, the ease pass writes every row's shown state from its frozen and settled words by
//! the mark's progress, and sets which rows fade. So draws, probes, and bounds read eased state
//! without knowing a transition runs, and no channel runs just to ease. When no row matches one
//! shown before, as when another dataset replaces the drawn one, every row enters with its
//! evaluated state and only fades in.
//!
//! The frozen and settled words are paged like the state, and kept only while a transition runs. A
//! stroke's geometry column keeps its table from the start of the transition, and its paths morph
//! from it point by point.
//!
//! Without an ease, a flowing mark whose rows moved still begins a zero-length transition: it shows
//! the new state at once, and its comets carry their travel over to the rows' new places.

use std::sync::Arc;

use super::View;
use super::clock::Clock;
use super::drawing::{Drawing, Holds};
use super::marks::{Holding, Shown};
use super::words::Kept;
use crate::data::{RowIds, Table};
use crate::gpu::Inner;
use crate::gpu::shaders::PAGE_ROWS;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::MarkKind;

/// A running transition: its start on the view's clock and its length in seconds.
pub(crate) struct Transition {
    start: f64,
    seconds: f64,
}

/// A transition waiting for the frame that freezes it.
pub(crate) struct Begin {
    /// Each new row's old row, then each exit's old row, when rows moved; `None` when every row
    /// kept its index.
    sources: Option<Vec<u32>>,
    /// Whether no new row matches one shown before, so rows only fade in and out.
    fades: bool,
}

impl Transition {
    /// Eased progress on `clock`, from 0 to 1. A zero-length transition is at 1 from the start.
    pub(crate) fn motion(&self, clock: &Clock) -> f32 {
        if self.seconds <= 0.0 { 1.0 } else { clock.eased(self.start, self.seconds) as f32 }
    }

    fn done(&self, clock: &Clock) -> bool {
        clock.done(self.start, self.seconds)
    }
}

/// How rows moved from `old` to `new`: each new row's old row (`NONE` if it entered), and the old
/// rows that left. `None` when every row kept its index.
pub(crate) fn remap(old: &Table, new: &Table) -> Option<(Vec<u32>, Vec<u32>)> {
    if old.structure == new.structure && old.order == new.order {
        return None;
    }
    if old.order == new.order && new.len() >= old.len() {
        // Rows keep their index, except in rewritten pages: there a row whose id changed enters,
        // and the row it replaced leaves.
        let mut sources: Vec<u32> = (0..new.len()).map(|r| if r < old.len() { r as u32 } else { wgsl::NONE }).collect();
        let mut exits = Vec::new();
        for block in rewritten(old, new).unwrap_or_default() {
            let rows = (block * PAGE_ROWS) as usize..(((block + 1) * PAGE_ROWS) as usize).min(old.len());
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

/// The row blocks of `new` holding rows that `old` did not hold at the same index, assuming every
/// other row kept its index: blocks whose id pages changed, and blocks past `old`'s rows. `None`
/// when the ids cannot tell, as between counted and listed ids.
pub(crate) fn rewritten(old: &Table, new: &Table) -> Option<Vec<u32>> {
    let pages = |len: usize| (len as u32).div_ceil(PAGE_ROWS);
    match (&old.ids, &new.ids) {
        (RowIds::Count(a), RowIds::Count(b)) if b >= a => Some((*a / PAGE_ROWS..pages(*b as usize)).collect()),
        (RowIds::Listed(a), RowIds::Listed(b)) if b.len() >= a.len() => {
            let (a, b) = (a.pages(), b.pages());
            Some((0..b.len()).filter(|&p| a.get(p).is_none_or(|page| page.id != b[p].id)).map(|p| p as u32).collect())
        }
        _ => None,
    }
}

/// How held rows moved from `old` to `new`: each new held row's old held row (`NONE` if it
/// entered), and the old drawn rows that left. `None` when every row kept its held row, as in a
/// paged table whose order is unchanged, regardless of what the camera draws.
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

/// Held rows: the table's rows, or its drawing's live held rows.
fn held(holding: &Holding) -> u32 {
    holding.drawing.as_ref().map_or(holding.table.len() as u32, |d| d.live())
}

/// The held rows `holding` draws, except those fading out with their tiles.
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

/// How rows moved between holdings with different orders: each new held row is traced to its old
/// held row, by index while the table's row order is unchanged, else by id.
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

/// Whether every new row kept its index or entered.
pub(crate) fn in_place(sources: &[u32]) -> bool {
    sources.iter().enumerate().all(|(r, &s)| s == r as u32 || s == wgsl::NONE)
}

/// The slots of `new` holding rows that `old` did not hold there: slots whose page is new to them,
/// slots whose page gained appended rows, and slots of kept rows that changed.
pub(crate) fn bound(old: Option<&Drawing>, new: &Drawing) -> Vec<u32> {
    let grown = old.map_or(u32::MAX, |old| old.order.len() / PAGE_ROWS);
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

/// Whether two holdings hold the same rows in the same layout: the same origin, row structure, row
/// order, and drawing.
pub(crate) fn holds_alike(a: &Holding, b: &Holding) -> bool {
    let same_drawing = match (&a.drawing, &b.drawing) {
        (None, None) => true,
        (Some(x), Some(y)) => Arc::ptr_eq(x, y),
        _ => false,
    };
    a.origin == b.origin && a.table.structure == b.table.structure && a.table.order == b.table.order && same_drawing
}

impl Shown {
    /// Takes over `before`'s held rows and their words, as a changed description of the same mark.
    pub(crate) fn inherit(&mut self, before: &mut Shown) {
        self.words = std::mem::take(&mut before.words);
        self.before = before.before;
        self.rows = before.rows;
        self.holding.clone_from(&before.holding);
        self.version = before.version + 1;
        self.place_version = before.place_version + 1;
    }

    /// Begins a transition from what the mark shows, with rows moved as `moved` says, if they
    /// moved. Does nothing when the mark showed no rows.
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

    /// Restarts the running transition from what the mark shows, as slots `bound` receive pages of
    /// entering rows. Other rows keep easing toward their settled state, which their channels
    /// already evaluated, and exits keep fading out after the live rows.
    pub(crate) fn restart(&mut self, bound: &[u32]) {
        let mut sources: Vec<u32> = (0..self.live()).collect();
        for &slot in bound {
            let rows = slot * PAGE_ROWS..((slot + 1) * PAGE_ROWS).min(sources.len() as u32);
            sources[rows.start as usize..rows.end as usize].fill(wgsl::NONE);
        }
        // Exits were held after the live rows when the frame began.
        sources.extend(self.before.saturating_sub(self.exits)..self.before);
        self.begin = Some(Begin { sources: Some(sources), fades: false });
    }
}

impl View {
    /// Freezes every transition starting this frame and advances the running ones. Returns whether
    /// any is running.
    pub(super) fn transitions(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> bool {
        // A drag moves rows at once.
        let seconds = if self.dragging() { 0.0 } else { self.ease().as_secs_f64() };
        let mut starting: Vec<usize> = (0..self.marks.len()).filter(|&i| self.marks[i].begin.is_some()).collect();
        if seconds == 0.0 {
            // Without an ease, only a flowing mark whose rows moved begins one, for its comets.
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
            // A transition beginning this frame runs through it, as a zero-length one must for its
            // comets.
            if transition.done(&self.clock) && !starting.contains(&i) {
                // One more evaluation writes every row's final state.
                shown.transition = None;
                shown.exits = 0;
                shown.all_dirty();
                shown.packed = false;
                if shown.tables.frozen().is_some() {
                    shown.tables.thaw(inner);
                }
            } else {
                running = true;
                // Rows ease only when the clock moves; their channels evaluated once already.
                shown.easing = self.clock.moved();
            }
        }
        running
    }

    /// Records each starting mark's shown state into its frozen words. The remap words give, per
    /// mark: its state pages as the frame began, how many rows showed, each new row's old row when
    /// rows moved, and where the vertices its endpoints reference moved, if they did.
    fn freeze(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, starting: &[usize]) {
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let mut words: Vec<u32> = Vec::new();
        // For each starting vertex mark whose rows moved: how many it held, then each one's new
        // row.
        let mut moves = vec![wgsl::NONE; self.marks.len()];
        for &i in starting {
            let m = &self.marks[i];
            let Some(sources) = m.begin.as_ref().and_then(|b| b.sources.as_ref()) else { continue };
            if m.kind() != MarkKind::Vertices {
                continue;
            }
            moves[i] = words.len() as u32;
            let at = words.len() + 1;
            words.push(m.before);
            words.resize(at + m.before as usize, wgsl::NONE);
            for (new, &old) in sources.iter().enumerate() {
                if old < m.before {
                    words[at + old as usize] = new as u32;
                }
            }
        }
        for &i in starting {
            let shown = &mut self.marks[i];
            let begin = shown.begin.take().expect("starting");
            let before = shown.words.state_before().clone();
            let width = shown.stride() + shown.extras();
            // If the row width changed, there is nothing to ease from: every row enters, fading in.
            let sources =
                if before.width == width { begin.sources } else { Some(vec![wgsl::NONE; shown.held() as usize]) };
            shown.carry = sources.is_some();
            let header = words.len();
            words.extend([0; 4]);
            words[header] = words.len() as u32;
            words.extend(before.blocks.iter());
            words[header + 1] = shown.before.min(shown.live());
            words[header + 2] = match sources {
                Some(sources) => {
                    let at = words.len() as u32;
                    words.extend(sources);
                    at
                }
                None => wgsl::NONE,
            };
            // Each endpoint, stored in the kind word of its number, follows its vertex where the
            // vertex mark's rows moved.
            let ends: Vec<(u32, u32)> = (0..shown.ends.len())
                .filter_map(|k| Some((k as u32, moves[shown.ends[k].mark?])))
                .filter(|&(_, moved)| moved != wgsl::NONE)
                .collect();
            words[header + 3] = if ends.is_empty() {
                wgsl::NONE
            } else {
                let at = words.len();
                words.resize(at + shown.stride() as usize, wgsl::NONE);
                for (word, moved) in ends {
                    words[at + word as usize] = moved;
                }
                at as u32
            };
            shown.remap = header as u32;
        }
        let resources = self.resources.as_mut().expect("created before transitions");
        resources.write_remap(device, queue, &words);
        inner.arena.clear(device, queue);
        inner.arena.written();
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Freeze);
        let pipeline = inner.pipelines.compute(device, Shader::Freeze, "gather");
        // The mark uniforms this frame writes before submitting hold each mark's remap offset.
        let mut pass = encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("latkit freeze"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &groups.view, &[]);
        pass.set_bind_group(2, &group, &[]);
        for &i in starting {
            pass.set_bind_group(1, &groups.mark, &[super::passes::offset(i)]);
            super::passes::dispatch(&mut pass, self.marks[i].held());
        }
    }

    /// Allocates frozen and settled words for every held row of each mark whose transition starts
    /// or runs, and frees them once it ends. A transition without room for them is cancelled, and
    /// its rows show their evaluated state at once.
    pub(super) fn fit_easing(&mut self, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let device = (&gpu.0.device, &gpu.0.queue);
        for shown in &mut self.marks {
            let easing = shown.begin.is_some() || shown.transition.is_some();
            let rows = shown.page_rows();
            let width = if easing { shown.stride() + shown.extras() } else { 0 };
            let mut fits = true;
            for kept in [Kept::Frozen, Kept::Settled] {
                let had = shown.words.pages(kept).blocks.len();
                match shown.words.fit(kept, &rows, width, device, &mut inner.arena) {
                    Some(new) => shown.packed &= new.is_empty() && had == shown.words.pages(kept).blocks.len(),
                    None => fits = false,
                }
            }
            if easing && !fits {
                for kept in [Kept::Frozen, Kept::Settled] {
                    shown.words.fit(kept, &[], 0, device, &mut inner.arena);
                }
                shown.begin = None;
                shown.transition = None;
                shown.exits = 0;
                shown.all_dirty();
                shown.packed = false;
            }
        }
    }
}
