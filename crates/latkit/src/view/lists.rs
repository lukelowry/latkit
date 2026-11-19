//! Lists on the GPU: each item counts its entries, a scan turns the counts into start offsets,
//! and inverse lookup assigns each entry to its item. Draws reserve an upper bound and reject the
//! unused tail before reading geometry, so they never wait for a count to reach the CPU.
//!
//! After the segment lists lie the drawn-row words of each mark drawing a paged table: the held
//! row of each row drawn, expanded from the drawing's runs when they change, so every pass reads a
//! drawn row in one word.
//!
//! Last come the height orders of marks whose rows stand at different heights, where depth varies.
//! Each sorts its instances lowest first on the GPU (`raster/order.wesl`): at once when the
//! instances change, and in the background, a few passes a frame, when only their heights do, so
//! heights that stream in cost each frame a bounded share. Height does not depend on the camera, so
//! moving the camera sorts nothing.

use super::View;
use std::sync::Arc;

use super::marks::{Holding, Shown};
use super::passes::offset;
use super::variants::MarkVariants;
use crate::data::{Field, RowIds, Version};
use crate::derive::{Derived, stamp_of};
use crate::expr::compile::{Deps, Program, Reads};
use crate::gpu::Inner;
use crate::gpu::listing::Background;
use crate::gpu::order::PASSES;
use crate::gpu::pipelines::Projection;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, HEIGHT_BITS, RADIX_BITS};
use crate::scene::mark::MarkKind;
use crate::{Mark, Space};

/// A listed mark's segment list (see `Shown::listed`), used when its rows have different numbers
/// of segments, or for areas, of triangles: where it lies, a stamp of its last build's inputs (the
/// list, the paths, and for great circles where the vertices are drawn), a stamp of what its
/// distances along were last measured from, and its count. Each entry is a segment's row and the
/// distance along its path to the segment's end, or an area's row and prepared corner address, so
/// a row's last entry holds its path's whole length. Distances along are in
/// position units for comets spaced in them, and otherwise in CSS pixels on screen, measured again
/// as the projection changes. A curved mark's count is read back, one readback at a time, and its
/// list grows to fit what was found.
#[derive(Default)]
pub(crate) struct Segments {
    pub(crate) list: Option<List>,
    pub(crate) built: u64,
    measured: u64,
    pub(crate) found: Derived<u32>,
}

/// Source-position dependencies of a vertex mark. Appending vertices does not move existing
/// endpoints. Reference columns independently invalidate edges newly connected to those vertices.
#[derive(Default)]
pub(crate) struct Shape {
    seen: Option<(bool, u64)>,
    version: Option<Version>,
    inputs: Option<ShapeInputs>,
}

struct ShapeInputs {
    program: Arc<Program>,
    holding: Holding,
    columns: u64,
}

impl ShapeInputs {
    fn of(shown: &Shown) -> Option<Self> {
        if shown.transition.is_some() || shown.begin.is_some() || shown.exits != 0 || !shown.drawable() {
            return None;
        }
        let holding = shown.holding.as_ref()?;
        if holding.drawing.is_some() {
            return None;
        }
        let program = &shown.compiled.as_ref()?.program;
        let mut columns = 0;
        for channel in program.channels.iter().filter(|c| matches!(c.name.as_str(), "position" | "elevation")) {
            // Joins, fitted domains, samples, transitions, and view expressions stay conservative.
            if channel.reads.deps != Deps::default() && channel.reads.deps != Deps::DATA {
                return None;
            }
            columns |= channel.reads.columns;
        }
        if program.columns.iter().enumerate().any(|(i, column)| {
            columns & Reads::column(i) != 0 && (column.from.is_some() || column.derived || column.sampled)
        }) {
            return None;
        }
        Some(Self { program: program.clone(), holding: holding.clone(), columns })
    }

    /// The old vertices keep both their identities and every input that places them. Immutable
    /// pages and their bounded write history prove this without comparing or evaluating values.
    fn keeps(&self, before: &Self) -> bool {
        let (old, new) = (&before.holding.table, &self.holding.table);
        if !Arc::ptr_eq(&self.program, &before.program)
            || self.holding.origin != before.holding.origin
            || old.order != new.order
            || new.len() < old.len()
        {
            return false;
        }
        let ids = match (&old.ids, &new.ids) {
            (RowIds::Count(a), RowIds::Count(b)) => b >= a,
            (RowIds::Listed(a), RowIds::Listed(b)) => b.kept_below(a, old.len()),
            _ => false,
        };
        ids && self.program.columns.iter().enumerate().all(|(i, column)| {
            if self.columns & Reads::column(i) == 0 {
                return true;
            }
            match (old.field_named(&column.name), new.field_named(&column.name)) {
                (Some(Field::Values(a, _)), Some(Field::Values(b, _))) => b.kept_below(a, old.len()),
                // References and other field kinds can change their interpretation outside this
                // table, so the general revision remains their dependency.
                _ => false,
            }
        })
    }
}

/// Words per instance: its row, and its path distance or prepared triangle address.
const SEGMENT_WORDS: u32 = 2;

