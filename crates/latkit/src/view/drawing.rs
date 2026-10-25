//! Drawings: what a view draws of each table drawn in part. The marks drawing a table hold pages of
//! its order, each in a slot of rows of their own, and draw runs of those held rows: the tiles the
//! camera asks for, finest first; the rows kept whatever their tiles, selected or framed by a fit;
//! and while tiles fade, those leaving. A page keeps its slot while it is held, so its rows keep their
//! words as the camera moves; a page no longer drawn stays held while the plan leaves room, so
//! drawing it again costs nothing, and a page held again costs only its words evaluated again. The
//! vertices the edges held end at are held with them, so an edge always finds its ends: a page where
//! many of them lie whole, the rest a row at a time, so edges whose ends lie far apart hold as many
//! rows as they end at, not as many pages. Rows kept whose pages it does not hold are held in pages of
//! kept rows, each in its place there while kept.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::FxHashSet;

use super::View;
use super::kept::KeptTable;
use crate::data::{Field, Name, Reference, UNWIRED, Version};
use crate::derive::order::Order;
use crate::derive::stamp_of;
use crate::derive::tiled::{Chosen, Draw, Place};
use crate::gpu::shaders as wgsl;
use crate::gpu::shaders::PAGE_ROWS;

/// What marks a slot holding a page of kept rows, beside the page's number.
const KEPT: u32 = 1 << 31;

/// Ends of the edges held lying in a page of the order of the table they end at, from which the page
/// is held whole; fewer are held a row at a time. Ends never take more than twice the rows they name.
const DENSE: u32 = PAGE_ROWS / 2;

/// What a slot holds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Holds {
    Free,
    /// Page `k` of the order.
    Page(u32),
    /// Page `j` of the rows kept.
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

/// A run of held rows a mark draws: where it starts among the rows drawn, the held row it starts at,
/// how many, and whether its tile fades in or out (`FADE_IN`, `FADE_OUT`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Run {
    pub(crate) item: u32,
    pub(crate) held: u32,
    pub(crate) len: u32,
    pub(crate) fade: u32,
}

/// What a view draws of one table drawn in part.
#[derive(Debug)]
pub(crate) struct Drawing {
    pub(crate) order: Order,
    /// What each slot holds: a page of the order, a page of the rows kept (`KEPT` and its number), or
    /// nothing (`NONE`).
    slots: Arc<[u32]>,
    /// Each page's slot, `NONE` where it is not held: what the ends of edges find their vertices by.
    pub(crate) pages: Arc<[u32]>,
    /// The rows kept whose pages it does not hold, by their place among the rows kept: each one's
    /// place in the order, `NONE` where a place is free.
    kept: Arc<[u32]>,
    /// The rows kept by their place in the order, with their held rows: what the ends of edges find
    /// kept vertices by.
    pub(crate) kept_table: KeptTable,
    /// The rows drawn whatever their tiles, as places in the order, ascending.
    pinned: Arc<[u32]>,
    pub(crate) runs: Vec<Run>,
    /// Runs by the held row they start at, for finding where a held row draws.
    by_held: Vec<u32>,
    /// The ranges of the order drawn, steadily or fading in, and those fading out.
    ranges: Vec<Range<u32>>,
    leaving: Vec<Range<u32>>,
    /// Whether tiles fade in or out: until they have, it settles to a drawing without fades.
    pub(crate) fades: bool,
    /// Rows drawn, and of them those fading out.
    pub(crate) items: u32,
    pub(crate) leaving_items: u32,
    /// When each slot's page was last asked for, by the layout that asked: pages no longer asked for
    /// stay held while there is room, those asked for latest first.
    asked: Arc<[u64]>,
    /// How many layouts led to it.
    lays: u64,
    /// Pages it holds that it no longer draws, and what their words were made from: the scene and
    /// the table's data.
    pub(crate) idle: u32,
    pub(crate) content: u64,
    /// What it was laid out from: the order, what it draws, the rows kept, and what ends hold.
    pub(crate) laid: u64,
    /// What tells it from every other drawing: what lists of its rows are kept by.
    pub(crate) made: Version,
    /// The places the edges held or the rows drawn whatever their tiles name that the drawing before
    /// it held elsewhere, ascending: the rows naming them find their ends again. With what tells them
    /// from the moves of the drawings before, the drawing's before it while none moved.
    pub(crate) moved: (Version, Arc<[u32]>),
    /// What its rows kept were laid out from: the rows drawn whatever their tiles, what the edges held
    /// ask of it, and the pages it holds. A drawing laid out from the same keeps them where they were.
    kept_from: u64,
    /// What tells how it holds rows: see [`Drawing::layout`].
    layout: u64,
}

