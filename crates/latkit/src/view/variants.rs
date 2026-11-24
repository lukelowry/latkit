//! The pipelines a scene uses, by what its frames use them for: each [`Stage`].
//!
//! Draw: for each kind of mark, its draw pipelines and the raster passes it needs (for a stroke
//! mark, those for the path it follows), and each mark's channel pipeline for what its channels
//! read. Where depth can vary, a mark's opaque draw shares its rows' program, so it costs no
//! compile, as its comets' draw does. Text: labels, glyphs, the distance fields text is set in, and
//! the overlay. Changes: the
//! passes that transitions and comet carry use. Lit: the lit rows' draws. Layers: the height sorts
//! frames use where depth varies. Fit: the passes measuring rows' extents for a
//! fit. Input: each kind of mark's probe program, which answers hover, picks, box selection, and
//! row location.
//!
//! The GPU compiles them through its queue, most urgent first ([`crate::gpu::pipelines`]). The view
//! draws once its draw pipelines are ready, and does without every other stage until its pipelines
//! are: frames show no text, no easing, no glow, and no height order, and fits, probes, and
//! queries wait.
//! A fit's passes are as urgent as drawing only while a fit will measure rows. Draw
//! recording never creates a missing pipeline, although a queued WebGL compile can still block
//! the browser thread. A view is complete once the stages
//! its frames draw with are ready, which never includes input. Pipelines the scene never uses are
//! never requested, and height sorts only once depth varies. A picture takes no input, and requests
//! everything it draws with at draw urgency.
//!
//! Each pipeline is named once, here: the passes shared by every mark as constants, and each mark's
//! own through [`MarkVariants`]. The view requests and runs them by these same names, so it runs
//! only what it requested.

use super::View;
use super::marks::Shown;
use crate::gpu::Inner;
use crate::gpu::atlas::FIELDS;
use crate::gpu::hooks::Hooks;
use crate::gpu::pipelines::{Asked, Options, Projection, Urgency, Variant};
use crate::gpu::shaders::{NONE, PATH_BENDS, PATH_ENDS, PATH_GEOMETRY, PATH_POLES, PATH_TRACE, STROKE_MARKERS, Shader};
use crate::scene::mark::{MarkKind, Primitive};
use crate::{Action, Mark, Scene, Space};

/// Writes the word of each drawn row of a paged mark from its runs.
pub(super) const EXPAND_RUNS: Variant = Variant::raster(Shader::Lists, "expand_runs");

/// The scan of a list's counts: a segment list's into each row's first instance, or a height
/// order's into where each digit's instances go.
pub(super) const SCAN: [Variant; 2] =
    [Variant::raster(Shader::Words, "scan_totals"), Variant::raster(Shader::Words, "scan")];

/// The passes sorting a height order by one digit of its keys, around a [`SCAN`]: counting each
/// block's instances by digit, ordering the counts by digit, then ranking and moving the
/// instances.
pub(super) const DIGIT_PASSES: [Variant; 4] = [
    Variant::raster(Shader::Order, "histogram"),
    Variant::raster(Shader::Order, "by_digit"),
    Variant::raster(Shader::Order, "rank"),
    Variant::raster(Shader::OrderScatter, "scatter"),
];

/// Counts each recorded segment's comet slots, then writes each slot, around a [`SCAN`].
pub(super) const COMET_SLOTS: [Variant; 2] =
    [Variant::raster(Shader::Comets, "count_slots"), Variant::raster(Shader::Comets, "slots")];

/// Eases a mark in transition from its frozen words toward its settled ones.
pub(super) const EASE: Variant = Variant::raster(Shader::State, "ease");

/// Writes how far comets have traveled into their rows, before their flows change or their rows
/// move, and every so often (see `View::comets_travel`).
pub(super) const TRAVEL: Variant = Variant::raster(Shader::State, "travel");

/// Carries comets' travel over to the rows a transition moved.
pub(super) const CARRY: Variant = Variant::raster(Shader::State, "carry");

/// Freezes the words a transition eases from.
pub(super) const GATHER: Variant = Variant::raster(Shader::State, "freeze");

/// Copies the pages the state passes wrote from their scratch into the arena.
pub(super) const PAGES: Variant = Variant::raster(Shader::WordsGather, "gather");

pub(super) use crate::gpu::pipelines::Draw;

/// What a mark's pipelines are specialized for: its kind, the `PATH_` code its rows follow, the
/// `MARKER_` code of each marker along its strokes (`NONE` past the last), and the hooks its draw
/// shaders call.
#[derive(Clone)]
pub(super) struct MarkVariants {
    kind: MarkKind,
    path: u32,
    projection: Projection,
    painted: bool,
    marker: u32,
    along: [u32; STROKE_MARKERS as usize],
    options: Options,
    hooks: Hooks,
}

impl MarkVariants {
    /// The variants `mark` uses in `scene`, requested before it compiles.
    fn of(mark: &Mark, scene: &Scene) -> MarkVariants {
        MarkVariants {
            kind: mark.kind(),
            path: mark.path(&scene.space),
            projection: Projection::of(&scene.space),
            // A stroke parts under its markers with the program that paints dashes and comets.
            painted: mark.measures_paths() || mark.marked(),
            marker: match mark {
                Mark::Vertices(vertices) => vertices.marker.code(),
                _ => 0,
            },
            along: std::array::from_fn(|k| mark.stroke_markers().get(k).map_or(NONE, |marker| marker.marker.code())),
            options: Options::MEET.when(mark.meets())
                | Options::TURNED.when(mark.turns())
                | Options::PLACED.when(mark.places_labels())
                | Options::HALO.when(match mark {
                    Mark::Edges(_) => scene.theme.edge.halo.value() > 0.0,
                    Mark::Lines(_) => scene.theme.line.halo.value() > 0.0,
                    Mark::Vertices(_) | Mark::Areas(_) => false,
                })
                | Options::ALONG.when(mark.marked() || mark.blended()),
            hooks: mark.hooks(),
        }
    }