/// A flowing mark's comet slots (see `raster/comets.wesl`): where they lie, a stamp of what the
/// records they were counted from hold, and how many its segments last counted. The count is read
/// back so the list grows to fit, when the view or the list changed (`seen`), not as data streams.
/// Each entry is a segment's record and which of its comets the slot draws.
#[derive(Default)]
pub(crate) struct CometSlots {
    pub(crate) list: Option<List>,
    built: u64,
    seen: u64,
    pub(crate) found: Derived<u32>,
}

impl CometSlots {
    /// The slots the comets draw draws: as many as the segments last counted, once read back, else
    /// every slot the list keeps. A slot past those counted draws nothing.
    pub(crate) fn drawn(&self) -> u32 {
        let Some(list) = self.list else { return 0 };
        if self.built != 0 && self.found.stamp() == self.built { list.kept.min(self.found.value) } else { list.kept }
    }
}

/// Words per comet slot: its segment's record, and which comet.
const SLOT_WORDS: u32 = 2;

/// Where a paged mark's drawn-row words lie in the lists buffer, `[start, room]` in words, and the
/// stamp of their last expansion's inputs: the drawing, their location, and the buffer.
#[derive(Default)]
pub(crate) struct DrawnRows {
    pub(crate) at: Option<[u32; 2]>,
    expanded: u64,
}

/// A mark's height order: its list, whose entries are the instance drawn at each position
/// (`ORDER_WORDS` per instance), and how many instances its last sort covered: those draws cover,
/// not the spare room of the lists they come from. It sorts at once when its instances change.
/// When only their heights change, it sorts again in the background (see [`Sort`]).
#[derive(Default)]
pub(crate) struct HeightOrder {
    pub(crate) list: Option<List>,
    count: u32,
    /// Stamps of what its instances are and of where they stand.
    instances: u64,
    heights: u64,
    /// Whether heights changed since its last sort began.
    stale: bool,
    /// Frames since its heights last changed, `None` before they ever did.
    since_change: Option<u32>,
}

impl HeightOrder {
    /// Whether heights changed since the last sort began, which a coming frame sorts.
    pub(super) fn stale(&self) -> bool {
        self.stale
    }
}

/// Records a background sort may pass over a frame: about three milliseconds on a laptop's GPU. A
/// sort takes [`SORT_PASSES`] passes over its instances, at least one a frame, so a sort of 160,000
/// raised rows lands within about 32 frames, and one of a few thousand within its frame.
const SORT_RECORDS: u32 = 1 << 17;

/// Frames without a height change after which heights count as at rest: a change then sorts at
/// once, and a background sort under way finishes. Heights fed at half the frame rate keep sorting
/// in the background.
const RESTED: u32 = 4;

/// Passes a height sort takes: keying the instances, each digit's passes, and writing the order.
const SORT_PASSES: u32 = 2 + HEIGHT_BITS.div_ceil(RADIX_BITS) * PASSES;

/// A height order sorting in the background, a few passes a frame, while only heights change. Its
/// mark keeps drawing its last order until this one lands. A view sorts one at a time: the mark,
/// what its instances were when the sort began, and the passes left.
pub(crate) struct Sort {
    mark: usize,
    key: crate::scene::mark::Key,
    instances: u64,
    count: u32,
    left: u32,
}

/// This frame's part of a background sort: its mark, the passes it runs, and whether its order
/// lands.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SortStep {
    pub(crate) mark: usize,
    passes: u32,
    pub(crate) lands: bool,
}

/// Words a height order keeps per instance: the instance and its key, on each of two sides.
const ORDER_WORDS: u32 = 1;

/// Where a list lies in the lists buffer, in words.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct List {
    pub(crate) header: u32,
    pub(crate) items: u32,
    pub(crate) entries: u32,
    /// The most entries it keeps, and words per entry.
    pub(crate) kept: u32,
    pub(crate) stride: u32,
    pub(crate) counts: u32,
}

impl List {
    /// A list of `items` items keeping `kept` entries of `stride` words: its header and entries at
    /// `front`, its block sums and counts at `back`.
    pub(crate) fn at(front: u32, back: u32, items: u32, kept: u32, stride: u32) -> List {
        let counts = back;
        List { header: front, items, entries: front + wgsl::LIST_HEADER, kept, stride, counts }
    }

    /// Words its header and entries take.
    pub(crate) fn front_words(kept: u32, stride: u32) -> u32 {
        (wgsl::LIST_HEADER + kept * stride).next_multiple_of(4)
    }

    /// Words its sums and counts take.
    pub(crate) fn back_words(items: u32) -> u32 {
        (items + 1).next_multiple_of(4)
    }

    /// Where the scan writes the list's total, before it is capped at `kept`.
    pub(crate) fn total(&self) -> u32 {
        self.counts + self.items
    }

    /// The header's item count, prefix offsets, entries, and reserved capacity.
    pub(crate) fn header_words(&self) -> [u32; wgsl::LIST_HEADER as usize] {
        [self.items, self.counts, self.entries, self.kept]
    }
}

