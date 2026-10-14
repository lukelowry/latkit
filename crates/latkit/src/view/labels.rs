//! Labels: each labeled mark keeps, in the labels buffer, a candidate per row and a run table from
//! its text codes to where the atlas holds each text. Placement runs on the GPU when the camera,
//! a labeled mark's state, or a run table changed: candidates, then rounds of claim and decide on a
//! grid of cells. Texts the atlas lacks are asked for in the same pass and read back; the host sets
//! a few each frame, and they show the frame after. Labels fade in and out after each placement.

use std::collections::HashMap;
use std::time::Duration;

use web_time::Instant;

use super::View;
use super::derived::{Derived, Landed, Work, stamp_of};
use super::passes::{dispatch, offset};
use super::resources::EyeSlot;
use super::sync::{Source, table_of};
use crate::gpu::Inner;
use crate::gpu::atlas::Glyphs;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::host::TextRun;

/// Rounds of claim and decide each placement runs.
const ROUNDS: u32 = 6;
/// How long labels fade in or out.
const FADE: Duration = Duration::from_millis(200);
/// Texts the host sets per frame at most.
const BUDGET: usize = 48;

/// Where one labeled mark's words lie in the labels buffer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Slots {
    pub(crate) candidates: u32,
    pub(crate) runs: u32,
    pub(crate) wanted: u32,
    pub(crate) id: u32,
    /// Rows and codes the slots hold.
    rows: u32,
    codes: u32,
}

#[derive(Default)]
pub(crate) struct Labels {
    /// Each labeled mark's slots, by mark.
    slots: Vec<Option<Slots>>,
    /// The cell grid: where it starts, its columns, and its rows.
    pub(crate) cells: [u32; 3],
    words: u32,
    /// What placement last ran from, and the readback of the texts it asked for.
    placed: Derived<()>,
    /// The labeled marks' slots when placement asked.
    asked: Vec<(usize, Slots)>,
    /// Labels fade until then.
    fading: Option<Instant>,
    last: Option<Instant>,
    /// Each labeled mark's written codes, with the run and where it lay.
    written: HashMap<usize, HashMap<u32, (TextRun, Glyphs)>>,
    evictions: u64,
    /// Bumps whenever a run table changes.
    changes: u64,
}

impl Labels {
    pub(crate) fn busy(&self) -> bool {
        self.placed.busy() || self.fading.is_some_and(|until| Instant::now() < until)
    }

    pub(crate) fn slots(&self, mark: usize) -> Option<Slots> {
        self.slots.get(mark).copied().flatten()
    }
}

impl View {
    /// The run each code of mark `i`'s label text is set as.
    fn run_of(&self, i: usize, code: u32, inner: &mut Inner) -> Option<TextRun> {
        let shown = &self.marks[i];
        let compiled = shown.compiled.as_ref()?;
        let labeling = compiled.drawing.label.as_ref()?;
        let column = &compiled.program.columns[labeling.column as usize];
        let style = shown.mark.style();
        let data = self.data(&style.data)?;
        let source = Source { data, table: data.table(&style.table)? };
        let (d, t) = table_of(column.of.as_ref(), &source, &self.data)?;
        let text = inner.dictionaries.field(d.name(), &t.name, &column.name).text(code)?.clone();
        let ratio = self.pixel_ratio;
        Some(TextRun {
            text,
            font: self.scene.theme.font.clone(),
            size_px: (labeling.size * ratio).round().max(1.0) as u32,
            max_width: labeling.max_width.map(|w| (w * ratio).round() as u32),
        })
    }

