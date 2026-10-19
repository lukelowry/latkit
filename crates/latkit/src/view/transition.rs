//! Transitions: a mark whose description, static data, or rows change eases from what it showed.
//!
//! When one starts, what each row shows is frozen into the frozen buffer at the row's new place:
//! copied when the rows are the same, gathered by id when rows were added, removed, or reordered.
//! Rows that left are frozen past the new rows and fade out there. While the mark eases, `evaluate`
//! blends every store from the frozen state by the mark's progress, so draws, probes, bounds, and
//! shadows read eased state without knowing a transition runs. Where no row is the same as one shown
//! before, as when another dataset replaces the one drawn, every row only fades: evaluated once as
//! the transition starts, the mark eases by its progress alone. The frozen buffer mirrors the state
//! buffer's layout and exists only while a transition does. A stroke's geometry column keeps the
//! table it had as the transition began, and its paths morph from it point by point.
//!
//! Without an ease, a flowing mark whose rows moved still begins a transition, of no length: it
//! shows the new state at once, and its comets carry their travel over to the rows' new places.

use super::View;
use super::clock::Clock;
use super::marks::Shown;
use crate::data::Table;
use crate::gpu::Inner;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::scene::mark::MarkKind;

/// A mark easing from what it showed, begun at a time on the view's clock, and whether its rows
/// only fade.
pub(crate) struct Transition {
    start: f64,
    seconds: f64,
    fades: bool,
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
        let sources = (0..new.len()).map(|r| if r < old.len() { r as u32 } else { wgsl::NONE }).collect();
        return Some((sources, Vec::new()));
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

/// The rows of `new` replacing every row of `old`, as when another dataset of the same name replaces
/// the one drawn: each enters, and each old row leaves, whatever its id.
pub(crate) fn replaced(old: &Table, new: &Table) -> (Vec<u32>, Vec<u32>) {
    (vec![wgsl::NONE; new.len()], (0..old.len() as u32).collect())
}

impl Shown {
    /// Takes over the rows `before` holds, as a changed description of the same mark.
    pub(crate) fn inherit(&mut self, before: &Shown) {
        self.region = before.region;
        self.held = before.held;
        self.rows = before.rows;
        self.drawn.clone_from(&before.drawn);
        self.version = before.version + 1;
        self.place_version = before.place_version + 1;
    }

    /// Starts easing from what the mark shows: its rows moved as `moved` says, if they did.
    pub(crate) fn begin(&mut self, moved: Option<(Vec<u32>, Vec<u32>)>) {
        if self.held == 0 {
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
            let fades: Vec<bool> =
                starting.iter().map(|&i| self.marks[i].begin.as_ref().is_some_and(|b| b.fades)).collect();
            self.freeze(encoder, inner, &starting);
            let start = self.clock.now();
            for (&i, fades) in starting.iter().zip(fades) {
                self.marks[i].transition = Some(Transition { start, seconds, fades });
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
                // Rows that only fade were written once; their fade follows the mark's progress. The
                // rest evaluate as the clock moves, and only then.
                if !transition.fades && self.clock.moved() {
                    shown.all_dirty();
                }
            }
        }
        if !running && self.marks.iter().all(|m| m.transition.is_none()) {
            self.resources.as_mut().expect("created").drop_frozen();
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
                    let rows = shown.held.min(shown.rows);
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
            super::passes::dispatch(&mut pass, shown.rows + shown.exits);
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
        let size = vertices.clone().map(|m| old_slot(m) + m.held).max().unwrap_or(0);
        let mut table = vec![wgsl::NONE; size as usize];
        for m in vertices {
            let (from, to) = (old_slot(m), m.region.state / wgsl::VERTEX_WORDS);
            match m.begin.as_ref().and_then(|b| b.sources.as_ref()) {
                Some(sources) => {
                    for (new_row, &old_row) in sources.iter().enumerate() {
                        if old_row != wgsl::NONE && old_row < m.held {
                            table[(from + old_row) as usize] = to + new_row as u32;
                        }
                    }
                }
                None => {
                    for row in 0..m.held.min(m.rows) {
                        table[(from + row) as usize] = to + row;
                    }
                }
            }
        }
        Some(table)
    }
}
