//! How a view draws a paged table.
//!
//! A drawing assigns the pages the camera needs to GPU slots and draws them as runs of held rows:
//! tiles fading out, then the camera's tiles in the order chosen, then pinned rows (selected,
//! framed by a fit, or ends of kept edges) that no tile covers. A page keeps its slot while
//! resident, so panning never moves rows. Idle pages stay resident while the budget allows, so
//! returning to them is free; a page made resident again only needs its words evaluated again.
//!
//! Resident edges need their endpoints resident. A vertex page that many edges end in is made
//! resident whole; scattered endpoints become kept rows, so far-apart edges cost one row per
//! endpoint rather than one page. Kept rows live in pages of their own, each at a fixed position
//! while kept.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::FxHashSet;

use super::View;
use super::kept::KeptTable;
use crate::data::{Field, Name, Reference, Table, UNWIRED, Version};
use crate::derive::order::Order;
use crate::derive::stamp_of;
use crate::derive::tiled::{Chosen, Draw, Place};
use crate::gpu::shaders as wgsl;
use crate::gpu::shaders::PAGE_ROWS;

/// Flag bit of a slot holding a page of kept rows; the low bits are that page's number.
const KEPT: u32 = 1 << 31;

/// Endpoints in one vertex page at which the page is made resident whole; with fewer, they are kept
/// individually. So endpoints never take more than twice the rows they reference.
const DENSE: u32 = PAGE_ROWS / 2;

/// The contents of a slot.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Holds {
    Free,
    /// Page `k` of the order.
    Page(u32),
    /// Page `j` of the kept rows.
    Kept(u32),
}

impl Holds {
    fn of(slot: u32) -> Holds {
        match slot {
            wgsl::NONE => Holds::Free,
            slot if slot & KEPT != 0 => Holds::Kept(slot & !KEPT),
            page => Holds::Page(page),
        }
    }
}

/// A span of consecutive held rows a mark draws: its first index among the rows drawn (`item`), its
/// first held row (`held`), its length, and whether its tile fades in or out (`FADE_IN`,
/// `FADE_OUT`, or 0).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Run {
    pub(crate) item: u32,
    pub(crate) held: u32,
    pub(crate) len: u32,
    pub(crate) fade: u32,
}

/// How a view draws one paged table: which pages are resident in which slots, and the runs drawn
/// from them.
#[derive(Debug)]
pub(crate) struct Drawing {
    pub(crate) order: Order,
    /// Each slot's contents: a page of the order, a page of kept rows (`KEPT` | its number), or
    /// nothing (`NONE`).
    slots: Arc<[u32]>,
    /// Each page's slot, `NONE` if not resident. The end table resolves endpoints through it.
    pub(crate) pages: Arc<[u32]>,
    /// The kept rows, indexed by kept position: each one's place in the order, `NONE` for a free
    /// position.
    kept: Arc<[u32]>,
    /// The kept rows keyed by order place, with their held rows. The end table resolves kept
    /// endpoints through it.
    pub(crate) kept_table: KeptTable,
    /// The pinned rows (drawn regardless of tiles), as order places, ascending.
    pinned: Arc<[u32]>,
    pub(crate) runs: Vec<Run>,
    /// Run indices sorted by first held row, to look up where a held row draws.
    by_held: Vec<u32>,
    /// The ranges of the order drawn (steady or fading in), and those fading out.
    ranges: Vec<Range<u32>>,
    leaving: Vec<Range<u32>>,
    /// Whether any tile fades in or out. Once the fade finishes, its settled drawing replaces it.
    pub(crate) fades: bool,
    /// Rows drawn, and how many of them fade out.
    pub(crate) items: u32,
    pub(crate) leaving_items: u32,
    /// The layout count at which each slot's page was last needed. Idle pages stay resident while
    /// there is room, most recently needed first.
    asked: Arc<[u64]>,
    /// How many layouts led to it, its own included.
    lays: u64,
    /// Idle pages, ascending.
    pub(crate) idle: Arc<[u32]>,
    /// The scene version its rows' words were evaluated in.
    pub(crate) scene: u64,
    /// The stamp of the [`Lay`] it was laid out from (see [`Lay::stamp`]).
    pub(crate) laid: u64,
    /// Unique to this drawing. Lists of its rows are keyed by it.
    pub(crate) made: Version,
    /// The endpoint or pinned places the previous drawing held elsewhere, ascending. Edge rows that
    /// reference them resolve their endpoints again. The version identifies this set of moves; it
    /// carries over from the previous drawing when nothing moved.
    pub(crate) moved: (Version, Arc<[u32]>),
    /// A stamp of the kept rows' inputs: pinned rows, endpoint needs, and resident pages. A drawing
    /// with the same stamp reuses its predecessor's kept rows unchanged.
    kept_from: u64,
    /// A stamp of how it holds rows; see [`Drawing::layout`].
    layout: u64,
}

/// Pinned rows (drawn regardless of tiles) as order places, ascending, with a stamp to compare them
/// without reading them.
#[derive(Clone, Default, Debug)]
pub(crate) struct Pinned {
    pub(crate) places: Arc<[u32]>,
    stamp: u64,
}

/// The inputs a drawing is laid out from.
pub(crate) struct Lay<'a> {
    pub(crate) chosen: &'a Chosen,
    /// Rows drawn regardless of tiles: selected rows, rows framed by a fit, and endpoints of kept
    /// edges.
    pub(crate) pinned: &'a Pinned,
    /// What resident edges need resident without drawing: whole pages, and individual rows.
    pub(crate) ends: &'a Ending,
    /// How many pages it may keep resident in all. Needed pages are always resident; idle pages
    /// fill whatever room is left.
    pub(crate) room: u32,
    /// The scene version its rows' words are evaluated in. Idle pages are released when it changes.
    pub(crate) scene: u64,
    /// Pages with rows written since the last layout. Idle pages among them are released, so a page
    /// is only rebuilt when it draws again.
    pub(crate) written: &'a Written,
}

/// The pages of an order with rows written between two versions of its table.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Written {
    #[default]
    Nothing,
    /// Whether each page has a written row.
    Pages(Vec<bool>),
    Every,
}

impl Written {
    /// The pages of `order` with rows written in `now` since `before`. Adding, dropping, renaming,
    /// or retyping a field, or changing a sampled field, counts as every row written.
    pub(crate) fn since(before: &Table, now: &Table, order: &Order) -> Written {
        if before.fields.len() != now.fields.len() {
            return Written::Every;
        }
        let mut rows = Vec::new();
        for ((name, field), (was_name, was)) in now.fields.iter().zip(&before.fields) {
            let (column, old) = match (field, was) {
                _ if name != was_name => return Written::Every,
                (Field::Values(column, version), Field::Values(old, old_version)) if version != old_version => {
                    (column, old)
                }
                (Field::Reference(reference), Field::Reference(old)) => (&reference.rows, &old.rows),
                (Field::Values(..), Field::Values(..)) => continue,
                (Field::Sampled(_, version), Field::Sampled(_, old_version)) if version == old_version => continue,
                _ => return Written::Every,
            };
            if !column.shares(old) {
                rows.extend(column.written_since(old));
            }
        }
        if rows.is_empty() {
            return Written::Nothing;
        }
        if rows.len() >= order.len() as usize {
            return Written::Every;
        }
        let mut pages = vec![false; order.pages() as usize];
        for row in rows {
            if let Some(page) = pages.get_mut((order.rank(row as u32) / PAGE_ROWS) as usize) {
                *page = true;
            }
        }
        Written::Pages(pages)
    }

