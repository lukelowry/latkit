//! Labels.
//!
//! In the labels buffer, each labeled mark keeps a run table that maps its text codes to where the
//! atlas holds each text. Both words are 0 until the text is set. Draws place every label from its
//! anchor each frame. A label shows when its text is set, its row is visible, and the text fits,
//! for example inside a block. No label depends on another label or on an earlier frame. A row
//! whose text is missing has no label.
//!
//! Labels beside their rows compete for screen space. When the camera, a labeled mark's places, or
//! a run table changes, the claim pass writes each such label's claim into the screen cells its
//! text covers. Until its text is set, a label claims the cells a short text would cover. Each cell
//! keeps the claim of the row drawn on top. A label shows only if it kept every cell it covers, so
//! labels never overlap. Only labels that keep their cells need texts, so however large the data,
//! the texts in view are only as many as fit on the screen. The claims depend on that frame alone.
//!
//! The texts pass then finds the texts those labels need. Each label near the view whose text the
//! atlas lacks asks for it, and each one in view whose text is set marks it seen. The host reads
//! both back, sets a few of the asked texts each frame within a budget, and touches the seen ones
//! so the atlas keeps them. A text shows the frame after it is set. When the atlas has no space
//! left beyond what the texts in view use, the rest wait. A run table grows with its mark's texts,
//! and the new one starts with every text already set, so labels keep showing.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use web_time::Instant;

use super::View;
use super::passes::{dispatch, offset};
use super::sync::Source;
use super::variants::MarkVariants;
use crate::Name;
use crate::derive::{Derived, stamp_of};
use crate::gpu::Inner;
use crate::gpu::atlas::{self, Glyphs};
use crate::gpu::dictionary::Dictionary;
use crate::gpu::pipelines::Variant;
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::host::TextRun;

/// The most texts the host sets per frame, and the most time setting them and building their
/// distance fields may take.
const BUDGET: usize = 48;
const BUDGET_TIME: Duration = Duration::from_millis(4);

/// Where one labeled mark's words lie in the labels buffer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Slots {
    pub(crate) runs: u32,
    pub(crate) wanted: u32,
    pub(crate) seen: u32,
    /// The number of codes its run table and seen bits have space for.
    codes: u32,
}

/// How a labeled mark sets its texts: the field its codes index, as dataset, table, and field, and
/// the font, size, and wrap width of its runs. A run table holds texts set one way.
#[derive(Clone, PartialEq, Debug)]
struct Setting {
    field: [Name; 3],
    font: Arc<str>,
    size: f32,
    max_width: Option<f32>,
}

impl Setting {
    /// The dictionary of the field's codes.
    fn dictionary<'g>(&self, inner: &'g mut Inner) -> &'g mut Dictionary {
        let [data, table, field] = &self.field;
        inner.dictionaries.field(data, table, field)
    }
}

#[derive(Default)]
pub(crate) struct Labels {
    /// Each labeled mark's slots and setting, by mark.
    slots: Vec<Option<Slots>>,
    settings: Vec<Option<Setting>>,
    /// The stamp the claim pass last ran from.
    claimed: Option<u64>,
    /// The stamp the texts pass last ran from, and the readback of the texts it gathered.
    gathered: Derived<()>,
    /// The labeled marks' slots when the texts pass ran.
    asked: Vec<(usize, Slots)>,
    /// Whether the last readback led to texts being set (or left to set), so the next texts pass
    /// runs to ask again.
    wanting: bool,
    /// Each labeled mark's codes whose texts are set, with the run and its glyphs in the atlas.
    written: HashMap<usize, HashMap<u32, (TextRun, Glyphs)>>,
    evictions: u64,
    /// Bumps whenever a run table changes.
    changes: u64,
}

impl Labels {
    /// Whether every label in view shows its text: no texts pass is being read back, and the last
    /// one asked for no missing text.
    pub(crate) fn complete(&self) -> bool {
        !self.gathered.busy() && !self.wanting
    }

    pub(crate) fn slots(&self, mark: usize) -> Option<Slots> {
        self.slots.get(mark).copied().flatten()
    }
}

