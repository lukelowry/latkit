//! The still: a texture holding what a frame draws up to a cut in its marks, so frames after it
//! draw only the marks that change. A frame starts from the still while the marks before the cut,
//! and the view as a whole (camera, size, theme, guides), draw as they did when it was drawn.
//!
//! The cut falls before the first mark that changed this frame, or after the first mark whose
//! comets move, which then draws its comets over the still that holds its rows: comets draw apart
//! from their rows, after them. When no mark changed, the still also holds every mark's opaque
//! pixels and frames keep its depth. Otherwise frames draw the backdrop's depth again and
//! the changed marks' opaque pixels over it, so where depth varies, the still holds only marks
//! standing on the ground: nothing drawn after them then lies behind them.
//!
//! Drawing a still costs a frame that draws its marks once more, which only frames after it repay.
//! So a cut draws a still from the second frame in a row that could start from it, or from the
//! first when the run before had more than one.

use super::View;
use super::passes::Work;
use super::resources::MARK_STRIDE;
use super::variants::Stage;
use crate::derive::stamp_of;
use crate::gpu::shaders as wgsl;

/// Where a frame starts from the still. The still holds the rows of the marks before `rows`. A frame
/// draws the comets of mark `comets` first, whose rows the still holds, then the marks from `rows`
/// on. With `opaque`, the still holds every mark's opaque pixels, and frames keep its depth.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) struct Cut {
    pub(super) rows: usize,
    pub(super) comets: Option<usize>,
    pub(super) opaque: bool,
}

/// A view's still: the cut this frame starts from, if it does, the cut the still holds, drawn in
/// the view stamped `view`, and the frames in a row up to this one, and in the run before, that
/// could start from the last cut in the last view.
#[derive(Default)]
pub(super) struct Still {
    pub(super) from: Option<Cut>,
    held: Option<Cut>,
    view: u64,
    last: Option<(Cut, u64)>,
    runs: [u32; 2],
}

impl Still {
    /// The cut the still holds.
    pub(super) fn held(&self) -> Option<Cut> {
        self.held
    }

    /// Notes that this frame drew `cut` into the still, or drew no still. A still that keeps its
    /// depth holds only until a frame draws whole, which leaves other depth behind.
    pub(super) fn drew(&mut self, cut: Option<Cut>) {
        match cut {
            Some(cut) => self.held = Some(cut),
            None if self.from.is_none() && self.held.is_some_and(|held| held.opaque) => self.held = None,
            None => {}
        }
    }
}

impl View {
    /// Chooses the frame's work (`[measure, travel, input]`, see `View::work`), lays out its marks'
    /// uniforms, and chooses whether it starts from the still, and at which cut, from those and the
    /// view's `uniform`, `eye`, and the overlay sprites drawn `under` the marks. First drops what the
    /// still holds once it no longer shows what this frame would draw. Returns the work and the
    /// marks' uniforms.
    pub(super) fn choose_still(
        &mut self,
        [measure, travel, input]: [bool; 3],
        uniform: &wgsl::Frame,
        eye: &wgsl::Eye,
        under: &[wgsl::Sprite],
    ) -> (Work, Vec<u8>) {
        let work = self.work(measure, travel, input);
        self.reveal();
        let marks = self.mark_uniforms();
        let changed = self.changed_marks(&work, &marks);
        let view = view_stamp(uniform, eye, under, self.drawn_area(), self.scene_version);
        let flowing = self.moving_comets();
        let any = |range: std::ops::Range<usize>| changed[range].iter().any(|&c| c);
        if let Some(held) = self.still.held {
            let after = if held.opaque { held.rows..changed.len() } else { 0..0 };
            // Comets moving on a mark the still holds the rows of draw over it, from its own cut only.
            let hidden = flowing.is_some_and(|f| f < held.rows && held.comets != Some(f));
            if self.still.view != view || any(0..held.rows) || any(after) || hidden {
                self.still.held = None;
            }
        }
        self.still.view = view;
        let cut = self.cut(&changed, flowing);
        let still = &mut self.still;
        let [run, before] = &mut still.runs;
        let this = cut.map(|cut| (cut, view));
        if this.is_some() && this == still.last {
            *run += 1;
        } else {
            if *run > 0 {
                *before = *run;
            }
            *run = u32::from(this.is_some());
        }
        still.last = this;
        let repays = *run > 1 || *before > 1;
        // A held still serves while it holds: frames draw the marks after it. One that keeps its
        // depth serves only its own cut. A cut holding more replaces it once it repays.
        let held = still.held.filter(|held| !held.opaque || Some(*held) == cut);
        still.from = match (held, cut) {
            (Some(held), Some(cut)) if cut.rows > held.rows && repays => Some(cut),
            (Some(held), _) => Some(held),
            (None, cut) => cut.filter(|_| repays),
        };
        (work, marks)
    }