    fn holds(&self, page: u32) -> bool {
        match self {
            Written::Nothing => false,
            Written::Pages(pages) => pages.get(page as usize).copied().unwrap_or(false),
            Written::Every => true,
        }
    }
}

impl Lay<'_> {
    /// A stamp of the order, ranges, pinned rows, endpoint needs, and room. Excludes `scene` and
    /// `written`, which only affect idle pages.
    pub(crate) fn stamp(&self) -> u64 {
        let chosen = self.chosen;
        stamp_of((chosen.order.id(), chosen.order.len(), &chosen.ranges, self.pinned.stamp, self.ends.stamp, self.room))
    }
}

impl Drawing {
    /// Lays out the drawing of `lay`, starting from `before`. Pages resident in `before` keep their
    /// slots, and its idle pages stay resident while `lay.room` allows. Kept rows (pinned rows and
    /// sparse endpoints whose pages are not resident) go in pages of their own, each keeping its
    /// position. With `fades`, tiles new since `before` fade in and tiles gone fade out. A `before`
    /// of another order carries nothing over: every row moves, and a transition animates the move.
    pub(crate) fn lay(before: Option<&Drawing>, lay: &Lay<'_>, fades: bool) -> Drawing {
        let order = lay.chosen.order.clone();
        let before = before.filter(|b| b.order.id() == order.id());
        let ranges = lay.chosen.ranges.clone();
        // The ranges `before` settles to: those it draws, without those fading out.
        let was: &[Range<u32>] = before.map_or(&[], |b| &b.ranges);
        let has = |list: &[Range<u32>], r: &Range<u32>| list.iter().any(|x| x == r);
        let fading = fades && before.is_some();
        let entering: Vec<Range<u32>> =
            if fading { ranges.iter().filter(|r| !has(was, r)).cloned().collect() } else { Vec::new() };
        let leaving: Vec<Range<u32>> =
            if fading { was.iter().filter(|r| !has(&ranges, r)).cloned().collect() } else { Vec::new() };
        // Resident pages: those drawn or fading out, and dense endpoint pages; idle pages of
        // `before` while there is room and their words are still valid; and pages of kept rows.
        let count = order.pages() as usize;
        let asked_now = asked(count, ranges.iter().chain(&leaving), &lay.ends.pages);
        let mut held = asked_now.clone();
        let idle = before
            .filter(|b| b.scene == lay.scene)
            .map_or_else(Vec::new, |b| linger(b, &asked_now, lay.room, lay.written, &mut held));
        // Kept rows stay unchanged while their inputs do, and appending or writing rows leaves
        // those inputs unchanged. Every page also keeps its slot, so no endpoint moves.
        let held_pages: Vec<usize> = (0..held.len()).filter(|&p| held[p]).collect();
        let kept_from = stamp_of((lay.pinned.stamp, lay.ends.stamp, held_pages));
        let same = before.filter(|b| b.kept_from == kept_from);
        let kept: Arc<[u32]> = if let Some(b) = same {
            b.kept.clone()
        } else {
            keep(before, &lay.pinned.places, &lay.ends.rows, &held, &order).into()
        };
        let kept_pages = kept.len().div_ceil(PAGE_ROWS as usize);
        let (slots, pages, kept_slots) = place(before, &held, kept_pages);
        let kept_table = if let Some(b) = same { b.kept_table.clone() } else { keep_table(before, &kept, &kept_slots) };
        let lays = before.map_or(1, |b| b.lays + 1);
        let asked: Arc<[u64]> = slots
            .iter()
            .enumerate()
            .map(|(s, &slot)| match Holds::of(slot) {
                Holds::Free => 0,
                Holds::Page(page) if !asked_now[page as usize] => {
                    // An idle page keeps its slot and the layout count it was last needed at.
                    before.and_then(|b| b.asked.get(s)).copied().unwrap_or(lays)
                }
                _ => lays,
            })
            .collect();
        let mut drawing = Drawing {
            order,
            slots: slots.into(),
            pages: pages.into(),
            kept,
            kept_table,
            pinned: lay.pinned.places.clone(),
            runs: Vec::new(),
            by_held: Vec::new(),
            ranges,
            leaving,
            fades: false,
            items: 0,
            leaving_items: 0,
            asked,
            lays,
            idle: idle.into(),
            scene: lay.scene,
            laid: lay.stamp(),
            made: Version::next(),
            moved: before.map_or_else(|| (Version::next(), Arc::default()), |b| b.moved.clone()),
            kept_from,
            layout: 0,
        };
        drawing.layout = stamp_of((drawing.order.id(), drawing.order.len(), &*drawing.slots, &*drawing.kept));
        if let Some(b) = before.filter(|b| b.kept_from != kept_from) {
            let places = moved(b, &drawing, lay.ends, &lay.pinned.places);
            if !places.is_empty() {
                drawing.moved = (Version::next(), places.into());
            }
        }
        drawing.run(&entering, &lay.pinned.places);
        drawing.fades = !entering.is_empty() || !drawing.leaving.is_empty();
        drawing
    }

    /// The drawing this one becomes once its fades finish: entering tiles draw steadily, and
    /// leaving tiles stop drawing, so their pages are no longer needed.
    pub(crate) fn settled(&self, lay: &Lay<'_>) -> Drawing {
        Drawing::lay(Some(self), lay, false)
    }

    /// Builds the runs: tiles fading out first, so they draw underneath; then the drawn ranges in
    /// the order chosen, with `entering` fading in; then `pinned` rows no range covers.
    fn run(&mut self, entering: &[Range<u32>], pinned: &[u32]) {
        let covered = |list: &[Range<u32>], row: u32| list.iter().any(|r| r.contains(&row));
        let kept: Vec<u32> = pinned
            .iter()
            .filter(|&&row| !covered(&self.ranges, row) && row < self.order.len())
            .filter_map(|&row| self.held_of(row))
            .collect();
        let mut runs: Vec<Run> = Vec::new();
        let mut item = 0;
        let pages = self.pages.clone();
        let mut push = |held: u32, len: u32, fade: u32, runs: &mut Vec<Run>| {
            match runs.last_mut() {
                Some(last) if last.held + last.len == held && last.fade == fade => last.len += len,
                _ => runs.push(Run { item, held, len, fade }),
            }
            item += len;
        };
        let mut span = |range: Range<u32>, fade: u32, runs: &mut Vec<Run>| {
            let mut d = range.start;
            while d < range.end {
                let page = d / PAGE_ROWS;
                let end = range.end.min((page + 1) * PAGE_ROWS);
                push(pages[page as usize] * PAGE_ROWS + d % PAGE_ROWS, end - d, fade, runs);
                d = end;
            }
        };
        let mut leaving_items = 0;
        for range in &self.leaving {
            // Skip pinned rows: they draw steadily with the other pinned rows instead.
            let mut start = range.start;
            for &row in pinned.iter().filter(|&&row| range.contains(&row)) {
                span(start..row, wgsl::FADE_OUT, &mut runs);
                start = row + 1;
            }
            span(start..range.end, wgsl::FADE_OUT, &mut runs);
            leaving_items += range.len() as u32 - pinned.iter().filter(|&&row| range.contains(&row)).count() as u32;
        }
        for range in &self.ranges {
            let fade = if entering.contains(range) { wgsl::FADE_IN } else { 0 };
            span(range.clone(), fade, &mut runs);
        }
        for held in kept {
            push(held, 1, 0, &mut runs);
        }
        let mut by_held: Vec<u32> = (0..runs.len() as u32).collect();
        crate::order::by_key(&mut by_held, |&r| u64::from(runs[r as usize].held));
        self.runs = runs;
        self.by_held = by_held;
        self.items = item;
        self.leaving_items = leaving_items;
    }