impl View {
    /// Builds only invalidated lists, and measures again the distances along of the segment lists of
    /// `lengths`. Every intermediate stays on the GPU, and persistent lists are updated by ordered
    /// copies from shared scratch, avoiding sampled/attached aliases.
    pub(super) fn record_lists(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        expanded: &[usize],
        [segments, lengths]: [&[usize]; 2],
        (ordered, sorting): (&[usize], Option<SortStep>),
    ) {
        if expanded.is_empty() && segments.is_empty() && lengths.is_empty() && ordered.is_empty() && sorting.is_none() {
            return;
        }
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let resources = self.resources.as_mut().expect("frame resources");
        let groups = resources.groups(&gpu.0, inner);
        for &i in segments.iter().chain(ordered) {
            let shown = &self.marks[i];
            for list in [shown.segments.list, shown.height_order.list].into_iter().flatten() {
                resources.lists().write(queue, list.header, &list.header_words());
            }
        }
        let input = |i: usize| crate::gpu::listing::Inputs {
            pages: inner.arena.words(),
            lists: resources.lists(),
            view: &groups.view,
            mark: &groups.mark,
            offset: offset(i),
            path: self.marks[i].path(),
            projection: Projection::of(&self.scene.space),
            measured: self.marks[i].measures_paths(),
        };
        let mut raster = crate::gpu::raster::Raster { device, queue, pipelines: &mut inner.pipelines, encoder };
        for &i in expanded {
            let shown = &self.marks[i];
            inner.listing.expand(
                &mut raster,
                &input(i),
                shown.rows + shown.exits,
                shown.drawn_rows.at.expect("drawn rows")[0],
            );
        }
        for &i in segments {
            let shown = &self.marks[i];
            let list = shown.segments.list.expect("segment list");
            inner.listing.segments(
                &mut raster,
                &input(i),
                crate::gpu::listing::Segments {
                    items: list.items,
                    kept: list.kept,
                    counts: list.counts,
                    destination: list.entries,
                    areas: shown.kind() == MarkKind::Areas,
                },
            );
        }
        for &i in lengths {
            let list = self.marks[i].segments.list.expect("segment list");
            inner.listing.measure(&mut raster, &input(i), list.kept, list.entries);
        }
        for &i in ordered {
            let order = &self.marks[i].height_order;
            let list = order.list.expect("height order");
            inner.listing.order(&mut raster, &input(i), (order.count, list.kept), list.entries);
        }
        // The background sort keys its instances, runs its digits' passes, then writes its order.
        if let (Some(step), Some(sort)) = (sorting, self.sort.as_mut()) {
            let list = self.marks[step.mark].height_order.list.expect("height order");
            let background = self.background.get_or_insert_with(|| Background::new(device, queue.retired()));
            for _ in 0..step.passes {
                match SORT_PASSES - sort.left {
                    0 => background.begin(&mut raster, &input(step.mark), (sort.count, list.kept)),
                    done if done < SORT_PASSES - 1 => background.advance(&mut raster, 1),
                    _ => background.land(&mut raster, &input(step.mark), sort.count, list.entries),
                }
                sort.left -= 1;
            }
            if sort.left == 0 {
                self.sort = None;
            }
        }
    }

