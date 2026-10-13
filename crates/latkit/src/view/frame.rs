//! One frame, in order: settle readbacks, sync columns, stream uploads, lay out state, pack the
//! program buffer, write uniforms, then record the compute and render passes into the caller's
//! encoder. Nothing here submits.

use super::fit::Fitting;
use super::marks::Shown;
use super::resources::{MARK_STRIDE, Resources};
use super::sync::{Source, Synced, table_of};
use super::{Event, Target, View, uniforms};
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
            return;
        }
        let gpu = self.gpu.clone();
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        // Runs the callbacks of finished readbacks; a no-op in browsers, which run them themselves.
        let _ = device.poll(wgpu::PollType::Poll);
        let ratio = f64::from(target.pixel_ratio.max(0.01));
        let size = [f64::from(target.size[0]) / ratio, f64::from(target.size[1]) / ratio];
        self.settle_fit(size);
        self.advance();
        let mut inner = gpu.0.lock();
        let waiting = self.sync(&mut inner);
        let budget = inner.budget;
        match inner.arena.pump(device, queue, budget.upload_per_frame, budget.bytes) {
            Ok(_) => self.upload_error = None,
            Err(error) if self.upload_error.as_ref() != Some(&error) => {
                self.upload_error = Some(error.clone());
                self.events.push(Event::Error(error));
            }
            Err(_) => {}
        }
        if waiting {
            // Pages that just uploaded can show this frame.
            self.sync(&mut inner);
        }
        if std::mem::take(&mut self.layout_dirty) {
            self.layout();
        }
        let resources = self.resources.get_or_insert_with(|| Resources::new(device));
        if resources.fit(device, &self.marks) {
            for shown in &mut self.marks {
                shown.all_dirty();
            }
        }
        self.pack(&mut inner);
        for shown in &mut self.marks {
            shown.dirty |= shown.channels_reading(Deps::TIME);
        }
        let elapsed = self.start.elapsed().as_secs_f64();
        let frame =
            uniforms::frame(&self.scene, &self.camera, size, target.pixel_ratio, target.format.is_srgb(), elapsed);
        let resources = self.resources.as_mut().expect("created");
        queue.write_buffer(&resources.frame, 0, bytemuck::bytes_of(&frame));
        let mut marks = vec![0_u8; self.marks.len() * MARK_STRIDE as usize];
        for (i, shown) in self.marks.iter().enumerate() {
            let uniform = uniforms::mark(i, shown);
            let at = i * MARK_STRIDE as usize;
            marks[at..at + size_of::<wgsl::Mark>()].copy_from_slice(bytemuck::bytes_of(&uniform));
        }
        if !marks.is_empty() {
            queue.write_buffer(resources.marks(), 0, &marks);
        }
        let groups = resources.groups(&gpu.0, &mut inner);
        let measure = self.measuring();
        if let Some(readback) = self.compute(encoder, &mut inner, &groups, measure) {
            self.fitting = Fitting::Measuring(readback);
        }
        self.draw(encoder, &mut inner, &groups, target);
        self.changed = false;
    }

    /// Syncs every mark's columns; changed columns dirty the channels reading them. True when a mark
    /// waits for uploads.
    fn sync(&mut self, inner: &mut Inner) -> bool {
        let at = self.at;
        let mut waiting = false;
        for shown in &mut self.marks {
            let Some(compiled) = &shown.compiled else { continue };
            let program = compiled.program.clone();
            let style = shown.mark.style();
            let Some(data) = self.data.iter().find(|d| *d.name() == style.data) else { continue };
            let Some(table) = data.table(&style.table) else { continue };
            let source = Source { data, table };
            if table.len() as u32 != shown.rows {
                shown.rows = table.len() as u32;
                self.layout_dirty = true;
            }
            let synced = shown.tables.sync(&program, &source, &self.data, at, inner);
            waiting |= matches!(synced, Synced::Waiting);
            if let Synced::Changed { columns } = synced {
                shown.columns_changed(columns);
                for text in &program.texts {
                    let column = &program.columns[text.column as usize];
                    let code = table_of(column.of.as_ref(), &source, &self.data).map_or(wgsl::NONE, |(d, t)| {
                        inner.dictionaries.field(d.name(), &t.name, &column.name).code(&text.text)
                    });
                    shown.constants[text.constant as usize] = code;
                }
            }
        }
        waiting
    }

    /// Places every mark's rows in the state, focus, and domain buffers, vertices first so a vertex's
    /// graph slot is its index among all vertices; then points edge ends at their vertex marks.
    fn layout(&mut self) {
        let (mut state, mut focus, mut domains) = (0, 0, 0);
        let order: Vec<usize> = (0..self.marks.len())
            .filter(|&i| self.marks[i].kind() == MarkKind::Vertices)
            .chain((0..self.marks.len()).filter(|&i| self.marks[i].kind() != MarkKind::Vertices))
            .collect();
        for i in order {
            let shown = &mut self.marks[i];
            if shown.offset != state || shown.focus != focus || shown.domains != domains {
                shown.all_dirty();
            }
            shown.offset = state;
            shown.focus = focus;
            shown.domains = domains;
            state += shown.rows * shown.stride();
            focus += shown.rows;
            domains += shown.reductions();
        }
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

/// The graph slot of vertex 0 of each table mark `i`'s ends name, or `NONE` where no vertex mark of
/// its data draws that table.
fn ends(marks: &[Shown], i: usize) -> Vec<u32> {
    let Some(compiled) = &marks[i].compiled else { return Vec::new() };
    let data = &marks[i].mark.style().data;
    compiled
        .program
        .ends
        .iter()
        .map(|table| {
            marks
                .iter()
                .find(|m| {
                    m.kind() == MarkKind::Vertices
                        && m.compiled.is_some()
                        && m.mark.style().data == *data
                        && m.mark.style().table == *table
                })
                .map_or(wgsl::NONE, |m| m.offset / wgsl::VERTEX_WORDS)
        })
        .collect()
}