    /// The number of held rows: `PAGE_ROWS` per slot, free slots included.
    pub(crate) fn live(&self) -> u32 {
        self.slots.len() as u32 * PAGE_ROWS
    }

    /// The number of slots, free ones included.
    pub(crate) fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// The contents of slot `s`.
    pub(crate) fn holds(&self, s: usize) -> Holds {
        Holds::of(self.slots.get(s).copied().unwrap_or(wgsl::NONE))
    }

    /// The order places of the rows in slot `s`, `NONE` for empty positions.
    pub(crate) fn places(&self, s: usize) -> Vec<u32> {
        match self.holds(s) {
            Holds::Free => Vec::new(),
            Holds::Page(k) => (k * PAGE_ROWS..((k + 1) * PAGE_ROWS).min(self.order.len())).collect(),
            Holds::Kept(_) => self.kept_places(s).to_vec(),
        }
    }

    /// The order places of the kept rows in slot `s`, `NONE` for empty positions. Empty unless the
    /// slot holds kept rows.
    pub(crate) fn kept_places(&self, s: usize) -> &[u32] {
        let Holds::Kept(j) = self.holds(s) else { return &[] };
        let start = ((j * PAGE_ROWS) as usize).min(self.kept.len());
        &self.kept[start..self.kept.len().min(start + PAGE_ROWS as usize)]
    }

    /// The table rows in slot `s`, in slot order, `NONE` for empty positions. A page of each column
    /// is packed from them.
    pub(crate) fn rows(&self, s: usize) -> Vec<u32> {
        match self.holds(s) {
            Holds::Free => Vec::new(),
            Holds::Page(k) => self.order.page(k),
            Holds::Kept(_) => {
                let source = |d: u32| if d == wgsl::NONE { wgsl::NONE } else { self.order.source(d) };
                self.places(s).into_iter().map(source).collect()
            }
        }
    }

    /// The held row of order place `d`, from its resident page or the kept rows; `None` if not
    /// resident.
    pub(crate) fn held_of(&self, d: u32) -> Option<u32> {
        let slot = *self.pages.get((d / PAGE_ROWS) as usize)?;
        if slot != wgsl::NONE {
            return Some(slot * PAGE_ROWS + d % PAGE_ROWS);
        }
        self.kept_table.held(d)
    }

    /// The held row of table row `r`, if resident.
    pub(crate) fn held_row(&self, r: u32) -> Option<u32> {
        (r < self.order.len()).then(|| self.held_of(self.order.rank(r))).flatten()
    }

    /// The table row in held row `h`, if any.
    pub(crate) fn source(&self, h: u32) -> Option<u32> {
        let d = match self.holds((h / PAGE_ROWS) as usize) {
            Holds::Free => return None,
            Holds::Page(page) => page.checked_mul(PAGE_ROWS)? + h % PAGE_ROWS,
            Holds::Kept(j) => *self.kept.get((j * PAGE_ROWS + h % PAGE_ROWS) as usize)?,
        };
        (d != wgsl::NONE && d < self.order.len()).then(|| self.order.source(d))
    }

    /// The index of held row `h` among the rows drawn, if it is drawn.
    pub(crate) fn item_of(&self, h: u32) -> Option<u32> {
        let i = self.by_held.partition_point(|&r| self.runs[r as usize].held <= h).checked_sub(1)?;
        let run = self.runs[self.by_held[i] as usize];
        (h < run.held + run.len).then_some(run.item + h - run.held)
    }

    /// The resident pages of its order.
    pub(crate) fn held_pages(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.slots.len()).filter_map(|s| match self.holds(s) {
            Holds::Page(page) => Some(page),
            _ => None,
        })
    }

    /// The pinned rows whose pages are not resident, as table rows.
    pub(crate) fn kept(&self) -> impl Iterator<Item = u32> + '_ {
        let paged = |d: u32| self.pages.get((d / PAGE_ROWS) as usize).is_some_and(|&slot| slot != wgsl::NONE);
        self.pinned.iter().filter(move |&&d| d < self.order.len() && !paged(d)).map(|&d| self.order.source(d))
    }

    /// A stamp of how it holds rows: its order, each slot's contents, and the kept rows' positions.
    /// Column tables are rebuilt when it changes.
    pub(crate) fn layout(&self) -> u64 {
        self.layout
    }

    /// Whether slot `s` holds the same rows in `other` as in this drawing.
    pub(crate) fn holds_alike(&self, other: &Drawing, s: usize) -> bool {
        self.slots.get(s) == other.slots.get(s)
            && (!matches!(self.holds(s), Holds::Kept(_)) || self.places(s) == other.places(s))
    }
}

/// For each of `count` pages, whether it is needed: the pages `ranges` draw, and `ends`.
fn asked<'r>(count: usize, ranges: impl Iterator<Item = &'r Range<u32>>, ends: &[u32]) -> Vec<bool> {
    let mut asked = vec![false; count];
    for range in ranges.filter(|r| r.start < r.end) {
        for page in range.start / PAGE_ROWS..=(range.end - 1) / PAGE_ROWS {
            if let Some(a) = asked.get_mut(page as usize) {
                *a = true;
            }
        }
    }
    for &page in ends {
        if let Some(a) = asked.get_mut(page as usize) {
            *a = true;
        }
    }
    asked
}

/// The kept-row table of `kept` (order places by kept position), whose kept pages lie in the slots
/// `kept_slots` gives. It is updated from `before`'s table: only positions whose place changed are
/// removed and inserted, so every other row keeps its bucket.
fn keep_table(before: Option<&Drawing>, kept: &[u32], kept_slots: &[u32]) -> KeptTable {
    let held = |i: usize| kept_slots[i / PAGE_ROWS as usize] * PAGE_ROWS + (i as u32) % PAGE_ROWS;
    let was: &[u32] = before.map_or(&[], |b| &b.kept);
    let at = |list: &[u32], i: usize| list.get(i).copied().unwrap_or(wgsl::NONE);
    let (mut gone, mut came) = (Vec::new(), Vec::new());
    for i in 0..kept.len().max(was.len()) {
        let (old, new) = (at(was, i), at(kept, i));
        if old != new {
            gone.extend((old != wgsl::NONE).then_some(old));
            came.extend((new != wgsl::NONE).then(|| [new, held(i)]));
        }
    }
    let rows: Vec<[u32; 2]> =
        kept.iter().enumerate().filter(|&(_, &d)| d != wgsl::NONE).map(|(i, &d)| [d, held(i)]).collect();
    KeptTable::laid(before.map_or(&KeptTable::default(), |b| &b.kept_table), &rows, &gone, &came)
}

