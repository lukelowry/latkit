//! Labels.
//!
//! In the labels buffer, each labeled mark keeps a run table that maps its text codes to where the
//! atlas holds each text. Both words are 0 until the text is set. A number label's codes are the
//! characters it writes, so the GPU writes any number from a few texts. Preparation retains each
//! label's screen box until its placement inputs change. A label shows when its text is set, its row is visible, and the text fits,
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
use super::passes::offset;
use super::sync::Source;
use super::variants::{MarkVariants, Stage};
use crate::Name;
use crate::derive::{Derived, stamp_of};
use crate::gpu::Inner;
use crate::gpu::atlas::{self, Glyphs};
use crate::gpu::pipelines::Projection;
use crate::gpu::readback::Readback;
use crate::gpu::shaders as wgsl;
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
    pub(crate) metadata: u32,
    pub(crate) positions: u32,
    rows: u32,
    /// The number of codes its run table and seen bits have space for.
    codes: u32,
}

/// How a labeled mark sets its texts, and the font, size, and wrap width of its runs. A run table
/// holds texts set one way.
#[derive(Clone, PartialEq, Debug)]
struct Setting {
    texts: Texts,
    font: Arc<str>,
    size: f32,
    max_width: Option<f32>,
}

/// What a labeled mark's codes index: a text field, as dataset, table, and field, or the
/// characters a number label writes, with its unit.
#[derive(Clone, PartialEq, Debug)]
enum Texts {
    Field([Name; 3]),
    Number(Option<Arc<str>>),
}

impl Setting {
    /// The text of `code`.
    fn text(&self, code: u32, inner: &mut Inner) -> Option<Arc<str>> {
        match &self.texts {
            Texts::Field([data, table, field]) => inner.dictionaries.field(data, table, field).text(code).cloned(),
            Texts::Number(unit) => match code {
                0..=9 => Some(code.to_string().into()),
                wgsl::CHAR_POINT => Some(".".into()),
                wgsl::CHAR_MINUS => Some("-".into()),
                wgsl::CHAR_EXPONENT => Some("e".into()),
                wgsl::CHAR_UNIT => unit.clone(),
                _ => None,
            },
        }
    }

