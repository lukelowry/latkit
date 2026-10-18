//! Labels: each labeled mark keeps, in the labels buffer, a candidate per row and a run table from
//! its text codes to where the atlas holds each text, or, until the text is set, an estimate of its
//! size. Draws place every label from its anchor each frame. Placement decides which show: it runs
//! on the GPU when the camera, a labeled mark's state, or a run table changed, as candidates, then
//! rounds of claim and decide on a grid of cells, and labels fade in and out after it. Only placed
//! labels ask for their texts, so the host sets no more texts than fit on screen however many rows
//! are labeled. A diagram's labels scale with the sheet and show wherever they fit, so there
//! placement only gathers the texts the atlas lacks. Those are read back, with the texts of labels
//! shown, which the atlas keeps; the host sets a few each frame, and they show the frame after.

use std::collections::HashMap;
use std::ops::Range;
use std::time::Duration;

use web_time::Instant;

use super::View;
use super::passes::{dispatch, offset};
use super::resources::EyeSlot;
use super::sync::{Source, table_of};
use crate::Space;
use crate::derive::{Derived, stamp_of};
use crate::gpu::Inner;
use crate::gpu::atlas::{self, Glyphs};
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::host::TextRun;

/// Rounds of claim and decide each placement runs.
const ROUNDS: u32 = 6;
/// Seconds labels fade in or out over.
const FADE: f64 = 0.2;
/// Texts the host sets per frame at most, and the time setting them and making their distance
/// fields may take.
const BUDGET: usize = 48;
const BUDGET_TIME: Duration = Duration::from_millis(4);

/// Where one labeled mark's words lie in the labels buffer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Slots {
    pub(crate) candidates: u32,
    pub(crate) runs: u32,
    pub(crate) wanted: u32,
    pub(crate) seen: u32,
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
    /// Labels fade until then, on the view's clock.
    fading: Option<f64>,
    /// Whether the last placement that landed asked for texts, which the next one shows.
    wanting: bool,
    /// Each labeled mark's written codes, with the run and where it lay.
    written: HashMap<usize, HashMap<u32, (TextRun, Glyphs)>>,
    /// Each labeled mark's codes whose run table entries hold a run or an estimate.
    estimated: HashMap<usize, u32>,
    evictions: u64,
    /// Bumps whenever a run table changes.
    changes: u64,
}

impl Labels {
    /// Whether every label placed shows its text: no placement is read back, and the last asked
    /// for no text it lacked.
    pub(crate) fn complete(&self) -> bool {
        !self.placed.busy() && !self.wanting
    }

    /// Whether labels are fading in or out at `now` on the view's clock.
    pub(crate) fn fading(&self, now: f64) -> bool {
        self.fading.is_some_and(|until| now < until)
    }

    pub(crate) fn slots(&self, mark: usize) -> Option<Slots> {
        self.slots.get(mark).copied().flatten()
    }
}

impl View {
    /// The run each code of mark `i`'s label text is set as: at the base size, whatever size it shows
    /// at, as a diagram's sheet measures it.
    fn run_of(&self, i: usize, code: u32, inner: &mut Inner) -> Option<TextRun> {
        let shown = &self.marks[i];
        let compiled = shown.compiled.as_ref()?;
        let labeling = compiled.drawing.label.as_ref()?;
        let column = &compiled.program.columns[labeling.column as usize];
        let style = shown.mark.style();
        let data = self.drawn(&style.data)?;
        let source = Source { data, table: data.table(&style.table)?, derived: [None; 2] };
        let (d, t) = table_of(column, &source, &self.data)?;
        let text = inner.dictionaries.field(d, &t.name, &column.name).text(code)?.clone();
        Some(atlas::run(text, self.scene.theme.font.clone(), labeling.size, labeling.max_width))
    }

