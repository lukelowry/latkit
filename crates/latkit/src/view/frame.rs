//! One frame, in order: tick the clock, settle readbacks, advance the camera, derive what marks read
//! beside their data, sync columns, stream uploads, fit rows into their regions, freeze transitions,
//! pack the program buffer, write focus and uniforms, then record the compute, shadow, label, render,
//! and probe passes into the caller's encoder. Nothing here submits.

use web_time::Instant;

use super::drawing::Drawn;
use super::marks::{End, Holding, Shown};
use super::resources::{EyeSlot, MARK_STRIDE, Resources};
use super::sync::{Inputs, Rows, Source, Synced, Window, table_of};
use super::transition::{bound, holds_alike, in_place, moved};
use super::{Camera, Event, Frame, View, timer, uniforms};
use crate::data::Keyed;
use crate::derive::order::Order;
use crate::derive::tiled::Place;
use crate::expr::compile::Deps;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Error, Name, derive};

/// The most seconds comets travel in one frame: after a pause they carry on, not leap.
const TRAVEL: f64 = 0.1;

impl View {
    /// Records `frame` of the scene into `encoder`; the caller submits it. Until the view is
    /// [ready](View::ready) for the frame's target it records nothing, and the target keeps what it
    /// holds.
    ///
    /// Uploads stream within the GPU's budget per frame. A mark shows a new data version once all of
    /// its changed pages are on the GPU, and keeps drawing the previous one until then.
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, frame: &Frame<'_>) {
        self.record(encoder, frame, true);
    }

    /// Records `frame` for a picture, which takes no input: it asks for what it draws and changes
    /// with alone.
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
        if !self.ready_for(frame.format, frame.pixel_ratio, input) {
            return;
        }
        let started = Instant::now();
        self.signal.clear();
        let dt = self.clock.tick(frame.time);
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        if let Some(timer) = &mut self.timer {
            timer.begin(encoder);
        }
        // Runs the callbacks of finished readbacks; a no-op in browsers, which run them themselves.
        let _ = device.poll(wgpu::PollType::Poll);
        self.tell_gpu_errors();
        self.pixel_ratio = frame.pixel_ratio.max(0.01);
        let ratio = f64::from(self.pixel_ratio);
        self.size = [f64::from(frame.size[0]) / ratio, f64::from(frame.size[1]) / ratio];
        self.settle();
        self.advance(dt);
        let mut inner = gpu.0.lock();
        inner.begin_frame(self.id);
        inner.atlas.tick();
        self.settle_labels(&mut inner);
        self.derive(&mut inner);
        self.answer_arranging();
        self.stream(&mut inner);
        let moved = self.lay_out(encoder, &mut inner);
        let (elapsed, travel) = self.effect_clock();
        let resources = self.resources.as_ref().expect("created");
        let (buffer, capacity) = (resources.focus().clone(), resources.focus_words());
        self.focus.dirty |= moved;
        self.write_focus(queue, &buffer, capacity, moved);
        if let Some(rows) = self.focus.take_lit() {
            self.resources.as_mut().expect("created").write_lit(device, queue, &rows);
        }
        let measure = self.measuring();
        // A picture takes no input; frames that do probe and answer queries once what those use
        // compiled.
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
        let main = uniforms::eye(&projected, self.size, self.pixel_ratio);
        let light = self.shade(&mut uniform, &main);
        let sprites = self.overlay(&mut inner);
        self.lay_out_blocks();
        self.write_uniforms(&uniform, &main, light.as_ref(), &sprites);
        if let Some(readback) = self.compute(encoder, &mut inner, measure.is_some(), travel > 0.0) {
            self.measuring_started(readback, measure.and_then(|m| m.fit));
        }
        self.count_found(encoder, &inner);
        let mut drawn = super::passes::Drawn::default();
        if let Some(light) = &light {
            self.cast(encoder, &mut inner, &mut drawn, light);
        } else {
            self.shadow_map.mark(0);
        }
        self.place_labels(encoder, &mut inner, &main);
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
            shown.moved = None;
            shown.carry = false;
        }
        self.events.extend(inner.atlas.errors.drain(..).map(Event::Error));
        self.events.extend(self.derived.take_errors().into_iter().map(Event::Error));
        drop(inner);
        self.end(started, input);
    }

    /// The time effects show this frame, and the seconds comets travel to it. What reads the clock
    /// shows anything new only when it moved; a frame drawn again at the same instant, as a shot
    /// draws while it waits, evaluates none of it. Under reduced motion the effect clock holds where
    /// it first stood; a picture's still sets it.
    fn effect_clock(&mut self) -> (f64, f64) {
        let held = !self.moves() && !self.effect_time.is_nan();
        let elapsed = self.signal.elapsed().unwrap_or_else(|| if held { self.effect_time } else { self.clock.now() });
        // Comets travel the clock's step since the last frame: none at first or back in time, and
        // never more than a pause's worth.
        let travel = if self.effect_time.is_nan() { 0.0 } else { (elapsed - self.effect_time).clamp(0.0, TRAVEL) };
        if self.effect_time != elapsed {
            self.effect_time = elapsed;
            for shown in &mut self.marks {
                shown.dirty_rows(shown.channels_reading(Deps::TIME), None);
            }
        }
        (elapsed, travel)
    }

    /// Ends a frame begun at `started`: what it stood in for, what it took, and the next frame its
    /// work asks for, as work landing between frames does. A frame taking no `input`, a picture's,
    /// asks none for probes and queries, which only frames that take input run.
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

    /// Lays the frame out: where every mark's rows sit, the transitions starting, the ends edges
    /// attach to, fitted domains, the buffers they fit, the program, and the labels; whether rows
    /// moved.
    fn lay_out(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner) -> bool {
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        for i in 0..self.marks.len() {
            let geodesic = self.geodesic(&self.marks[i]);
            self.marks[i].geodesic = geodesic;
        }
        let resources = self.resources.get_or_insert_with(|| Resources::new(device));
        resources.forget_retired();
        let moved = self.fit_rows(encoder);
        self.transitions(encoder, inner);
        self.attach_ends();
        let domains = self.place_domains();
        let resources = self.resources.as_mut().expect("created");
        let vertices: u64 = self
            .marks
            .iter()
            .filter(|m| m.kind() == MarkKind::Vertices)
            .map(|m| u64::from(m.region.state / wgsl::VERTEX_WORDS + m.region.capacity))
            .max()
            .unwrap_or(0);
        resources.fit(device, self.marks.len() as u64, domains, vertices);
        self.pack(inner);
        self.lay_out_labels(inner);
        moved
    }

    /// Takes what landed since the last frame: probes, fits, queries, the intents and keys waiting on
    /// picks; and tells, once, why marks the data given since no longer fits failed.
    fn settle(&mut self) {
        if let Some(ms) = self.timer.as_mut().and_then(timer::Timer::landed) {
            self.stats.gpu_ms = ms;
        }
        self.settle_fit();
        self.settle_probe();
        self.settle_query();
        self.settle_gestures();
        for (i, shown) in self.marks.iter_mut().enumerate() {
            if let Some((error, told)) = &mut shown.failure
                && !*told
            {
                *told = true;
                self.events.tell(Event::Error(shown.mark.within(i, error.clone())));
            }
        }
    }

    /// Derives what marks read beside their data, from the data and the scene alone, handing the
    /// host what the frame cannot afford. First the tiles the camera and the plot window ask for,
    /// the datasets tiles make; then the orders tables drawn in part draw in, and the ranges of them
    /// the camera asks for; then every other derivation, from the data.
    fn derive(&mut self, inner: &mut Inner) {
        let host = inner.host.clone();
        let projected = self.projected();
        let earth = matches!(self.scene.space, crate::Space::Earth(_));
        let placing = earth || matches!(self.scene.space, crate::Space::Plane(_));
        let sight = derive::sight::Sight { projected: &projected, size: self.size, earth };
        // One budget for the frame: the tiles, what is drawn in part, then every other derivation.
        let (waker, counters) = (self.waker.clone(), self.gpu.0.counters.clone());
        let errors = self.gpu.0.errors.clone();
        let mut jobs = derive::Jobs::new(host.as_deref(), &waker, &counters, &errors, inner.frame.work);
        let mut tiles = std::mem::take(&mut self.derived.tiles);
        let reading = self.reading();
        let asked = derive::tiles::Asked { sight: earth.then_some(&sight), reading: &reading };
        tiles.update(&self.derive_input(host.as_deref()), &asked, &jobs);
        for data in tiles.take_changed() {
            self.take_data(data, inner);
        }
        self.derived.tiles = tiles;
        let budget = inner.budget.bytes;
        self.update_plan(&mut inner.ledger, budget);
        self.trace_columns = self.planning.trace_columns();
        let ask = derive::tiled::Ask {
            sources: &self.sources,
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

    /// What derivations read this frame.
    fn derive_input<'a>(&'a self, host: Option<&'a dyn crate::host::Host>) -> derive::Input<'a> {
        derive::Input {
            scene: &self.scene,
            scene_version: self.scene_version,
            data: &self.sources,
            host,
            dragging: self.dragging(),
            paged: None,
        }
    }

    /// Lays out the lists buffer, the marks' segment lists, and takes this frame's query when it
    /// `answers` them, returning its words and whether it reads depth. A buffer replaced empty counts
    /// every segment again.
    fn lay_out_lists(&mut self, answers: bool) -> Option<([f32; 4], bool)> {
        self.lay_out_segments();
        let device = &self.gpu.0.device;
        self.resources.as_mut().expect("created").fit_lists(device, u64::from(self.list_words));
        if answers { self.next_query() } else { None }
    }

    /// Writes the frame's uniform, its eyes, every mark's uniform, and the overlay's sprites.
    fn write_uniforms(
        &mut self,
        frame: &wgsl::Frame,
        main: &wgsl::Eye,
        light: Option<&wgsl::Eye>,
        sprites: &[wgsl::Sprite],
    ) {
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        self.reveal();
        let marks = self.mark_uniforms();
        let resources = self.resources.as_mut().expect("created");
        queue.write_buffer(&resources.frame, 0, bytemuck::bytes_of(frame));
        let mut eyes = vec![0_u8; 2 * MARK_STRIDE as usize];
        let light_at = EyeSlot::Light.offset() as usize;
        eyes[..size_of::<wgsl::Eye>()].copy_from_slice(bytemuck::bytes_of(main));
        if let Some(light) = light {
            eyes[light_at..light_at + size_of::<wgsl::Eye>()].copy_from_slice(bytemuck::bytes_of(light));
        }
        queue.write_buffer(resources.eyes(), 0, &eyes);
        if !marks.is_empty() {
            queue.write_buffer(resources.marks(), 0, &marks);
        }
        resources.fit_sprites(device, sprites.len());
        if !sprites.is_empty() {
            queue.write_buffer(resources.sprites(), 0, bytemuck::cast_slice(sprites));
        }
    }

    /// Lays out what each table drawn in part draws, syncs every mark's columns to it, streams the
    /// pages they need within what the GPU's frame has left to upload, and swaps in each dataset
    /// whose pages have all landed, those that just did included.
    fn stream(&mut self, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        self.lay_out_drawings();
        self.sync(inner);
        let uploaded = inner.arena.pump(&gpu.0.device, &gpu.0.queue, inner.frame.upload);
        inner.frame.upload = inner.frame.upload.saturating_sub(uploaded);
        self.publish(inner);
    }

    /// Every mark's uniform, at its dynamic offset.
    pub(super) fn mark_uniforms(&self) -> Vec<u8> {
        let mut marks = vec![0_u8; self.marks.len() * MARK_STRIDE as usize];
        for (i, shown) in self.marks.iter().enumerate() {
            let uniform = uniforms::mark(i, shown, self.labels.slots(i), &self.clock);
            let at = i * MARK_STRIDE as usize;
            marks[at..at + size_of::<wgsl::Mark>()].copy_from_slice(bytemuck::bytes_of(&uniform));
        }
        marks
    }

    /// Tells errors the device reported outside any scope, once each.
    pub(super) fn tell_gpu_errors(&mut self) {
        let errors: Vec<Error> =
            std::mem::take(&mut *self.gpu.0.errors.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        self.events.extend(errors.into_iter().map(Event::Error));
        let custom = self.gpu.0.lock().pipelines.custom_errors();
        self.events.extend(custom.into_iter().map(Event::Error));
    }

    /// The plot window lines trace across, and the pixel columns it spans within what the plan
    /// affords.
    fn trace_window(&self) -> (Option<[f64; 2]>, u32) {
        let across = match self.camera {
            Camera::Plot { x, .. } => Some(x),
            Camera::Map { .. } => None,
        };
        let area = self.area();
        (across, (((area[2] - area[0]) * f64::from(self.pixel_ratio)).max(1.0) as u32).min(self.trace_columns))
    }

    /// What marks read of sampled fields, for time tiles to fetch: the plot window, the coordinate
    /// shown, and each field a mark's program reads, with whether a line traces it.
    fn reading(&self) -> derive::tiles::Reading {
        let (across, columns) = self.trace_window();
        let mut fields = Vec::new();
        for shown in &self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            let style = shown.mark.style();
            for column in compiled.program.columns.iter().filter(|c| !c.derived) {
                let (data, table) = column.of.clone().unwrap_or_else(|| (style.data.clone(), style.table.clone()));
                fields.push((data, table, column.name.clone(), column.trace));
            }
        }
        derive::tiles::Reading { across, columns, at: self.at, fields }
    }

    /// Syncs every mark's columns to its data, and for a table drawn in part to the drawing replacing
    /// what draws: tables whose inputs changed are rebuilt once, and wait for their pages.
    fn sync(&mut self, inner: &mut Inner) {
        let at = self.at;
        let (across, columns) = self.trace_window();
        let window = Window { across, columns, steps: 0 };
        // The order each table drawn in part draws in, by dataset.
        let mut orders: Keyed<Name, Vec<(Name, Order)>> = Keyed::default();
        for ((data, table), drawn) in &self.drawings {
            if let Some(drawing) = drawn.latest() {
                orders.entry(data.clone()).or_default().push((table.clone(), drawing.order.clone()));
            }
        }
        for shown in &mut self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            let style = shown.mark.style();
            let Some(data) = self.sources.iter().find(|d| *d.name() == style.data) else { continue };
            let Some(table) = data.table(&style.table) else { continue };
            let derived = self.derived.beside(&style.data, &style.table);
            let source = Source { data, table, derived, paged: self.derived.paged(&style.data, &style.table) };
            let drawing = self.drawings.get(&(style.data.clone(), style.table.clone())).and_then(Drawn::latest);
            let rows = drawing.map_or(Rows::Own, |drawing| Rows::Held(drawing));
            let window = Window { steps: compiled.drawing.flags & (wgsl::STEP_BEFORE | wgsl::STEP_AFTER), ..window };
            let orders = orders.get(&style.data).map_or(&[][..], Vec::as_slice);
            let inputs = Inputs { all: &self.sources, at, window, orders };
            shown.tables.sync(&compiled.program, &source, rows, &inputs, inner);
        }
    }

    /// Swaps in what each dataset draws once all of it is ready: every mark's rebuilt tables, and
    /// the drawing of each of its tables drawn in part, together, so edges never end at another
    /// drawing's vertices and a data version appears whole.
    fn publish(&mut self, inner: &mut Inner) {
        let mut datasets: Vec<Name> =
            self.marks.iter().filter(|m| m.compiled.is_some()).map(|m| m.mark.style().data.clone()).collect();
        datasets.sort();
        datasets.dedup();
        let now = self.clock.now();
        for name in datasets {
            let marks: Vec<usize> = (0..self.marks.len())
                .filter(|&i| self.marks[i].compiled.is_some() && self.marks[i].mark.style().data == name)
                .collect();
            if marks.iter().any(|&i| self.marks[i].tables.waiting(inner) == Synced::Waiting) {
                continue;
            }
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
                self.took(i, inner);
            }
        }
    }

    /// Takes what mark `i` draws now its dataset is published: its rebuilt tables, its table's
    /// drawing, and the rows they hold. Changed columns dirty the channels reading them; rows that
    /// came, went, or moved evaluate every channel, and with changed static values begin a
    /// transition.
    fn took(&mut self, i: usize, inner: &mut Inner) {
        // A drag moves rows at once.
        let easing = !self.ease().is_zero() && !self.dragging();
        let shown = &mut self.marks[i];
        let Some(compiled) = &shown.compiled else { return };
        let (program, geometry) = (compiled.program.clone(), compiled.drawing.geometry);
        let key = (shown.mark.style().data.clone(), shown.mark.style().table.clone());
        let Some(data) = self.sources.iter().find(|d| *d.name() == key.0) else { return };
        let Some(table) = data.table(&key.1) else { return };
        let drawing = self.drawings.get(&key).and_then(|d| d.current.clone());
        let published = shown.tables.publish(&program, geometry, inner);
        let holding = Holding { origin: data.origin(), table: table.clone(), drawing: drawing.clone() };
        if published.is_none() && shown.holding.as_ref().is_some_and(|h| holds_alike(h, &holding)) {
            return;
        }
        let before = shown.holding.take();
        let alike = before.as_ref().is_some_and(|old| holds_alike(old, &holding));
        let moved = before.as_ref().and_then(|old| moved(old, &holding));
        // A path morphs from the one its row ran through only while every row keeps its place;
        // rows that moved, as rows do between orders, fade instead.
        let kept = moved.as_ref().is_none_or(|(sources, exits)| exits.is_empty() && in_place(sources));
        // Slots given pages of other rows: their rows evaluate every channel, and their labels start
        // over.
        let bound = match &drawing {
            Some(new) => bound(before.as_ref().and_then(|h| h.drawing.as_deref()).filter(|_| moved.is_none()), new),
            None => Vec::new(),
        };
        match &before {
            // Rows that came, went, or moved evaluate every channel, constants included: where every
            // row kept its place, over the row blocks rewritten; else over every row.
            Some(old) if old.drawing.is_none() && drawing.is_none() => {
                if moved.is_some() || shown.rows != table.len() as u32 {
                    let rewritten = old.table.len() <= table.len() && moved.as_ref().is_none_or(|(s, _)| in_place(s));
                    match rewritten.then(|| super::transition::rewritten(&old.table, table)).flatten() {
                        Some(pages) => shown.rows_rewritten(&super::marks::Blocks::of_pages(&pages)),
                        None => shown.all_dirty(),
                    }
                }
            }
            Some(_) if moved.is_none() => shown.slots_bound(&bound),
            _ => shown.all_dirty(),
        }
        shown.rows = drawing.as_ref().map_or(table.len() as u32, |d| d.items);
        shown.holding = Some(holding);
        // Without an ease, a flowing mark whose rows moved still begins, a transition of no length,
        // so its comets follow the rows.
        let carries = shown.mark.flows() && moved.is_some();
        let eased = published.as_ref().is_some_and(|p| shown.static_columns(p.data));
        if (easing || carries) && shown.before > 0 && (moved.is_some() || eased) {
            shown.begin(moved);
        } else if moved.is_some() {
            shown.exits = 0;
        } else if shown.transition.is_some() && !bound.is_empty() {
            // Rows of slots bound while the mark eases enter; the rest ease on from what they show.
            shown.restart(&bound);
        }
        if !kept || (shown.begin.is_none() && shown.transition.is_none()) {
            shown.tables.thaw(inner);
        }
        // Where rows draw changed: what follows it, shadows, normals, labels, and segment lists, follows.
        // A column changed alone evaluates the channels reading it, which moves them as it must.
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
                let code = table_of(column, &source, &self.sources).map_or(wgsl::NONE, |(d, t)| {
                    inner.dictionaries.field(d, &t.name, &column.name).code_of(&text.text)
                });
                shown.constants[text.constant as usize] = code;
            }
        }
        if shown.kind() == MarkKind::Lines {
            self.fitting.plot_due = true;
        }
        // Rows may have moved under the focus.
        if !alike {
            self.focus.dirty = true;
        }
    }

    /// Where each mark's fitted domains start; returns how many there are.
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

    /// Points every edge and face mark's ends at the vertex marks drawing their tables.
    /// The ends of rows evaluate again where their vertices moved: another vertex mark or region,
    /// another order, or for rows that hold no page their ends lie in, other slots. Edges drawn in
    /// part hold the pages their ends lie in, whose slots never move under them.
    fn attach_ends(&mut self) {
        for i in 0..self.marks.len() {
            let ends = ends(&self.marks, i);
            let was = &self.marks[i].ends;
            if ends == *was {
                continue;
            }
            let style = self.marks[i].mark.style();
            let place = self.planning.plans().get(&(style.data.clone(), style.table.clone())).map(|p| &p.place);
            let closed = self.marks[i].drawing().is_some() && matches!(place, Some(Place::Ends(_)));
            let moved = ends.len() != was.len()
                || ends.iter().zip(was).any(|(a, b)| {
                    a.first != b.first || a.order != b.order || (!closed && (a.pages != b.pages || a.kept != b.kept))
                });
            // Edges kept find their ends among the rows kept, which move as those change: they alone
            // evaluate again.
            let kept = closed && ends.iter().zip(was).any(|(a, b)| a.kept != b.kept);
            self.marks[i].ends = ends;
            self.marks[i].packed = false;
            if moved {
                self.marks[i].all_dirty();
            } else if kept {
                let slots = self.marks[i].drawing().map(|d| d.kept_slots()).unwrap_or_default();
                self.marks[i].slots_bound(&slots);
            }
        }
    }
}

/// Where each of mark `i`'s ends finds its vertices: the vertex mark it attaches to, its vertex 0's
/// graph slot, and where it holds the pages of the order it draws its table in, if in part. An end
/// attaches to the unnamed vertex mark drawing its table, else to the first one.
fn ends(marks: &[Shown], i: usize) -> Vec<End> {
    let Some(compiled) = &marks[i].compiled else { return Vec::new() };
    let data = &marks[i].mark.style().data;
    compiled
        .program
        .ends
        .iter()
        .map(|table| match super::graph::end_mark(marks, data, table) {
            Some(m) => End {
                first: marks[m].region.state / wgsl::VERTEX_WORDS,
                order: marks[m].drawing().map_or(0, |d| d.order.id()),
                pages: marks[m].drawing().map(|d| d.pages.clone()),
                kept: marks[m].drawing().map(|d| d.kept_rows.clone()),
            },
            None => End { first: wgsl::NONE, order: 0, pages: None, kept: None },
        })
        .collect()
}