    /// The number of codes so far.
    fn codes(&self, inner: &mut Inner) -> u32 {
        match &self.texts {
            Texts::Field([data, table, field]) => inner.dictionaries.field(data, table, field).len() as u32,
            Texts::Number(_) => wgsl::NUMBER_CODES,
        }
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
    /// How mark `i` sets its label texts: as a number's characters, or from its text field wherever
    /// it is, in the mark's table, a joined one, or a table derived beside it. `None` while the mark
    /// has no label or the table with its text is missing.
    fn setting(&self, i: usize) -> Option<Setting> {
        let shown = &self.marks[i];
        let compiled = shown.compiled.as_ref()?;
        let labeling = compiled.drawing.label.as_ref()?;
        let (texts, max_width) = if let Some((_, unit)) = &labeling.number {
            (Texts::Number(unit.clone()), None)
        } else {
            let column = &compiled.program.columns[labeling.column as usize];
            let source = Source::of(shown.mark.style(), &self.snapshots, &self.derived)?;
            let (data, table) = source.table_of(column, &self.snapshots)?;
            (Texts::Field([data.clone(), table.name.clone(), column.name.clone()]), labeling.max_width)
        };
        Some(Setting { texts, font: labeling.font.clone(), size: labeling.size, max_width })
    }

    /// The text run for code `code` of mark `i`'s label text, at the base size regardless of the
    /// size it shows at.
    fn run_of(&self, i: usize, code: u32, inner: &mut Inner) -> Option<TextRun> {
        let setting = self.setting(i)?;
        let text = setting.text(code, inner)?;
        Some(atlas::run(text, setting.font, setting.size, setting.max_width))
    }

    /// The number of codes mark `i`'s label text has so far.
    fn codes_of(&self, i: usize, inner: &mut Inner) -> u32 {
        self.setting(i).map_or(0, |setting| setting.codes(inner))
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
                // An empty text gives no label, so it claims no screen cells. A host pads even an
                // empty run, so it is never rasterized.
                let blank = run.text.trim().is_empty();
                let host = inner.host.clone();
                let glyphs = if blank { None } else { inner.atlas.text(host.as_deref(), &run) };
                // With no atlas space left this frame, the remaining texts are asked for again once
                // the view changes.
                if glyphs.is_none() && !blank && inner.atlas.full() {
                    break 'marks;
                }
                set += 1;
                match glyphs {
                    Some(glyphs) => self.write_run(i, slots, code, run, glyphs),
                    // A text that draws nothing gives no label too.
                    None => self.write_words(slots, code, [wgsl::NONE; 2]),
                }
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
            resources.labels().write(&self.gpu.0.queue, slots.runs + 4 * code, &[words[0], words[1], 0, 0]);
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
            let rows = self.marks[i].rows.max(1).next_power_of_two().max(self.labels.slots(i).map_or(0, |s| s.rows));
            slots[i] = Some(Slots { runs: 0, wanted: at, seen: 0, codes: 0, metadata: 0, positions: 0, rows });
            at += (1 + wgsl::WANTED).next_multiple_of(4);
        }
        for (&i, &codes) in labeled.iter().zip(&codes) {
            let s = slots[i].as_mut().expect("labeled");
            s.seen = at;
            s.codes = codes;
            at += (codes / 32).next_multiple_of(4);
        }
        for &i in &labeled {
            let s = slots[i].as_mut().expect("labeled");
            s.runs = at;
            at += 4 * s.codes;
        }
        for &i in &labeled {
            let s = slots[i].as_mut().expect("labeled");
            s.metadata = at;
            at += 4 * s.rows;
            s.positions = at;
            at += 4 * s.rows;
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
            let words: Vec<u32> = consecutive
                .iter()
                .flat_map(|code| {
                    let [a, b] = written[code].1.corners();
                    [a, b, 0, 0]
                })
                .collect();
            resources.labels().write(&self.gpu.0.queue, slots.runs + 4 * consecutive[0], &words);
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
                    cleared.push(slots.runs + 4 * code);
                }
                held
            });
        }
        if cleared.is_empty() {
            return;
        }
        if let Some(resources) = &self.resources {
            for &at in &cleared {
                resources.labels().write(&self.gpu.0.queue, at, &[0; 4]);
            }
        }
        self.labels.changes += 1;
    }

    /// Claims the screen cells labels cover, and runs the texts pass, when their inputs changed.
    /// Claims run in every such frame, since that frame's labels show from them. The texts pass
    /// waits while its last readback is in flight, and while a fit is about to move the camera.
    /// Both wait until the text pipelines have compiled.
    pub(super) fn place_labels(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        inner: &mut Inner,
        eye: &wgsl::Eye,
        frame: &wgsl::Frame,
    ) {
        if !self.can_use(Stage::Text) {
            return;
        }
        let labeled: Vec<(usize, Slots)> =
            self.labels.slots.iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).collect();
        if labeled.is_empty() {
            return;
        }
        // What the passes read: a color changing every frame moves no label.
        // An edge label also follows the marks supplying its endpoints. Transitions, tile
        // growth, and hover growth move anchors even when no position channel was re-evaluated.
        let versions: Vec<_> = self.marks.iter().map(|m| (m.places_drawn(), m.rows, m.reveal.to_bits())).collect();
        // The eye's matrix is relative to the frame's origin. Panning can change that origin
        // without changing the matrix, but still moves every label's screen claim.
        let projection = (
            frame.center_hi.map(f32::to_bits),
            frame.center_lo.map(f32::to_bits),
            frame.space,
            frame.globe.to_bits(),
            frame.mercator_y.to_bits(),
            frame.bow.to_bits(),
        );
        let stamp = stamp_of((
            bytemuck::bytes_of(eye),
            projection,
            self.labels.changes,
            versions,
            self.scene_version,
            &self.focus.hovered,
            frame.grow.to_bits(),
        ));
        let claim = self.labels.claimed != Some(stamp);
        let gather = self.labels.gathered.due(stamp) && !self.labels.gathered.busy() && !self.fitting.framing();
        if !claim && !gather {
            return;
        }
        let gpu = self.gpu.clone();
        let device = &gpu.0.device;
        let resources = self.resources.as_mut().expect("created before labels");
        let cells = |side: f32| ((side + 2.0 * wgsl::LABEL_MARGIN * side) / wgsl::LABEL_CELL).ceil() as u32 + 1;
        resources.label_cells(device, eye.size.map(cells));
        let groups = resources.groups(&gpu.0, inner);
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
        let mut raster =
            crate::gpu::raster::Raster { device, queue: &gpu.0.queue, pipelines: &mut inner.pipelines, encoder };
        if claim {
            for (index, &(i, slots)) in labeled.iter().enumerate() {
                let rows = self.marks[i].rows;
                inner.texts.metadata(
                    &mut raster,
                    &input(i),
                    resources.labels(),
                    MarkVariants::shown(&self.marks[i], &self.scene.space).label_passes()[0],
                    rows,
                    [slots.metadata, slots.positions],
                );
                crate::gpu::texts::Texts::claim(
                    &mut raster,
                    &input(i),
                    resources.labels(),
                    resources.cells(),
                    rows,
                    index == 0,
                );
            }
            self.labels.claimed = Some(stamp);
        }
        if gather {
            self.labels.gathered.mark(stamp);
            for &(i, slots) in &labeled {
                let rows = self.marks[i].rows;
                let numeric = self.labels.settings[i].as_ref().is_some_and(|s| matches!(s.texts, Texts::Number(_)));
                inner.texts.gather(
                    &mut raster,
                    &input(i),
                    resources.labels(),
                    resources.cells(),
                    rows,
                    crate::gpu::texts::Request { numeric, codes: slots.codes, wanted: slots.wanted, seen: slots.seen },
                );
            }
            self.read_gathered(encoder, inner, labeled, stamp);
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
        let end = labeled.iter().map(|(_, s)| s.seen + (s.codes / 32).next_multiple_of(4)).max().unwrap_or(first);
        let readback =
            Readback::words(&inner.readbacks, &self.gpu.0.device, encoder, labels, first, end - first, &self.waker);
        self.labels.gathered.start(stamp, readback);
        self.labels.asked = labeled;
    }
}