/// The places in `ends` or `pinned` that `before` held and `now` holds elsewhere or not at all,
/// ascending. Edge rows that reference them resolve their endpoints again. A page resident in both
/// keeps its slot, and a row kept in both keeps its kept position, so only rows of a page resident
/// in just one drawing move: listed rows of pages `before` held and `now` does not, and rows
/// `before` kept whose pages `now` holds. A row `before` did not hold is referenced only by edge
/// rows new to the edge drawing, which resolve their endpoints when they arrive.
fn moved(before: &Drawing, now: &Drawing, ends: &Ending, pinned: &[u32]) -> Vec<u32> {
    /// The subslice of ascending `places` that lies in page `p`.
    fn within(places: &[u32], p: u32) -> &[u32] {
        let start = places.partition_point(|&d| d < p * PAGE_ROWS);
        &places[start..places.partition_point(|&d| d < (p + 1) * PAGE_ROWS)]
    }
    let held = |drawing: &Drawing, page: usize| drawing.pages.get(page).is_some_and(|&slot| slot != wgsl::NONE);
    let mut moved = Vec::new();
    let mut gained = vec![false; now.pages.len()];
    for p in 0..before.pages.len().max(now.pages.len()) {
        if held(before, p) && !held(now, p) {
            moved.extend_from_slice(within(&ends.rows, p as u32));
            moved.extend_from_slice(within(pinned, p as u32));
        }
    }
    for (p, gained) in gained.iter_mut().enumerate() {
        *gained = held(now, p) && !held(before, p);
    }
    if gained.contains(&true) {
        let gained = |d: u32| gained.get((d / PAGE_ROWS) as usize).copied().unwrap_or(false);
        moved.extend(before.kept.iter().copied().filter(|&d| d != wgsl::NONE && gained(d)));
    }
    moved.sort_unstable();
    moved.dedup();
    moved
}

/// Keeps idle pages resident: pages `before` held that are no longer `asked` for and have no
/// `written` row, most recently needed first, up to `room` resident pages in all. Marks them in
/// `held` and returns them ascending.
fn linger(before: &Drawing, asked: &[bool], room: u32, written: &Written, held: &mut [bool]) -> Vec<u32> {
    let wanted = asked.iter().filter(|&&a| a).count() as u32;
    let mut idle: Vec<(u64, u32)> = (0..before.slots.len())
        .filter_map(|s| match before.holds(s) {
            Holds::Page(page) if !asked.get(page as usize).copied().unwrap_or(true) && !written.holds(page) => {
                Some((before.asked[s], page))
            }
            _ => None,
        })
        .collect();
    idle.sort_unstable_by(|a, b| b.cmp(a));
    let mut kept: Vec<u32> = idle.iter().take(room.saturating_sub(wanted) as usize).map(|&(_, page)| page).collect();
    for &page in &kept {
        held[page as usize] = true;
    }
    kept.sort_unstable();
    kept
}

/// The kept rows: the places in `order` from `pinned` and `ends` whose pages are not `held`,
/// indexed by kept position, `NONE` for a free position. Rows already kept in `before` keep their
/// positions; the rest take the first free ones.
fn keep(before: Option<&Drawing>, pinned: &[u32], ends: &[u32], held: &[bool], order: &Order) -> Vec<u32> {
    let mut out: Vec<u32> =
        pinned.iter().chain(ends).copied().filter(|&d| d < order.len() && !held[(d / PAGE_ROWS) as usize]).collect();
    out.sort_unstable();
    out.dedup();
    let wanted: FxHashSet<u32> = out.iter().copied().collect();
    let mut kept: Vec<u32> = before.map_or_else(Vec::new, |b| b.kept.to_vec());
    let mut placed: FxHashSet<u32> = FxHashSet::default();
    for d in &mut kept {
        if *d != wgsl::NONE && wanted.contains(d) {
            placed.insert(*d);
        } else {
            *d = wgsl::NONE;
        }
    }
    let mut free = (0..kept.len()).filter(|&i| kept[i] == wgsl::NONE).collect::<Vec<_>>().into_iter();
    for &d in out.iter().filter(|d| !placed.contains(d)) {
        match free.next() {
            Some(i) => kept[i] = d,
            None => kept.push(d),
        }
    }
    while kept.last() == Some(&wgsl::NONE) {
        kept.pop();
    }
    kept
}

/// Assigns slots to the `held` pages and to `kept_pages` pages of kept rows. Each keeps its slot
/// from `before`; the rest take the first free slots. Returns each slot's contents, each page's
/// slot, and each kept page's slot.
fn place(before: Option<&Drawing>, held: &[bool], kept_pages: usize) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let mut slots: Vec<u32> = before.map_or_else(Vec::new, |b| b.slots.to_vec());
    let mut pages = vec![wgsl::NONE; held.len()];
    let mut kept_slots = vec![wgsl::NONE; kept_pages];
    for (s, slot) in slots.iter_mut().enumerate() {
        match Holds::of(*slot) {
            Holds::Page(k) if held.get(k as usize).copied().unwrap_or(false) => pages[k as usize] = s as u32,
            Holds::Kept(j) if (j as usize) < kept_pages => kept_slots[j as usize] = s as u32,
            _ => *slot = wgsl::NONE,
        }
    }
    let mut free = (0..slots.len()).filter(|&s| slots[s] == wgsl::NONE).collect::<Vec<_>>().into_iter();
    let mut take = |slots: &mut Vec<u32>, what: u32| -> u32 {
        let slot = free.next().unwrap_or_else(|| {
            slots.push(wgsl::NONE);
            slots.len() - 1
        });
        slots[slot] = what;
        slot as u32
    };
    for page in 0..held.len() {
        if held[page] && pages[page] == wgsl::NONE {
            pages[page] = take(&mut slots, page as u32);
        }
    }
    for (j, slot) in kept_slots.iter_mut().enumerate() {
        if *slot == wgsl::NONE {
            *slot = take(&mut slots, KEPT | j as u32);
        }
    }
    while slots.last() == Some(&wgsl::NONE) {
        slots.pop();
    }
    (slots, pages, kept_slots)
}

/// For each page of an edge table's order, the places of its endpoints in the vertex table's order.
/// Computed when the page first becomes resident, and kept while neither order nor the end
/// references change. Appending rows to either table moves no placed row, so a page is recomputed
/// only after rows are appended to it. In a sampled edge order, the vertices that sampled edges end
/// at come first in the vertex table's sample, so they lie in its first pages.
#[derive(Default)]
pub(crate) struct Ends {
    stamp: u64,
    /// Per edge page: its row count when computed, and its endpoint places.
    pages: Vec<Option<(u32, Arc<Places>)>>,
    /// The last [`Ending`] computed, with the stamp of its inputs.
    asked: (u64, Arc<Ending>),
}

/// The distinct endpoint places of one page of edges, ascending, and for each vertex page they fall
/// in, a run `[page, start, end]` indexing into `places`.
struct Places {
    places: Vec<u32>,
    runs: Vec<[u32; 3]>,
}