    /// The variants `shown` runs.
    pub(super) fn shown(shown: &Shown, scene: &Scene) -> MarkVariants {
        MarkVariants { path: shown.path(), ..MarkVariants::of(&shown.mark, scene) }
    }

    fn primitive(&self) -> u32 {
        self.kind.primitive().code()
    }

    /// The shader for draw `draw`, calling the mark's hooks.
    pub(super) fn shader(&self, draw: Draw) -> Shader {
        let (every, focus) = self.kind.shaders(self.hooks.marker.is_some(), self.hooks.shade.is_some());
        match draw {
            Draw::Rows | Draw::Opaque | Draw::Comets | Draw::Depth => every,
            Draw::Lit => focus,
        }
    }

    /// The pass writing where each segment of a stroke mark lies on screen this frame, for its draws
    /// and for its lit draw, which read it (see `lib/screen.wesl`). A trace's segment and a point
    /// cost less to place than a record does, so their draws place them, and areas draw from their
    /// triangles.
    pub(super) fn screen(&self) -> Option<Variant> {
        let shader = match self.path {
            PATH_BENDS | PATH_GEOMETRY => Shader::ScreenProjected,
            _ => Shader::Screen,
        };
        (self.kind.primitive() == Primitive::Strokes && self.path != PATH_TRACE)
            .then(|| self.own(Variant::raster(shader, "record")))
    }

    /// `variant` for this mark's path and projection, with the options its shader holds code for.
    fn own(&self, variant: Variant) -> Variant {
        variant.path(self.path).projection(self.projection).options(self.options)
    }

    /// The pipeline for draw `draw`. The mark's hooks complete its shader.
    pub(super) fn draw(&self, draw: Draw, format: wgpu::TextureFormat, samples: u32) -> Asked {
        let variant = self
            .own(Variant::draw(self.shader(draw), format, samples).mode(draw))
            .painted(self.painted)
            .marker(self.marker);
        if self.hooks.is_empty() { Asked::Shader(variant) } else { Asked::Hooked(self.hooks.clone(), variant) }
    }

    /// The pipeline drawing marker `k` of those along its strokes, an instance a segment record
    /// (see `lib/along.wesl`): over its rows, or with [`Draw::Lit`], over its lit rows. `None` past
    /// its last marker.
    pub(super) fn marker(&self, k: usize, draw: Draw, format: wgpu::TextureFormat, samples: u32) -> Option<Variant> {
        let code = self.along.get(k).copied().filter(|&code| code != NONE)?;
        let shader = if draw == Draw::Lit { Shader::PointsFocus } else { Shader::Points };
        let options = Options::TURNED | Options::ALONG;
        Some(Variant::draw(shader, format, samples).projection(self.projection).marker(code).options(options))
    }

    /// The pass measuring its rows' extents for a fit. `None` for edges between their ends, which
    /// lie within their vertices' box. Edges through bends measure their points as lines do.
    pub(super) fn bounds(&self) -> Option<Variant> {
        let entry = match self.kind {
            MarkKind::Edges if self.path == PATH_BENDS => "strokes",
            kind => kind.bounds()?,
        };
        Some(self.own(Variant::raster(Shader::Bounds, entry)))
    }

    /// The passes counting each row's instances into its list, then writing them, around a
    /// [`SCAN`].
    pub(super) fn segments(&self, measured: bool) -> [Variant; 2] {
        [
            self.own(Variant::raster(Shader::Lists, "count_segments")),
            if measured {
                self.own(Variant::raster(Shader::Lists, "segments"))
            } else if self.kind == MarkKind::Areas {
                Variant::raster(Shader::Lists, "area_segments")
            } else {
                Variant::raster(Shader::Lists, "segments_unmeasured")
            },
        ]
    }

    /// The pass keying each instance by its height before [`DIGIT_PASSES`] sort its height order.
    pub(super) fn height_keys(&self) -> Variant {
        self.own(Variant::raster(Shader::Lists, "height_keys"))
    }

    /// Its program for the probe `shader`, which answers hover, queries, and the depth under the
    /// pointer for its geometry.
    pub(super) fn probe(&self, shader: Shader) -> Variant {
        self.own(Variant::probe(shader, self.primitive()))
    }

    /// The label passes: `claim`, which claims the screen cells its labels would cover, then
    /// `texts`, which finds the texts needed by the labels that kept their cells.
    pub(super) fn label_passes(&self) -> [Variant; 7] {
        [
            self.own(Variant::raster(Shader::Metadata, "metadata").primitive(self.primitive())),
            Variant::raster(Shader::Claims, "claim"),
            Variant::raster(Shader::Requests, "request"),
            Variant::raster(Shader::TextCodes, "bits"),
            Variant::raster(Shader::TextCodes, "counts"),
            Variant::raster(Shader::TextCodes, "gather"),
            Variant::raster(Shader::TextCodes, "seen"),
        ]
    }

    /// The pipeline drawing its labels' glyphs.
    pub(super) fn glyphs(&self, format: wgpu::TextureFormat, samples: u32) -> Variant {
        self.own(Variant::draw(Shader::Glyphs, format, samples).primitive(self.primitive()))
    }
}

/// What a view's frames use pipelines for. A view asks for each stage at its own urgency, and its
/// frames do without a stage until its pipelines land.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Stage {
    /// The marks. Until these land, the view draws nothing new.
    Draw,
    /// Labels, titles, legends, and the overlay.
    Text,
    /// Transitions: freezing, easing, and carrying comets.
    Changes,
    /// The glow of selected, hovered, and related rows.
    Lit,
    /// Sorting rows that stand at different heights to draw lowest first, where depth varies.
    Layers,
    /// Measuring rows' extents for a fit, which frames draw nothing with.
    Fit,
    /// Probes and queries, which draw nothing.
    Input,
}

impl Stage {
    const ALL: [Stage; 7] =
        [Stage::Draw, Stage::Text, Stage::Changes, Stage::Lit, Stage::Layers, Stage::Fit, Stage::Input];