    /// Codes mark `i`'s label text has so far.
    fn codes_of(&self, i: usize, inner: &mut Inner) -> u32 {
        let shown = &self.marks[i];
        let Some(compiled) = &shown.compiled else { return 0 };
        let Some(labeling) = &compiled.drawing.label else { return 0 };
        let column = &compiled.program.columns[labeling.column as usize];
        let style = shown.mark.style();
        let Some(data) = self.drawn(&style.data) else { return 0 };
        let Some(table) = data.table(&style.table) else { return 0 };
        let source = Source { data, table, derived: [None; 2] };
        let Some((d, t)) = table_of(column, &source, &self.data) else { return 0 };
        inner.dictionaries.field(d, &t.name, &column.name).len() as u32
    }

    /// Sets the texts a placement asked for, within the frame's budget; placement asks again for
    /// those left.
    pub(super) fn settle_labels(&mut self, inner: &mut Inner) {
        let Some((_, bytes)) = self.labels.placed.landed() else { return };
        let asked = std::mem::take(&mut self.labels.asked);
        let words: &[u32] = bytemuck::cast_slice(&bytes);
        let gpu = self.gpu.clone();
        let started = Instant::now();
        let (mut set, mut left) = (0, false);
        'marks: for (i, slots) in asked {
            if self.labels.slots(i) != Some(slots) {
                continue;
            }
            let first = self.labels.slots.iter().flatten().map(|s| s.wanted).min().unwrap_or(0);
            // Texts labels show stay in the atlas.
            let seen = (slots.seen - first) as usize;
            if let (Some(bits), Some(written)) =
                (words.get(seen..seen + (slots.codes / 32) as usize), self.labels.written.get(&i))
            {
                for (k, &word) in bits.iter().enumerate() {
                    let mut word = word;
                    while word != 0 {
                        let code = k as u32 * 32 + word.trailing_zeros();
                        word &= word - 1;
                        if let Some((run, _)) = written.get(&code) {
                            inner.atlas.touch(run);
                        }
                    }
                }
            }
            let at = (slots.wanted - first) as usize;
            let count = words.get(at).copied().unwrap_or(0).min(wgsl::WANTED) as usize;
            let mut codes: Vec<u32> = words.get(at + 1..at + 1 + count).unwrap_or(&[]).to_vec();
            codes.sort_unstable();
            codes.dedup();
            for code in codes.into_iter().take_while(|&code| code < slots.codes) {
                if set == BUDGET || started.elapsed() > BUDGET_TIME {
                    left = true;
                    break 'marks;
                }
                let Some(run) = self.run_of(i, code, inner) else { continue };
                let host = inner.host.clone();
                let Some(glyphs) = inner.atlas.text(&gpu.0.queue, host.as_deref(), &run) else { continue };
                set += 1;
                self.write_run(i, slots, code, run, glyphs);
            }
        }
        self.labels.wanting = set > 0 || left;
        if self.labels.wanting {
            self.labels.changes += 1;
            self.wake();
        }
    }

    fn write_run(&mut self, i: usize, slots: Slots, code: u32, run: TextRun, glyphs: Glyphs) {
        let words = glyphs.corners();
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
        // Wanted codes, then seen codes, so one copy reads them all; then the cells; then each mark's
        // candidates and run table.
        let mut at = 0;
        let codes: Vec<u32> = labeled.iter().map(|&i| self.codes_of(i, inner).next_power_of_two().max(64)).collect();
        for &i in &labeled {
            slots[i] = Some(Slots { candidates: 0, runs: 0, wanted: at, seen: 0, id: 0, rows: 0, codes: 0 });
            at += 1 + wgsl::WANTED;
        }
        for (&i, &codes) in labeled.iter().zip(&codes) {
            let s = slots[i].as_mut().expect("labeled");
            s.seen = at;
            s.codes = codes;
            at += codes / 32;
        }
        let columns = (self.size[0] / f64::from(wgsl::CELL)).ceil().max(1.0) as u32;
        let rows = (self.size[1] / f64::from(wgsl::CELL)).ceil().max(1.0) as u32;
        let cells = [at, columns, rows];
        at += columns * rows;
        let mut id = 0;
        for &i in &labeled {
            let mark_rows = self.marks[i].region.capacity;
            let s = slots[i].as_mut().expect("labeled");
            s.candidates = at;
            s.rows = mark_rows;
            at += mark_rows * wgsl::CANDIDATE_WORDS;
            s.runs = at;
            at += 2 * s.codes;
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
            self.labels.estimated.clear();
            self.labels.placed = Derived::default();
            self.labels.asked.clear();
            self.labels.changes += 1;
        }
        if inner.atlas.evictions != self.labels.evictions {
            self.labels.evictions = inner.atlas.evictions;
            self.drop_evicted(inner);
            // Port labels look for their texts again where the atlas holds them now.
            for shown in self.marks.iter_mut().filter(|m| m.port_count() > 0) {
                shown.packed = false;
            }
        }
        self.estimate_runs(inner);
    }

    /// Writes the run table entries of each labeled mark's codes new since the last frame: where the
    /// atlas holds a text, else an estimate of its size, so its label is placed before it is set.
    fn estimate_runs(&mut self, inner: &mut Inner) {
        for i in 0..self.labels.slots.len() {
            let Some(slots) = self.labels.slots[i] else { continue };
            let from = self.labels.estimated.get(&i).copied().unwrap_or(0);
            let codes = self.codes_of(i, inner).min(slots.codes);
            if codes <= from {
                continue;
            }
            let words = self.run_words(i, from..codes, inner);
            if let Some(resources) = &self.resources {
                let at = u64::from(slots.runs + 2 * from) * 4;
                self.gpu.0.queue.write_buffer(resources.labels(), at, bytemuck::cast_slice(&words));
            }
            self.labels.estimated.insert(i, codes);
            self.labels.changes += 1;
        }
    }

    /// The run table words of mark `i`'s codes `codes`: where the atlas holds each text set, and an
    /// estimate of the rest.
    fn run_words(&self, i: usize, codes: Range<u32>, inner: &mut Inner) -> Vec<u32> {
        let shown = &self.marks[i];
        let written = self.labels.written.get(&i);
        let texts = 'texts: {
            let Some(compiled) = &shown.compiled else { break 'texts None };
            let Some(labeling) = &compiled.drawing.label else { break 'texts None };
            let column = &compiled.program.columns[labeling.column as usize];
            let style = shown.mark.style();
            let Some(data) = self.drawn(&style.data) else { break 'texts None };
            let Some(table) = data.table(&style.table) else { break 'texts None };
            let source = Source { data, table, derived: [None; 2] };
            let Some((d, t)) = table_of(column, &source, &self.data) else { break 'texts None };
            Some((inner.dictionaries.field(d, &t.name, &column.name), labeling))
        };
        let mut words = Vec::with_capacity(2 * codes.len());
        for code in codes {
            let entry = match (written.and_then(|w| w.get(&code)), &texts) {
                (Some((_, glyphs)), _) => glyphs.corners(),
                (None, Some((dictionary, labeling))) => dictionary.text(code).map_or([0, 0], |text| {
                    let font = self.scene.theme.font.clone();
                    atlas::estimate(&atlas::run(text.clone(), font, labeling.size, labeling.max_width))
                }),
                (None, None) => [0, 0],
            };
            words.extend(entry);
        }
        words
    }

    /// Puts estimates back in run table entries whose runs the atlas no longer holds where they were.
    fn drop_evicted(&mut self, inner: &Inner) {
        let mut cleared = Vec::new();
        for (&i, written) in &mut self.labels.written {
            let Some(slots) = self.labels.slots.get(i).copied().flatten() else { continue };
            written.retain(|&code, (run, glyphs)| {
                let held = inner.atlas.holds(run, *glyphs);
                if !held {
                    cleared.push((slots.runs + 2 * code, atlas::estimate(run)));
                }
                held
            });
        }
        if cleared.is_empty() {
            return;
        }
        if let Some(resources) = &self.resources {
            for (at, words) in &cleared {
                self.gpu.0.queue.write_buffer(resources.labels(), u64::from(*at) * 4, bytemuck::cast_slice(words));
            }
        }
        self.labels.changes += 1;
    }

    /// The labels' words of the frame uniform, the clock having moved `dt` seconds.
    pub(super) fn label_words(&mut self, frame: &mut wgsl::Frame, dt: f64) {
        let [cells, columns, rows] = self.labels.cells;
        frame.cells = cells;
        frame.cell_columns = columns;
        frame.cell_rows = rows;
        frame.label_fade = (dt / FADE).min(1.0) as f32;
    }

    /// Places labels when what they would show changed, and fades them; reads back the texts
    /// placement asked for.
    pub(super) fn place_labels(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, eye: &wgsl::Eye) {
        let labeled: Vec<(usize, Slots)> =
            self.labels.slots.iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).collect();
        if labeled.is_empty() {
            return;
        }
        // A diagram's labels follow the camera without placement; the camera only says which texts
        // they ask for.
        let diagram = matches!(self.scene.space, Space::Diagram(_));
        // What places labels: a color changing every frame moves none.
        let versions: Vec<u64> = labeled.iter().map(|&(i, _)| self.marks[i].place_version).collect();
        let stamp = stamp_of((bytemuck::bytes_of(eye), self.labels.changes, versions));
        let due = self.labels.placed.due(stamp) && !self.labels.placed.busy();
        let now = self.clock.now();
        let fading = !diagram && self.labels.fading(now);
        if !due && !fading {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before labels");
        if due {
            self.labels.placed.mark(stamp);
            if !diagram {
                self.labels.fading = Some(now + FADE + 0.05);
            }
            for &(_, slots) in &labeled {
                encoder.clear_buffer(resources.labels(), u64::from(slots.wanted) * 4, Some(4));
                encoder.clear_buffer(
                    resources.labels(),
                    u64::from(slots.seen) * 4,
                    Some(u64::from(slots.codes / 32) * 4),
                );
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
            }
            if due && !diagram {
                cells(&mut pass, &clear);
                for _ in 0..ROUNDS {
                    each(&mut pass, "claim");
                    each(&mut pass, "decide");
                    each(&mut pass, "occupy");
                    cells(&mut pass, &reset);
                }
                each(&mut pass, "ask");
            }
            if !diagram {
                each(&mut pass, "fade");
            }
        }
        if due {
            let first = labeled.iter().map(|(_, s)| s.wanted).min().unwrap_or(0);
            let seen: u64 = labeled.iter().map(|(_, s)| u64::from(s.codes / 32)).sum();
            let words = labeled.len() as u64 * u64::from(1 + wgsl::WANTED) + seen;
            let readback = Readback::new(
                &inner.readbacks,
                device,
                encoder,
                resources.labels(),
                u64::from(first) * 4,
                words * 4,
                &self.waker,
            );
            self.labels.placed.start(stamp, readback);
            self.labels.asked = labeled;
        }
    }

    /// Draws every labeled mark's labels, then every vertex mark's port labels: `glyphs` are the
    /// pass groups of the labels' and the port labels' shaders.
    pub(super) fn draw_labels(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        inner: &mut Inner,
        format: wgpu::TextureFormat,
        samples: u32,
        groups: &super::resources::Groups,
        glyphs: [(Shader, &wgpu::BindGroup); 2],
    ) {
        let device = &self.gpu.0.device;
        let [(labels, labels_group), (ports, ports_group)] = glyphs;
        for (i, slots) in self.labels.slots.iter().enumerate() {
            let shown = &self.marks[i];
            if slots.is_none() || shown.rows == 0 {
                continue;
            }
            let variant = Variant::draw(labels, format, samples).path(shown.path());
            pass.set_pipeline(&inner.pipelines.render_pipeline(device, variant));
            pass.set_bind_group(2, labels_group, &[]);
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            pass.draw(0..4, 0..shown.rows);
        }
        for (i, shown) in self.marks.iter().enumerate() {
            let labeled =
                shown.compiled.as_ref().is_some_and(|c| c.drawing.ports.iter().any(|(_, p, _)| p.label.is_some()));
            if !labeled || !shown.drawable() || shown.rows == 0 {
                continue;
            }
            pass.set_pipeline(&inner.pipelines.render(device, ports, format, samples));
            pass.set_bind_group(2, ports_group, &[]);
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            pass.draw(0..4, 0..shown.rows * shown.port_count());
        }
    }
}