/// Rows drawn whatever their tiles, as places in the order, ascending, and what tells them from other
/// such rows without reading them.
#[derive(Clone, Default, Debug)]
pub(crate) struct Pinned {
    pub(crate) places: Arc<[u32]>,
    stamp: u64,
}

/// What a drawing is laid out from.
pub(crate) struct Lay<'a> {
    pub(crate) chosen: &'a Chosen,
    /// Rows drawn whatever their tiles: those selected or framed by a fit, and those the edges kept end
    /// at.
    pub(crate) pinned: &'a Pinned,
    /// What the ends of the edges held hold of it, not drawn: pages whole, and rows one at a time.
    pub(crate) ends: &'a Ending,
    /// Pages it may hold in all: those it no longer draws stay held while there is room.
    pub(crate) room: u32,
    /// What the words of the rows it holds are made from: the scene and the table's data. Pages no
    /// longer drawn stay held only while it is as it was, so none is made again unless drawn.
    pub(crate) content: u64,
}

impl Lay<'_> {
    /// The stamp of what it lays out.
    pub(crate) fn stamp(&self) -> u64 {
        let chosen = self.chosen;
        stamp_of((chosen.order.id(), chosen.order.len(), &chosen.ranges, self.pinned.stamp, self.ends.stamp, self.room))
    }
}