impl View {
    /// How mark `i` sets its label texts, wherever its text field is: in the mark's table, a joined
    /// one, or a table derived beside it. `None` while the mark has no label or the table with its
    /// text is missing.
    fn setting(&self, i: usize) -> Option<Setting> {
        let shown = &self.marks[i];
        let compiled = shown.compiled.as_ref()?;
        let labeling = compiled.drawing.label.as_ref()?;
        let column = &compiled.program.columns[labeling.column as usize];
        let source = Source::of(shown.mark.style(), &self.snapshots, &self.derived)?;
        let (data, table) = source.table_of(column, &self.snapshots)?;
        Some(Setting {
            field: [data.clone(), table.name.clone(), column.name.clone()],
            font: labeling.font.clone(),
            size: labeling.size,
            max_width: labeling.max_width,
        })
    }

    /// The text run for code `code` of mark `i`'s label text, at the base size regardless of the
    /// size it shows at, as a diagram's sheet measures it.
    fn run_of(&self, i: usize, code: u32, inner: &mut Inner) -> Option<TextRun> {
        let setting = self.setting(i)?;
        let text = setting.dictionary(inner).text(code)?.clone();
        Some(atlas::run(text, setting.font, setting.size, setting.max_width))
    }

    /// The number of codes mark `i`'s label text has so far.
    fn codes_of(&self, i: usize, inner: &mut Inner) -> u32 {
        self.setting(i).map_or(0, |setting| setting.dictionary(inner).len() as u32)
    }

    /// Sets the texts the last texts pass asked for, within the frame's budget. The next pass asks
    /// for any left over.
    pub(super) fn settle_labels(&mut self, inner: &mut Inner) {
        let Some((_, bytes)) = self.labels.gathered.landed() else { return };
        let asked = std::mem::take(&mut self.labels.asked);
        let words = crate::wire::words(&bytes);
        let started = Instant::now();
        let (mut set, mut left) = (0, false);
        'marks: for (i, slots) in asked {
            if self.labels.slots(i) != Some(slots) {
                continue;
            }
            let first = self.labels.slots.iter().flatten().map(|s| s.wanted).min().unwrap_or(0);
            // Touch the texts shown labels use, so the atlas keeps them. The seen bit of a text not
            // set marks it asked for, and touches nothing.
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
                let Some(glyphs) = inner.atlas.text(host.as_deref(), &run) else {
                    // With no atlas space left this frame, the remaining texts are asked for again
                    // once the view changes.
                    if inner.atlas.full() {
                        break 'marks;
                    }
                    // A text that draws nothing, such as an empty one, gives no label, so it
                    // claims no screen cells.
                    set += 1;
                    self.write_words(slots, code, [wgsl::NONE; 2]);
                    continue;
                };
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
        self.write_words(slots, code, glyphs.corners());
        self.labels.written.entry(i).or_default().insert(code, (run, glyphs));
    }

    /// Writes `code`'s run table entry.
    fn write_words(&self, slots: Slots, code: u32, words: [u32; 2]) {
        if let Some(resources) = &self.resources {
            let at = u64::from(slots.runs + 2 * code) * 4;
            self.gpu.0.queue.write_buffer(resources.labels(), at, bytemuck::cast_slice(&words));
        }
    }