impl Ends {
    /// What the edges resident in `drawing` need of the vertex table they reference through `ends`,
    /// which draws in `target`: dense pages, sparse endpoint rows, and the endpoints of kept edges.
    /// Recomputed only when the drawing's layout or the vertex table's length changes. Each edge
    /// page counts its distinct endpoints once toward their vertex page, so a vertex page that many
    /// edge pages share may be made resident whole with fewer than `DENSE` distinct rows in use.
    fn ending(&mut self, drawing: &Drawing, target: &Order, ends: &[&Reference]) -> Arc<Ending> {
        let stamp = stamp_of((drawing.order.id(), target.id(), ends.iter().map(|r| r.version).collect::<Vec<_>>()));
        if stamp != self.stamp {
            self.stamp = stamp;
            self.pages.clear();
        }
        let asked = stamp_of((stamp, drawing.layout(), target.len()));
        if asked == self.asked.0 {
            return self.asked.1.clone();
        }
        let found: Vec<Arc<Places>> =
            drawing.held_pages().map(|page| self.of(&drawing.order, target, ends, page)).collect();
        let mut counts = vec![0_u32; target.pages() as usize];
        for &[page, start, end] in found.iter().flat_map(|f| &f.runs) {
            counts[page as usize] += end - start;
        }
        let dense = |page: u32| counts[page as usize] >= DENSE;
        let pages: Vec<u32> = (0..counts.len() as u32).filter(|&page| dense(page)).collect();
        let mut rows: Vec<u32> = Vec::new();
        for f in &found {
            for &[_, start, end] in f.runs.iter().filter(|&&[page, ..]| !dense(page)) {
                rows.extend_from_slice(&f.places[start as usize..end as usize]);
            }
        }
        rows.sort_unstable();
        rows.dedup();
        // Endpoints of kept edges, drawn regardless of their pages.
        let mut kept: Vec<u32> = Vec::new();
        for row in drawing.kept() {
            for reference in ends {
                let t = reference.target_row(row as usize);
                if t != UNWIRED && t < target.len() {
                    kept.push(target.rank(t));
                }
            }
        }
        self.asked = (asked, Arc::new(Ending::new(pages, rows, kept)));
        self.asked.1.clone()
    }

    /// Whether any endpoint of edge page `page` is among `places` (ascending). True if the page was
    /// never computed.
    fn lie_in(&self, page: u32, places: &[u32]) -> bool {
        let Some(Some((_, found))) = self.pages.get(page as usize) else { return true };
        // Binary-search the longer list for each item of the shorter.
        let (few, many) =
            if found.places.len() < places.len() { (&found.places[..], places) } else { (places, &found.places[..]) };
        few.iter().any(|d| many.binary_search(d).is_ok())
    }

    /// The endpoint places in `target` of edge page `page` of `order`, through `ends`. Cached until
    /// the page's row count changes.
    fn of(&mut self, order: &Order, target: &Order, ends: &[&Reference], page: u32) -> Arc<Places> {
        if self.pages.len() <= page as usize {
            self.pages.resize_with(page as usize + 1, || None);
        }
        let rows = order.len().saturating_sub(page * PAGE_ROWS).min(PAGE_ROWS);
        match &self.pages[page as usize] {
            Some((had, found)) if *had == rows => found.clone(),
            _ => {
                let mut places: Vec<u32> = Vec::new();
                for r in order.page(page) {
                    for reference in ends {
                        let t = reference.target_row(r as usize);
                        if t != UNWIRED && t < target.len() {
                            places.push(target.rank(t));
                        }
                    }
                }
                places.sort_unstable();
                places.dedup();
                let mut runs: Vec<[u32; 3]> = Vec::new();
                for (i, &d) in places.iter().enumerate() {
                    match runs.last_mut() {
                        Some(run) if run[0] == d / PAGE_ROWS => run[2] = i as u32 + 1,
                        _ => runs.push([d / PAGE_ROWS, i as u32, i as u32 + 1]),
                    }
                }
                let found = Arc::new(Places { places, runs });
                self.pages[page as usize] = Some((rows, found.clone()));
                found
            }
        }
    }
}

/// What resident edges need of the vertex table, as places in its order, ascending: dense `pages`
/// to make resident whole and the remaining endpoint `rows` to keep individually, neither drawn;
/// and the endpoints of `kept` edges, drawn regardless of their pages.
#[derive(Default, Debug)]
pub(crate) struct Ending {
    pages: Vec<u32>,
    rows: Vec<u32>,
    kept: Vec<u32>,
    /// A stamp of `pages`, `rows`, and `kept`, to compare them without reading them.
    stamp: u64,
}

impl Ending {
    fn new(pages: Vec<u32>, rows: Vec<u32>, kept: Vec<u32>) -> Ending {
        let stamp = stamp_of((&pages, &rows, &kept));
        Ending { pages, rows, kept, stamp }
    }

    /// The union of `endings`.
    fn merged(endings: &[Arc<Ending>]) -> Ending {
        let all = |part: fn(&Ending) -> &Vec<u32>| {
            let mut all: Vec<u32> = endings.iter().flat_map(|e| part(e).iter().copied()).collect();
            all.sort_unstable();
            all.dedup();
            all
        };
        Ending::new(all(|e| &e.pages), all(|e| &e.rows), all(|e| &e.kept))
    }
}

/// The drawing state of one paged table: the `current` drawing, the `next` one that replaces it
/// once every page it needs is on the GPU, and the view-clock time `since` the current one first
/// drew. Also caches its edges' needs of their vertex table (`ends`), the merged needs of edge
/// tables ending at this table (`ending`), and its pinned rows.
#[derive(Default)]
pub(crate) struct Drawn {
    pub(crate) current: Option<Arc<Drawing>>,
    pub(crate) next: Option<Arc<Drawing>>,
    pub(crate) since: f64,
    ends: Ends,
    ending: (u64, Arc<Ending>),
    pinned: Pinned,
    /// The table as of the last frame, to find which rows were written since.
    table: Option<Table>,
}

impl Drawn {
    /// The drawing marks sync to: `next` if any, else `current`.
    pub(crate) fn latest(&self) -> Option<&Arc<Drawing>> {
        self.next.as_ref().or(self.current.as_ref())
    }

    /// The slots of `drawing` (this table's edge drawing) whose rows end at any of `places` in the
    /// vertex table, ascending: resident pages by their cached endpoints, and every kept page.
    pub(crate) fn naming(&self, drawing: &Drawing, places: &[u32]) -> Vec<u32> {
        (0..drawing.slot_count())
            .filter(|&s| match drawing.holds(s) {
                Holds::Page(page) => self.ends.lie_in(page, places),
                Holds::Kept(_) => true,
                Holds::Free => false,
            })
            .map(|s| s as u32)
            .collect()
    }

    /// The merged needs of every edge table ending at this table, merged again only when one
    /// changes.
    fn ending(&mut self, endings: &[Arc<Ending>]) -> Arc<Ending> {
        match endings {
            [] => Arc::default(),
            [one] => one.clone(),
            many => {
                let stamp = stamp_of(many.iter().map(|e| e.stamp).collect::<Vec<_>>());
                if stamp != self.ending.0 {
                    self.ending = (stamp, Arc::new(Ending::merged(many)));
                }
                self.ending.1.clone()
            }
        }
    }

    /// The pinned rows: `own` (selected or framed by a fit) and the endpoints of kept edges in
    /// `ending`. Rebuilt only when those change.
    fn pin(&mut self, own: Vec<u32>, ending: &Ending) -> Pinned {
        let stamp = stamp_of((&own, &ending.kept));
        if stamp != self.pinned.stamp {
            let mut places = own;
            places.extend_from_slice(&ending.kept);
            places.sort_unstable();
            places.dedup();
            self.pinned = Pinned { places: places.into(), stamp };
        }
        self.pinned.clone()
    }
}

