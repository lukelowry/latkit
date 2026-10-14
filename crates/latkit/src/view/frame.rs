//! One frame, in order: settle readbacks, advance the camera, sync columns, stream uploads, fit rows
//! into their regions, freeze transitions, pack the program buffer, write focus and uniforms, then
//! record the compute, shadow, render, and probe passes into the caller's encoder. Nothing here
//! submits.

use web_time::Instant;

use super::marks::Shown;
use super::resources::{EyeSlot, MARK_STRIDE, Resources};
use super::sync::{Source, Synced, Window, table_of};
use super::transition::remap;
use super::{Camera, Event, Target, View, uniforms};
use crate::Error;
use crate::expr::compile::Deps;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;

impl View {
    /// Records a frame of the scene into `encoder` for `target`; the caller submits it.
    ///
    /// Uploads stream within the GPU's budget per frame. A mark shows a new data version once all of
    /// its changed pages are on the GPU, and keeps drawing the previous one until then.
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &Target<'_>) {
        if self.gpu.lost() {
            if !self.told_lost {
                self.told_lost = true;
                self.events.push(Event::Error(Error::DeviceLost));
            }
            return;
        }
        let started = Instant::now();
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        // Runs the callbacks of finished readbacks; a no-op in browsers, which run them themselves.
        let _ = device.poll(wgpu::PollType::Poll);
        self.tell_gpu_errors();
        self.pixel_ratio = target.pixel_ratio.max(0.01);
        let ratio = f64::from(self.pixel_ratio);
        self.size = [f64::from(target.size[0]) / ratio, f64::from(target.size[1]) / ratio];
        self.settle();
        self.advance();
        let mut inner = gpu.0.lock();
        self.make_pipelines(&mut inner, target.format, super::resources::samples(target.pixel_ratio));
        inner.atlas.tick();
        self.settle_labels(&mut inner);
        self.stream(&mut inner);
        self.derive();
        let resources = self.resources.get_or_insert_with(|| Resources::new(device));
        resources.forget_retired();
        let moved = self.fit_rows(encoder);
        self.transitions(encoder, &mut inner);
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
        self.pack(&mut inner);
        self.lay_out_labels(&mut inner);
        for shown in &mut self.marks {
            shown.dirty |= shown.channels_reading(Deps::TIME);
        }
        let resources = self.resources.as_ref().expect("created");
        let (buffer, capacity) = (resources.focus().clone(), resources.focus_words());
        self.focus.dirty |= moved;
        self.write_focus(queue, &buffer, capacity, moved);
        let measure = self.measuring();
        let probe = self.probe_point();
        let query = self.lay_out_lists();
        let projected = self.projected();
        let elapsed = self.start.elapsed().as_secs_f64();
        let mut frame = uniforms::frame(&self.scene, &projected, self.size, target.format.is_srgb(), elapsed);
        frame.pointer = self.pointer.unwrap_or([-1e9, -1e9]);
        frame.selecting = u32::from(!self.focus.selection.is_empty());
        frame.fitting = u32::from(measure.as_ref().is_some_and(|m| m.rows));
        if let Some(point) = probe {
            frame.probe = point;
            frame.probe_radius = self.scene.controls.pick_radius + if self.probing.touch { 8.0 } else { 0.0 };
        }
        if let Some((words, _)) = query {
            frame.query = words;
        }
        self.label_words(&mut frame);
        let main = uniforms::eye(&projected, self.size, self.pixel_ratio);
        self.px_per_unit = main.px_per_unit[0];
        let light = self.shade(&mut frame, &main);
        let sprites = self.overlay(&mut inner, queue);
        self.write_uniforms(&frame, &main, light.as_ref(), &sprites);
        if let Some(readback) = self.compute(encoder, &mut inner, measure.is_some()) {
            self.measuring_started(readback, measure.and_then(|m| m.fit));
        }
        self.place(encoder, &mut inner);
        if let Some(light) = &light {
            self.cast(encoder, &mut inner, light);
        } else {
            self.shadow_map.mark(0);
        }
        self.place_labels(encoder, &mut inner, &main);
        let depth = probe.is_some() || query.is_some_and(|(_, depth)| depth);
        self.draw(encoder, &mut inner, target, sprites.len() as u32, depth);
        if let Some(point) = probe {
            let readback = self.probe(encoder, &mut inner);
            self.probing(point, readback);
        }
        self.run_query(encoder, &mut inner);
        for shown in &mut self.marks {
            shown.held = shown.rows + shown.exits;
            shown.moved = None;
        }
        self.changed = false;
        self.stats.frames += 1;
        self.stats.cpu_ms = started.elapsed().as_secs_f32() * 1000.0;
    }

    /// Takes what landed since the last frame: probes, fits, queries, layouts, routes, and the
    /// events waiting on picks.
    fn settle(&mut self) {
        self.settle_fit();
        self.settle_probe();
        self.settle_query();
        self.settle_placing();
        self.settle_routing();
        self.settle_awaiting();
    }

    /// Derives what marks draw from the data they synced: graph words, and which edges follow
    /// great circles.
    fn derive(&mut self) {
        self.derive_graph();
        for i in 0..self.marks.len() {
            let geodesic = self.geodesic(&self.marks[i]);
            self.marks[i].geodesic = geodesic;
        }
    }

    /// Lays out the lists buffer: the marks' segment lists, then the lists of this frame's query,
    /// whose words and depth use it returns. A buffer replaced empty counts every segment again.
    fn lay_out_lists(&mut self) -> Option<([f32; 4], bool)> {
        self.lay_out_segments();
        let query = self.next_query();
        let words = self.queries.words().max(self.segment_words);
        let device = &self.gpu.0.device;
        self.resources.as_mut().expect("created").fit_lists(device, u64::from(words));
        query
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

    /// Syncs every mark's columns and streams the pages they need within the frame's budget.
    fn stream(&mut self, inner: &mut Inner) {
        let gpu = self.gpu.clone();
        let waiting = self.sync(inner);
        let budget = inner.budget;
        match inner.arena.pump(&gpu.0.device, &gpu.0.queue, budget.upload_per_frame, budget.bytes) {
            Ok(_) => self.upload_error = None,
            Err(error) if self.upload_error.as_ref() != Some(&error) => {
                self.upload_error = Some(error.clone());
                self.events.push(Event::Error(error));
            }
            Err(_) => {}
        }
        if waiting {
            // Pages that just uploaded can show this frame.
            self.sync(inner);
        }
    }

    /// Every mark's uniform, at its dynamic offset.
    pub(super) fn mark_uniforms(&self) -> Vec<u8> {
        let mut marks = vec![0_u8; self.marks.len() * MARK_STRIDE as usize];
        for (i, shown) in self.marks.iter().enumerate() {
            let uniform = uniforms::mark(i, shown, self.labels.slots(i));
            let at = i * MARK_STRIDE as usize;
            marks[at..at + size_of::<wgsl::Mark>()].copy_from_slice(bytemuck::bytes_of(&uniform));
        }
        marks
    }

    /// Tells errors the device reported outside any scope, once each.
    fn tell_gpu_errors(&mut self) {
        let errors: Vec<Error> =
            std::mem::take(&mut *self.gpu.0.errors.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        self.events.extend(errors.into_iter().map(Event::Error));
        let custom = self.gpu.0.lock().pipelines.custom_errors();
        self.events.extend(custom.into_iter().map(Event::Error));
    }

    /// Syncs every mark's columns; changed columns dirty the channels reading them, and changed
    /// static values or rows start a transition. True when a mark waits for uploads.
    fn sync(&mut self, inner: &mut Inner) -> bool {
        let at = self.at;
        let area = self.area();
        let window = Window {
            across: match self.camera {
                Camera::Plot { x, .. } => Some(x),
                Camera::Map { .. } => None,
            },
            columns: ((area[2] - area[0]) * f64::from(self.pixel_ratio)).max(1.0) as u32,
        };
        let easing = !self.scene.ease.is_zero();
        let mut waiting = false;
        for shown in &mut self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            let program = compiled.program.clone();
            let style = shown.mark.style();
            let Some(data) = self.data.iter().find(|d| *d.name() == style.data) else { continue };
            let Some(table) = data.table(&style.table) else { continue };
            let source = Source { data, table };
            let synced = shown.tables.sync(&program, &source, &self.data, at, window, inner);
            waiting |= matches!(synced, Synced::Waiting);
            let Synced::Changed { columns } = synced else { continue };
            let moved = shown.drawn.as_ref().and_then(|old| remap(old, table));
            if easing && shown.held > 0 && (moved.is_some() || shown.static_columns(columns)) {
                shown.begin(moved);
            } else if moved.is_some() {
                shown.exits = 0;
            }
            shown.rows = table.len() as u32;
            shown.drawn = Some(table.clone());
            shown.columns_changed(columns);
            if shown.kind() == MarkKind::Lines {
                self.fitting.plot_due = true;
            }
            for text in &program.texts {
                let column = &program.columns[text.column as usize];
                let code = table_of(column.of.as_ref(), &source, &self.data).map_or(wgsl::NONE, |(d, t)| {
                    inner.dictionaries.field(d.name(), &t.name, &column.name).code(&text.text)
                });
                shown.constants[text.constant as usize] = code;
            }
        }
        waiting
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
    fn attach_ends(&mut self) {
        for i in 0..self.marks.len() {
            let ends = ends(&self.marks, i);
            if ends != self.marks[i].ends {
                self.marks[i].ends = ends;
                self.marks[i].packed = false;
                self.marks[i].all_dirty();
            }
        }
    }
}

/// The graph slot of vertex 0 of the vertex mark each of mark `i`'s ends attaches to, or `NONE`. An
/// end attaches to the unnamed vertex mark drawing its table, else to the first one.
fn ends(marks: &[Shown], i: usize) -> Vec<u32> {
    let Some(compiled) = &marks[i].compiled else { return Vec::new() };
    let data = &marks[i].mark.style().data;
    compiled
        .program
        .ends
        .iter()
        .chain(marks[i].graph.end_tables())
        .map(|table| {
            super::graph::end_mark(marks, data, table)
                .map_or(wgsl::NONE, |m| marks[m].region.state / wgsl::VERTEX_WORDS)
        })
        .collect()
}