    /// How soon a view asks for the stage. A picture takes no input, and asks for everything it
    /// draws with at draw urgency.
    fn urgency(self, input: bool) -> Urgency {
        match self {
            Stage::Draw => Urgency::Draw,
            _ if !input => Urgency::Draw,
            Stage::Text => Urgency::Text,
            Stage::Changes | Stage::Lit | Stage::Layers | Stage::Fit | Stage::Input => Urgency::Answer,
        }
    }
}

/// A set of stages.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(super) struct StageSet(u8);

impl StageSet {
    /// The set with `stage` added.
    pub(super) fn with(self, stage: Stage) -> StageSet {
        StageSet(self.0 | 1 << stage as u8)
    }

    pub(super) fn has(self, stage: Stage) -> bool {
        self.0 & 1 << stage as u8 != 0
    }

    /// Whether the two sets share a stage.
    pub(super) fn meets(self, other: StageSet) -> bool {
        self.0 & other.0 != 0
    }
}

/// Each stage's pipelines, for frames of one scene into one target.
#[derive(Default)]
struct Stages([Vec<Asked>; Stage::ALL.len()]);

impl Stages {
    fn of(&self, stage: Stage) -> &[Asked] {
        &self.0[stage as usize]
    }

    fn add(&mut self, stage: Stage, need: Asked) {
        self.0[stage as usize].push(need);
    }

    fn add_all(&mut self, stage: Stage, needs: impl IntoIterator<Item = Asked>) {
        self.0[stage as usize].extend(needs);
    }

    /// Keeps each stage's first request for a pipeline. Several marks can need the same one.
    fn dedupe(&mut self) {
        for needs in &mut self.0 {
            let mut seen = rustc_hash::FxHashSet::default();
            needs.retain(|need| seen.insert(need.clone()));
        }
    }
}

/// The pipelines a view requested for frames into one target, with or without input, by stage.
pub(super) struct Asking {
    target: (wgpu::TextureFormat, u32),
    input: bool,
    stages: Stages,
    after_draw: bool,
}

impl Asking {
    fn queue_following(&self, inner: &mut Inner, waker: &std::task::Waker) {
        for stage in [Stage::Text, Stage::Changes, Stage::Lit, Stage::Input] {
            if stage != Stage::Input || self.input {
                inner.pipelines.queue(self.stages.of(stage), stage.urgency(self.input), waker);
            }
        }
    }

    /// Whether frames ask for `stage`: input only when they take it, and layers only where depth
    /// varies, and fitting only when it must measure rows.
    fn asks(&self, stage: Stage, deep: bool, measure: bool) -> bool {
        match stage {
            Stage::Input => self.input,
            Stage::Layers => deep,
            Stage::Fit => measure,
            _ => true,
        }
    }
}

impl View {
    /// Requests the pipelines the scene's frames into `target` use, with or without `input`, each
    /// stage at its urgency, on the first call for that pair. Layers are requested once depth varies,
    /// and a fit's passes as urgently as drawing while a fit will measure rows. Every call also
    /// requests each mark's channel pipeline, whose variant depends on what the
    /// channels read, known once the data is. Each finished compile wakes the view. Returns the
    /// request's index in `asked`.
    pub(super) fn ask(
        &mut self,
        inner: &mut Inner,
        target: (wgpu::TextureFormat, u32),
        input: bool,
        needs: &[Asked],
    ) -> usize {
        let device = &self.gpu.0.device;
        let deep = self.deep();
        let measure = self.measures();
        let at = if let Some(at) = self.asked.iter().position(|a| a.target == target && a.input == input) {
            at
        } else {
            let after_draw = cfg!(target_arch = "wasm32") && input && self.scene.marks.iter().any(Mark::flows);
            let asking = Asking { target, input, stages: stages(&self.scene, target.0, target.1), after_draw };
            inner.pipelines.queue(asking.stages.of(Stage::Draw), Urgency::Draw, &self.compile_waker);
            if !asking.after_draw {
                asking.queue_following(inner, &self.compile_waker);
            }
            self.asked.push(asking);
            self.asked.len() - 1
        };
        // A flat view never draws in layers, so it compiles nothing for them. Asking again is free.
        if deep {
            inner.pipelines.queue(
                self.asked[at].stages.of(Stage::Layers),
                Stage::Layers.urgency(input),
                &self.compile_waker,
            );
        }
        // Explicit camera bounds and trace-window extents are already known on the CPU.
        if measure {
            inner.pipelines.queue(self.asked[at].stages.of(Stage::Fit), Urgency::Draw, &self.compile_waker);
        }
        inner.pipelines.ask(device, needs, Urgency::Draw, &self.compile_waker);
        at
    }

    /// Browser links for labels and interaction can occupy the same driver threads as geometry.
    /// Start them once the first interactive frame's commands have been recorded. Captures request
    /// their text up front and warmed programs are immediately usable across views.
    #[cfg(target_arch = "wasm32")]
    pub(super) fn recorded(&mut self, inner: &mut Inner, frame: &crate::Frame<'_>, input: bool) {
        if !input {
            return;
        }
        let target = (frame.format, self.samples(frame.pixel_ratio));
        if let Some(asking) = self.asked.iter_mut().find(|a| a.input && a.target == target)
            && std::mem::take(&mut asking.after_draw)
        {
            asking.queue_following(inner, &self.compile_waker);
            inner.pipelines.queue(&[Asked::Shader(TRAVEL)], Urgency::Draw, &self.compile_waker);
        }
    }

    /// Draw dependencies known after refreshing the data and planning its resident rows.
    pub(super) fn draw_work(&self) -> Vec<Asked> {
        let mut needs = channels(self.marks.iter());
        // A former paged drawing can remain visible until its replacement is published.
        if self.planning.plans().values().any(|p| p.draw != crate::derive::tiled::Draw::Whole)
            || self.marks.iter().any(|m| m.drawing().is_some())
        {
            needs.push(Asked::Shader(EXPAND_RUNS));
        }
        // The first frame has no elapsed travel. Later frames may change the flow
        // during layout and must be able to write the distance under the previous flow.
        if self.effect_time.is_finite() && self.marks.iter().any(|m| m.mark.flows()) {
            needs.push(Asked::Shader(TRAVEL));
        }
        needs
    }