    /// Lays out the lists buffer: every listed mark's segment list at the front, using counts read
    /// back, then each paged mark's drawn-row words, then in `sorted` frames the height order of
    /// each mark whose rows stand at different heights. A list smaller than its rows need grows,
    /// with a quarter to spare.
    pub(super) fn lay_out_lists_buffer(&mut self, sorted: bool) {
        let mut at = 0;
        for shown in &mut self.marks {
            if let Some((stamp, bytes)) = shown.segments.found.landed() {
                let found = crate::wire::In::new(&bytes).u32().unwrap_or(0);
                shown.segments.found.make(stamp, found);
            }
            shown.follow_lanes(&self.derived);
            if !shown.listed() {
                shown.segments.list = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let kept = shown.segment_capacity();
            let list = match shown.segments.list {
                Some(list) if list.header == at && list.items == items && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    List::at(at, at + List::front_words(kept, SEGMENT_WORDS), items, kept, SEGMENT_WORDS)
                }
            };
            at += List::front_words(list.kept, SEGMENT_WORDS) + List::back_words(items);
            shown.segments.list = Some(list);
        }
        // Then one word per row each paged mark draws, rows that left included.
        for shown in &mut self.marks {
            if shown.drawing().is_none() {
                shown.drawn_rows.at = None;
                continue;
            }
            let items = shown.rows + shown.exits;
            let region = match shown.drawn_rows.at {
                Some([start, room]) if start == at && room >= items => [start, room],
                _ => [at, (items + items / 4).next_multiple_of(4)],
            };
            at += region[1];
            shown.drawn_rows.at = Some(region);
        }
        // Then a height order for each mark whose rows stand at different heights, with room for
        // every instance it may draw.
        let ordered: Vec<bool> = (0..self.marks.len()).map(|i| sorted && self.heights_vary(i)).collect();
        for (shown, ordered) in self.marks.iter_mut().zip(ordered) {
            if !ordered {
                shown.height_order.list = None;
                continue;
            }
            let kept = shown.instances().max(1);
            let list = match shown.height_order.list {
                Some(list) if list.header == at && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    let items = 0;
                    List::at(at, at + List::front_words(kept, ORDER_WORDS), items, kept, ORDER_WORDS)
                }
            };
            at += List::front_words(list.kept, ORDER_WORDS) + List::back_words(list.items);
            shown.height_order.list = Some(list);
        }
        // Then the comet slots of each flowing mark whose segments have records: at first two for
        // each segment, and then what its segments counted, with a quarter to spare.
        for shown in &mut self.marks {
            if let Some((stamp, bytes)) = shown.comets.found.landed() {
                let found = crate::wire::In::new(&bytes).u32().unwrap_or(0);
                shown.comets.found.make(stamp, found);
            }
            let recorded = MarkVariants::shown(shown, &self.scene.space).screen().is_some();
            if !(recorded && shown.mark.flows() && shown.drawable()) {
                shown.comets.list = None;
                continue;
            }
            let items = shown.counted_instances(shown.instances());
            let found = shown.comets.found.value;
            let kept = (2 * items).max(found).max(4);
            let list = match shown.comets.list {
                Some(list) if list.header == at && list.items == items && list.kept >= kept => list,
                _ => {
                    let kept = kept + kept / 4;
                    List::at(at, at + List::front_words(kept, SLOT_WORDS), items, kept, SLOT_WORDS)
                }
            };
            at += List::front_words(list.kept, SLOT_WORDS) + List::back_words(items);
            shown.comets.list = Some(list);
        }
        self.list_words = at;
    }

    /// The comet slots this frame counts again (see `raster/comets.wesl`): those of each mark
    /// `drawn` whose comets show, where its records may hold other than when they were counted. Its
    /// list moved, its records (`firsts`) start elsewhere, the view draws other than it did (its
    /// camera, size, or theme, `view`), or the mark, or a mark whose rows it reads, draws other than it
    /// did (see `View::changed_marks`). A frame where comets only travel counts none. Each comes
    /// with where its records start, and whether its count is read back: when anything but the
    /// marks' drawing changed.
    pub(super) fn comet_slots_due(
        &mut self,
        drawn: &[bool],
        firsts: &[Option<u32>],
        view: u64,
    ) -> Vec<(usize, u32, bool)> {
        if self.comets_shown == 0.0 {
            return Vec::new();
        }
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let draws: Vec<u64> = self.marks.iter().map(|m| m.drawn).collect();
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let (Some(list), Some(&Some(first)), Some(true)) =
                (shown.comets.list, firsts.get(i), drawn.get(i).copied())
            else {
                continue;
            };
            let ends: Vec<u64> = shown.ends.iter().filter_map(|end| end.mark).map(|m| draws[m]).collect();
            let seen = stamp_of(((list.header, list.items, list.kept), generation, first, view));
            let stamp = stamp_of((seen, draws[i], ends));
            let comets = &mut shown.comets;
            if stamp != comets.built {
                due.push((i, first, seen != comets.seen));
                (comets.built, comets.seen) = (stamp, seen);
            }
        }
        due
    }

    /// Reads back how many comet slots each mark `counted` counted, one readback at a time, so its
    /// list grows to fit.
    pub(super) fn comet_slots_found(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner, counted: &[usize]) {
        let gpu = self.gpu.clone();
        let Some(resources) = &self.resources else { return };
        for &i in counted {
            let comets = &mut self.marks[i].comets;
            let Some(list) = comets.list else { continue };
            if comets.found.busy() || !comets.found.due(comets.built) {
                continue;
            }
            let readback = Readback::words(
                &inner.readbacks,
                &gpu.0.device,
                encoder,
                resources.lists(),
                list.total(),
                1,
                &self.waker,
            );
            comets.found.start(comets.built, readback);
        }
    }

    /// Whether mark `i`'s rows can stand at different heights where depth varies, so they draw
    /// lowest first: a raised vertex mark on a plane or the earth, and edges and poles ending at
    /// one.
    pub(super) fn heights_vary(&self, i: usize) -> bool {
        if !matches!(self.scene.space, Space::Plane(_) | Space::Earth(_)) {
            return false;
        }
        let shown = &self.marks[i];
        match shown.kind() {
            MarkKind::Vertices => raised(&shown.mark),
            MarkKind::Edges => {
                matches!(shown.path(), wgsl::PATH_ENDS | wgsl::PATH_BENDS | wgsl::PATH_POLES)
                    && shown.ends.iter().any(|end| end.mark.is_some_and(|m| raised(&self.marks[m].mark)))
            }
            MarkKind::Lines | MarkKind::Areas => false,
        }
    }

    /// The height orders this frame sorts. Those whose lists buffer or instances changed sort at
    /// once, as do those whose rows' heights changed in a frame that cannot wait: a picture's or a
    /// video's frame shows every row in order, and without the clock moving, no later frame would
    /// come. So does a change after heights rested ([`RESTED`]), a one-off change. Heights that
    /// keep changing sort in the background, one order at a time, at most [`SORT_RECORDS`] records
    /// of passes a frame, and once they rest, the sort under way finishes. Heights change where its
    /// rows or the vertices they end at are drawn ([`Shown::places_drawn`]), with the paths drawn
    /// between them, and where the rows resolve their ends. Returns the marks that sort at once,
    /// and this frame's part of the background sort.
    pub(super) fn height_orders_due(&mut self, input: bool) -> (Vec<usize>, Option<SortStep>) {
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let places: Vec<(bool, u64)> = self.marks.iter().map(Shown::places_drawn).collect();
        let waits = input && self.clock.moved();
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(list) = shown.height_order.list.filter(|_| shown.drawable()) else {
                shown.height_order.stale = false;
                continue;
            };
            let ends: Vec<(bool, u64)> = shown.ends.iter().filter_map(|end| end.mark).map(|m| places[m]).collect();
            let drawn = shown.drawing().map(|d| d.made);
            let count = shown.counted_instances(shown.instances()).min(list.kept);
            let instances = stamp_of((list.header, list.kept, generation, shown.rows, shown.exits, drawn, count));
            let heights = stamp_of((shown.segments.built, places[i], ends));
            let order = &mut shown.height_order;
            let changed = heights != order.heights || shown.end_block_count > 0;
            let streaming = order.since_change.is_some_and(|frames| frames < RESTED);
            order.since_change =
                if changed { Some(0) } else { order.since_change.map(|frames| frames.saturating_add(1)) };
            order.stale |= changed;
            order.heights = heights;
            if instances != order.instances || (order.stale && !(waits && streaming)) {
                (order.instances, order.count, order.stale) = (instances, count, false);
                due.push(i);
            }
        }
        // A sort under way goes on while its mark keeps a height order over the instances it had,
        // and does not sort at once. Then the first stale order starts one.
        let marks = &self.marks;
        let holds = |sort: &Sort| {
            marks.get(sort.mark).is_some_and(|m| {
                m.key == sort.key
                    && m.drawable()
                    && m.height_order.list.is_some()
                    && m.height_order.instances == sort.instances
                    && !due.contains(&sort.mark)
            })
        };
        if self.sort.as_ref().is_some_and(|sort| !holds(sort)) {
            self.sort = None;
        }
        if self.sort.is_none()
            && let Some(i) = self.marks.iter().position(|m| m.height_order.stale)
        {
            let shown = &mut self.marks[i];
            let order = &mut shown.height_order;
            order.stale = false;
            if order.count > 0 {
                let (key, instances, count) = (shown.key.clone(), order.instances, order.count);
                self.sort = Some(Sort { mark: i, key, instances, count, left: SORT_PASSES });
            }
        }
        let step = self.sort.as_ref().map(|sort| {
            let rested = self.marks[sort.mark].height_order.since_change.is_none_or(|frames| frames >= RESTED);
            let passes = if rested { sort.left } else { (SORT_RECORDS / sort.count.max(1)).clamp(1, sort.left) };
            SortStep { mark: sort.mark, passes, lands: passes == sort.left }
        });
        (due, step)
    }

    /// Whether a background sort is under way, which later frames go on with.
    pub(super) fn sorting(&self) -> bool {
        self.sort.is_some()
    }

    /// The marks whose drawn-row words are rewritten this frame: those whose drawing, rows, word
    /// location, or lists buffer changed.
    pub(super) fn drawn_rows_due(&mut self) -> Vec<usize> {
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(at) = shown.drawn_rows.at.filter(|_| shown.drawable()) else { continue };
            let drawn = shown.drawing().map(|d| d.made);
            let stamp = stamp_of((at, shown.rows, shown.exits, drawn, generation));
            if stamp != shown.drawn_rows.expanded {
                shown.drawn_rows.expanded = stamp;
                due.push(i);
            }
        }
        due
    }

    /// The marks whose segment lists rebuild this frame: those whose list, lists buffer, paths,
    /// fans, or drawing changed. A list also follows where the vertices its rows join are drawn,
    /// but only where its segments depend on that: along great circles, and where a path's length
    /// is measured. Parallel edges move sideways as they draw, so neither the camera nor a moving
    /// vertex rebuilds their list, and a color changing every frame rebuilds none.
    pub(super) fn segments_due(&mut self) -> Vec<usize> {
        let vertices: Vec<Option<Version>> =
            self.marks.iter_mut().map(|m| (m.kind() == MarkKind::Vertices).then(|| m.shape_version())).collect();
        let generation = self.resources.as_ref().map_or(0, super::resources::Resources::lists_generation);
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(list) = shown.segments.list.filter(|_| shown.drawable()) else { continue };
            let measured = shown.measures_paths();
            let arcs = (shown.geodesic || measured).then(|| {
                let ends: Vec<_> = shown.ends.iter().map(|end| end.mark.map(|m| (m, vertices[m]))).collect();
                (ends, shown.places_drawn())
            });
            let tables = shown.compiled.as_ref().map(|c| {
                let generation = |column| (column, shown.tables.column_generation(column));
                let ends: Vec<_> = c.program.ends.iter().map(|end| generation(end.column)).collect();
                (generation(c.drawing.geometry), generation(c.drawing.lane), ends)
            });
            let drawn = shown.drawing().map(|d| d.made);
            let units = shown.along_units;
            let stamp = stamp_of((
                list.header,
                list.items,
                list.kept,
                tables,
                generation,
                arcs,
                drawn,
                measured,
                shown.fans,
                units,
            ));
            if stamp != shown.segments.built {
                shown.segments.built = stamp;
                due.push(i);
            }
        }
        due
    }

    /// The marks whose segment lists measure their distances along again, as the projection
    /// changed: those that dash, or carry comets spaced in CSS pixels, which measure on screen.
    /// A list only comets read waits while comets rest (see `View::comets_travel`). A list `built`
    /// this frame measures as it builds.
    pub(super) fn lengths_due(&mut self, built: &[usize]) -> Vec<usize> {
        let screen = self.screen_stamp();
        let resting = self.comets_shown == 0.0;
        let mut due = Vec::new();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let read = shown.mark.dashes() || !resting;
            if shown.segments.list.is_none()
                || !shown.drawable()
                || !shown.measures_paths()
                || shown.along_units
                || !read
            {
                continue;
            }
            let stamp = stamp_of((shown.segments.built, screen));
            if stamp != shown.segments.measured {
                shown.segments.measured = stamp;
                if !built.contains(&i) {
                    due.push(i);
                }
            }
        }
        due
    }

    /// A stamp of what the lengths of segments on screen depend on: the projection and the view's
    /// size, and where depth varies, the camera's center, which brings rows nearer or farther. On a
    /// map seen straight down, panning changes no length.
    fn screen_stamp(&self) -> u64 {
        let projected = self.projected();
        let matrix = projected.clip_from_world.to_cols_array().map(|v| (v as f32).to_bits());
        let center = self.deep().then(|| projected.center.map(f64::to_bits));
        let shape = [projected.globe, projected.parallax, self.size[0], self.size[1]].map(f64::to_bits);
        stamp_of((matrix, shape, center))
    }

    /// Reads curved marks' counts without blocking. Great-circle reservations grow when needed;
    /// a current count also trims draws to the compacted prefix. A new list invalidates its old
    /// count immediately, so no changed geometry is dropped while a readback is pending.
    pub(super) fn count_found(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &Inner) {
        let gpu = self.gpu.clone();
        let Some(resources) = &self.resources else { return };
        for shown in &mut self.marks {
            let Some(list) = shown.segments.list.filter(|_| shown.curved() && shown.drawable()) else { continue };
            let built = shown.segments.built;
            if shown.segments.found.busy() || !shown.segments.found.due(built) {
                continue;
            }
            let at = list.total();
            let readback =
                Readback::words(&inner.readbacks, &gpu.0.device, encoder, resources.lists(), at, 1, &self.waker);
            shown.segments.found.start(built, readback);
        }
    }
}