    /// Codes mark `i`'s label text has so far.
    fn codes_of(&self, i: usize, inner: &mut Inner) -> u32 {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return 0 };
        let Some(labeling) = &compiled.drawing.label else { return 0 };
        let column = &compiled.program.columns[labeling.column as usize];
        let style = shown.mark.style();
        let Some(data) = self.data(&style.data) else { return 0 };
        let Some(table) = data.table(&style.table) else { return 0 };
        let source = Source { data, table };
        let Some((d, t)) = table_of(column.of.as_ref(), &source, &self.data) else { return 0 };
        inner.dictionaries.field(d.name(), &t.name, &column.name).len() as u32
    }

    /// Sets the texts a placement asked for, within the frame's budget.
    pub(super) fn settle_labels(&mut self, inner: &mut Inner) {
        let Some((_, Landed::Read(bytes))) = self.labels.placed.landed() else { return };
        let asked = std::mem::take(&mut self.labels.asked);
        let words: &[u32] = bytemuck::cast_slice(&bytes);
        let gpu = self.gpu.clone();
        let mut budget = BUDGET;
        let mut wrote = false;
        for (i, slots) in asked {
            if self.labels.slots(i) != Some(slots) {
                continue;
            }
            let at = (slots.wanted - self.labels.slots.iter().flatten().map(|s| s.wanted).min().unwrap_or(0)) as usize;
            let count = words.get(at).copied().unwrap_or(0).min(wgsl::WANTED) as usize;
            let mut codes: Vec<u32> = words.get(at + 1..at + 1 + count).unwrap_or(&[]).to_vec();
            codes.sort_unstable();
            codes.dedup();
            for code in codes {
                if budget == 0 || code >= slots.codes {
                    break;
                }
                let Some(run) = self.run_of(i, code, inner) else { continue };
                let host = inner.host.clone();
                let Some(glyphs) = inner.atlas.text(&gpu.0.queue, host.as_deref(), &run) else { continue };
                budget -= 1;
                wrote = true;
                self.write_run(i, slots, code, run, glyphs);
            }
        }
        if wrote || budget == 0 {
            self.labels.changes += 1;
            self.wake();
        }
    }

    fn write_run(&mut self, i: usize, slots: Slots, code: u32, run: TextRun, glyphs: Glyphs) {
        let [l, t, r, b] = glyphs.rect;
        let words = [l | t << 16, r | b << 16];
        if let Some(resources) = &self.resources {
            let at = u64::from(slots.runs + 2 * code) * 4;
            self.gpu.0.queue.write_buffer(resources.labels(), at, bytemuck::cast_slice(&words));
        }
        self.labels.written.entry(i).or_default().insert(code, (run, glyphs));
    }

    /// Lays each labeled mark's slots out in the labels buffer, starting it over when they moved;
    /// drops run table entries the atlas evicted.
    pub(super) fn lay_out_labels(&mut self, inner: &mut Inner) {
        let mut slots: Vec<Option<Slots>> = vec![None; self.marks.len()];
        let labeled: Vec<usize> = (0..self.marks.len())
            .filter(|&i| {
                self.marks[i].drawable() && self.marks[i].compiled.as_ref().is_some_and(|c| c.drawing.label.is_some())
            })
            .collect();
        // Wanted codes first, so one copy reads them all; then the cells; then each mark's candidates
        // and run table.
        let mut at = 0;
        for &i in &labeled {
            slots[i] = Some(Slots { candidates: 0, runs: 0, wanted: at, id: 0, rows: 0, codes: 0 });
            at += 1 + wgsl::WANTED;
        }
        let columns = (self.size[0] / f64::from(wgsl::CELL)).ceil().max(1.0) as u32;
        let rows = (self.size[1] / f64::from(wgsl::CELL)).ceil().max(1.0) as u32;
        let cells = [at, columns, rows];
        at += columns * rows;
        let mut id = 0;
        for &i in &labeled {
            let mark_rows = self.marks[i].region.capacity;
            let codes = self.codes_of(i, inner).next_power_of_two().max(64);
            let s = slots[i].as_mut().expect("labeled");
            s.candidates = at;
            s.rows = mark_rows;
            at += mark_rows * wgsl::CANDIDATE_WORDS;
            s.runs = at;
            s.codes = codes;
            at += 2 * codes;
            s.id = id;
            id += mark_rows;
        }
        if slots != self.labels.slots || cells != self.labels.cells {
            let device = self.gpu.0.device.clone();
            if let Some(resources) = &mut self.resources {
                resources.replace_labels(&device, u64::from(at));
            }
            self.labels.slots = slots;
            self.labels.cells = cells;
            self.labels.words = at;
            self.labels.written.clear();
            self.labels.placed = Derived::default();
            self.labels.asked.clear();
            self.labels.changes += 1;
        }
        if inner.atlas.evictions != self.labels.evictions {
            self.labels.evictions = inner.atlas.evictions;
            self.drop_evicted(inner);
        }
    }

    /// Clears run table entries whose runs the atlas no longer holds where they were.
    fn drop_evicted(&mut self, inner: &Inner) {
        let mut cleared = Vec::new();
        for (&i, written) in &mut self.labels.written {
            let Some(slots) = self.labels.slots.get(i).copied().flatten() else { continue };
            written.retain(|&code, (run, glyphs)| {
                let held = inner.atlas.holds(run, *glyphs);
                if !held {
                    cleared.push(slots.runs + 2 * code);
                }
                held
            });
        }
        if cleared.is_empty() {
            return;
        }
        if let Some(resources) = &self.resources {
            for &at in &cleared {
                self.gpu.0.queue.write_buffer(resources.labels(), u64::from(at) * 4, &[0; 8]);
            }
        }
        self.labels.changes += 1;
    }

    /// The labels' words of the frame uniform.
    pub(super) fn label_words(&mut self, frame: &mut wgsl::Frame) {
        let now = Instant::now();
        let dt = self.labels.last.map_or(0.0, |last| now.duration_since(last).as_secs_f32());
        self.labels.last = Some(now);
        let [cells, columns, rows] = self.labels.cells;
        frame.cells = cells;
        frame.cell_columns = columns;
        frame.cell_rows = rows;
        frame.label_fade = (dt / FADE.as_secs_f32()).min(1.0);
    }

    /// Places labels when what they would show changed, and fades them; reads back the texts
    /// placement asked for.
    pub(super) fn place_labels(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, eye: &wgsl::Eye) {
        let labeled: Vec<(usize, Slots)> =
            self.labels.slots.iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).collect();
        if labeled.is_empty() {
            return;
        }
        let versions: Vec<u64> = labeled.iter().map(|&(i, _)| self.marks[i].version).collect();
        let stamp = stamp_of((bytemuck::bytes_of(eye), self.labels.changes, versions));
        let due = self.labels.placed.due(stamp) && !self.labels.placed.busy();
        let fading = self.labels.fading.is_some_and(|until| Instant::now() < until);
        if !due && !fading {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before labels");
        if due {
            self.labels.placed.mark(stamp);
            self.labels.fading = Some(Instant::now() + FADE + Duration::from_millis(50));
            for &(_, slots) in &labeled {
                encoder.clear_buffer(resources.labels(), u64::from(slots.wanted) * 4, Some(4));
            }
        }
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Labels);
        let [_, columns, rows] = self.labels.cells;
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit labels"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &groups.view, &[EyeSlot::Main.offset()]);
            pass.set_bind_group(2, &group, &[]);
            let marks: Vec<(usize, u32, u32)> =
                labeled.iter().map(|&(i, _)| (i, self.marks[i].rows, self.marks[i].path())).collect();
            let clear = inner.pipelines.compute(device, Shader::Labels, "clear_cells");
            let reset = inner.pipelines.compute(device, Shader::Labels, "reset_cells");
            let mut each = |pass: &mut wgpu::ComputePass<'_>, entry: &'static str| {
                for &(i, rows, path) in &marks {
                    let variant = Variant::compute(Shader::Labels, entry).path(path);
                    pass.set_pipeline(&inner.pipelines.compute_pipeline(device, variant));
                    pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                    dispatch(pass, rows);
                }
            };
            let cells = |pass: &mut wgpu::ComputePass<'_>, pipeline: &wgpu::ComputePipeline| {
                pass.set_bind_group(1, &groups.mark, &[offset(labeled[0].0)]);
                pass.set_pipeline(pipeline);
                dispatch(pass, columns * rows);
            };
            if due {
                each(&mut pass, "candidates");
                cells(&mut pass, &clear);
                for _ in 0..ROUNDS {
                    each(&mut pass, "claim");
                    each(&mut pass, "decide");
                    each(&mut pass, "occupy");
                    cells(&mut pass, &reset);
                }
            }
            each(&mut pass, "fade");
        }
        if due {
            let first = labeled.iter().map(|(_, s)| s.wanted).min().unwrap_or(0);
            let words = labeled.len() as u64 * u64::from(1 + wgsl::WANTED);
            let readback =
                Readback::new(&inner.readbacks, device, encoder, resources.labels(), u64::from(first) * 4, words * 4);
            self.labels.placed.start(stamp, Work::Read(readback));
            self.labels.asked = labeled;
        }
    }

    /// Draws every labeled mark's placed labels.
    pub(super) fn draw_labels(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        pipeline: &wgpu::RenderPipeline,
        groups: &super::resources::Groups,
        group: &wgpu::BindGroup,
    ) {
        let mut set = false;
        for (i, slots) in self.labels.slots.iter().enumerate() {
            if slots.is_none() || self.marks[i].rows == 0 {
                continue;
            }
            if !set {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(2, group, &[]);
                set = true;
            }
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            pass.draw(0..4, 0..self.marks[i].rows);
        }
    }
}