    /// The multisample count of its frames at `pixel_ratio` (see [`samples`]).
    pub(super) fn samples(&self, pixel_ratio: f32) -> u32 {
        samples(&self.scene, self.gpu.samples_for(pixel_ratio))
    }

    /// The formats the view's frames draw into: those it asked pipelines for, else the GPU's
    /// default.
    pub(super) fn formats(&self) -> Vec<wgpu::TextureFormat> {
        let mut formats: Vec<_> = Vec::new();
        for asking in &self.asked {
            if !formats.contains(&asking.target.0) {
                formats.push(asking.target.0);
            }
        }
        if formats.is_empty() {
            formats.push(crate::gpu::FORMAT);
        }
        formats
    }

    /// Why the browser refused to build a pipeline the view asked for, if it refused one.
    pub(super) fn refusal(&self, inner: &Inner, needs: &[Asked]) -> Option<crate::Error> {
        let pipelines = &inner.pipelines;
        self.asked
            .iter()
            .flat_map(|a| Stage::ALL.map(|stage| a.stages.of(stage)))
            .find_map(|needs| pipelines.refused(needs))
            .or_else(|| pipelines.refused(needs))
    }

    /// The stages of request `at` whose pipelines have not all landed, and of those, the ones it
    /// asked for. Layers it has not asked for never land. Draw includes each mark's channels.
    pub(super) fn unready(&self, inner: &Inner, at: usize, needs: &[Asked]) -> (StageSet, StageSet) {
        let asking = &self.asked[at];
        let deep = self.deep();
        let measure = self.measures();
        let (mut unready, mut asked) = (StageSet::default(), StageSet::default());
        for stage in Stage::ALL {
            let landed = inner.pipelines.ready(asking.stages.of(stage));
            let landed = landed && (stage != Stage::Draw || inner.pipelines.ready(needs));
            if !landed && (stage != Stage::Input || asking.input) {
                unready = unready.with(stage);
                if asking.asks(stage, deep, measure) {
                    asked = asked.with(stage);
                }
            }
        }
        (unready, asked)
    }

    /// Whether frames draw in layers: depth varies, so opaque pixels draw first. The opaque draws
    /// share the draw pipelines' programs, so they are ready whenever the view draws.
    pub(super) fn layered(&self) -> bool {
        self.deep()
    }

    /// Whether frames sort rows that stand at different heights to draw lowest first: they draw in
    /// layers, and the sorts have compiled.
    pub(super) fn sorted(&self) -> bool {
        self.layered() && self.can_use(Stage::Layers)
    }
}

/// Each of `marks`' channel pipelines, built for what its channels read, and the reduction of
/// fitted domains if any mark fits one. Before a mark compiles, it reads no joins, samples, or view
/// state.
pub(super) fn channels<'a>(marks: impl Iterator<Item = &'a Shown> + Clone) -> Vec<Asked> {
    let mut channels: Vec<Asked> = Vec::new();
    for shown in marks.clone() {
        let Some(compiled) = &shown.compiled else { continue };
        for entry in ["evaluate", "reduce"] {
            if entry == "reduce" && shown.reductions() == 0 {
                continue;
            }
            let need = Asked::Kernel(compiled.kernel.clone(), Variant::state(Shader::State, entry, shown.reads()));
            if !channels.contains(&need) {
                channels.push(need);
            }
        }
    }
    if marks.into_iter().any(|m| m.reductions() > 0) {
        channels.push(Asked::Shader(Variant::raster(Shader::Words, "maximum")));
    }
    channels
}

/// The multisample count frames of `scene` draw with, on a GPU whose screen takes `most`. Only
/// areas need more than one sample: their triangle edges are the edges of the shape. Points,
/// strokes, text, and the backdrop antialias in their shaders, hooks included, so a scene without
/// areas draws one sample a pixel, and reads the depth it drew without drawing it again.
pub(super) fn samples(scene: &Scene, most: u32) -> u32 {
    if scene.marks.iter().any(|mark| mark.kind() == MarkKind::Areas) { most } else { 1 }
}

/// The pipelines a frame of `scene` into `format` at `samples` per pixel draws with, except each
/// mark's channel pipeline: what a scene needs before it can draw.
pub(super) fn draws(scene: &Scene, format: wgpu::TextureFormat, samples: u32) -> Vec<Asked> {
    stages(scene, format, samples).of(Stage::Draw).to_vec()
}

