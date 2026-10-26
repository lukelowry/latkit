//! One frame, in order: tick the clock, settle readbacks, advance the camera, derive the tables
//! marks read beside their data, lay out drawings, sync columns, stream uploads, give marks word
//! pages for their rows, freeze transitions, pack the program buffer, write focus words and
//! uniforms, then record the compute, label, render, probe, and query passes into the caller's
//! encoder.
//!
//! The frame submits nothing itself except setup that must run before its recorded passes:
//! clearing newly handed-out pages, and copying buffers that grew.

use web_time::Instant;

use super::drawing::Drawn;
use super::marks::Holding;
use super::resources::{MARK_STRIDE, Resources};
use super::sync::{Inputs, Rebuilt, Rows, Source, Window, table_of};
use super::transition::{bound, holds_alike, in_place, moved};
use super::words::Kept;
use super::{Camera, Event, Frame, View, timer, uniforms};
use crate::data::Keyed;
use crate::derive::order::Order;
use crate::expr::compile::Deps;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Error, Name, derive};

/// Whether a frame's pages found room in the arena. If some did not, the next frame makes room:
/// `Short` grows the arena or plans less; `Starved`, when the arena is full and the plan is already
/// minimal, releases what the view draws of datasets waiting for room.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Debug)]
pub(super) enum Room {
    #[default]
    Found,
    Short,
    Starved,
}

/// The most seconds comets travel in one frame, so after a pause they resume instead of jumping.
const TRAVEL: f64 = 0.1;