impl View {
    /// Draws every labeled mark's labels. `glyphs` is the pass bind group of the glyph shader.
    #[allow(clippy::too_many_arguments, reason = "the main pass's draw state")]
    pub(super) fn draw_labels(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        drawn: &mut super::passes::Drawn,
        inner: &mut Inner,
        format: wgpu::TextureFormat,
        samples: u32,
        groups: &super::resources::Groups,
        glyphs: &wgpu::BindGroup,
    ) {
        let device = &self.gpu.0.device;
        for (i, slots) in self.labels.slots.iter().enumerate() {
            let shown = &self.marks[i];
            if slots.is_none() || shown.rows == 0 {
                continue;
            }
            // A number label draws each character as an instance.
            let numbered =
                shown.compiled.as_ref().and_then(|c| c.drawing.label.as_ref()).is_some_and(|l| l.number.is_some());
            let per = if numbered { wgsl::NUMBER_CHARS } else { 1 };
            pass.set_pipeline(
                &inner.pipelines.render(device, MarkVariants::shown(shown, &self.scene.space).glyphs(format, samples)),
            );
            pass.set_bind_group(2, glyphs, &[]);
            pass.set_bind_group(1, &groups.mark, &[offset(i)]);
            let grid = self.size.map(|side| {
                let side = side as f32;
                ((side + 2.0 * wgsl::LABEL_MARGIN * side) / wgsl::LABEL_CELL).ceil() as u32
            });
            let outside = shown.compiled.as_ref().is_some_and(|c| {
                shown.kind().primitive() != crate::scene::mark::Primitive::Points
                    || (c.drawing.flags & wgsl::SIZED == 0 && c.drawing.markers.marker != wgsl::MARKER_BLOCK)
            });
            let items = if outside { shown.rows.min(grid[0] * grid[1]) } else { shown.rows };
            drawn.draw(pass, 4, items * per);
        }
    }
}