/// The pipelines frames of `scene` into `format` at `samples` per pixel use, except each mark's
/// channel pipeline, which depends on what its channels read.
fn stages(scene: &Scene, format: wgpu::TextureFormat, samples: u32) -> Stages {
    let any = |test: &dyn Fn(&Mark) -> bool| scene.marks.iter().any(test);
    let draw = |shader| Asked::Shader(Variant::draw(shader, format, samples).projection(Projection::of(&scene.space)));
    let mut stages = Stages::default();
    stages.add(Stage::Draw, draw(Shader::Backdrop));
    if samples > 1 {
        stages.add(
            Stage::Input,
            Asked::Shader(Variant::draw(Shader::Backdrop, format, 1).projection(Projection::of(&scene.space))),
        );
    }
    // A transition freezes rows' state and eases from it. Without an ease, comets on rows that moved
    // still carry over through a transition of no length (see `View::transitions`).
    if !scene.ease.is_zero() || any(&Mark::flows) {
        stages.add_all(Stage::Changes, [Asked::Shader(EASE), Asked::Shader(GATHER)]);
    }
    if !scene.marks.is_empty() {
        // Frames start from the still once its pipeline lands, after the marks' own. Under it, the
        // globe draws its depth again.
        stages.add(Stage::Changes, draw(Shader::Still));
        if Projection::of(&scene.space) == Projection::Globe {
            let depth = Variant::draw(Shader::Backdrop, format, samples).mode(Draw::Depth);
            stages.add(Stage::Changes, Asked::Shader(depth.projection(Projection::Globe)));
        }
        stages.add(Stage::Draw, Asked::Shader(PAGES));
        if any(&|mark| matches!(mark, Mark::Edges(_))) {
            stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::State, "ends")));
        }
        stages.add(Stage::Fit, Asked::Shader(Variant::raster(Shader::Words, "fill")));
        stages.add(Stage::Fit, Asked::Shader(Variant::raster(Shader::Words, "maximum")));
    }
    let controls = scene.controls;
    // The overlay draws a plot's grid lines and axes, the title, the legends, and the selection box
    // and connection line that gestures draw. Its lines and fills draw with the marks, so a plot
    // never shows its traces without its axes. Its text draws once the text stage can.
    let legends = any(&|m| m.style().legend.is_some() && m.style().color.is_some());
    let written = matches!(scene.space, Space::Plot(_)) || scene.title.is_some() || legends;
    let draws = [Action::Box, Action::ZoomBox, Action::Connect].into_iter().any(|a| controls.gestures.any(a));
    if written || draws {
        stages.add(Stage::Draw, draw(Shader::Overlay));
    }
    // The distance fields of text a frame sets are built before the frame draws.
    let labeled = any(&|m| m.style().label.is_some());
    if written || labeled {
        stages.add_all(Stage::Text, FIELDS.map(Asked::Shader));
    }
    // Comets travel, and frames where only they move start from the still.
    if any(&Mark::flows) {
        stages.add(Stage::Changes, Asked::Shader(CARRY));
    }
    if any(&|m| listed(m, scene)) {
        stages.add_all(Stage::Draw, SCAN.map(Asked::Shader));
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lists, "pack_counts")));
    }
    if any(&|m| listed(m, scene) && m.measures_paths()) {
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lists, "pack_segments")));
        for entry in ["totals", "scan"] {
            stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::Lengths, entry)));
        }
    }
    for mark in &scene.marks {
        mark_stages(mark, scene, format, samples, &mut stages);
    }
    stages.dedupe();
    stages
}

/// Only paths with a variable number of segments need count and list passes.
fn listed(mark: &Mark, scene: &Scene) -> bool {
    match mark.path(&scene.space) {
        PATH_GEOMETRY | PATH_BENDS => true,
        PATH_ENDS if matches!(mark, Mark::Edges(_)) => {
            matches!(scene.space, Space::Earth(_)) || scene.theme.edge.fans()
        }
        _ => false,
    }
}