    /// Lays out each labeled mark's slots in the labels buffer, and fixes run table entries whose
    /// texts the atlas evicted. When the layout or a mark's setting changed, it replaces the buffer
    /// and writes back every text still set as before, so labels keep showing. A mark that stopped
    /// being labeled, or sets its texts another way, starts over.
    pub(super) fn lay_out_labels(&mut self, inner: &mut Inner) {
        let mut slots: Vec<Option<Slots>> = vec![None; self.marks.len()];
        let labeled: Vec<usize> = (0..self.marks.len())
            .filter(|&i| {
                self.marks[i].drawable() && self.marks[i].compiled.as_ref().is_some_and(|c| c.drawing.label.is_some())
            })
            .collect();
        // Every mark's wanted codes, then every mark's seen bits, so one copy reads them all. Then
        // each mark's run table.
        let mut at = 0;
        let codes: Vec<u32> = labeled.iter().map(|&i| self.codes_of(i, inner).next_power_of_two().max(64)).collect();
        for &i in &labeled {
            slots[i] = Some(Slots { runs: 0, wanted: at, seen: 0, codes: 0 });
            at += 1 + wgsl::WANTED;
        }
        for (&i, &codes) in labeled.iter().zip(&codes) {
            let s = slots[i].as_mut().expect("labeled");
            s.seen = at;
            s.codes = codes;
            at += codes / 32;
        }
        for &i in &labeled {
            let s = slots[i].as_mut().expect("labeled");
            s.runs = at;
            at += 2 * s.codes;
        }
        let settings: Vec<Option<Setting>> =
            (0..self.marks.len()).map(|i| slots[i].and_then(|_| self.setting(i))).collect();
        if slots != self.labels.slots || settings != self.labels.settings {
            let device = self.gpu.0.device.clone();
            if let Some(resources) = &mut self.resources {
                resources.replace_labels(&device, u64::from(at));
            }
            let before = std::mem::take(&mut self.labels.settings);
            let kept = |i: usize| settings.get(i).is_some_and(|s| s.is_some() && before.get(i) == Some(s));
            self.labels.written.retain(|&i, _| kept(i));
            self.labels.slots = slots;
            self.labels.settings = settings;
            for &i in &labeled {
                self.write_back(i);
            }
            self.labels.claimed = None;
            self.labels.gathered = Derived::default();
            self.labels.asked.clear();
            self.labels.changes += 1;
        }
        if inner.atlas.evictions != self.labels.evictions {
            self.labels.evictions = inner.atlas.evictions;
            self.drop_evicted(inner);
            // Repack port labels so they find their texts where the atlas now holds them.
            for shown in self.marks.iter_mut().filter(|m| m.port_count() > 0) {
                shown.packed = false;
            }
        }
    }

    /// Writes the run table entries of every text set for mark `i`, as into a new labels buffer.
    /// Consecutive codes write together.
    fn write_back(&self, i: usize) {
        let (Some(resources), Some(slots), Some(written)) =
            (&self.resources, self.labels.slots(i), self.labels.written.get(&i))
        else {
            return;
        };
        let mut codes: Vec<u32> = written.keys().copied().filter(|&code| code < slots.codes).collect();
        codes.sort_unstable();
        for consecutive in codes.chunk_by(|a, b| *b == *a + 1) {
            let words: Vec<u32> = consecutive.iter().flat_map(|code| written[code].1.corners()).collect();
            let at = u64::from(slots.runs + 2 * consecutive[0]) * 4;
            self.gpu.0.queue.write_buffer(resources.labels(), at, bytemuck::cast_slice(&words));
        }
    }