impl Drawing {
    /// What draws of `lay`: pages `before` holds kept in their slots, those it no longer draws while
    /// `lay` leaves room, the rows kept whose pages it does not hold (those drawn whatever their tiles,
    /// and the ends' rows held one at a time) in pages of their own, each in its place there, and with
    /// `fades` the tiles arriving since fading in and those gone fading out. A drawing of another order
    /// keeps nothing: its rows move, and a transition moves them.
    pub(crate) fn lay(before: Option<&Drawing>, lay: &Lay<'_>, fades: bool) -> Drawing {
        let order = lay.chosen.order.clone();
        let before = before.filter(|b| b.order.id() == order.id());
        let ranges = lay.chosen.ranges.clone();
        // What the drawing before settles to: its ranges drawn, those it was fading out gone.
        let was: &[Range<u32>] = before.map_or(&[], |b| &b.ranges);
        let has = |list: &[Range<u32>], r: &Range<u32>| list.iter().any(|x| x == r);
        let fading = fades && before.is_some();
        let entering: Vec<Range<u32>> =
            if fading { ranges.iter().filter(|r| !has(was, r)).cloned().collect() } else { Vec::new() };
        let leaving: Vec<Range<u32>> =
            if fading { was.iter().filter(|r| !has(&ranges, r)).cloned().collect() } else { Vec::new() };
        // Pages held: those drawn, those fading out, and those many ends lie in; while there is room
        // and their words hold, those held before and no longer asked for; and the rows kept whose
        // pages it does not hold, in pages of their own.
        let count = order.pages() as usize;
        let asked_now = asked(count, ranges.iter().chain(&leaving), &lay.ends.pages);
        let mut held = asked_now.clone();
        let idle_kept =
            before.filter(|b| b.content == lay.content).map_or(0, |b| linger(b, &asked_now, lay.room, &mut held));
        // The rows kept stay as they were while what they are laid out from does, as rows appended or
        // written leave it: every page keeps its slot, so no row the ends name moves.
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
                    // An idle page kept its slot, and when it was asked for.
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
            idle: idle_kept,
            content: lay.content,
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

    /// The drawing this one settles to once its tiles have faded: those arriving drawn steadily,
    /// those leaving gone, their pages let go.
    pub(crate) fn settled(&self, lay: &Lay<'_>) -> Drawing {
        Drawing::lay(Some(self), lay, false)
    }

    /// Lays out its runs: the tiles fading out first, under the rest; then what it draws, finest
    /// first, `entering` fading in; then the rows kept that no tile draws.
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
            // A row kept leaves no gap: it draws steadily, with the rows kept.
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

    /// Held rows: a page's rows in each slot.
    pub(crate) fn live(&self) -> u32 {
        self.slots.len() as u32 * PAGE_ROWS
    }

    /// How many slots it has, free ones among them.
    pub(crate) fn slot_count(&self) -> usize {
        self.slots.len()
    }

    /// What slot `s` holds.
    pub(crate) fn holds(&self, s: usize) -> Holds {
        Holds::of(self.slots.get(s).copied().unwrap_or(wgsl::NONE))
    }

    /// The places in the order of the rows slot `s` holds, `NONE` where a place holds none.
    pub(crate) fn places(&self, s: usize) -> Vec<u32> {
        match self.holds(s) {
            Holds::Free => Vec::new(),
            Holds::Page(k) => (k * PAGE_ROWS..((k + 1) * PAGE_ROWS).min(self.order.len())).collect(),
            Holds::Kept(_) => self.kept_places(s).to_vec(),
        }
    }

    /// The places in the order of the rows kept slot `s` holds, `NONE` where a place holds none; none
    /// for a slot holding no rows kept.
    pub(crate) fn kept_places(&self, s: usize) -> &[u32] {
        let Holds::Kept(j) = self.holds(s) else { return &[] };
        let start = ((j * PAGE_ROWS) as usize).min(self.kept.len());
        &self.kept[start..self.kept.len().min(start + PAGE_ROWS as usize)]
    }

    /// The rows of its table slot `s` holds, in their places: what a page of its columns packs from;
    /// `NONE` where a place holds no row.
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

    /// The held row of place `d` in the order, if it holds it: in its page, or among the rows kept.
    pub(crate) fn held_of(&self, d: u32) -> Option<u32> {
        let slot = *self.pages.get((d / PAGE_ROWS) as usize)?;
        if slot != wgsl::NONE {
            return Some(slot * PAGE_ROWS + d % PAGE_ROWS);
        }
        self.kept_table.held(d)
    }

    /// The held row of row `r` of its table, if it holds it.
    pub(crate) fn held_row(&self, r: u32) -> Option<u32> {
        (r < self.order.len()).then(|| self.held_of(self.order.rank(r))).flatten()
    }

    /// The row of its table held row `h` holds.
    pub(crate) fn source(&self, h: u32) -> Option<u32> {
        let d = match self.holds((h / PAGE_ROWS) as usize) {
            Holds::Free => return None,
            Holds::Page(page) => page.checked_mul(PAGE_ROWS)? + h % PAGE_ROWS,
            Holds::Kept(j) => *self.kept.get((j * PAGE_ROWS + h % PAGE_ROWS) as usize)?,
        };
        (d != wgsl::NONE && d < self.order.len()).then(|| self.order.source(d))
    }

    /// Where held row `h` draws among the rows drawn, if it does.
    pub(crate) fn item_of(&self, h: u32) -> Option<u32> {
        let i = self.by_held.partition_point(|&r| self.runs[r as usize].held <= h).checked_sub(1)?;
        let run = self.runs[self.by_held[i] as usize];
        (h < run.held + run.len).then_some(run.item + h - run.held)
    }

    /// The pages of its order it holds.
    pub(crate) fn held_pages(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.slots.len()).filter_map(|s| match self.holds(s) {
            Holds::Page(page) => Some(page),
            _ => None,
        })
    }

    /// The rows of its table it keeps drawn whatever their tiles, whose pages it does not hold.
    pub(crate) fn kept(&self) -> impl Iterator<Item = u32> + '_ {
        let paged = |d: u32| self.pages.get((d / PAGE_ROWS) as usize).is_some_and(|&slot| slot != wgsl::NONE);
        self.pinned.iter().filter(move |&&d| d < self.order.len() && !paged(d)).map(|&d| self.order.source(d))
    }

    /// What tells how it holds rows: its order, what each slot holds, and where it keeps rows. A
    /// column's pages follow it.
    pub(crate) fn layout(&self) -> u64 {
        self.layout
    }

    /// Whether slot `s` holds the same rows in `other` as in it.
    pub(crate) fn holds_alike(&self, other: &Drawing, s: usize) -> bool {
        self.slots.get(s) == other.slots.get(s)
            && (!matches!(self.holds(s), Holds::Kept(_)) || self.places(s) == other.places(s))
    }
}