/// Adds `mark`'s pipelines to `stages`: its draw and raster passes (for the path a stroke follows
/// or an area's triangle geometry), its lit-row draw (for the rows that hover, selection, and edge
/// endpoints light), its opaque draw and height sort where depth varies, the pass measuring it for
/// a fit, its probe, and its labels.
fn mark_stages(mark: &Mark, scene: &Scene, format: wgpu::TextureFormat, samples: u32, stages: &mut Stages) {
    let variants = MarkVariants::of(mark, scene);
    if mark.draws_rows() {
        stages.add(Stage::Draw, variants.draw(Draw::Rows, format, samples));
        stages.add(Stage::Lit, variants.draw(Draw::Lit, format, samples));
    }
    if variants.path == PATH_TRACE {
        stages.add(Stage::Draw, Asked::Shader(Variant::raster(Shader::TracePoints, "point")));
    }
    if let Some(screen) = variants.screen() {
        stages.add(Stage::Draw, Asked::Shader(screen));
        if screen.shader() == Shader::ScreenProjected {
            stages.add(Stage::Draw, Asked::Shader(variants.own(Variant::raster(Shader::Project, "point"))));
        }
    }
    // Comets draw over their rows with the rows' program. Where the rows have records, a comet a
    // slot, which the frame counts from the records (see `raster/comets.wesl`).
    if mark.flows() {
        stages.add(Stage::Draw, variants.draw(Draw::Comets, format, samples));
        if variants.screen().is_some() {
            stages.add_all(Stage::Draw, COMET_SLOTS.map(Asked::Shader));
            stages.add_all(Stage::Draw, SCAN.map(Asked::Shader));
        }
    }
    // A stroke's markers draw after its rows, and after its lit rows.
    for k in 0..mark.stroke_markers().len() {
        stages.add_all(Stage::Draw, variants.marker(k, Draw::Rows, format, samples).map(Asked::Shader));
        stages.add_all(Stage::Lit, variants.marker(k, Draw::Lit, format, samples).map(Asked::Shader));
    }
    // Depth varies only where the camera can tilt or the globe shows: on a plane or the earth.
    if matches!(scene.space, Space::Plane(_) | Space::Earth(_)) {
        if mark.draws_rows() {
            stages.add(Stage::Draw, variants.draw(Draw::Opaque, format, samples));
        }
        // Rows that can stand at different heights draw lowest first: a raised vertex mark's, and
        // those of edges and poles, which may end at one.
        let edges = matches!(mark, Mark::Edges(_)) && matches!(variants.path, PATH_ENDS | PATH_BENDS | PATH_POLES);
        if super::lists::raised(mark) || (edges && scene.marks.iter().any(super::lists::raised)) {
            stages.add(Stage::Layers, Asked::Shader(variants.height_keys()));
            stages.add(Stage::Layers, Asked::Shader(Variant::raster(Shader::Lists, "pack_order")));
            stages.add_all(Stage::Layers, [&DIGIT_PASSES[..], &SCAN[..]].concat().into_iter().map(Asked::Shader));
        }
    }
    stages.add_all(Stage::Fit, variants.bounds().map(Asked::Shader));
    if listed(mark, scene) {
        stages.add_all(Stage::Draw, variants.segments(mark.measures_paths()).map(Asked::Shader));
    }
    // One probe program answers hover, queries, and the depth under the pointer for the mark's
    // geometry. Every mark gets one, so any drawn row can be located, pickable or not.
    for entry in ["probe", "finish"] {
        stages.add(Stage::Input, Asked::Shader(variants.probe(Shader::Probe).entry(entry)));
    }
    stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::Boxed, "boxed_row")));
    for entry in ["counts", "boxed"] {
        stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::QueryPack, entry)));
    }
    for entry in ["greatest", "fill"] {
        stages.add(Stage::Input, Asked::Shader(Variant::raster(Shader::Words, entry)));
    }
    stages.add_all(Stage::Input, SCAN.map(Asked::Shader));
    if samples > 1 {
        stages.add(Stage::Input, variants.draw(Draw::Opaque, format, 1));
    }
    if mark.style().label.is_some() {
        stages.add(Stage::Text, Asked::Shader(variants.glyphs(format, samples)));
        stages.add_all(Stage::Text, variants.label_passes().map(Asked::Shader));
        stages.add_all(Stage::Text, SCAN.map(Asked::Shader));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Areas, Edges, Event, Lines, Plane, Vertices};

    #[test]
    fn only_a_scene_that_draws_areas_multisamples() {
        let graph = Scene::new(Plane::default()).draw(Vertices::of("g", "V")).draw(Edges::of("g", "E").ends("a", "b"));
        let map = graph.clone().draw(Areas::of("g", "A"));
        assert_eq!([samples(&graph, 4), samples(&map, 4), samples(&map, 1)], [1, 4, 1]);
        // One sample a pixel leaves depth readable where it was drawn, so only a multisampled
        // scene asks for the pipelines that draw it again for probes.
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let replays = |scene: &Scene| {
            let backdrop = Variant::draw(Shader::Backdrop, format, 1).projection(Projection::of(&scene.space));
            stages(scene, format, samples(scene, 4)).of(Stage::Input).contains(&Asked::Shader(backdrop))
        };
        assert!(!replays(&graph) && replays(&map));
    }

    #[test]
    fn label_only_vertices_request_glyphs_without_a_marker_program() {
        let scene = Scene::new(Plane::default())
            .draw(Vertices::of("g", "Bus").marker(crate::Marker::None).label(crate::Label::new(crate::field("name"))));
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let variants = MarkVariants::of(&scene.marks[0], &scene);
        let stages = stages(&scene, format, 1);
        assert!(!stages.of(Stage::Draw).contains(&variants.draw(Draw::Rows, format, 1)));
        assert!(!stages.of(Stage::Lit).contains(&variants.draw(Draw::Lit, format, 1)));
        assert!(stages.of(Stage::Text).contains(&Asked::Shader(variants.glyphs(format, 1))));
    }

    #[test]
    fn straight_planar_edges_skip_list_construction_until_fans_are_enabled() {
        let mut scene = Scene::new(Plane::default()).draw(Edges::of("g", "E").ends("a", "b"));
        let counts = Asked::Shader(MarkVariants::of(&scene.marks[0], &scene).segments(false)[0]);
        let asks = |scene: &Scene| draws(scene, wgpu::TextureFormat::Rgba8Unorm, 1).contains(&counts);
        assert!(!asks(&scene));
        scene.theme.edge.parallel = Some(crate::Parallel { converge: crate::Converge::Fan, ..Default::default() });
        assert!(asks(&scene));
    }

    #[test]
    fn only_marks_that_frame_a_fit_ask_for_a_bounds_pass() {
        let scene = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V"))
            .draw(Edges::of("g", "E").ends("from", "to"))
            .draw(Lines::of("g", "L"));
        let stages = stages(&scene, wgpu::TextureFormat::Rgba8Unorm, 1);
        let fit = stages.of(Stage::Fit);
        let asks = |entry, path| {
            fit.contains(&Asked::Shader(
                Variant::raster(Shader::Bounds, entry).path(path).projection(Projection::Planar),
            ))
        };
        assert!(asks("points", PATH_ENDS), "vertices frame a fit");
        assert!(asks("strokes", PATH_GEOMETRY), "so do lines along their paths");
        assert!(!asks("strokes", PATH_ENDS), "edges lie between the vertices that frame them");
    }

    #[test]
    fn comets_ask_for_the_transition_that_carries_them_even_without_an_ease() {
        let changes = |scene: Scene| {
            let stages = stages(&scene.ease(std::time::Duration::ZERO), wgpu::TextureFormat::Rgba8Unorm, 1);
            [EASE, GATHER, CARRY].map(|pass| stages.of(Stage::Changes).contains(&Asked::Shader(pass)))
        };
        let still = Scene::new(Plane::default()).draw(Edges::of("g", "E").ends("a", "b"));
        assert_eq!(changes(still), [false; 3], "nothing eases or carries");
        let flowing = Scene::new(Plane::default()).draw(Edges::of("g", "E").ends("a", "b").flow(crate::field("s")));
        assert_eq!(changes(flowing), [true; 3], "rows that move freeze, ease, and carry their comets over");
    }

    /// The browser holds GLSL only for specializations the build made. A scene asking for any other
    /// would stop the page that draws it, as glowing areas once did.
    #[test]
    fn every_pipeline_a_scene_asks_for_was_built_for_the_browser() {
        use crate::{
            Areas, Earth, EdgeTheme, Label, Legend, LineTheme, Marker, Meet, Place, Plot, Shape, Theme, field,
        };
        let markers = [
            Marker::Shape(Shape::Diamond),
            Marker::Block { corner: None },
            Marker::Gauge { fill: field("f"), shape: Shape::Ellipse },
            Marker::Pie { slices: vec![field("a")], colors: vec![], hole: 0.0 },
            Marker::Icon { images: vec![], index: field("i") },
            Marker::symbol(["M0 0V-1"], 0.0),
            Marker::Wgsl { source: "fn marker(f: MarkerFragment) -> MarkerColor { }".into(), inputs: vec![] },
        ];
        let globe = Earth::default().projection(crate::Projection::Globe);
        let spaces = [Space::Plane(Plane::default()), Space::Earth(Earth::default()), Space::Earth(globe)];
        let shade = || crate::Shade::new("fn shade(f: ShadeFragment) -> vec4f { return f.color; }");
        // Each space once as its marks draw by default, and once with the options that have
        // pipelines of their own: a halo, a bearing, a label's place, ends that meet markers,
        // markers along strokes, of each kind a stroke takes, and a place where colors change.
        let dark = Theme::dark();
        let haloed = Theme {
            edge: EdgeTheme { halo: 2.0.into(), ..dark.edge },
            line: LineTheme { halo: 2.0.into(), ..dark.line },
            ..dark.clone()
        };
        let spaces = spaces.into_iter().chain([Space::Plot(Plot::default())]);
        for (space, theme) in spaces.flat_map(|space| [(space.clone(), dark.clone()), (space, haloed.clone())]) {
            let options = theme == haloed;
            let mut scene = Scene::new(space).title("t").theme(theme);
            for marker in &markers {
                let raised = Vertices::of("g", "V").marker(marker.clone()).elevation(field("z"));
                let label = Label::new(field("n"));
                let label = if options { label.place(Place::Top) } else { label };
                let raised = raised.label(label).legend(Legend::new("l")).color(field("c"));
                let raised = if options { raised.bearing(field("b")) } else { raised };
                scene = scene.draw(raised.clone()).draw(raised.shade(shade()));
            }
            let along = || {
                let pictures = [Marker::Icon { images: vec![], index: field("i") }, Marker::symbol(["M0 0V-1"], 0.0)];
                [Marker::Shape(Shape::Rectangle)].into_iter().chain(pictures).filter(|_| options)
            };
            let edges = || {
                let edges = Edges::of("g", "E").ends("a", "b").markers(along());
                if options { edges.meet(Meet::Nearest).blend(0.5, 0.5) } else { edges }
            };
            for edges in [edges(), edges().poles(), edges().bends("p"), edges().joins("J", "j")] {
                scene = scene
                    .draw(edges.clone())
                    .draw(edges.clone().shade(shade()))
                    .draw(edges.flow(field("s")).dash(field("d")).label(Label::new(field("n"))));
            }
            scene = scene
                .draw(Lines::of("g", "L").markers(along()))
                .draw(Lines::of("g", "L").markers(along()).flow(field("s")).shade(shade()))
                .draw(Areas::of("g", "A"))
                .draw(Areas::of("g", "A").shade(shade()));
            for samples in [1, 4] {
                let stages = stages(&scene, wgpu::TextureFormat::Bgra8Unorm, samples);
                for need in Stage::ALL.iter().flat_map(|&stage| stages.of(stage)) {
                    if let Asked::Shader(variant) | Asked::Hooked(_, variant) = need {
                        assert!(variant.built(), "the browser has no GLSL for {}", need.label());
                    }
                }
            }
        }
    }

    #[test]
    fn only_rows_that_can_stand_at_heights_ask_to_sort_by_height() {
        let sorting = |scene: Scene| {
            let stages = stages(&scene, wgpu::TextureFormat::Rgba8Unorm, 1);
            let layering = stages.of(Stage::Layers);
            let keys = |path| {
                layering.contains(&Asked::Shader(
                    Variant::raster(Shader::Lists, "height_keys").path(path).projection(Projection::Planar),
                ))
            };
            [keys(PATH_ENDS), keys(PATH_POLES), keys(PATH_GEOMETRY)]
        };
        let flat = Scene::new(Plane::default()).draw(Vertices::of("g", "V")).draw(Edges::of("g", "E").ends("a", "b"));
        assert_eq!(sorting(flat), [false; 3], "rows on the ground keep their order");
        let raised = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V").elevation(crate::field("z")))
            .draw(Edges::of("g", "V").poles())
            .draw(Lines::of("g", "L"));
        assert_eq!(sorting(raised), [true, true, false], "vertices and poles stand at heights, lines lie flat");
    }

    #[test]
    fn a_view_needing_a_refused_pipeline_says_why_once_and_draws_nothing() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        assert!(view.ready_for(format, 1.0, false));
        view.events().for_each(drop);
        let need = view.asked[0].stages.of(Stage::Draw)[0].clone();
        gpu.0.lock().pipelines.refuse(&need, "the stage reads no such constant");
        let done = view.done();
        assert!(!view.ready_for(format, 1.0, false), "a view that can't draw what its scene says draws nothing");
        assert!(!view.ready_for(format, 1.0, false));
        let errors: Vec<_> =
            view.events().filter_map(|e| if let Event::Error(e) = e { Some(e) } else { None }).collect();
        assert_eq!(errors.len(), 1, "it says why once: {errors:?}");
        assert!(matches!(&errors[0], crate::Error::Unsupported(m) if m.contains(&need.label())), "{errors:?}");
        assert_eq!(done.take(), Some(Err(errors[0].clone())), "and what waited for it to be done fails");
        assert_eq!(view.done().take(), Some(Err(errors[0].clone())));
    }

    #[test]
    fn opaque_draws_come_with_drawing_and_only_a_view_whose_depth_varies_asks_for_height_sorts() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let opaque = |need: &Asked| need.label().contains("Opaque");
        let edges = || Edges::of("g", "E").ends("a", "b");
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")).draw(edges()));
        assert!(view.ready_for(format, 1.0, true));
        let draw = view.asked[0].stages.of(Stage::Draw).to_vec();
        assert_eq!(draw.iter().filter(|need| opaque(need)).count(), 2, "every mark's opaque draw is a draw pipeline");
        assert_eq!(view.asked[0].stages.of(Stage::Layers), [], "rows on the ground need no height sort");
        // Straight down at a plane, marks draw in order. Tilted, opaque pixels draw first at once.
        assert!(!view.layered());
        view.set_camera(crate::Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 40.0, bearing: 0.0 });
        assert!(view.ready_for(format, 1.0, true) && view.layered() && view.sorted());
        // Raised rows make depth vary straight down too, and sort once the sorts land.
        let raised = Vertices::of("g", "V").elevation(crate::field("z"));
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(raised).draw(edges()));
        assert!(view.ready_for(format, 1.0, true));
        let sorting = view.asked[0].stages.of(Stage::Layers).to_vec();
        assert!(!sorting.is_empty() && !sorting.iter().any(opaque), "layers are the height sorts alone");
        assert!(view.layered() && view.sorted());
        let only: Vec<Asked> = sorting.into_iter().filter(|need| !draw.contains(need)).collect();
        for need in &only {
            gpu.0.lock().pipelines.hold(need);
        }
        assert!(view.ready_for(format, 1.0, true) && view.layered() && !view.sorted(), "it draws in layers meanwhile");
        for need in &only {
            gpu.0.lock().pipelines.release(need);
        }
    }

    #[test]
    fn only_a_fit_that_measures_rows_waits_for_the_passes_measuring_them() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        view.fit(crate::Fit::Bounds { min: [-1.0, -1.0, 0.0], max: [1.0, 1.0, 0.0] });
        assert!(view.ready_for(format, 1.0, true));
        let fit = view.asked[0].stages.of(Stage::Fit).to_vec();
        assert!(!fit.is_empty() && !view.asked[0].stages.of(Stage::Draw).iter().any(|need| fit.contains(need)));
        let hold = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.hold(need));
        let release = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.release(need));
        // Only a measurement requests the fit pipelines. Build them once so the test can hold them pending.
        view.fit(crate::Fit::All);
        assert!(view.ready_for(format, 1.0, true));
        view.fit(crate::Fit::Bounds { min: [-1.0, -1.0, 0.0], max: [1.0, 1.0, 0.0] });
        hold(&fit);
        assert!(view.ready_for(format, 1.0, true), "a box fit draws without them");
        assert!(!view.waiting().compiling);
        view.fit(crate::Fit::All);
        assert!(view.ready_for(format, 1.0, true), "a fit that measures rows draws meanwhile");
        assert!(view.waiting().compiling && !view.measure_due(), "and waits for them to measure");
        release(&fit);
        assert!(view.ready_for(format, 1.0, true));
        assert!(!view.waiting().compiling);
    }

    #[test]
    fn a_new_scene_draws_once_its_pipelines_land_and_the_scene_before_draws_meanwhile() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        assert!(view.ready_for(format, 1.0, true));
        let drawn = view.asked[0].stages.of(Stage::Draw).to_vec();
        // A scene adding flowing edges, whose draws hold back as if compiling.
        let after = Scene::new(Plane::default())
            .draw(Vertices::of("g", "V"))
            .draw(Edges::of("g", "E").ends("a", "b").flow(crate::field("s")));
        let new: Vec<Asked> = draws(&after, format, samples(&after, gpu.samples().expect("set")))
            .into_iter()
            .filter(|need| !drawn.contains(need))
            .collect();
        assert_ne!(new, Vec::new(), "flowing edges draw with pipelines of their own");
        {
            let mut inner = gpu.0.lock();
            inner.pipelines.ask(&gpu.0.device, &new, Urgency::Draw, &view.compile_waker);
            for need in &new {
                inner.pipelines.hold(need);
            }
        }
        view.set_scene(after);
        assert!(!view.complete() && view.done().take().is_none(), "what waits for it to be done waits");
        assert_eq!(view.scene().marks.len(), 2, "the view's scene is the one set");
        assert_eq!(view.marks.len(), 1, "but the scene before draws");
        assert!(view.ready_for(format, 1.0, true), "and goes on drawing while the new one compiles");
        assert!(view.waiting().compiling && !view.measure_due());
        assert!(view.under_way().compiling, "every frame meanwhile waits on it");
        assert!(view.compiling.is_some(), "and a compile landing wakes the view to draw it");
        view.set_camera(crate::Camera::Map { center: [5.0, 0.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 });
        assert!(matches!(view.camera, crate::Camera::Map { center: [0.0, ..], .. }), "a camera set waits for it");
        for need in &new {
            gpu.0.lock().pipelines.release(need);
        }
        view.swap_when_ready(true);
        assert!(view.incoming.is_none() && view.marks.len() == 2, "it draws once they land");
        assert!(matches!(view.camera, crate::Camera::Map { center: [5.0, ..], .. }), "with the camera set for it");
        assert!(view.ready_for(format, 1.0, true));
    }

    #[test]
    fn a_view_waits_only_for_the_pipelines_its_frames_draw_with() {
        let Some(gpu) = crate::gpu::testing::gpu() else { return };
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let mut view = View::new(&gpu, Scene::new(Plane::default()).draw(Vertices::of("g", "V")));
        assert!(view.ready_for(format, 1.0, true));
        let of = |view: &View, stage| view.asked[0].stages.of(stage).to_vec();
        let (draw, lit, input) = (of(&view, Stage::Draw), of(&view, Stage::Lit), of(&view, Stage::Input));
        let hold = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.hold(need));
        let release = |needs: &[Asked]| needs.iter().for_each(|need| gpu.0.lock().pipelines.release(need));
        // Probes share reduction/fill kernels with drawing. Hold only the exclusive input
        // pipelines: already compiled shared pipelines cannot become pending again.
        let input: Vec<_> = input.into_iter().filter(|need| !draw.contains(need)).collect();
        hold(&input);
        assert!(view.ready_for(format, 1.0, true));
        assert!(!view.can_use(Stage::Input) && !view.waiting().compiling, "complete without its probes");
        assert!(view.compiling.is_some(), "a finished compile wakes it to probe");
        release(&input);
        // The glow is drawn only while a row is lit.
        hold(&lit);
        assert!(view.ready_for(format, 1.0, true));
        assert!(!view.waiting().compiling, "complete while nothing is lit");
        view.marks[0].lit.rows = 1;
        assert!(view.ready_for(format, 1.0, true));
        assert!(view.waiting().compiling, "incomplete while a lit row draws without its glow");
        release(&lit);
        // Without its draws, the view draws nothing new.
        hold(&draw);
        assert!(!view.ready_for(format, 1.0, true));
        assert!(view.waiting().compiling);
        release(&draw);
        assert!(view.ready_for(format, 1.0, true));
        assert!(view.can_use(Stage::Input) && !view.waiting().compiling);
    }
}