/// Whether `mark` is a vertex mark whose rows stand at the heights its elevation gives.
pub(super) fn raised(mark: &Mark) -> bool {
    matches!(mark, Mark::Vertices(vertices) if vertices.raised())
}

impl Shown {
    fn shape_version(&mut self) -> Version {
        let seen = self.places_drawn();
        if self.shape.seen != Some(seen) {
            let inputs = ShapeInputs::of(self);
            if !inputs.as_ref().zip(self.shape.inputs.as_ref()).is_some_and(|(now, before)| now.keeps(before)) {
                self.shape.version = Some(Version::next());
            }
            self.shape.seen = Some(seen);
            self.shape.inputs = inputs;
        }
        self.shape.version.expect("a shape is versioned on its first use")
    }

    /// Whether its segment count is being read back, or is due to be.
    pub(crate) fn counting(&self) -> bool {
        let found = &self.segments.found;
        found.busy() || (self.curved() && self.drawable() && found.due(self.segments.built))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Camera, Color, Data, Frame, Grid, Ids, Lines, Plane, Scene, Table, field};

    /// Renders `view` into a small target, a frame every sixtieth of a second from `time`, until
    /// it settles with no work late.
    fn settle(gpu: &crate::Gpu, view: &mut View, time: &mut f64) {
        let device = gpu.device();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("list test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
        for _ in 0..20 {
            *time += 1.0 / 60.0;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let frame =
                Frame { target: &target, format: crate::gpu::FORMAT, size: [64, 64], pixel_ratio: 1.0, time: *time };
            view.render(&mut encoder, &frame);
            gpu.queue().submit([encoder.finish()]);
            let wait =
                wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) };
            device.poll(wait).unwrap();
            if !view.needs_render() {
                assert_eq!(gpu.work().late, 0);
                return;
            }
        }
        panic!("the view settles");
    }

    #[test]
    fn only_fans_list_parallel_edges_and_no_camera_or_vertex_moves_their_list() {
        use crate::{Converge, EdgeTheme, Edges, Parallel, Patch, Theme, Vertices};
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        // Ten nodes in a row. Nine edges join the first two, and one edge joins each next pair.
        let from = (0..9).map(|_| 0).chain(1..9).collect::<Vec<u64>>();
        let to = (0..9).map(|_| 1).chain(2..10).collect::<Vec<u64>>();
        let x: Vec<f64> = (0..10).map(|i| f64::from(i) * 4.0 - 18.0).collect();
        let nodes = Table::new("Node", (0..10).collect::<Vec<u64>>()).field("x", x).field("y", vec![0.0; 10]);
        let links = Table::new("Link", Ids::count(from.len() as u32)).reference("from", "Node", from);
        let data = Data::new("d");
        data.apply(Patch::new().set(nodes).set(links.reference("to", "Node", to))).unwrap();
        let shown = |parallel: Option<Parallel>| {
            let theme = Theme { edge: EdgeTheme { parallel, ..Theme::dark().edge }, ..Theme::dark() };
            let scene = Scene::new(Plane { grid: Grid::Off })
                .theme(theme)
                .ease(std::time::Duration::ZERO)
                .draw(Vertices::of("d", "Node").position(field("x"), field("y")).radius(1.0))
                .draw(Edges::of("d", "Link").ends("from", "to"));
            let mut view = View::new(&gpu, scene);
            view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
            view.set_sources([&data]).unwrap();
            view
        };
        let mut time = 0.0;
        let mut view = shown(Some(Parallel { converge: Converge::Fan, ..Parallel::default() }));
        let mut built = |view: &mut View| {
            settle(&gpu, view, &mut time);
            view.marks[1].segments.built
        };
        let first = built(&mut view);
        let list = view.marks[1].segments.list.expect("fans draw through a list");
        assert!(list.kept < list.items * 3, "room for the fans of rows off the middle, not for every row's");
        data.apply(Table::new("Node", [1_u64]).field("y", vec![3.0])).unwrap();
        let moved = built(&mut view);
        view.set_camera(Camera::Map { center: [1.0, 0.0, 0.0], zoom: 2.0, pitch: 40.0, bearing: 0.0 });
        let turned = built(&mut view);
        assert_eq!([moved, turned], [first; 2], "parallel edges keep their list wherever they lie");
        // Squeezed or straight, every edge is one segment, so none needs a list.
        let mut view = shown(Some(Parallel::default()));
        settle(&gpu, &mut view, &mut time);
        assert!(view.marks[1].segments.list.is_none() && view.marks[1].laned());
        // Without parallel edges, no lanes are derived.
        let mut view = shown(None);
        settle(&gpu, &mut view, &mut time);
        assert!(view.marks[1].segments.list.is_none() && !view.marks[1].laned());
    }

    #[test]
    fn curved_lists_keep_counts_for_unreferenced_appends_but_follow_changed_endpoints() {
        use crate::{Earth, Edges, Patch, Vertices};
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let data = Data::new("d");
        data.apply(
            Patch::new()
                .set(Table::new("Node", vec![0_u64, 1]).field("x", vec![-1.0, 1.0]).field("y", vec![0.0, 0.0]))
                .set(Table::new("Link", Ids::count(2)).reference("from", "Node", vec![0_u64, 0]).reference(
                    "to",
                    "Node",
                    vec![1_u64, 9],
                )),
        )
        .unwrap();
        let scene = |shift: f64| {
            Scene::new(Earth::default().grid(Grid::Off))
                .ease(std::time::Duration::ZERO)
                .draw(Vertices::of("d", "Node").position(field("x") + shift, field("y")).radius(1.0))
                .draw(Edges::of("d", "Link").ends("from", "to"))
        };
        let mut view = View::new(&gpu, scene(0.0));
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
        view.set_sources([&data]).unwrap();
        let mut time = 0.0;
        let mut render = |view: &mut View| {
            settle(&gpu, view, &mut time);
            view.marks[1].segments.built
        };
        let first = render(&mut view);
        assert_ne!(first, 0);
        data.apply(Table::new("Node", [2_u64]).field("x", vec![5.0]).field("y", vec![0.0])).unwrap();
        assert_eq!(render(&mut view), first, "an unreferenced append keeps existing geometry and its exact count");
        data.apply(Table::new("Node", [1_u64]).field("x", vec![110.0])).unwrap();
        let moved = render(&mut view);
        assert_ne!(moved, first, "an existing endpoint moving changes its arc");
        data.apply(Table::new("Node", [9_u64]).field("x", vec![60.0]).field("y", vec![30.0])).unwrap();
        let connected = render(&mut view);
        assert_ne!(connected, moved, "a formerly missing reference connecting changes its list");
        view.set_scene(scene(1.0));
        assert_ne!(render(&mut view), connected, "changing the position expression invalidates inherited geometry");
    }

    #[test]
    fn heights_changing_every_frame_sort_in_the_background_and_end_in_order() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        // Three raised rows sort within each frame. Twenty thousand take a few frames a sort, which
        // go on drawing the order before.
        for rows in [3_u32, 20_000] {
            let n = rows as usize;
            let data = Data::new("d");
            let node = |lift: f64| {
                let z: Vec<f64> = (0..n).map(|i| (i % 7) as f64 + if i == 1 { lift } else { 0.0 }).collect();
                Table::new("Node", Ids::count(rows)).field("z", z)
            };
            let x: Vec<f64> = (0..n).map(|i| i as f64 / n as f64 - 0.5).collect();
            data.apply(node(1.0).field("x", x).field("y", vec![0.0; n])).unwrap();
            let lands = heights_streaming(&gpu, &data, &node);
            if rows == 3 {
                assert_eq!(lands, 30, "a small order lands within each frame");
            } else {
                assert!(lands > 0 && lands < 30, "a large one lands every few frames: {lands} of 30");
            }
        }
        assert_eq!(gpu.work().late, 0);
    }

    /// Draws `data`'s raised nodes tilted, then for half a second changes their heights through
    /// `node` every frame. Returns the frames in which no sort remained under way. Asserts that once
    /// heights stop changing, the last sort lands and the view sleeps.
    fn heights_streaming(gpu: &crate::Gpu, data: &Data, node: &dyn Fn(f64) -> Table) -> u32 {
        use crate::Vertices;
        let raised = Vertices::of("d", "Node").position(field("x"), field("y")).elevation(field("z"));
        let scene = Scene::new(Plane { grid: Grid::Off }).ease(std::time::Duration::ZERO).draw(raised);
        let mut view = View::new(gpu, scene);
        // Tilted, depth varies, so the raised rows draw lowest first.
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 50.0, bearing: 0.0 });
        view.set_sources([data]).unwrap();
        let device = gpu.device();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("height order test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut time = 0.0;
        let mut frame = |view: &mut View| {
            time += 1.0 / 60.0;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
            let size = [64, 64];
            view.render(
                &mut encoder,
                &Frame { target: &target, format: crate::gpu::FORMAT, size, pixel_ratio: 1.0, time },
            );
            gpu.queue().submit([encoder.finish()]);
            let wait =
                wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) };
            device.poll(wait).unwrap();
        };
        for _ in 0..10 {
            frame(&mut view);
        }
        assert!(view.marks[0].height_order.list.is_some(), "the tilted view orders its raised rows");
        let mut lands = 0;
        for i in 0..30 {
            data.apply(node(f64::from(i % 4))).unwrap();
            frame(&mut view);
            lands += u32::from(!view.sorting());
        }
        // Once the heights stop changing, the last sort lands, and the view sleeps.
        for _ in 0..12 {
            if !view.needs_render() {
                break;
            }
            frame(&mut view);
        }
        assert!(!view.needs_render(), "the view sleeps");
        assert!(!view.marks[0].height_order.stale() && !view.sorting(), "with every row in order");
        // A frame that does not sort, as while a new scene's sorts compile, keeps no orders, and
        // ends a sort under way.
        data.apply(node(3.0)).unwrap();
        frame(&mut view);
        view.lay_out_lists_buffer(false);
        assert!(view.height_orders_due(true).1.is_none() && !view.sorting(), "no sort without its order");
        lands
    }

    #[test]
    fn path_lists_track_geometry_and_length_styles_but_not_color_updates() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let data = Data::new("d");
        data.apply(
            Table::new("Path", Ids::count(1))
                .field("geometry", vec![vec![[-10.0, 0.0], [0.0, 0.0], [10.0, 0.0]]])
                .field("red", vec![false]),
        )
        .unwrap();
        let line = Lines::of("d", "Path").color(crate::when(field("red")).then(Color::WHITE).otherwise(Color::BLACK));
        let scene = |line| Scene::new(Plane { grid: Grid::Off }).ease(std::time::Duration::ZERO).draw(line);
        let mut view = View::new(&gpu, scene(line.clone()));
        view.set_camera(Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 });
        view.set_sources([&data]).unwrap();
        let device = gpu.device();
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("list invalidation test"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::gpu::FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let target = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut time = 0.0;
        let mut render = |view: &mut View| {
            for _ in 0..20 {
                time += 1.0 / 60.0;
                let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
                view.render(
                    &mut encoder,
                    &Frame { target: &target, format: crate::gpu::FORMAT, size: [64, 64], pixel_ratio: 1.0, time },
                );
                gpu.queue().submit([encoder.finish()]);
                device
                    .poll(wgpu::PollType::Wait {
                        submission_index: None,
                        timeout: Some(std::time::Duration::from_secs(10)),
                    })
                    .unwrap();
                if !view.needs_render() {
                    return view.marks[0].segments.built;
                }
            }
            panic!("the view settles");
        };
        let first = render(&mut view);
        assert_ne!(first, 0);
        data.apply(Table::new("Path", [0_u64]).field("red", vec![true])).unwrap();
        assert_eq!(render(&mut view), first, "changing color preserves the path list");
        data.apply(Table::new("Path", [0_u64]).field("geometry", vec![vec![[-10.0, 0.0], [10.0, 0.0]]])).unwrap();
        let changed = render(&mut view);
        assert_ne!(changed, first, "changing the path rebuilds its list");
        view.set_scene(scene(line.dash(true)));
        assert_ne!(render(&mut view), changed, "enabling dashes measures the existing path");
    }
}
