//! Transitions: a mark whose description, static data, or rows change eases from what it showed.
//!
//! When one starts, what each row shows is frozen into the mark's frozen words at the row's new
//! place: where it was when the rows are the same, gathered by id when rows were added, removed, or
//! reordered. Rows that left are frozen past the new rows and fade out there. While the mark eases,
//! its channels store into its settled words once per change; each frame the clock moves, the ease
//! pass writes what every row shows from its frozen and settled words by the mark's progress, and
//! which rows fade, so draws, probes, bounds, and shadows read eased state without knowing a
//! transition runs, and no channel runs to ease. Where no row is the same as one shown before, as when
//! another dataset replaces the one drawn, every row enters, shows what it evaluated, and only fades.
//! The frozen and settled words are pages like the state's, kept only while a transition runs. A
//! stroke's geometry column keeps the table it had as the transition began, and its paths morph from
//! it point by point.
//!
//! Without an ease, a flowing mark whose rows moved still begins a transition, of no length: it
//! shows the new state at once, and its comets carry their travel over to the rows' new places.

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

/// The row blocks of `new` whose rows `old` did not hold where `new` does, every other row kept in
/// place: those whose ids' pages changed, and those past `old`'s rows. `None` where that does not
/// tell, as between ids counted and ids listed.
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
    /// Takes over the rows `before` holds and their words, as a changed description of the same mark.
    pub(crate) fn inherit(&mut self, before: &mut Shown) {
        self.words = std::mem::take(&mut before.words);
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
            let rows = slot * PAGE_ROWS..((slot + 1) * PAGE_ROWS).min(sources.len() as u32);
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
                shown.packed = false;
                if shown.tables.frozen().is_some() {
                    shown.tables.thaw(inner);
                }
            } else {
                running = true;
                // Rows ease as the clock moves, and only then: their channels evaluated once.
                shown.easing = self.clock.moved();
            }
        }
        running
    }

    /// Records what each starting mark shows into its frozen words: the remap words say, for each, the
    /// pages its rows' words were in as the frame began, how many rows showed, where each new row was
    /// where rows moved, and where the vertices its ends name moved where those did.
    fn freeze(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, starting: &[usize]) {
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let mut words: Vec<u32> = Vec::new();
        // Where each vertex mark's rows moved: how many it held, then where each went.
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
            // Rows whose words took another shape show nothing to ease from: they enter, and fade in.
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
            // Each kind word naming a vertex follows that vertex where its mark's rows moved.
            let ends: Vec<(u32, u32)> = shown
                .code
                .iter()
                .filter(|op| op[0] == wgsl::OP_STORE_END)
                .filter_map(|op| Some((op[1], moves[shown.ends.get(op[3] as usize)?.mark?])))
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
        // The marks' uniforms this frame writes before it submits hold each mark's remap offset.
        let mut pass = encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("latkit freeze"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &groups.view, &[0]);
        pass.set_bind_group(2, &group, &[]);
        for &i in starting {
            pass.set_bind_group(1, &groups.mark, &[super::passes::offset(i)]);
            super::passes::dispatch(&mut pass, self.marks[i].held());
        }
    }

    /// Gives each mark whose transition starts or runs frozen and settled words for every row it
    /// holds, and lets them go once it ends; a transition finding no room for them does not start, and
    /// its rows show what they evaluate at once.
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