impl View {
    /// Lays out each paged table's drawing from the camera's choices. A new drawing replaces the
    /// current one when its inputs changed, or when the current one finished fading. A table no
    /// longer paged loses its drawing and draws whole, in its own order.
    pub(super) fn lay_out_drawings(&mut self) {
        let choices = std::mem::take(&mut self.choices);
        self.drawings.retain(|key, _| choices.contains_key(key));
        let fades = !self.ease().is_zero();
        let ease = self.ease().as_secs_f64();
        // Edge tables go first, so their vertex tables know which endpoints to make resident and
        // which kept-edge endpoints to draw.
        let mut keys: Vec<&(Name, Name)> = choices.keys().collect();
        crate::order::by_key(&mut keys, |key| {
            u64::from(!matches!(self.planning.plans().get(*key).map(|p| &p.place), Some(Place::Ends(_))))
        });
        let mut ends: crate::data::Keyed<(Name, Name), Vec<Arc<Ending>>> = crate::data::Keyed::default();
        for key in keys {
            let chosen = &choices[key];
            let endings = ends.remove(key).unwrap_or_default();
            let own = self.pinned(key, &chosen.order);
            let (scene, room) = (self.scene_version, self.room(key));
            let table = self.snapshot(&key.0).and_then(|d| d.table(&key.1)).cloned();
            let drawn = self.drawings.entry(key.clone()).or_default();
            let written = match (&drawn.table, &table) {
                (Some(before), Some(now)) => Written::since(before, now, &chosen.order),
                _ => Written::Every,
            };
            drawn.table = table;
            let ending = drawn.ending(&endings);
            let pinned = drawn.pin(own, &ending);
            let lay = Lay { chosen, pinned: &pinned, ends: &ending, room, scene, written: &written };
            let stamp = lay.stamp();
            let current = drawn.current.clone();
            let latest = drawn.next.as_ref().or(current.as_ref());
            // Idle pages are released when the scene changes or one of their rows is written.
            let stale = latest.is_some_and(|d| {
                !d.idle.is_empty() && (d.scene != scene || d.idle.iter().any(|&page| written.holds(page)))
            });
            if latest.map(|d| d.laid) != Some(stamp) || stale {
                drawn.next = Some(Arc::new(Drawing::lay(current.as_deref(), &lay, fades)));
            } else if drawn.next.is_none()
                && let Some(current) = current.filter(|c| c.fades && self.clock.done(drawn.since, ease))
            {
                drawn.next = Some(Arc::new(current.settled(&lay)));
            }
            // Record what this table's resident edges need of the vertex table they end at.
            let Some(place) = self.planning.plans().get(key).map(|p| &p.place) else { continue };
            let Place::Ends(fields) = place else { continue };
            let Some(table) = self.snapshots.iter().find(|d| *d.name() == key.0).and_then(|d| d.table(&key.1)) else {
                continue;
            };
            let references: Vec<&Reference> = fields
                .iter()
                .filter_map(|f| match table.field_named(f) {
                    Some(Field::Reference(r)) => Some(r),
                    _ => None,
                })
                .collect();
            let Some(to) = references.first().map(|r| r.to.clone()) else { continue };
            let target_key = (key.0.clone(), to);
            let Some(target) = choices.get(&target_key) else { continue };
            let drawn = self.drawings.get_mut(key).expect("laid out");
            let drawing = drawn.latest().expect("laid out").clone();
            let ending = drawn.ends.ending(&drawing, &target.order, &references);
            ends.entry(target_key).or_default().push(ending);
        }
        self.choices = choices;
    }

    /// Sets each mark's `reveal` for this frame: how far its paged table's tiles have faded in or
    /// out, from 0 to 1; 1 when they are not fading.
    pub(super) fn reveal(&mut self) {
        let ease = self.ease().as_secs_f64();
        for shown in &mut self.marks {
            let key = (shown.mark.style().data.clone(), shown.mark.style().table.clone());
            shown.reveal = match self.drawings.get(&key) {
                Some(drawn) if drawn.current.as_ref().is_some_and(|c| c.fades) => {
                    self.clock.eased(drawn.since, ease) as f32
                }
                _ => 1.0,
            };
        }
    }

    /// What each paged table of lines or areas draws this frame, for shaping: the pages of its
    /// order the camera chose, and the pinned rows outside those pages.
    pub(super) fn paged(&self) -> crate::data::Keyed<(Name, Name), crate::derive::Paged> {
        let shaped = |(data, table): &(Name, Name)| {
            self.scene.marks.iter().any(|mark| {
                let style = mark.style();
                matches!(mark, crate::Mark::Lines(_) | crate::Mark::Areas(_))
                    && style.data == *data
                    && style.table == *table
            })
        };
        let mut paged = crate::data::Keyed::default();
        for (key, chosen) in self.choices.iter().filter(|(key, _)| shaped(key)) {
            let ranges = chosen.ranges.iter().filter(|r| r.start < r.end);
            let mut pages: Vec<u32> = ranges.flat_map(|r| r.start / PAGE_ROWS..=(r.end - 1) / PAGE_ROWS).collect();
            pages.sort_unstable();
            pages.dedup();
            let pinned = self.pinned(key, &chosen.order);
            let kept: Vec<u32> =
                pinned.into_iter().filter(|&d| pages.binary_search(&(d / PAGE_ROWS)).is_err()).collect();
            paged.insert(key.clone(), crate::derive::Paged { order: chosen.order.clone(), pages, kept });
        }
        paged
    }

    /// How many pages `key`'s drawing may keep resident in all: for a table drawn by tiles, as many
    /// as the plan's rows fill; otherwise 0, so no idle page stays.
    fn room(&self, key: &(Name, Name)) -> u32 {
        match self.planning.plans().get(key).map(|p| p.draw) {
            Some(Draw::Tiles { rows }) => rows.div_ceil(PAGE_ROWS),
            _ => 0,
        }
    }