impl View {
    /// Records `frame` of the scene into `encoder`; the caller submits it. Until the view is
    /// [ready](View::ready) for the frame's target, it records nothing and the target keeps its
    /// contents.
    ///
    /// Uploads stream within the GPU's per-frame budget. A mark shows a new data version once all
    /// of its changed pages are on the GPU, and draws the previous version until then.
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, frame: &Frame<'_>) {
        self.record(encoder, frame, true);
    }

    /// Records `frame` for a picture. Pictures take no input, so they compile only what they draw
    /// and change with, never the pipelines that probes and queries use.
    pub(crate) fn render_picture(&mut self, encoder: &mut wgpu::CommandEncoder, frame: &Frame<'_>) {
        self.record(encoder, frame, false);
    }

    fn record(&mut self, encoder: &mut wgpu::CommandEncoder, frame: &Frame<'_>, input: bool) {
        if self.gpu.lost() {
            if !self.told_lost {
                self.told_lost = true;
                self.events.tell(Event::Error(Error::DeviceLost));
            }
            return;
        }
        // Set the frame's size first, so the tiles sources bring up are those this frame shows.
        // Clear the arrival flag before that, so work they start that finishes at once wakes the
        // next frame.
        self.pixel_ratio = frame.pixel_ratio.max(0.01);
        let ratio = f64::from(self.pixel_ratio);
        self.size = [f64::from(frame.size[0]) / ratio, f64::from(frame.size[1]) / ratio];
        let landed = self.signal.take();
        if !self.ready_for(frame.format, frame.pixel_ratio, input) {
            self.signal.leave(landed);
            return;
        }
        let started = Instant::now();
        let starved = std::mem::take(&mut self.room) == Room::Starved;
        let dt = self.clock.tick(frame.time);
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        if let Some(timer) = &mut self.timer {
            timer.begin(encoder);
        }
        // Runs the callbacks of finished readbacks; a no-op in browsers, which run them themselves.
        let _ = device.poll(wgpu::PollType::Poll);
        self.tell_gpu_errors();
        self.measure_gutters();
        self.settle();
        self.advance(dt);
        let mut inner = gpu.0.lock();
        // Release before `begin_frame`, which frees the pages before this frame reads any of them.
        if starved {
            self.start_over(&mut inner);
        }
        inner.begin_frame(self.id, device, queue);
        inner.atlas.tick();
        self.settle_labels(&mut inner);
        self.derive(&mut inner);
        self.tell_failures();
        self.answer_arranging();
        self.stream(&mut inner);
        let fresh = self.lay_out(encoder, &mut inner);
        let (elapsed, travel) = self.effect_clock();
        let pages = inner.arena.buffer().clone();
        self.write_focus(queue, &pages, fresh);
        if let Some(rows) = self.focus.take_lit() {
            self.resources.as_mut().expect("created").write_lit(device, queue, &rows);
        }
        let measure = self.measuring();
        // A picture takes no input. Other frames probe and answer queries once the pipelines those
        // use have compiled.
        let answers = input && self.answers();
        let probe = self.probe_point(answers);
        let query = self.lay_out_lists(answers);
        let projected = self.projected();
        let srgb = frame.format.is_srgb();
        let mut uniform = uniforms::frame(&self.scene, &projected, self.size, srgb, elapsed, self.at);
        uniform.flow_step = travel as f32;
        if self.signal.transparent() {
            uniform.background[3] = 0.0;
        }
        uniform.pointer = self.pointer.map_or([-1e9, -1e9], |p| p.point);
        uniform.selecting = u32::from(!self.focus.selection.is_empty());
        uniform.fitting = u32::from(measure.as_ref().is_some_and(|m| m.rows));
        if let Some(point) = probe {
            uniform.probe = point;
            uniform.probe_radius = self.probe_radius();
        }
        if let Some((words, _)) = query {
            uniform.query = words;
        }
        self.label_words(&mut uniform, dt);
        let eye = uniforms::eye(&projected, self.size, self.pixel_ratio);
        let sprites = self.overlay(&mut inner);
        self.lay_out_blocks();
        self.write_uniforms(&uniform, &eye, &sprites);
        if let Some(readback) = self.compute(encoder, &mut inner, measure.is_some(), travel > 0.0) {
            self.measuring_started(readback, measure.and_then(|m| m.fit));
        }
        self.count_found(encoder, &inner);
        let mut drawn = super::passes::Drawn::default();
        self.place_labels(encoder, &mut inner, &eye);
        let depth = probe.is_some() || query.is_some_and(|(_, depth)| depth);
        self.draw(encoder, &mut inner, &mut drawn, frame, sprites.len() as u32, depth);
        self.stats.draws = drawn.draws;
        self.stats.instances = drawn.instances;
        if let Some(point) = probe {
            let readback = self.probe(encoder, &mut inner);
            self.probing(point, readback);
        }
        self.run_query(encoder, &mut inner);
        if let Some(timer) = &mut self.timer {
            timer.end(encoder, device);
        }
        for shown in &mut self.marks {
            shown.before = shown.held();
            shown.words.settle();
            shown.carry = false;
        }
        self.events.extend(inner.atlas.errors.drain(..).map(Event::Error));
        self.events.extend(self.derived.take_errors().into_iter().map(Event::Error));
        drop(inner);
        self.end(started, input);
    }

    /// The effect time for this frame, and the seconds comets travel to reach it. Channels reading
    /// the clock re-evaluate only when it moved, so a frame redrawn at the same instant (as a shot
    /// draws while it waits) evaluates none of them. Under reduced motion the effect time stays at
    /// its first value. A shot's fixed time overrides both.
    fn effect_clock(&mut self) -> (f64, f64) {
        let held = !self.moves() && !self.effect_time.is_nan();
        let elapsed = self.signal.elapsed().unwrap_or_else(|| if held { self.effect_time } else { self.clock.now() });
        // Comets travel the clock's step since the last frame: none on the first frame or when time
        // runs backward, and at most `TRAVEL`.
        let travel = if self.effect_time.is_nan() { 0.0 } else { (elapsed - self.effect_time).clamp(0.0, TRAVEL) };
        if self.effect_time != elapsed {
            self.effect_time = elapsed;
            for shown in &mut self.marks {
                shown.dirty_rows(shown.channels_reading(Deps::TIME), None);
            }
        }
        (elapsed, travel)
    }

    /// Ends a frame begun at `started`: reports what it still waits on, records its stats, and
    /// requests the next frame if work remains, as work arriving between frames does. A frame
    /// without `input` (a picture's) requests none for probes and queries, which only input frames
    /// run.
    fn end(&mut self, started: Instant, input: bool) {
        let waiting = self.under_way();
        if waiting != self.waiting {
            self.waiting = waiting;
            self.events.tell(Event::Waiting(waiting));
        }
        self.changed = false;
        self.stats.frames += 1;
        self.stats.cpu_ms = started.elapsed().as_secs_f32() * 1000.0;
        if self.due(input) {
            self.signal.ask();
        }
    }

    /// Lays out the frame: each mark's word pages, starting transitions, edge end attachments,
    /// fitted domains and the buffers sized for them, the program buffer, and labels. Returns
    /// whether any focus word pages are new.
    fn lay_out(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> bool {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        for i in 0..self.marks.len() {
            let geodesic = self.geodesic(&self.marks[i]);
            self.marks[i].geodesic = geodesic;
        }
        self.resources.get_or_insert_with(|| Resources::new(device));
        let fresh = self.fit_words(inner);
        self.fit_easing(inner);
        inner.arena.clear(device, &gpu.0.queue);
        self.transitions(encoder, inner);
        self.attach_ends();
        let domains = self.place_domains();
        let resources = self.resources.as_mut().expect("created");
        resources.fit(device, self.marks.len() as u64, domains);
        self.pack(encoder, inner);
        self.lay_out_labels(inner);
        fresh
    }

    /// Gives every mark word pages for its held rows: state, focus words, label candidates, and,
    /// for a vertex mark that faces attach to, the normals they sum. Rows in new state pages
    /// evaluate from scratch. A mark the arena has no room for draws nothing until it has. Returns
    /// whether any focus word pages are new.
    fn fit_words(&mut self, inner: &mut Inner) -> bool {
        let gpu = self.gpu.clone();
        let device = (&gpu.0.device, &gpu.0.queue);
        let mut normals = vec![false; self.marks.len()];
        for shown in self.marks.iter().filter(|m| m.kind() == MarkKind::Faces) {
            let Some(compiled) = &shown.compiled else { continue };
            for end in &compiled.program.ends {
                if let Some(m) = super::graph::end_mark(&self.marks, &shown.mark.style().data, &end.table) {
                    normals[m] = true;
                }
            }
        }
        let (mut fresh, mut short, mut changed) = (false, false, false);
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let rows = shown.page_rows();
            let labeled = shown.compiled.as_ref().is_some_and(|c| c.drawing.label.is_some());
            let fits = [
                (Kept::State, shown.stride() + shown.extras()),
                (Kept::Focus, 1),
                (Kept::Candidates, if labeled { wgsl::CANDIDATE_WORDS } else { 0 }),
                (Kept::Normals, if normals[i] { wgsl::NORMAL_WORDS } else { 0 }),
            ];
            for (kept, width) in fits {
                let had = shown.words.pages(kept).blocks.len();
                let Some(new) = shown.words.fit(kept, &rows, width, device, &mut inner.arena) else {
                    short = true;
                    continue;
                };
                if new.is_empty() && had == shown.words.pages(kept).blocks.len() {
                    continue;
                }
                shown.packed = false;
                changed = true;
                fresh |= kept == Kept::Focus;
                // Rows in new state pages evaluate every channel, writing every word first.
                if kept == Kept::State {
                    shown.slots_bound(&new);
                    shown.fresh.extend(&new);
                }
            }
        }
        if short {
            self.found_no_room(inner);
        }
        if changed {
            self.hold_to_share(inner);
        }
        fresh
    }

    /// Records that some pages found no room; what lacks them draws nothing until the next frame
    /// makes room. If the arena can grow, or the plan can shrink (it shrinks here), that is
    /// `Short`. Otherwise it is `Starved`, which releases what the view draws of datasets waiting
    /// for room, unless an earlier release freed nothing (`limited`).
    fn found_no_room(&mut self, inner: &Inner) {
        let room = if !inner.arena.full() || self.planning.overflowed() {
            Room::Short
        } else if self.limited {
            Room::Found
        } else {
            Room::Starved
        };
        self.room = self.room.max(room);
    }

    /// Releases what the view draws of each dataset waiting for room, when the arena is full and
    /// the plan is already minimal. Its marks draw nothing until the staged replacement arrives in
    /// the freed room. If nothing was released, what the view draws does not fit the budget: it
    /// reports a `Limit` error once and waits for a new data version to publish.
    fn start_over(&mut self, inner: &mut Inner) {
        let mut freed = false;
        for shown in &mut self.marks {
            if !self.staged.contains_key(&shown.mark.style().data) || shown.holding.take().is_none() {
                continue;
            }
            shown.release(inner);
            (shown.rows, shown.exits, shown.before) = (0, 0, 0);
            (shown.begin, shown.transition) = (None, None);
            shown.packed = false;
            freed = true;
        }
        for (key, drawn) in self.drawings.iter_mut() {
            if self.staged.contains_key(&key.0) {
                drawn.current = None;
            }
        }
        if !freed {
            self.limited = true;
            let reason = "the view does not fit the GPU's budget, even drawing as little as possible";
            self.events.tell(Event::Error(Error::Limit(reason.into())));
        }
    }

    /// Keeps what the view draws within its share of the budget. It counts each page its tables pin
    /// once, plus the word pages its marks keep per row, minus idle pages, which stay only while
    /// there is room and go first when the plan shrinks.
    fn hold_to_share(&mut self, inner: &Inner) {
        let mut pins: Vec<crate::gpu::arena::PageKey> = self.marks.iter().flat_map(|m| m.tables.pins()).collect();
        pins.sort_unstable_by_key(|key| (key.page, key.low, key.words as u8));
        pins.dedup();
        let pages: u64 = pins.into_iter().map(|key| inner.arena.bytes_of(key)).sum();
        let words: u64 = self.marks.iter().map(|m| m.words.bytes()).sum();
        let idle: f64 = self
            .drawings
            .iter()
            .filter_map(|(key, drawn)| Some(self.planning.page_bytes(key, drawn.current.as_ref()?.idle.len() as u32)))
            .sum();
        let needed = ((pages + words) as f64 - idle).max(0.0);
        self.planning.held(needed as u64, self.choices.values().any(|c| c.capped));
    }

    /// Takes the results that arrived since the last frame: GPU timing, fits, probes, queries, and
    /// the intents and key steps waiting on picks.
    fn settle(&mut self) {
        if let Some(ms) = self.timer.as_mut().and_then(timer::Timer::landed) {
            self.stats.gpu_ms = ms;
        }
        self.settle_fit();
        self.settle_probe();
        self.settle_query();
        self.settle_gestures();
    }

    /// Reports, once each, why marks failed against the data drawn. Runs after the frame takes the
    /// latest data versions, so a dataset filled between frames reports nothing about the version
    /// before.
    fn tell_failures(&mut self) {
        for (i, shown) in self.marks.iter_mut().enumerate() {
            if let Some((error, told)) = &mut shown.failure
                && !*told
            {
                *told = true;
                self.events.tell(Event::Error(shown.mark.within(i, error.clone())));
            }
        }
    }

    /// Derives the tables marks read beside their data, from the data and scene alone, handing the
    /// host whatever the frame cannot afford. First come the orders of paged tables and the ranges
    /// of them the camera needs, then every other derivation.
    fn derive(&mut self, inner: &mut Inner) {
        let host = inner.host.clone();
        let projected = self.projected();
        let earth = matches!(self.scene.space, crate::Space::Earth(_));
        let placing = earth || matches!(self.scene.space, crate::Space::Plane(_));
        let sight = derive::sight::Sight { projected: &projected, size: self.size, earth };
        // One work budget for the frame, spent on paged tables first, then on other derivations.
        let (waker, counters) = (self.waker.clone(), self.gpu.0.counters.clone());
        let errors = self.gpu.0.errors.clone();
        let mut jobs = derive::Jobs::new(host.as_deref(), &waker, &counters, &errors, inner.frame.work);
        let budget = inner.budget.bytes;
        self.update_plan(&mut inner.ledger, budget);
        self.trace_columns = self.planning.trace_columns();
        let ask = derive::tiled::Ask {
            data: &self.snapshots,
            plans: self.planning.plans(),
            sight: placing.then_some(&sight),
            earth,
        };
        let mut tiled = std::mem::take(&mut self.derived.tiled);
        self.choices = tiled.update(&ask, &mut jobs);
        self.derived.tiled = tiled;
        let paged = self.paged();
        let mut derived = std::mem::take(&mut self.derived);
        let input = derive::Input { paged: Some(&paged), ..self.derive_input(host.as_deref()) };
        if derived.update(&input, &mut jobs) {
            self.changed = true;
        }
        self.derived = derived;
        inner.frame.work = jobs.left() as u32;
    }

    /// Brings every tile set up to date with what the camera and plot window need, from the GPU's
    /// tile cache and what arrived since. Tiles fetch and decode as they arrive, so this spends
    /// none of the frame's work budget.
    pub(super) fn update_tiles(&mut self, inner: &mut Inner) {
        let host = inner.host.clone();
        let projected = self.projected();
        let earth = matches!(self.scene.space, crate::Space::Earth(_));
        let sight = derive::sight::Sight { projected: &projected, size: self.size, earth };
        let reading = self.reading();
        let asked = crate::tiles::Asked { sight: earth.then_some(&sight), reading: &reading };
        let (waker, counters) = (self.waker.clone(), self.gpu.0.counters.clone());
        let errors = self.gpu.0.errors.clone();
        let jobs = derive::Jobs::new(host.as_deref(), &waker, &counters, &errors, 0);
        let mut tiles = std::mem::take(&mut self.derived.tiles);
        tiles.update(&self.derive_input(host.as_deref()), &asked, &mut inner.tiles, &jobs);
        self.derived.tiles = tiles;
    }

    /// The input derivations read this frame.
    fn derive_input<'a>(&'a self, host: Option<&'a dyn crate::host::Host>) -> derive::Input<'a> {
        derive::Input {
            scene: &self.scene,
            scene_version: self.scene_version,
            data: &self.snapshots,
            host,
            dragging: self.dragging(),
            paged: None,
        }
    }

    /// Lays out the lists buffer and the marks' segment lists. If the frame `answers` queries,
    /// takes this frame's query, returning its words and whether it reads depth. A replaced buffer
    /// starts empty, so every segment is counted again.
    fn lay_out_lists(&mut self, answers: bool) -> Option<([f32; 4], bool)> {
        self.lay_out_segments();
        let device = &self.gpu.0.device;
        self.resources.as_mut().expect("created").fit_lists(device, u64::from(self.list_words));
        if answers { self.next_query() } else { None }
    }

    /// Writes the frame's uniform, its eye, every mark's uniform, and the overlay's sprites.
    fn write_uniforms(&mut self, frame: &wgsl::Frame, eye: &wgsl::Eye, sprites: &[wgsl::Sprite]) {
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        self.reveal();
        let marks = self.mark_uniforms();
        let resources = self.resources.as_mut().expect("created");
        queue.write_buffer(&resources.frame, 0, bytemuck::bytes_of(frame));
        queue.write_buffer(resources.eye(), 0, bytemuck::bytes_of(eye));
        if !marks.is_empty() {
            queue.write_buffer(resources.marks(), 0, &marks);
        }
        resources.fit_sprites(device, sprites.len());
        if !sprites.is_empty() {
            queue.write_buffer(resources.sprites(), 0, bytemuck::cast_slice(sprites));
        }
    }

    /// Lays out each paged table's drawing, syncs every mark's columns, uploads the pages they need
    /// within the frame's remaining upload budget, and swaps in each dataset whose pages have all
    /// arrived, including those that just did.
    fn stream(&mut self, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        self.lay_out_drawings();
        self.sync(inner);
        let uploaded = inner.arena.pump(&gpu.0.queue, inner.frame.upload);
        inner.frame.upload = inner.frame.upload.saturating_sub(uploaded);
        if self.publish(inner) {
            self.limited = false;
            self.hold_to_share(inner);
        }
    }

    /// Every mark's uniform, at its dynamic offset.
    pub(super) fn mark_uniforms(&self) -> Vec<u8> {
        let mut marks = vec![0_u8; self.marks.len() * MARK_STRIDE as usize];
        for (i, shown) in self.marks.iter().enumerate() {
            let uniform = uniforms::mark(i, shown, &self.labels, &self.clock);
            let at = i * MARK_STRIDE as usize;
            marks[at..at + size_of::<wgsl::Mark>()].copy_from_slice(bytemuck::bytes_of(&uniform));
        }
        marks
    }

    /// Reports errors the device raised outside any error scope, and custom pipeline errors, once
    /// each.
    pub(super) fn tell_gpu_errors(&mut self) {
        let errors: Vec<Error> =
            std::mem::take(&mut *self.gpu.0.errors.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        self.events.extend(errors.into_iter().map(Event::Error));
        let custom = self.gpu.0.lock().pipelines.custom_errors();
        self.events.extend(custom.into_iter().map(Event::Error));
    }

    /// The plot's x range that traces span, and its width in device pixel columns, capped by the
    /// plan.
    fn trace_window(&self) -> (Option<[f64; 2]>, u32) {
        let across = match self.camera {
            Camera::Plot { x, .. } => Some(x),
            Camera::Map { .. } => None,
        };
        let area = self.area();
        (across, (((area[2] - area[0]) * f64::from(self.pixel_ratio)).max(1.0) as u32).min(self.trace_columns))
    }

    /// What marks read of sampled fields, for time tiles to fetch: the plot window and its pixel
    /// columns, the coordinate shown, and each field a mark's program reads, with whether a line
    /// traces it.
    fn reading(&self) -> crate::tiles::Reading {
        let (across, columns) = self.trace_window();
        let mut fields = Vec::new();
        for shown in &self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            let style = shown.mark.style();
            for column in compiled.program.columns.iter().filter(|c| !c.derived) {
                let (data, table) = column.from.clone().unwrap_or_else(|| (style.data.clone(), style.table.clone()));
                fields.push((data, table, column.name.clone(), column.trace));
            }
        }
        crate::tiles::Reading { across, columns, at: self.at, fields }
    }

    /// Syncs every mark's columns to its data and, for a paged table, to its latest drawing. Column
    /// tables whose inputs changed are rebuilt once and staged with their dataset, which reserves
    /// every page they read at once or waits for room.
    fn sync(&mut self, inner: &mut Inner) {
        let at = self.at;
        let (across, columns) = self.trace_window();
        let window = Window { across, columns, steps: 0 };
        // Each paged table's order, by dataset.
        let mut orders: Keyed<Name, Vec<(Name, Order)>> = Keyed::default();
        for ((data, table), drawn) in &self.drawings {
            if let Some(drawing) = drawn.latest() {
                orders.entry(data.clone()).or_default().push((table.clone(), drawing.order.clone()));
            }
        }
        for (i, shown) in self.marks.iter_mut().enumerate() {
            let Some(compiled) = &shown.compiled else { continue };
            let style = shown.mark.style();
            let Some(data) = self.snapshots.iter().find(|d| *d.name() == style.data) else { continue };
            let Some(table) = data.table(&style.table) else { continue };
            let derived = self.derived.beside(&style.data, &style.table);
            let source = Source { data, table, derived, paged: self.derived.paged(&style.data, &style.table) };
            let drawing = self.drawings.get(&(style.data.clone(), style.table.clone())).and_then(Drawn::latest);
            let rows = drawing.map_or(Rows::Own, |drawing| Rows::Held(drawing));
            let window = Window { steps: compiled.drawing.flags & (wgsl::STEP_BEFORE | wgsl::STEP_AFTER), ..window };
            let orders = orders.get(&style.data).map_or(&[][..], Vec::as_slice);
            let inputs = Inputs { all: &self.snapshots, at, window, orders };
            let staged = self.staged.get(&style.data).and_then(|s| s.of(i));
            if let Some(rebuilt) = shown.tables.rebuild(&compiled.program, &source, rows, &inputs, staged, inner) {
                self.staged.entry(style.data.clone()).or_default().put(i, rebuilt, inner);
            }
        }
        let gpu = self.gpu.clone();
        let mut short = false;
        for (_, staged) in self.staged.iter_mut() {
            short |= !staged.reserve(inner, &gpu.0.device, &gpu.0.queue);
        }
        if short {
            self.found_no_room(inner);
        }
    }

    /// Swaps in each dataset once all of it is ready and every mark has room for word pages of its
    /// new rows. A dataset's rebuilt tables and its paged tables' drawings swap in together, so
    /// edges never end at another drawing's vertices and a data version appears whole. Returns
    /// whether any tables were swapped in.
    fn publish(&mut self, inner: &mut Inner) -> bool {
        let mut datasets: Vec<Name> =
            self.marks.iter().filter(|m| m.compiled.is_some()).map(|m| m.mark.style().data.clone()).collect();
        datasets.sort();
        datasets.dedup();
        let now = self.clock.now();
        let mut published = false;
        for name in datasets {
            let marks: Vec<usize> = (0..self.marks.len())
                .filter(|&i| self.marks[i].compiled.is_some() && self.marks[i].mark.style().data == name)
                .collect();
            if self.staged.get_mut(&name).is_some_and(|s| !s.ready(inner)) {
                continue;
            }
            if !marks.iter().all(|&i| self.room_for(i, inner)) {
                self.found_no_room(inner);
                continue;
            }
            let mut staged = self.staged.remove(&name).unwrap_or_default();
            for (key, drawn) in self.drawings.iter_mut() {
                if key.0 == name
                    && let Some(next) = drawn.next.take()
                {
                    if next.fades {
                        drawn.since = now;
                    }
                    drawn.current = Some(next);
                }
            }
            for i in marks {
                let rebuilt = staged.take(i);
                published |= rebuilt.is_some();
                self.took(i, rebuilt, inner);
            }
            staged.release(inner);
        }
        published
    }

    /// Whether mark `i` has word pages for the rows it will hold once its dataset publishes,
    /// allocating any it lacks. Its existing pages stay unchanged until then.
    fn room_for(&mut self, i: usize, inner: &mut Inner) -> bool {
        let shown = &self.marks[i];
        let style = shown.mark.style();
        let key = (style.data.clone(), style.table.clone());
        let drawing = self.drawings.get(&key).and_then(Drawn::latest);
        let live = match drawing {
            Some(drawing) => drawing.live(),
            None => self.snapshot(&key.0).and_then(|d| d.table(&key.1)).map_or(0, |t| t.len() as u32),
        };
        // Size new pages as `page_rows` will: a whole page per slot of a paged table, else the
        // table's own rows, a page at a time.
        let held = live + shown.exits;
        let mut rows = shown.page_rows();
        let had = rows.len();
        for p in had as u32..held.div_ceil(wgsl::PAGE_ROWS) {
            let start = p * wgsl::PAGE_ROWS;
            let full = drawing.is_some() && start < live;
            rows.push(if full { wgsl::PAGE_ROWS } else { held.min(start + wgsl::PAGE_ROWS) - start });
        }
        if rows.len() == had {
            return true;
        }
        let labeled = shown.compiled.as_ref().is_some_and(|c| c.drawing.label.is_some());
        let fits = [
            (Kept::State, shown.stride() + shown.extras()),
            (Kept::Focus, 1),
            (Kept::Candidates, if labeled { wgsl::CANDIDATE_WORDS } else { 0 }),
        ];
        let gpu = self.gpu.clone();
        let shown = &mut self.marks[i];
        fits.into_iter().all(|(kept, width)| {
            let fitted = shown.words.fit(kept, &rows, width, (&gpu.0.device, &gpu.0.queue), &mut inner.arena);
            shown.packed &= fitted.as_ref().is_some_and(Vec::is_empty);
            fitted.is_some()
        })
    }

    /// Updates mark `i` after its dataset publishes: its rebuilt tables, its table's drawing, and
    /// the rows they hold. Changed columns dirty the channels reading them. Rows that came, went,
    /// or moved evaluate every channel. Moved rows or changed static values begin a transition.
    fn took(&mut self, i: usize, rebuilt: Option<Rebuilt>, inner: &mut Inner) {
        // During a drag, rows move without easing.
        let easing = !self.ease().is_zero() && !self.dragging();
        let shown = &mut self.marks[i];
        let Some(compiled) = &shown.compiled else { return };
        let (program, geometry) = (compiled.program.clone(), compiled.drawing.geometry);
        let key = (shown.mark.style().data.clone(), shown.mark.style().table.clone());
        let Some(data) = self.snapshots.iter().find(|d| *d.name() == key.0) else { return };
        let Some(table) = data.table(&key.1) else { return };
        let drawing = self.drawings.get(&key).and_then(|d| d.current.clone());
        let published = rebuilt.map(|rebuilt| shown.tables.publish(rebuilt, &program, geometry, inner));
        let holding = Holding { origin: data.origin(), table: table.clone(), drawing: drawing.clone() };
        if published.is_none() && shown.holding.as_ref().is_some_and(|h| holds_alike(h, &holding)) {
            return;
        }
        let before = shown.holding.take();
        let alike = before.as_ref().is_some_and(|old| holds_alike(old, &holding));
        let moved = before.as_ref().and_then(|old| moved(old, &holding));
        // A path morphs from its previous shape only while every row keeps its place. Rows that
        // moved, as they do between orders, fade instead.
        let kept = moved.as_ref().is_none_or(|(sources, exits)| exits.is_empty() && in_place(sources));
        // Slots now holding pages of other rows: their rows evaluate every channel, and their
        // labels restart.
        let bound = match &drawing {
            Some(new) => bound(before.as_ref().and_then(|h| h.drawing.as_deref()).filter(|_| moved.is_none()), new),
            None => Vec::new(),
        };
        match &before {
            // Rows that came, went, or moved evaluate every channel, constants included: over the
            // rewritten row blocks if every row kept its place, else over every row.
            Some(old) if old.drawing.is_none() && drawing.is_none() => {
                if moved.is_some() || shown.rows != table.len() as u32 {
                    let rewritten = old.table.len() <= table.len() && moved.as_ref().is_none_or(|(s, _)| in_place(s));
                    match rewritten.then(|| super::transition::rewritten(&old.table, table)).flatten() {
                        Some(pages) => shown.rows_rewritten(&pages),
                        None => shown.all_dirty(),
                    }
                }
            }
            Some(_) if moved.is_none() => shown.slots_bound(&bound),
            _ => shown.all_dirty(),
        }
        shown.rows = drawing.as_ref().map_or(table.len() as u32, |d| d.items);
        shown.holding = Some(holding);
        // Without an ease, a flowing mark whose rows moved still begins a zero-length transition,
        // so its comets follow the rows.
        let carries = shown.mark.flows() && moved.is_some();
        let eased = published.as_ref().is_some_and(|p| shown.static_columns(p.data));
        if (easing || carries) && shown.before > 0 && (moved.is_some() || eased) {
            shown.begin(moved);
        } else if moved.is_some() {
            shown.exits = 0;
        } else if shown.transition.is_some() && !bound.is_empty() {
            // Rows in slots rebound mid-transition enter; the rest keep easing from what they show.
            shown.restart(&bound);
        }
        if !kept || (shown.begin.is_none() && shown.transition.is_none()) {
            shown.tables.thaw(inner);
        }
        // If where rows draw changed, bump the versions so normals, labels, and segment lists
        // follow. A changed column alone evaluates the channels reading it, which bump them.
        if !alike {
            shown.version += 1;
            shown.place_version += 1;
        }
        shown.bound = bound;
        shown.packed = false;
        if let Some(published) = &published {
            shown.columns_changed(published.data, published.blocks.as_deref());
            let source = Source { data, table, derived: self.derived.beside(&key.0, &key.1), paged: Vec::new() };
            for text in &program.texts {
                let column = &program.columns[text.column as usize];
                let code = table_of(column, &source, &self.snapshots).map_or(wgsl::NONE, |(d, t)| {
                    inner.dictionaries.field(d, &t.name, &column.name).code_of(&text.text)
                });
                shown.constants[text.constant as usize] = code;
            }
        }
        if shown.kind() == MarkKind::Lines {
            self.fitting.plot_due = true;
        }
        // Rows may have moved under the focus words.
        if !alike {
            self.focus.dirty = true;
        }
    }

    /// Assigns each mark the index of its first fitted domain, dirtying marks whose index moved.
    /// Returns the total number of domains.
    fn place_domains(&mut self) -> u64 {
        let mut domains = 0;
        for shown in &mut self.marks {
            if shown.domains != domains {
                shown.domains = domains;
                shown.all_dirty();
            }
            domains += shown.reductions();
        }
        u64::from(domains)
    }
}