    /// Clears run table entries whose texts the atlas evicted or moved, so their labels hide until
    /// their texts are set again.
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
                self.gpu.0.queue.write_buffer(resources.labels(), u64::from(at) * 4, bytemuck::cast_slice(&[0_u32; 2]));
            }
        }
        self.labels.changes += 1;
    }

    /// Claims the screen cells labels cover, and runs the texts pass, when their inputs changed.
    /// Claims run in every such frame, since that frame's labels show from them. The texts pass
    /// waits while its last readback is in flight, and while a fit is about to move the camera.
    /// Both wait until the text pipelines have compiled.
    pub(super) fn place_labels(&mut self, encoder: &mut wgpu::CommandEncoder, inner: &mut Inner, eye: &wgsl::Eye) {
        if !self.texts() {
            return;
        }
        let labeled: Vec<(usize, Slots)> =
            self.labels.slots.iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).collect();
        if labeled.is_empty() {
            return;
        }
        // What the passes read: a color changing every frame moves no label.
        let versions: Vec<u64> = labeled.iter().map(|&(i, _)| self.marks[i].place_version).collect();
        let stamp = stamp_of((bytemuck::bytes_of(eye), self.labels.changes, versions));
        let claim = self.labels.claimed != Some(stamp);
        let gather = self.labels.gathered.due(stamp) && !self.labels.gathered.busy() && !self.fitting.framing();
        if !claim && !gather {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before labels");
        // The grid spans the view and a margin around it, a word per cell. One more cell each way
        // covers rounding.
        let cells =
            |side: f32| u64::from(((side + 2.0 * wgsl::LABEL_MARGIN * side) / wgsl::LABEL_CELL).ceil() as u32 + 1);
        let words = cells(eye.size[0]) * cells(eye.size[1]);
        let grid = resources.label_cells(device, words).clone();
        let groups = resources.groups(&gpu.0, inner);
        let group = resources.pass(device, inner, Shader::Texts);
        let mut run = |encoder: &mut wgpu::CommandEncoder, label: &str, entry: usize| {
            let mut pass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(label), timestamp_writes: None });
            pass.set_bind_group(0, &groups.view, &[]);
            pass.set_bind_group(2, &group, &[]);
            // A pipeline for each mark's primitive, which finds its rows' anchors.
            for &(i, _) in &labeled {
                let shown = &self.marks[i];
                pass.set_pipeline(&inner.pipelines.compute(device, MarkVariants::shown(shown).label_passes()[entry]));
                pass.set_bind_group(1, &groups.mark, &[offset(i)]);
                dispatch(&mut pass, shown.rows);
            }
        };
        if claim {
            encoder.clear_buffer(&grid, 0, Some(words * 4));
            run(encoder, "latkit label claims", 0);
            self.labels.claimed = Some(stamp);
        }
        if gather {
            self.labels.gathered.mark(stamp);
            self.forget_asked(encoder, &labeled);
            run(encoder, "latkit texts", 1);
            self.read_gathered(encoder, inner, labeled, stamp);
        }
    }

    /// Clears the texts each of `labeled` asked for and saw, before a texts pass asks again.
    fn forget_asked(&self, encoder: &mut wgpu::CommandEncoder, labeled: &[(usize, Slots)]) {
        let labels = self.resources.as_ref().expect("created before labels").labels();
        for &(_, slots) in labeled {
            encoder.clear_buffer(labels, u64::from(slots.wanted) * 4, Some(4));
            encoder.clear_buffer(labels, u64::from(slots.seen) * 4, Some(u64::from(slots.codes / 32) * 4));
        }
    }

    /// Reads back the texts the texts pass over `labeled` (from `stamp`) asked for and saw.
    fn read_gathered(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &Inner,
        labeled: Vec<(usize, Slots)>,
        stamp: u64,
    ) {
        let labels = self.resources.as_ref().expect("created before labels").labels();
        let first = labeled.iter().map(|(_, s)| s.wanted).min().unwrap_or(0);
        let seen: u64 = labeled.iter().map(|(_, s)| u64::from(s.codes / 32)).sum();
        let words = labeled.len() as u64 * u64::from(1 + wgsl::WANTED) + seen;
        let (device, offset) = (&self.gpu.0.device, u64::from(first) * 4);
        let readback = Readback::new(&inner.readbacks, device, encoder, labels, offset, words * 4, &self.waker);
        self.labels.gathered.start(stamp, readback);
        self.labels.asked = labeled;
    }
}

impl View {
    /// Draws every labeled mark's labels, then every vertex mark's port labels. `glyphs` holds the
    /// pass bind groups of their glyph shaders.
    #[allow(clippy::too_many_arguments, reason = "the main pass's draw state")]
    pub(super) fn draw_labels(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut super::passes::Drawn,
        inner: &mut Inner,
        format: wgpu::TextureFormat,
        samples: u32,
        groups: &super::resources::Groups,
        [labels_group, ports_group]: [&wgpu::BindGroup; 2],
    ) {
        let device = &self.gpu.0.device;
        for (i, slots) in self.labels.slots.iter().enumerate() {
            let shown = &self.marks[i];
            if slots.is_none() || shown.rows == 0 {
                continue;
            }
            pass.set_pipeline(&inner.pipelines.render(device, MarkVariants::shown(shown).glyphs(format, samples)));
            pass.set_bind_group(2, labels_group, &[]);
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            drawn.draw(pass, 4, shown.rows);
        }
        for (i, shown) in self.marks.iter().enumerate() {
            let labeled =
                shown.compiled.as_ref().is_some_and(|c| c.drawing.ports.iter().any(|(_, p, _)| p.label.is_some()));
            if !labeled || !shown.drawable() || shown.rows == 0 {
                continue;
            }
            pass.set_pipeline(&inner.pipelines.render(device, Variant::draw(Shader::GlyphsPorts, format, samples)));
            pass.set_bind_group(2, ports_group, &[]);
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            drawn.draw(pass, 4, shown.rows * shown.port_count());
        }
    }
}