/// The pages of `count` asked for: those `ranges` draw, and `ends`.
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

/// The table of the rows `kept`, by their places among the rows kept, held in the pages of rows kept
/// `kept_slots` says, laid out from the one `before` keeps: the rows whose places changed come and go,
/// and every other keeps its bucket.
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

/// The places `ends` or `pinned` name that `before` held and `now` holds elsewhere or not at all,
/// ascending: the rows naming them find their ends again. A page held in both keeps its slot, and a
/// row kept in both its place among the rows kept, so only rows of a page held in one alone move:
/// those named of a page `before` held, and those `before` kept of a page `now` holds. A row `before`
/// did not hold is named only by rows new to the edges, which find their ends as they arrive.
fn moved(before: &Drawing, now: &Drawing, ends: &Ending, pinned: &[u32]) -> Vec<u32> {
    /// Those of `places`, ascending, lying in page `p`.
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

/// Holds the pages `before` held that are no longer `asked` for while `room` leaves room, those
/// asked for latest first: how many it holds.
fn linger(before: &Drawing, asked: &[bool], room: u32, held: &mut [bool]) -> u32 {
    let wanted = asked.iter().filter(|&&a| a).count() as u32;
    let mut idle: Vec<(u64, u32)> = (0..before.slots.len())
        .filter_map(|s| match before.holds(s) {
            Holds::Page(page) if !asked.get(page as usize).copied().unwrap_or(true) => Some((before.asked[s], page)),
            _ => None,
        })
        .collect();
    idle.sort_unstable_by(|a, b| b.cmp(a));
    let kept = idle.iter().take(room.saturating_sub(wanted) as usize);
    kept.clone().for_each(|&(_, page)| held[page as usize] = true);
    kept.count() as u32
}

/// The rows of `pinned` and of `ends`, places in `order`, whose pages are not `held`, by their places
/// among the rows kept, `NONE` where a place is free: each keeps its place in `before`, and the rest
/// take the first free ones.
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

/// Slots for the pages `held` and `kept_pages` pages of rows kept, each keeping the slot it had in
/// `before`, the rest taking the first free ones: the slots, each page's slot, and each page of rows
/// kept's slot.
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

/// Of each page of an edge table's order, the places in its ends' table's order of the rows its edges
/// end at: worked out the first time it is held, kept while neither order nor the ends change. Rows
/// appended to either table move no row already placed, so a page is worked out again only once rows
/// were appended to it. A sample lifts the rows its edges end at in the sample of their table, so they
/// lie in the pages it draws first.
#[derive(Default)]
pub(crate) struct Ends {
    stamp: u64,
    /// Each page's rows when it was worked out, and the places its ends lie at.
    pages: Vec<Option<(u32, Arc<Places>)>>,
    /// What the edges held asked last, and the stamp of what it was worked out from.
    asked: (u64, Arc<Ending>),
}

/// The places a page of edges ends at, ascending, each once, and for each page of the order they lie
/// in, the run of them there: the page, and where its places start and end.
struct Places {
    places: Vec<u32>,
    runs: Vec<[u32; 3]>,
}

impl Ends {
    /// What the edges `drawing` holds ask of the table they end at by `ends`, which draws in
    /// `target`: the pages many of their ends lie in, the rest of the rows they end at, and the rows
    /// the edges kept end at; worked out again only where the pages the drawing holds or what it keeps
    /// changed. An edge page's ends count once each toward their page's, so a page whose rows the ends
    /// of many edge pages share may be held whole for fewer rows.
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
        // The rows the edges kept end at, drawn whatever their pages.
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

    /// Whether the ends of edge page `page` lie at any of `places`, ascending; so where the page was
    /// never worked out.
    fn lie_in(&self, page: u32, places: &[u32]) -> bool {
        let Some(Some((_, found))) = self.pages.get(page as usize) else { return true };
        // Each of the fewer looked for among the more.
        let (few, many) =
            if found.places.len() < places.len() { (&found.places[..], places) } else { (places, &found.places[..]) };
        few.iter().any(|d| many.binary_search(d).is_ok())
    }

    /// The places in `target` that edge page `page` of `order` ends at, by `ends`.
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

/// What the edges held ask of the table they end at, as places in its order, ascending: the pages
/// many of their ends lie in, held whole, and the rest of the rows they end at, held one at a time,
/// neither drawn; and the rows the edges kept end at, drawn whatever their pages.
#[derive(Default, Debug)]
pub(crate) struct Ending {
    pages: Vec<u32>,
    rows: Vec<u32>,
    kept: Vec<u32>,
    /// What tells the pages and rows held from others without reading them.
    stamp: u64,
}

impl Ending {
    fn new(pages: Vec<u32>, rows: Vec<u32>, kept: Vec<u32>) -> Ending {
        let stamp = stamp_of((&pages, &rows, &kept));
        Ending { pages, rows, kept, stamp }
    }

    /// What `endings` ask together.
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

/// What draws of a table drawn in part: the drawing drawn, the one replacing it once every page it
/// needs is on the GPU, when the one drawn was first drawn on the view's clock, what its edges ask of
/// the table they end at, what the edges ending at it ask of it together, and the rows it draws
/// whatever their tiles.
#[derive(Default)]
pub(crate) struct Drawn {
    pub(crate) current: Option<Arc<Drawing>>,
    pub(crate) next: Option<Arc<Drawing>>,
    pub(crate) since: f64,
    ends: Ends,
    ending: (u64, Arc<Ending>),
    pinned: Pinned,
}

impl Drawn {
    /// The drawing marks sync to: the one replacing what draws, else what draws.
    pub(crate) fn latest(&self) -> Option<&Arc<Drawing>> {
        self.next.as_ref().or(self.current.as_ref())
    }

    /// The slots of `drawing`, of this table's edges, whose rows end at any of `places` of the table
    /// they end at, ascending: each page by where its ends lie, and every page of rows kept.
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

    /// What every edge table drawn ending at it asks of it, as one; merged again only where any
    /// changed.
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

    /// The rows drawn whatever their tiles: `own`, those selected or framed, and those `ending` keeps;
    /// gathered again only where those changed.
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
    /// Lays out what draws of each table drawn in part, from what the camera chose: a drawing to
    /// replace what draws where what it is laid out from changed, or where what draws has faded in.
    /// A table no longer drawn in part draws as it is.
    pub(super) fn lay_out_drawings(&mut self) {
        let choices = std::mem::take(&mut self.choices);
        self.drawings.retain(|key, _| choices.contains_key(key));
        let fades = !self.ease().is_zero();
        let ease = self.ease().as_secs_f64();
        // Edges first: the vertices their ends name are held with them, and the rows edges kept end
        // at drawn with them.
        let mut keys: Vec<&(Name, Name)> = choices.keys().collect();
        crate::order::by_key(&mut keys, |key| {
            u64::from(!matches!(self.planning.plans().get(*key).map(|p| &p.place), Some(Place::Ends(_))))
        });
        let mut ends: crate::data::Keyed<(Name, Name), Vec<Arc<Ending>>> = crate::data::Keyed::default();
        for key in keys {
            let chosen = &choices[key];
            let endings = ends.remove(key).unwrap_or_default();
            let own = self.pinned(key, &chosen.order);
            let (content, room) = (self.content(key), self.room(key));
            let drawn = self.drawings.entry(key.clone()).or_default();
            let ending = drawn.ending(&endings);
            let pinned = drawn.pin(own, &ending);
            let lay = Lay { chosen, pinned: &pinned, ends: &ending, room, content };
            let stamp = lay.stamp();
            let current = drawn.current.clone();
            let latest = drawn.next.as_ref().or(current.as_ref());
            // Pages no longer drawn are let go once their words would be made again.
            let stale = latest.is_some_and(|d| d.idle > 0 && d.content != content);
            if latest.map(|d| d.laid) != Some(stamp) || stale {
                drawn.next = Some(Arc::new(Drawing::lay(current.as_deref(), &lay, fades)));
            } else if drawn.next.is_none()
                && let Some(current) = current.filter(|c| c.fades && self.clock.done(drawn.since, ease))
            {
                drawn.next = Some(Arc::new(current.settled(&lay)));
            }
            // The vertices the edges this drawing holds end at, held with their vertices.
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

    /// How far the tiles of each mark's table drawn in part have faded in or out this frame.
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

    /// What each table of lines or areas drawn in part draws this frame, which their shapes follow:
    /// the pages of its order the camera chose, and those holding the rows drawn whatever their tiles.
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

    /// What the words of the rows of `key`'s table are made from: the scene, and the table's data.
    fn content(&self, key: &(Name, Name)) -> u64 {
        let table = self.snapshot(&key.0).and_then(|d| d.table(&key.1));
        let data = table.map(|t| (t.structure, t.fields.iter().map(|(_, f)| f.version()).collect::<Vec<_>>()));
        stamp_of((self.scene_version, data))
    }

    /// Pages the drawing of `key`'s table may hold in all: for a table drawn through tiles, as many as
    /// the rows the plan gives it fill; else none past those it draws.
    fn room(&self, key: &(Name, Name)) -> u32 {
        match self.planning.plans().get(key).map(|p| p.draw) {
            Some(Draw::Tiles { rows }) => rows.div_ceil(PAGE_ROWS),
            _ => 0,
        }
    }

    /// The places in `order` of the rows of `key`'s table drawn whatever their tiles: those selected,
    /// and those a fit frames, ascending.
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

    /// Rows drawn whatever their tiles: `places`.
    fn pinned(places: &[u32]) -> Pinned {
        Pinned { places: places.into(), stamp: stamp_of(places) }
    }

    /// What draws one range of `order`.
    fn one(order: &Order, range: Range<u32>) -> Chosen {
        Chosen { order: order.clone(), ranges: vec![range], capped: false }
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
                content: 0,
            },
            false,
        );
        assert_eq!(&*first.slots, [0, 3]);
        assert_eq!(first.items, 2 * PAGE_ROWS);
        // Page 0 leaves, page 5 arrives: it takes the slot page 0 left, and page 3 stays where it was.
        let next = Drawing::lay(
            Some(&first),
            &Lay {
                chosen: &chosen(&order, &[3 * PAGE_ROWS..4 * PAGE_ROWS, 5 * PAGE_ROWS..6 * PAGE_ROWS]),
                pinned: &Pinned::default(),
                ends: &Ending::default(),
                room: 0,
                content: 0,
            },
            false,
        );
        assert_eq!(&*next.slots, [5, 3]);
        assert_eq!(next.held_of(3 * PAGE_ROWS + 7), Some(PAGE_ROWS + 7));
        assert_eq!(next.source(7), Some(5 * PAGE_ROWS + 7));
        assert_eq!(next.item_of(PAGE_ROWS + 7), Some(7), "page 3's rows draw first");
    }

    #[test]
    fn pages_no_longer_drawn_stay_held_while_there_is_room() {
        let order = order(8 * PAGE_ROWS);
        let lay = |ranges: &[Range<u32>], room: u32, before: Option<&Drawing>| {
            Drawing::lay(
                before,
                &Lay {
                    chosen: &chosen(&order, ranges),
                    pinned: &Pinned::default(),
                    ends: &Ending::default(),
                    room,
                    content: 0,
                },
                false,
            )
        };
        let first = lay(&[0..PAGE_ROWS, PAGE_ROWS..2 * PAGE_ROWS], 3, None);
        assert_eq!(&*first.slots, [0, 1]);
        // Page 1 is no longer drawn and page 4 is: with room for three pages, page 1 stays held.
        let next = lay(&[0..PAGE_ROWS, 4 * PAGE_ROWS..5 * PAGE_ROWS], 3, Some(&first));
        assert_eq!((&*next.slots, next.items), (&[0, 1, 4][..], 2 * PAGE_ROWS), "page 1 held, not drawn");
        // Drawn again, it draws from its slot: no slot takes a page of other rows.
        let back = lay(&[0..PAGE_ROWS, PAGE_ROWS..2 * PAGE_ROWS], 3, Some(&next));
        assert_eq!(&*back.slots, [0, 1, 4]);
        assert_eq!(crate::view::transition::bound(Some(&next), &back), Vec::<u32>::new());
        // With room for two, of the pages no longer drawn the one asked for latest stays.
        let tight = lay(std::slice::from_ref(&(6 * PAGE_ROWS..7 * PAGE_ROWS)), 2, Some(&back));
        assert_eq!(&*tight.slots, [6, 1]);
        // Their words made from other data or another scene, pages no longer drawn are let go.
        let ranges = [0..PAGE_ROWS, 4 * PAGE_ROWS..5 * PAGE_ROWS];
        let changed = Lay {
            chosen: &chosen(&order, &ranges),
            pinned: &Pinned::default(),
            ends: &Ending::default(),
            room: 3,
            content: 1,
        };
        let changed = Drawing::lay(Some(&back), &changed, false);
        assert_eq!((&*changed.slots, changed.idle), (&[0, wgsl::NONE, 4][..], 0));
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
                content: 0,
            },
            true,
        );
        assert!(!first.fades, "a first drawing has nothing to fade from");
        let lay = Lay {
            chosen: &one(&order, PAGE_ROWS..PAGE_ROWS + 10),
            pinned: &pinned(&[3]),
            ends: &Ending::default(),
            room: 0,
            content: 0,
        };
        let next = Drawing::lay(Some(&first), &lay, true);
        assert!(next.fades);
        let fades: Vec<(u32, u32)> = next.runs.iter().map(|r| (r.len, r.fade)).collect();
        // Rows 0..10 fade out but row 3, kept, which draws steadily after the tile arriving.
        assert_eq!(fades, [(3, wgsl::FADE_OUT), (6, wgsl::FADE_OUT), (10, wgsl::FADE_IN), (1, 0)]);
        assert_eq!(next.leaving_items, 9);
        let settled = next.settled(&lay);
        assert!(!settled.fades);
        assert_eq!(settled.runs.iter().map(|r| r.fade).collect::<Vec<_>>(), [0, 0]);
        assert_eq!(settled.items, 11);
    }

    #[test]
    fn ends_lying_sparse_are_held_a_row_at_a_time() {
        let order = order(4 * PAGE_ROWS);
        // Many ends lie in page 3, two in page 2: page 3 is held whole, the two rows one at a time,
        // and none draws.
        let ends = Ending::new(vec![3], vec![2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], Vec::new());
        let lay = Lay { chosen: &one(&order, 0..10), pinned: &Pinned::default(), ends: &ends, room: 0, content: 0 };
        let drawing = Drawing::lay(None, &lay, false);
        assert_eq!(&*drawing.slots, [0, 3, KEPT], "the page drawn, the ends' page, and a page of the ends' rows");
        assert_eq!(drawing.items, 10, "what ends hold is not drawn");
        assert_eq!(drawing.held_of(2 * PAGE_ROWS + 9), Some(2 * PAGE_ROWS + 1));
        assert_eq!(drawing.held_of(2 * PAGE_ROWS + 6), None, "rows no end names are not held");
        // Another end held: the rows held before keep their places.
        let more = Ending::new(vec![3], vec![PAGE_ROWS, 2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], Vec::new());
        let next = Drawing::lay(Some(&drawing), &Lay { ends: &more, ..lay }, false);
        assert_eq!(next.held_of(2 * PAGE_ROWS + 9), Some(2 * PAGE_ROWS + 1));
        assert_eq!(next.held_of(PAGE_ROWS), Some(2 * PAGE_ROWS + 2));
        assert_eq!(next.moved, drawing.moved, "no row ends name moved");
        // Rows appended to the order leave what the rows kept are laid out from: they stay as they were.
        let Order::Pyramid { pyramid, .. } = &order else { unreachable!("a pyramid") };
        let grown = Order::Pyramid { pyramid: pyramid.clone(), rows: 4 * PAGE_ROWS + 1 };
        let appended = Drawing::lay(Some(&next), &Lay { chosen: &one(&grown, 0..10), ends: &more, ..lay }, false);
        assert!(Arc::ptr_eq(&appended.kept, &next.kept), "the rows kept as they were");
        assert_eq!((&appended.kept_table, &appended.moved), (&next.kept_table, &next.moved));
        // Page 2 drawn: the rows of it held one at a time move into it, and the edges ending there find
        // them again; the row kept of page 1 stays where it was.
        let drawn = Lay { chosen: &chosen(&order, &[0..10, 2 * PAGE_ROWS..2 * PAGE_ROWS + 10]), ends: &more, ..lay };
        let paged = Drawing::lay(Some(&next), &drawn, false);
        assert_eq!(paged.held_of(2 * PAGE_ROWS + 9), Some(paged.pages[2] * PAGE_ROWS + 9));
        assert_eq!(paged.held_of(PAGE_ROWS), next.held_of(PAGE_ROWS));
        assert_ne!(paged.moved.0, next.moved.0);
        assert_eq!(&*paged.moved.1, [2 * PAGE_ROWS + 5, 2 * PAGE_ROWS + 9], "the rows of page 2 named moved");
    }

    #[test]
    fn edges_find_their_ends_again_where_their_pages_name_what_moved() {
        let order = order(3 * PAGE_ROWS);
        let whole = one(&order, 0..3 * PAGE_ROWS);
        let lay = Lay { chosen: &whole, pinned: &Pinned::default(), ends: &Ending::default(), room: 0, content: 0 };
        let edges = Drawing::lay(None, &lay, false);
        let at = |places: &[u32]| Some((PAGE_ROWS, Arc::new(Places { places: places.to_vec(), runs: Vec::new() })));
        let pages = vec![at(&[3, 9]), at(&[PAGE_ROWS + 1]), at(&[7, 2 * PAGE_ROWS])];
        let drawn = Drawn { ends: Ends { pages, ..Ends::default() }, ..Drawn::default() };
        assert_eq!(drawn.naming(&edges, &[9]), [0], "the page of edges ending there");
        assert_eq!(drawn.naming(&edges, &[7, PAGE_ROWS + 1]), [1, 2]);
        assert!(drawn.naming(&edges, &[5]).is_empty(), "no edge held ends there");
    }

    #[test]
    fn rows_kept_lie_in_pages_of_their_own_and_ends_hold_their_pages() {
        let order = order(4 * PAGE_ROWS);
        let lay = Lay {
            chosen: &one(&order, 0..10),
            pinned: &pinned(&[2 * PAGE_ROWS + 1]),
            ends: &Ending::new(vec![3], Vec::new(), Vec::new()),
            room: 0,
            content: 0,
        };
        let drawing = Drawing::lay(None, &lay, false);
        assert_eq!(&*drawing.slots, [0, 3, KEPT], "the page drawn, the ends', and a page of the row kept");
        assert_eq!(drawing.items, 11, "ends' pages are held, not drawn");
        let held = drawing.held_of(2 * PAGE_ROWS + 1).expect("kept");
        assert_eq!((held, drawing.source(held)), (2 * PAGE_ROWS, Some(2 * PAGE_ROWS + 1)));
        assert_eq!(drawing.held_pages().collect::<Vec<_>>(), [0, 3]);
        // Another row kept takes the next place among them; the first keeps its own.
        let more = Lay { pinned: &pinned(&[PAGE_ROWS + 7, 2 * PAGE_ROWS + 1]), ..lay };
        let next = Drawing::lay(Some(&drawing), &more, false);
        assert_eq!(
            (next.held_of(2 * PAGE_ROWS + 1), next.held_of(PAGE_ROWS + 7)),
            (Some(2 * PAGE_ROWS), Some(2 * PAGE_ROWS + 1))
        );
        assert_eq!(crate::view::transition::bound(Some(&drawing), &next), [2], "only the page of rows kept");
        // A row kept whose page comes to be drawn draws from its page.
        let drawn = Lay { chosen: &chosen(&order, &[0..10, 2 * PAGE_ROWS..2 * PAGE_ROWS + 10]), ..more };
        let paged = Drawing::lay(Some(&next), &drawn, false);
        assert_eq!(paged.held_of(2 * PAGE_ROWS + 1), Some(paged.pages[2] * PAGE_ROWS + 1));
        assert_eq!(paged.held_of(PAGE_ROWS + 7), Some(2 * PAGE_ROWS + 1), "the other kept where it was");
    }
}