    /// Whether each mark draws other than it did last frame: its uniform (but for what only this
    /// frame's evaluation reads, the channels it evaluates and the remap it freezes from, where its
    /// focus words lie, and its lit rows, which only the focus draw reads), its program words, its
    /// column tables, or its words changed, this frame's work rewrites what it draws from, the
    /// selection changed which of its rows dim, or its shade reads the clock or the pointer. A hover
    /// changes none of these: the focus draw draws the hovered rows over the still. A mark reading
    /// another's rows, as edges read their vertices', changes with it, but for its shade, which
    /// colors pixels and moves no row.
    fn changed_marks(&mut self, work: &Work, marks: &[u8]) -> Vec<bool> {
        let size = size_of::<wgsl::Mark>();
        let (mut changed, shaded): (Vec<bool>, Vec<bool>) = self
            .marks
            .iter_mut()
            .enumerate()
            .map(|(i, shown)| {
                let at = i * MARK_STRIDE as usize;
                let mut uniform: wgsl::Mark =
                    marks.get(at..at + size).map_or_else(bytemuck::Zeroable::zeroed, bytemuck::pod_read_unaligned);
                // Rows read focus words only while a selection lights rows, and focus pages that
                // move then mark the mark focused, so where they lie changes nothing drawn.
                (uniform.mask, uniform.remap, uniform.focus, uniform.focused, uniform.pieces) = (0, 0, 0, 0, 0);
                let uniform = bytemuck::bytes_of(&uniform);
                let drawn = stamp_of((uniform, &shown.written, shown.tables.generation(), shown.version));
                let shading = shown.compiled.as_ref().and_then(|c| c.drawing.shade.as_ref());
                let focused = std::mem::take(&mut shown.focused);
                let rows = (std::mem::replace(&mut shown.drawn, drawn) != drawn) | work.redraws(i) | focused;
                (rows, shading.is_some_and(|shading| shading.timed || shading.pointed))
            })
            .unzip();
        for i in 0..changed.len() {
            if self.marks[i].ends.iter().any(|end| end.mark.is_some_and(|m| changed[m])) {
                changed[i] = true;
            }
        }
        changed.iter().zip(shaded).map(|(&rows, shaded)| rows | shaded).collect()
    }

    /// The cut this frame could start from: before the first mark that changed, or after the first
    /// whose comets move, if it comes first. `None` when it would hold no mark, when the still of a
    /// frame where marks changed would hold a mark off the ground where depth varies, until the
    /// pipelines it draws with have landed, and while the camera is unplaced.
    fn cut(&self, changed: &[bool], flowing: Option<usize>) -> Option<Cut> {
        if self.unplaced() {
            return None;
        }
        let first = changed.iter().position(|&c| c);
        let cut = match (first, flowing) {
            (Some(c), f) if f.is_none_or(|f| c <= f) => Cut { rows: c, comets: None, opaque: false },
            (first, Some(f)) => Cut { rows: f + 1, comets: Some(f), opaque: first.is_none() },
            (_, None) => Cut { rows: self.marks.len(), comets: None, opaque: true },
        };
        let grounded = cut.opaque || !self.layered() || (0..cut.rows).all(|i| !self.heights_vary(i));
        // Frames where only comets move draw with the comets' pipelines. Other cuts wait for the
        // still's own.
        let ready =
            if cut.opaque && cut.comets.is_some() { self.can_use(Stage::Draw) } else { self.can_use(Stage::Changes) };
        (cut.rows > 0 && grounded && ready).then_some(cut)
    }

    /// The first mark whose comets travel.
    fn moving_comets(&self) -> Option<usize> {
        let comets = self.own_motion().0;
        self.marks.iter().position(|m| comets && m.drawable() && m.instances() > 0 && m.mark.flows())
    }
}

/// A stamp of what draws the same for every mark: the frame's uniform without what moves every frame
/// but no row's pixels (comets, the clock and pointer that channels and shades read, whose marks
/// change instead, and what probes and queries read), the eye, the overlay sprites under the marks,
/// the area marks draw in, and the scene.
fn view_stamp(
    uniform: &wgsl::Frame,
    eye: &wgsl::Eye,
    under: &[wgsl::Sprite],
    area: Option<super::camera::Area>,
    scene: u64,
) -> u64 {
    let mut frame = *uniform;
    frame.pointer = [0.0; 2];
    frame.probe = [0.0; 2];
    frame.query = [0.0; 4];
    frame.probe_radius = 0.0;
    frame.elapsed = 0.0;
    frame.fitting = 0;
    frame.flow_step = 0.0;
    frame.flow_time = 0.0;
    frame.flow = [0.0; 4];
    frame.probe_area = [0.0; 4];
    frame.probe_cover = [[0.0; 4]; 4];
    frame.probe_way = [0.0; 2];
    frame.probe_skip = [0; 2];
    frame.probe_covers = 0;
    let area = area.map(|a| a.map(f64::to_bits));
    stamp_of((bytemuck::bytes_of(&frame), bytemuck::bytes_of(eye), bytemuck::cast_slice::<_, u8>(under), area, scene))
}