    /// The places in `order` of `key`'s rows drawn regardless of tiles: selected rows and rows a
    /// fit frames, ascending.
    fn pinned(&self, key: &(Name, Name), order: &Order) -> Vec<u32> {
        let Some(table) = self.snapshot(&key.0).and_then(|d| d.table(&key.1)) else { return Vec::new() };
        let mut rows: Vec<u32> = self
            .focus
            .selection
            .iter()
            .chain(&self.focus.fitting)
            .filter(|row| row.data == key.0 && row.table == key.1)
            .filter_map(|row| table.row(row.id.as_ref()))
            .map(|r| order.rank(r as u32))
            .collect();
        rows.sort_unstable();
        rows.dedup();
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::pyramid::Pyramid;

    fn order(rows: u32) -> Order {
        Order::Pyramid { pyramid: Arc::new(Pyramid::new((0..rows).collect(), Vec::new())), rows }
    }

    fn chosen(order: &Order, ranges: &[Range<u32>]) -> Chosen {
        Chosen { order: order.clone(), ranges: ranges.to_vec(), capped: false }
    }

    /// Pinned rows at `places`.
    fn pinned(places: &[u32]) -> Pinned {
        Pinned { places: places.into(), stamp: stamp_of(places) }
    }

    /// A choice drawing one range of `order`.
    fn one(order: &Order, range: Range<u32>) -> Chosen {
        Chosen { order: order.clone(), ranges: vec![range], capped: false }
    }

    #[test]
    fn written_rows_mark_the_pages_that_contain_them() {
        let order = order(3 * PAGE_ROWS);
        let n = 3 * PAGE_ROWS as usize;
        let data = crate::data::Data::new("d");
        data.apply(Table::new("T", crate::data::Ids::count(n as u32)).field("v", vec![0.0; n])).expect("valid");
        let table = || data.snapshot().table("T").expect("a table").clone();
        let before = table();
        assert_eq!(Written::since(&before, &table(), &order), Written::Nothing, "nothing written");
        data.apply(Table::new("T", vec![u64::from(PAGE_ROWS) + 5]).field("v", vec![1.0])).expect("valid");
        assert_eq!(Written::since(&before, &table(), &order), Written::Pages(vec![false, true, false]));
        data.apply(Table::new("T", vec![0_u64]).field("w", vec![1.0])).expect("valid");
        assert_eq!(Written::since(&before, &table(), &order), Written::Every, "a new field marks every row written");
    }

    #[test]
    fn pages_keep_their_slots_as_tiles_come_and_go() {
        let order = order(8 * PAGE_ROWS);
        let first = Drawing::lay(
            None,
            &Lay {
                chosen: &chosen(&order, &[0..PAGE_ROWS, 3 * PAGE_ROWS..4 * PAGE_ROWS]),
                pinned: &Pinned::default(),
                ends: &Ending::default(),
                room: 0,
                scene: 0,
                written: &Written::Nothing,
            },
            false,
        );
        assert_eq!(&*first.slots, [0, 3]);
        assert_eq!(first.items, 2 * PAGE_ROWS);
        // Page 0 leaves and page 5 arrives: page 5 takes page 0's slot, and page 3 keeps its own.
        let next = Drawing::lay(
            Some(&first),
            &Lay {
                chosen: &chosen(&order, &[3 * PAGE_ROWS..4 * PAGE_ROWS, 5 * PAGE_ROWS..6 * PAGE_ROWS]),
                pinned: &Pinned::default(),
                ends: &Ending::default(),
                room: 0,
                scene: 0,
                written: &Written::Nothing,
            },
            false,
        );
        assert_eq!(&*next.slots, [5, 3]);
        assert_eq!(next.held_of(3 * PAGE_ROWS + 7), Some(PAGE_ROWS + 7));
        assert_eq!(next.source(7), Some(5 * PAGE_ROWS + 7));
        assert_eq!(next.item_of(PAGE_ROWS + 7), Some(7), "page 3's rows draw first");
    }

    #[test]
    fn idle_pages_stay_resident_while_there_is_room() {
        let order = order(8 * PAGE_ROWS);
        let lay = |ranges: &[Range<u32>], room: u32, before: Option<&Drawing>| {
            Drawing::lay(
                before,
                &Lay {
                    chosen: &chosen(&order, ranges),
                    pinned: &Pinned::default(),
                    ends: &Ending::default(),
                    room,
                    scene: 0,
                    written: &Written::Nothing,
                },
                false,
            )
        };
        let first = lay(&[0..PAGE_ROWS, PAGE_ROWS..2 * PAGE_ROWS], 3, None);
        assert_eq!(&*first.slots, [0, 1]);
        // Page 1 stops drawing and page 4 starts. With room for three pages, page 1 stays resident.
        let next = lay(&[0..PAGE_ROWS, 4 * PAGE_ROWS..5 * PAGE_ROWS], 3, Some(&first));
        assert_eq!((&*next.slots, next.items), (&[0, 1, 4][..], 2 * PAGE_ROWS), "page 1 is idle: resident, not drawn");
        // Drawn again, page 1 draws from its old slot, so no slot takes a page of other rows.
        let back = lay(&[0..PAGE_ROWS, PAGE_ROWS..2 * PAGE_ROWS], 3, Some(&next));
        assert_eq!(&*back.slots, [0, 1, 4]);
        assert_eq!(crate::view::transition::bound(Some(&next), &back), Vec::<u32>::new());
        // With room for two, the most recently needed idle page stays.
        let tight = lay(std::slice::from_ref(&(6 * PAGE_ROWS..7 * PAGE_ROWS)), 2, Some(&back));
        assert_eq!(&*tight.slots, [6, 1]);
        // In another scene, idle pages are released.
        let ranges = [0..PAGE_ROWS, 4 * PAGE_ROWS..5 * PAGE_ROWS];
        let changed = Lay {
            chosen: &chosen(&order, &ranges),
            pinned: &Pinned::default(),
            ends: &Ending::default(),
            room: 3,
            scene: 1,
            written: &Written::Nothing,
        };
        let changed = Drawing::lay(Some(&back), &changed, false);
        assert_eq!((&*changed.slots, &*changed.idle), (&[0, wgsl::NONE, 4][..], &[][..]));
        // A row written in an idle page releases that page and no other.
        let mut pages = vec![false; 8];
        pages[4] = true;
        let written = Lay {
            chosen: &chosen(&order, std::slice::from_ref(&(0..PAGE_ROWS))),
            pinned: &Pinned::default(),
            ends: &Ending::default(),
            room: 3,
            scene: 0,
            written: &Written::Pages(pages),
        };
        let written = Drawing::lay(Some(&back), &written, false);
        assert_eq!((&*written.slots, &*written.idle), (&[0, 1][..], &[1][..]));
    }

    #[test]
    fn tiles_fade_in_and_out_then_settle() {
        let order = order(4 * PAGE_ROWS);
        let first = Drawing::lay(
            None,
            &Lay {
                chosen: &one(&order, 0..10),
                pinned: &Pinned::default(),
                ends: &Ending::default(),
                room: 0,
                scene: 0,
                written: &Written::Nothing,
            },
            true,
        );
        assert!(!first.fades, "a first drawing has nothing to fade from");
        let lay = Lay {
            chosen: &one(&order, PAGE_ROWS..PAGE_ROWS + 10),
            pinned: &pinned(&[3]),
            ends: &Ending::default(),
            room: 0,
            scene: 0,
            written: &Written::Nothing,
        };
        let next = Drawing::lay(Some(&first), &lay, true);
        assert!(next.fades);
        let fades: Vec<(u32, u32)> = next.runs.iter().map(|r| (r.len, r.fade)).collect();
        // Rows 0..10 fade out except pinned row 3, which draws steadily after the entering tile.
        assert_eq!(fades, [(3, wgsl::FADE_OUT), (6, wgsl::FADE_OUT), (10, wgsl::FADE_IN), (1, 0)]);
        assert_eq!(next.leaving_items, 9);
        let settled = next.settled(&lay);
        assert!(!settled.fades);
        assert_eq!(settled.runs.iter().map(|r| r.fade).collect::<Vec<_>>(), [0, 0]);
        assert_eq!(settled.items, 11);
    }

    #[test]
    fn table_order_draws_ranges_in_the_order_chosen_and_keeps_slots_as_rows_are_appended() {
        let lay = |version: Version, rows: u32, ranges: &[Range<u32>], before: Option<&Drawing>| {
            let order = Order::Table { rows, order: version };
            let lay = Lay {
                chosen: &chosen(&order, ranges),
                pinned: &Pinned::default(),
                ends: &Ending::default(),
                room: 0,
                scene: 0,
                written: &Written::Nothing,
            };
            Drawing::lay(before, &lay, true)
        };
        let version = Version::next();
        // A coarse tile's rows on page 1 draw first, under a finer tile's rows on page 0.
        let first = lay(version, PAGE_ROWS + 50, &[PAGE_ROWS..PAGE_ROWS + 50, 0..10], None);
        assert_eq!(&*first.slots, [0, 1]);
        assert_eq!((first.item_of(PAGE_ROWS), first.item_of(0)), (Some(0), Some(50)));
        // A tile arriving appends its rows, which fade in; every page keeps its slot.
        let ranges = [PAGE_ROWS..PAGE_ROWS + 50, 0..10, PAGE_ROWS + 50..PAGE_ROWS + 80];
        let appended = lay(version, PAGE_ROWS + 80, &ranges, Some(&first));
        assert_eq!(&*appended.slots, [0, 1]);
        assert!(appended.fades && appended.leaving.is_empty());
        assert_eq!(appended.items, 90);
        // Removing rows makes another order: nothing carries over, and nothing fades.
        let removed = lay(Version::next(), 30, std::slice::from_ref(&(0..30)), Some(&appended));
        assert!(!removed.fades);
        assert_eq!((&*removed.slots, removed.items), (&[0][..], 30));
    }

    #[test]
    fn sparse_endpoints_are_kept_individually() {
        let order = order(4 * PAGE_ROWS);
        // Many endpoints lie in page 3 and two in page 2: page 3 is resident whole, the two rows
        // are kept individually, and none draws.
        let ends = Ending::new(vec![3], vec![2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], Vec::new());
        let lay = Lay {
            chosen: &one(&order, 0..10),
            pinned: &Pinned::default(),
            ends: &ends,
            room: 0,
            scene: 0,
            written: &Written::Nothing,
        };
        let drawing = Drawing::lay(None, &lay, false);
        assert_eq!(&*drawing.slots, [0, 3, KEPT], "the drawn page, the endpoint page, and a page of kept rows");
        assert_eq!(drawing.items, 10, "rows resident only for endpoints are not drawn");
        assert_eq!(drawing.held_of(2 * PAGE_ROWS + 9), Some(2 * PAGE_ROWS + 1));
        assert_eq!(drawing.held_of(2 * PAGE_ROWS + 6), None, "rows no endpoint references are not resident");
        // Another endpoint is added: the rows kept before keep their positions.
        let more = Ending::new(vec![3], vec![PAGE_ROWS, 2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], Vec::new());
        let next = Drawing::lay(Some(&drawing), &Lay { ends: &more, ..lay }, false);
        assert_eq!(next.held_of(2 * PAGE_ROWS + 9), Some(2 * PAGE_ROWS + 1));
        assert_eq!(next.held_of(PAGE_ROWS), Some(2 * PAGE_ROWS + 2));
        assert_eq!(next.moved, drawing.moved, "no endpoint moved");
        // Appending rows to the order changes no kept-row input, so the kept rows stay unchanged.
        let Order::Pyramid { pyramid, .. } = &order else { unreachable!("a pyramid") };
        let grown = Order::Pyramid { pyramid: pyramid.clone(), rows: 4 * PAGE_ROWS + 1 };
        let appended = Drawing::lay(Some(&next), &Lay { chosen: &one(&grown, 0..10), ends: &more, ..lay }, false);
        assert!(Arc::ptr_eq(&appended.kept, &next.kept), "the kept rows are unchanged");
        assert_eq!((&appended.kept_table, &appended.moved), (&next.kept_table, &next.moved));
        // Page 2 is drawn: its individually kept rows move into it, and the edges ending there
        // resolve their endpoints again. The kept row of page 1 stays put.
        let drawn = Lay { chosen: &chosen(&order, &[0..10, 2 * PAGE_ROWS..2 * PAGE_ROWS + 10]), ends: &more, ..lay };
        let paged = Drawing::lay(Some(&next), &drawn, false);
        assert_eq!(paged.held_of(2 * PAGE_ROWS + 9), Some(paged.pages[2] * PAGE_ROWS + 9));
        assert_eq!(paged.held_of(PAGE_ROWS), next.held_of(PAGE_ROWS));
        assert_ne!(paged.moved.0, next.moved.0);
        assert_eq!(&*paged.moved.1, [2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], "page 2's kept rows are listed as moved");
    }

    #[test]
    fn edge_pages_ending_at_moved_rows_resolve_their_endpoints_again() {
        let order = order(3 * PAGE_ROWS);
        let whole = one(&order, 0..3 * PAGE_ROWS);
        let lay = Lay {
            chosen: &whole,
            pinned: &Pinned::default(),
            ends: &Ending::default(),
            room: 0,
            scene: 0,
            written: &Written::Nothing,
        };
        let edges = Drawing::lay(None, &lay, false);
        let at = |places: &[u32]| Some((PAGE_ROWS, Arc::new(Places { places: places.to_vec(), runs: Vec::new() })));
        let pages = vec![at(&[3, 9]), at(&[PAGE_ROWS + 1]), at(&[7, 2 * PAGE_ROWS])];
        let drawn = Drawn { ends: Ends { pages, ..Ends::default() }, ..Drawn::default() };
        assert_eq!(drawn.naming(&edges, &[9]), [0], "the page of edges ending at place 9");
        assert_eq!(drawn.naming(&edges, &[7, PAGE_ROWS + 1]), [1, 2]);
        assert!(drawn.naming(&edges, &[5]).is_empty(), "no resident edge ends at place 5");
    }

    #[test]
    fn kept_rows_fill_pages_of_their_own_and_endpoint_pages_are_resident() {
        let order = order(4 * PAGE_ROWS);
        let lay = Lay {
            chosen: &one(&order, 0..10),
            pinned: &pinned(&[2 * PAGE_ROWS + 1]),
            ends: &Ending::new(vec![3], Vec::new(), Vec::new()),
            room: 0,
            scene: 0,
            written: &Written::Nothing,
        };
        let drawing = Drawing::lay(None, &lay, false);
        assert_eq!(&*drawing.slots, [0, 3, KEPT], "the drawn page, the endpoint page, and a page of kept rows");
        assert_eq!(drawing.items, 11, "endpoint pages are resident, not drawn");
        let held = drawing.held_of(2 * PAGE_ROWS + 1).expect("kept");
        assert_eq!((held, drawing.source(held)), (2 * PAGE_ROWS, Some(2 * PAGE_ROWS + 1)));
        assert_eq!(drawing.held_pages().collect::<Vec<_>>(), [0, 3]);
        // Another pinned row takes the next kept position; the first keeps its own.
        let more = Lay { pinned: &pinned(&[PAGE_ROWS + 7, 2 * PAGE_ROWS + 1]), ..lay };
        let next = Drawing::lay(Some(&drawing), &more, false);
        assert_eq!(
            (next.held_of(2 * PAGE_ROWS + 1), next.held_of(PAGE_ROWS + 7)),
            (Some(2 * PAGE_ROWS), Some(2 * PAGE_ROWS + 1))
        );
        assert_eq!(crate::view::transition::bound(Some(&drawing), &next), [2], "only the kept-row slot changed");
        // A kept row whose page starts drawing draws from that page.
        let drawn = Lay { chosen: &chosen(&order, &[0..10, 2 * PAGE_ROWS..2 * PAGE_ROWS + 10]), ..more };
        let paged = Drawing::lay(Some(&next), &drawn, false);
        assert_eq!(paged.held_of(2 * PAGE_ROWS + 1), Some(paged.pages[2] * PAGE_ROWS + 1));
        assert_eq!(paged.held_of(PAGE_ROWS + 7), Some(2 * PAGE_ROWS + 1), "the other kept row stays put");
    }
}
